// Google 連携の状態機械。OAuth 2.0 Loopback + PKCE（2.3）。個人版は .env、共有版は利用者が入力した Client ID/Secret（2.4）を使う。
// Electron に依存しない：fetch / ブラウザ起動 / ループバック / トークン保存はすべて注入する（テスト容易性のため）。
// IPC は持たない。状態変化は events の 'change' で通知し、ipc.js が中継する（レンダラーへは状態 enum のみ渡し、トークンは渡さない）。
//
// status:
//   unconfigured … Client ID/Secret が未設定・不正（configProblem に理由。個人版は .env、共有版は設定画面の入力）
//   unlinked     … 未連携（lastError に直前の失敗理由があれば入る）
//   linking      … ブラウザで同意フロー中
//   checking     … 起動時のサイレント更新中
//   linked       … 連携済み。linkedAt に同意した時刻（Phase 16 より前の連携は null）。relinking が true なら、連携したまま同意をやり直している
//
// 連携し直す（relink。Phase 16）：連携したまま同意フローをもう一度行い、成功したらトークンを差し替える。
// 自分で作ったクライアント（テストモード）は連携が 7 日で切れるので、切れる前に連携し直せるようにする（linkExpiry.js が予告する）。
// 状態は linked のままなので、通知の取得は止まらず、メールの「初回は既存の未読を通知済み扱い」も起きない。
// 古いトークンは取り消さない（取り消すと同じ許可から出た新しいトークンまで無効になることがあるため。期限で自然に切れる）。

import { EventEmitter } from 'node:events';
import {
  buildAuthUrl,
  buildRefreshRequest,
  buildRevokeRequest,
  buildTokenExchangeRequest,
  codeChallengeFromVerifier,
  generateCodeVerifier,
  generateState,
  hasAllScopes,
  interpretTokenResponse,
  validateOAuthEnv,
} from './authCore.js';

// アクセストークンの期限がこれを切ったら更新する
const REFRESH_MARGIN_MS = 60 * 1000;

/**
 * @param {object} deps
 * @param {Record<string, string | undefined>} [deps.env] process.env（個人版。clientConfig が無いときに validateOAuthEnv で検証する）
 * @param {{ ok: true, clientId: string, clientSecret: string } | { ok: false, reason: string }} [deps.clientConfig]
 *   検証済みの Client ID/Secret（共有版。後から configure で差し替える）
 * @param {ReturnType<import('./tokenStorage.js').createTokenStorage>} deps.tokenStorage
 * @param {typeof fetch} deps.fetch
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {typeof import('./loopback.js').startLoopbackServer} deps.startLoopback
 * @param {{ info: Function, warn: Function }} [deps.log] トークン・コード・Secret は絶対に渡さないこと
 * @param {() => number} [deps.now]
 */
export function createAuth({ env = {}, clientConfig, tokenStorage, fetch, openExternal, startLoopback, log = console, now = Date.now }) {
  const events = new EventEmitter();
  let config = clientConfig ?? validateOAuthEnv(env);

  let state = config.ok
    ? { status: 'unlinked', lastError: null }
    : { status: 'unconfigured', configProblem: config.reason, lastError: null };

  /** メモリ上の認証情報。setCredentials にそのまま渡せる形（access_token / expiry_date は保存しない） */
  let credentials = null;
  /** 同意した時刻（連携の期限の予告に使う。tokens.enc の linked_at）。不明なら null */
  let linkedAt = null;
  let flow = null; // 進行中のリンクフロー { close }
  let refreshing = null; // 単一フライトの更新
  let generation = 0; // 解除・再連携をまたいだ古い非同期結果を捨てるための世代番号

  if (!config.ok) log.warn(`[auth] OAuth client config problem: ${config.reason}`);

  const setState = (next) => {
    state = next;
    events.emit('change', { ...state });
  };
  const linkedState = (extra = {}) => ({ status: 'linked', lastError: null, linkedAt, ...extra });

  const readJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  /** トークンエンドポイントへ POST し、interpretTokenResponse の結果（または network 失敗）を返す */
  async function postToken({ url, init }) {
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      return { ok: false, kind: 'network' };
    }
    return interpretTokenResponse({ status: res.status, body: await readJson(res) });
  }

  /**
   * 保存済み refresh_token でアクセストークンを再取得する（単一フライト）。
   * - invalid_grant のときだけトークンを破棄して未連携に戻す
   * - ネットワークエラー・5xx・その他は、トークンを保持したまま失敗を返す（状態は変えない）
   * @returns {Promise<{ ok: true } | { ok: false, kind: string }>}
   */
  function refreshAccessToken() {
    if (refreshing) return refreshing;
    if (!credentials || !config.ok) return Promise.resolve({ ok: false, kind: 'no_credentials' });

    const gen = generation;
    const refreshToken = credentials.refresh_token;
    refreshing = (async () => {
      const res = await postToken(buildRefreshRequest({ ...config, refreshToken }));
      if (gen !== generation) return { ok: false, kind: 'superseded' }; // 更新中に解除・再連携された
      if (res.ok) {
        credentials = {
          ...credentials,
          access_token: res.tokens.access_token,
          expiry_date: now() + res.tokens.expires_in * 1000,
          scope: res.tokens.scope || credentials.scope,
          token_type: res.tokens.token_type,
        };
        // Google は通常ローテーションしないが、新しい refresh_token が来た場合は差し替える
        if (res.tokens.refresh_token && res.tokens.refresh_token !== credentials.refresh_token) {
          credentials.refresh_token = res.tokens.refresh_token;
          await tokenStorage.save({ ...credentials, linked_at: linkedAt }).catch(() => log.warn('[auth] failed to persist rotated refresh token'));
        }
        return { ok: true };
      }
      if (res.kind === 'invalid_grant') {
        log.warn('[auth] refresh token was rejected (invalid_grant); returning to unlinked');
        credentials = null;
        linkedAt = null;
        await tokenStorage.remove().catch(() => {});
        setState({ status: 'unlinked', lastError: 'expired' });
      } else {
        log.warn(`[auth] token refresh failed (${res.kind}); keeping stored token`);
      }
      return res;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * 同意フロー（link と relink で共通）。返す Promise は決して reject しない。
   * @param {{ relink: boolean }} opts relink … 連携したまま行う（失敗しても未連携にしない）
   */
  function consent({ relink }) {
    const gen = ++generation;
    setState(relink ? linkedState({ relinking: true }) : { status: 'linking', lastError: null });

    return (async () => {
      const fail = (lastError) => {
        if (gen !== generation) return;
        flow = null;
        // 連携し直す途中で元のトークンが切れていたら（invalid_grant）、未連携のまま
        setState(relink && credentials ? linkedState({ lastError }) : { status: 'unlinked', lastError });
      };
      let server;
      try {
        const codeVerifier = generateCodeVerifier();
        const expectedState = generateState();
        server = await startLoopback({ expectedState });
        flow = { close: server.close };
        server.result.catch(() => {}); // 閉じられたときの reject を未処理にしない（実際の待機は下で行う）
        if (gen !== generation) return server.close();

        const url = buildAuthUrl({
          clientId: config.clientId,
          redirectUri: server.redirectUri,
          codeChallenge: codeChallengeFromVerifier(codeVerifier),
          state: expectedState,
        });
        try {
          await openExternal(url);
        } catch {
          server.close();
          return fail('browser_failed');
        }

        let callback;
        try {
          callback = await server.result;
        } catch (e) {
          return fail(e.code === 'timeout' ? 'timeout' : null);
        }
        if (callback.error) return fail(callback.error === 'denied' ? 'denied' : 'exchange_failed');

        const res = await postToken(
          buildTokenExchangeRequest({ ...config, code: callback.code, codeVerifier, redirectUri: server.redirectUri }),
        );
        if (gen !== generation) return;
        if (!res.ok) {
          log.warn(`[auth] token exchange failed (${res.kind})`);
          return fail(res.kind === 'invalid_client' ? 'invalid_client' : res.kind === 'network' ? 'network' : 'exchange_failed');
        }
        if (!hasAllScopes(res.tokens.scope)) {
          log.warn('[auth] granted scopes are insufficient');
          // 不完全な許可が Google 側に残らないよう、取得できたトークンは取り消す
          const { url, init } = buildRevokeRequest(res.tokens.refresh_token ?? res.tokens.access_token);
          fetch(url, init).catch(() => {});
          return fail('scope_insufficient');
        }
        if (!res.tokens.refresh_token) {
          log.warn('[auth] no refresh_token in exchange response');
          return fail('no_refresh_token');
        }

        const next = {
          refresh_token: res.tokens.refresh_token,
          scope: res.tokens.scope,
          token_type: res.tokens.token_type,
        };
        const at = now();
        try {
          await tokenStorage.save({ ...next, linked_at: at });
        } catch (e) {
          log.warn(`[auth] failed to save tokens: ${e?.message ?? e}`);
          return fail('save_failed');
        }
        if (gen !== generation) return;
        credentials = {
          ...next,
          access_token: res.tokens.access_token,
          expiry_date: now() + res.tokens.expires_in * 1000,
        };
        linkedAt = at;
        flow = null;
        // 連携し直したときに古いトークンで更新中だった結果（invalid_grant で未連携に戻す等）を捨てる
        generation++;
        log.info(relink ? '[auth] relinked' : '[auth] linked');
        setState(linkedState());
      } catch (e) {
        log.warn(`[auth] link failed: ${e?.message ?? e}`);
        server?.close();
        fail('exchange_failed');
      }
    })();
  }

  return {
    events,

    /** UI 向けの現在状態（トークンは含まない）。 */
    getState: () => ({ ...state }),

    /**
     * 起動時に呼ぶ（await 不要・reject しない）。保存済みトークンがあればバックグラウンドでサイレント更新する。
     * 成否はログのみで、UI はブロックしない。
     */
    async init() {
      if (!config.ok) return;
      try {
        const stored = await tokenStorage.load();
        if (!stored) return;
        const { linked_at: storedLinkedAt, ...rest } = stored;
        credentials = rest;
        linkedAt = Number.isFinite(storedLinkedAt) ? storedLinkedAt : null;
        setState({ status: 'checking', lastError: null });
        const res = await refreshAccessToken();
        if (res.kind === 'superseded' || res.kind === 'invalid_grant') return; // 後者は refreshAccessToken 内で unlinked 済み
        if (res.ok) log.info('[auth] silent refresh succeeded');
        // 成功、またはネットワークエラー・5xx 等（トークンは保持。アクセストークンは getCredentials 時に再試行）
        setState(linkedState());
      } catch (e) {
        log.warn(`[auth] init failed: ${e?.message ?? e}`);
        if (state.status === 'checking') setState({ status: 'unlinked', lastError: null });
      }
    },

    /**
     * 同意フローを開始する。状態は同期的に linking になり、完了・失敗は 'change' で通知される。
     * 返す Promise は決して reject しない。
     */
    link() {
      if (!config.ok || state.status !== 'unlinked') return Promise.resolve();
      return consent({ relink: false });
    },

    /**
     * 連携したまま同意をやり直す（Phase 16）。状態は linked のまま relinking: true になり、成功したらトークンを差し替える。
     * 失敗・キャンセルしたら、元のトークンのまま linked に戻る（lastError に理由）。返す Promise は決して reject しない。
     */
    relink() {
      if (!config.ok || state.status !== 'linked' || state.relinking) return Promise.resolve();
      return consent({ relink: true });
    },

    /** 進行中の同意フロー（連携し直すときは linked のまま）を中断する。 */
    cancel() {
      const relinking = state.status === 'linked' && state.relinking === true;
      if (state.status !== 'linking' && !relinking) return;
      generation++;
      const f = flow;
      flow = null;
      f?.close();
      setState(relinking ? linkedState() : { status: 'unlinked', lastError: null });
    },

    /**
     * 連携解除：Google 側で revoke（ベストエフォート）し、ローカルのトークンを必ず削除する。
     */
    async unlink() {
      if (!config.ok) return;
      generation++;
      const f = flow;
      flow = null;
      f?.close();

      let stored = credentials;
      credentials = null;
      linkedAt = null;
      try {
        stored ??= await tokenStorage.load();
      } catch {
        // 読めなくても削除は続行する
      }
      if (stored?.refresh_token) {
        try {
          const { url, init } = buildRevokeRequest(stored.refresh_token);
          const res = await fetch(url, init);
          if (!res.ok) log.warn(`[auth] revoke returned ${res.status}; local token will still be removed`);
        } catch {
          log.warn('[auth] revoke failed (network); local token will still be removed');
        }
      }
      await tokenStorage.remove();
      log.info('[auth] unlinked');
      setState({ status: 'unlinked', lastError: null });
    },

    /**
     * googleapis の OAuth2Client.setCredentials() にそのまま渡せる認証情報を返す（refresh_token を含む）。
     * Phase 4 の API 呼び出しでは使わない（getAccessToken を使う）。
     * アクセストークンが期限切れ間近なら先にサイレント更新する。未連携なら null。
     * 更新に失敗しても（一時障害）保持中の refresh_token を含む認証情報を返す。
     * @returns {Promise<{ refresh_token: string, access_token?: string, expiry_date?: number, scope: string, token_type: string } | null>}
     */
    async getCredentials() {
      if (!credentials) return null;
      const fresh = credentials.access_token && credentials.expiry_date - now() > REFRESH_MARGIN_MS;
      if (!fresh) await refreshAccessToken();
      return credentials ? { ...credentials } : null;
    },

    /**
     * Phase 4 用：Google API に渡す有効なアクセストークン「だけ」を返す。refresh_token は外に出さない
     * （googleapis の OAuth2Client に refresh_token を持たせて自動更新させると、ここの更新・invalid_grant 処理と二重化するため）。
     * 期限切れ間近なら先にサイレント更新する（単一フライト）。期限切れのトークンは返さない。
     *
     * 失敗の kind：unlinked（未連携・invalid_grant で解除された）／ network ／ transient（5xx・429）／ invalid_client ／ other。
     * トークンは保持されるので、一時障害なら次回の呼び出しで回復し得る。
     * @returns {Promise<{ ok: true, token: string } | { ok: false, kind: string }>}
     */
    async getAccessToken() {
      if (!credentials) return { ok: false, kind: 'unlinked' };
      const fresh = credentials.access_token && credentials.expiry_date - now() > REFRESH_MARGIN_MS;
      if (!fresh) {
        const res = await refreshAccessToken();
        if (!res.ok) return { ok: false, kind: res.kind === 'invalid_grant' || res.kind === 'no_credentials' ? 'unlinked' : res.kind };
      }
      if (!credentials?.access_token) return { ok: false, kind: 'unlinked' };
      return { ok: true, token: credentials.access_token };
    },

    /**
     * API が 401 を返したときに呼ぶ。保持中のアクセストークンを捨て、次の getAccessToken() で必ず更新させる。
     * （Google 側で失効させた場合、これが無いと期限（最大約1時間）まで 401 が続く。refresh_token は触らない）
     */
    invalidateAccessToken() {
      if (!credentials) return;
      const { access_token: _a, expiry_date: _e, ...rest } = credentials;
      credentials = rest;
    },

    /**
     * Client ID/Secret を差し替える（共有版の設定画面での保存・削除。2.4・v5.11）。
     * トークンは発行したクライアントに結び付くため、受け付けるのは未設定（unconfigured）か未連携（unlinked）のときだけ。
     * 連携中・同意フロー中・起動時の確認中は false を返して何もしない（先に連携解除させる）。
     * @param {{ ok: true, clientId: string, clientSecret: string } | { ok: false, reason: string }} next validateOAuthClient の結果
     * @returns {boolean} 差し替えたか
     */
    configure(next) {
      if (state.status !== 'unconfigured' && state.status !== 'unlinked') return false;
      config = next?.ok ? { ok: true, clientId: next.clientId, clientSecret: next.clientSecret } : { ok: false, reason: next?.reason ?? 'missing_client_id' };
      credentials = null;
      linkedAt = null;
      setState(config.ok ? { status: 'unlinked', lastError: null } : { status: 'unconfigured', configProblem: config.reason, lastError: null });
      return true;
    },

    /** 連携中・同意フロー中・確認中でなければ true（Client ID/Secret を変更できる）。 */
    canConfigure: () => state.status === 'unconfigured' || state.status === 'unlinked',

    /** 終了時に呼ぶ。進行中のループバックサーバーを閉じる。 */
    dispose() {
      generation++;
      flow?.close();
      flow = null;
    },
  };
}
