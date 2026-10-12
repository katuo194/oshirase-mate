import { describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/main/auth.js';
import { REVOKE_ENDPOINT, SCOPES, TOKEN_ENDPOINT, codeChallengeFromVerifier } from '../src/main/authCore.js';
import { FIXTURE, createFakeGoogleOAuth } from '../mocks/google/oauth.js';

const ENV = { GOOGLE_OAUTH_CLIENT_ID: FIXTURE.clientId, GOOGLE_OAUTH_CLIENT_SECRET: FIXTURE.clientSecret };

const storedCreds = { refresh_token: FIXTURE.refreshToken, scope: FIXTURE.scope, token_type: 'Bearer' };

/** メモリ上の tokenStorage（tokenStorage.test.js で実物は検証済み） */
function memoryStorage(initial = null) {
  const s = {
    data: initial,
    save: vi.fn(async (c) => {
      s.data = { refresh_token: c.refresh_token, scope: c.scope, token_type: c.token_type };
    }),
    load: vi.fn(async () => s.data),
    remove: vi.fn(async () => {
      s.data = null;
    }),
  };
  return s;
}

/** 手動で結果を流し込めるループバックの偽物 */
function fakeLoopback() {
  const servers = [];
  const startLoopback = async ({ expectedState }) => {
    let resolve;
    let reject;
    const result = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const server = {
      expectedState,
      redirectUri: 'http://127.0.0.1:5555/callback',
      result,
      closed: false,
      close: () => {
        server.closed = true;
        reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      },
      deliver: (v) => resolve(v),
      timeout: () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })),
    };
    servers.push(server);
    return server;
  };
  return { startLoopback, servers };
}

function setup({ env = ENV, clientConfig, stored = null, google = createFakeGoogleOAuth(), openExternal, storage } = {}) {
  const clock = { t: 1_000_000 };
  const tokenStorage = storage ?? memoryStorage(stored);
  const loop = fakeLoopback();
  const opened = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const auth = createAuth({
    env,
    clientConfig,
    tokenStorage,
    fetch: google.fetch,
    openExternal: openExternal ?? (async (url) => void opened.push(url)),
    startLoopback: loop.startLoopback,
    log,
    now: () => clock.t,
  });
  const states = [];
  auth.events.on('change', (s) => states.push(s.status));
  return { auth, google, tokenStorage, loop, opened, log, clock, states };
}

/** link() を開始し、ブラウザが開かれるところまで進める */
async function startLink(ctx) {
  const done = ctx.auth.link();
  await vi.waitFor(() => expect(ctx.opened.length + (ctx.loop.servers[0]?.closed ? 1 : 0)).toBeGreaterThan(0));
  return done;
}
const authUrlParams = (ctx) => new URL(ctx.opened[0]).searchParams;

describe('未設定（.env なし・不正）', () => {
  it('unconfigured になり、link / init は何もしない', async () => {
    const ctx = setup({ env: {} });
    expect(ctx.auth.getState()).toMatchObject({ status: 'unconfigured', configProblem: 'missing_client_id' });
    await ctx.auth.init();
    await ctx.auth.link();
    expect(ctx.loop.servers).toHaveLength(0);
    expect(ctx.tokenStorage.load).not.toHaveBeenCalled();
    expect(ctx.auth.getState().status).toBe('unconfigured');
  });

  it('Secret のみ欠落', () => {
    const ctx = setup({ env: { GOOGLE_OAUTH_CLIENT_ID: FIXTURE.clientId } });
    expect(ctx.auth.getState().configProblem).toBe('missing_client_secret');
  });

  it('ログに Client Secret の値を出さない', () => {
    const ctx = setup({ env: { GOOGLE_OAUTH_CLIENT_ID: 'bad', GOOGLE_OAUTH_CLIENT_SECRET: 'super-secret-value' } });
    expect(JSON.stringify(ctx.log.warn.mock.calls)).not.toContain('super-secret-value');
  });
});

describe('起動時のサイレント更新（init）', () => {
  it('トークンなし → unlinked のまま、通信しない', async () => {
    const ctx = setup();
    await ctx.auth.init();
    expect(ctx.auth.getState().status).toBe('unlinked');
    expect(ctx.google.calls).toHaveLength(0);
  });

  it('保存済みトークンあり → checking → linked。アクセストークンを取得する', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    expect(ctx.states).toEqual(['checking', 'linked']);
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)[0].params).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: FIXTURE.refreshToken,
    });
    expect(await ctx.auth.getCredentials()).toMatchObject({
      refresh_token: FIXTURE.refreshToken,
      access_token: `${FIXTURE.accessToken}-refreshed`,
      token_type: 'Bearer',
    });
  });

  it('invalid_grant → トークンを削除して unlinked（lastError=expired）', async () => {
    const google = createFakeGoogleOAuth();
    google.validRefreshTokens.clear();
    const ctx = setup({ stored: storedCreds, google });
    await ctx.auth.init();
    expect(ctx.tokenStorage.remove).toHaveBeenCalled();
    expect(ctx.tokenStorage.data).toBeNull();
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'expired' });
  });

  it.each([
    ['ネットワークエラー', { network: true }],
    ['5xx', { status: 503, body: { error: 'backendError' } }],
    ['invalid_client 等の非 invalid_grant 4xx', { status: 401, body: { error: 'invalid_client' } }],
  ])('%s → トークンを保持し linked のまま', async (_name, failure) => {
    const ctx = setup({ stored: storedCreds });
    ctx.google.failNext(failure);
    await ctx.auth.init();
    expect(ctx.tokenStorage.remove).not.toHaveBeenCalled();
    expect(ctx.tokenStorage.data).toEqual(storedCreds);
    expect(ctx.auth.getState().status).toBe('linked');
  });

  it('一時障害の後でも getCredentials で再試行して回復する', async () => {
    const ctx = setup({ stored: storedCreds });
    ctx.google.failNext({ network: true });
    await ctx.auth.init();
    const c = await ctx.auth.getCredentials();
    expect(c.access_token).toBe(`${FIXTURE.accessToken}-refreshed`);
  });

  it('更新中に refresh_token がローテーションされたら保存し直す', async () => {
    const ctx = setup({ stored: storedCreds });
    ctx.google.rotateRefreshTokenTo('rotated-token');
    await ctx.auth.init();
    expect(ctx.tokenStorage.data.refresh_token).toBe('rotated-token');
  });

  it('トークン読み出しで例外が出ても reject せず、UI をブロックしない', async () => {
    const storage = memoryStorage();
    storage.load.mockRejectedValue(new Error('boom'));
    const ctx = setup({ storage });
    await expect(ctx.auth.init()).resolves.toBeUndefined();
    expect(ctx.auth.getState().status).toBe('unlinked');
  });
});

describe('連携フロー（link）', () => {
  it('成功：PKCE で交換し、暗号化保存して linked になる', async () => {
    const ctx = setup();
    const done = ctx.auth.link();
    expect(ctx.auth.getState().status).toBe('linking'); // 同期的に linking
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));

    const q = authUrlParams(ctx);
    expect(q.get('client_id')).toBe(FIXTURE.clientId);
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback');
    expect(q.get('scope')).toBe(SCOPES.join(' '));
    expect(q.get('state')).toBe(ctx.loop.servers[0].expectedState);

    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;

    const exchange = ctx.google.callsTo(TOKEN_ENDPOINT)[0].params;
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: FIXTURE.code, redirect_uri: 'http://127.0.0.1:5555/callback' });
    // 認可URLの code_challenge と、交換時の code_verifier が対応している
    expect(codeChallengeFromVerifier(exchange.code_verifier)).toBe(q.get('code_challenge'));

    expect(ctx.states).toEqual(['linking', 'linked']);
    expect(ctx.tokenStorage.save).toHaveBeenCalledTimes(1);
    expect(ctx.tokenStorage.data.refresh_token).toBe('new-refresh-token');
    expect(await ctx.auth.getCredentials()).toMatchObject({ refresh_token: 'new-refresh-token', access_token: FIXTURE.accessToken });
  });

  it('linking 中の再クリックや、linked 中の link() は無視される', async () => {
    const ctx = setup();
    const done = ctx.auth.link();
    await ctx.auth.link();
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));
    expect(ctx.loop.servers).toHaveLength(1);
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    await ctx.auth.link();
    expect(ctx.loop.servers).toHaveLength(1);
  });

  it('同意拒否 → unlinked（lastError=denied）', async () => {
    const ctx = setup();
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].deliver({ error: 'denied' });
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'denied' });
    expect(ctx.tokenStorage.save).not.toHaveBeenCalled();
  });

  it('タイムアウト → unlinked（lastError=timeout）', async () => {
    const ctx = setup();
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].timeout();
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'timeout' });
  });

  it('ブラウザを開けない → unlinked（lastError=browser_failed）、サーバーを閉じる', async () => {
    const ctx = setup({ openExternal: async () => Promise.reject(new Error('no browser')) });
    await ctx.auth.link();
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'browser_failed' });
    expect(ctx.loop.servers[0].closed).toBe(true);
  });

  it('スコープが不足（同意画面で一部を外された）→ 保存せず、取り消しを試み、scope_insufficient', async () => {
    const google = createFakeGoogleOAuth({ grantedScope: SCOPES.slice(0, 2).join(' ') });
    const ctx = setup({ google });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'scope_insufficient' });
    expect(ctx.tokenStorage.save).not.toHaveBeenCalled();
    expect(google.callsTo(REVOKE_ENDPOINT)).toHaveLength(1);
  });

  it('Client ID/Secret が Google に拒否された → invalid_client', async () => {
    const ctx = setup({ env: { ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: 'wrong-secret' } });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'invalid_client' });
  });

  it('交換時のネットワーク断 → network', async () => {
    const ctx = setup();
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.google.failNext({ network: true });
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'network' });
  });

  it('暗号化保存に失敗 → 連携済みにせず save_failed', async () => {
    const storage = memoryStorage();
    storage.save.mockRejectedValue(new Error('encryption unavailable'));
    const ctx = setup({ storage });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'save_failed' });
    expect(await ctx.auth.getCredentials()).toBeNull();
  });

  it('cancel：サーバーを閉じ、lastError なしで unlinked に戻る。遅れて届いた結果は無視される', async () => {
    const ctx = setup();
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.auth.cancel();
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.loop.servers[0].closed).toBe(true);
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: null });
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(0);
  });

  it('失敗後は再度 link できる', async () => {
    const ctx = setup();
    const first = startLink(ctx);
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(1));
    ctx.loop.servers[0].deliver({ error: 'denied' });
    await first;

    const second = ctx.auth.link();
    await vi.waitFor(() => expect(ctx.loop.servers).toHaveLength(2));
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(2));
    ctx.loop.servers[1].deliver({ code: FIXTURE.code });
    await second;
    expect(ctx.auth.getState().status).toBe('linked');
  });
});

describe('連携解除（unlink）', () => {
  it('Google 側を revoke し、ローカルのトークンを削除して unlinked', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    await ctx.auth.unlink();
    expect(ctx.google.callsTo(REVOKE_ENDPOINT)[0].params).toEqual({ token: FIXTURE.refreshToken });
    expect(ctx.tokenStorage.data).toBeNull();
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: null });
    expect(await ctx.auth.getCredentials()).toBeNull();
  });

  it('revoke が失敗（オフライン）してもローカル削除は必ず行う', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    ctx.google.setRevokeFails(true);
    await ctx.auth.unlink();
    expect(ctx.tokenStorage.data).toBeNull();
    expect(ctx.auth.getState().status).toBe('unlinked');
  });

  it('解除後に再連携できる', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    await ctx.auth.unlink();
    const done = ctx.auth.link();
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState().status).toBe('linked');
  });

  it('更新（checking）中に解除しても、古い更新結果で連携済みに戻らない', async () => {
    const ctx = setup({ stored: storedCreds });
    const release = ctx.google.hold();
    const init = ctx.auth.init();
    await vi.waitFor(() => expect(ctx.auth.getState().status).toBe('checking'));
    await ctx.auth.unlink();
    release();
    await init;
    expect(ctx.auth.getState().status).toBe('unlinked');
    expect(ctx.tokenStorage.data).toBeNull();
  });
});

describe('getCredentials（Phase 3/4 向け）', () => {
  it('未連携なら null', async () => {
    expect(await setup().auth.getCredentials()).toBeNull();
  });

  it('有効期限内は再取得しない。期限が近づくと更新する', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    const n = ctx.google.callsTo(TOKEN_ENDPOINT).length;
    await ctx.auth.getCredentials();
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(n);

    ctx.clock.t += 3540 * 1000; // 残り 59 秒 → マージン内
    await ctx.auth.getCredentials();
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(n + 1);
  });

  it('同時に呼んでも更新は1回（単一フライト）', async () => {
    const ctx = setup({ stored: storedCreds });
    const release = ctx.google.hold();
    const init = ctx.auth.init(); // 更新中のまま保留
    await vi.waitFor(() => expect(ctx.auth.getState().status).toBe('checking'));
    const all = Promise.all([ctx.auth.getCredentials(), ctx.auth.getCredentials(), ctx.auth.getCredentials()]);
    release();
    await all;
    await init;
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(1);
  });

  it('更新で invalid_grant になったら unlinked に戻る', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    ctx.google.validRefreshTokens.clear();
    ctx.clock.t += 7200 * 1000;
    expect(await ctx.auth.getCredentials()).toBeNull();
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'expired' });
  });

  it('setCredentials に渡せる snake_case のフィールドを返す', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    const c = await ctx.auth.getCredentials();
    expect(Object.keys(c).sort()).toEqual(['access_token', 'expiry_date', 'refresh_token', 'scope', 'token_type']);
    expect(c.expiry_date).toBe(ctx.clock.t + 3599 * 1000);
  });
});

describe('getAccessToken（Phase 4：アクセストークンだけを返す）', () => {
  it('未連携なら unlinked。通信しない', async () => {
    const ctx = setup();
    expect(await ctx.auth.getAccessToken()).toEqual({ ok: false, kind: 'unlinked' });
    expect(ctx.google.calls).toHaveLength(0);
  });

  it('連携済みならアクセストークン文字列だけを返す（refresh_token は含まない）', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    const res = await ctx.auth.getAccessToken();
    expect(res).toEqual({ ok: true, token: `${FIXTURE.accessToken}-refreshed` });
    expect(JSON.stringify(res)).not.toContain(FIXTURE.refreshToken);
  });

  it('有効期限内は再取得しない。期限が近づくと更新する', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    const n = ctx.google.callsTo(TOKEN_ENDPOINT).length;
    await ctx.auth.getAccessToken();
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(n);

    ctx.clock.t += 3540 * 1000; // 残り 59 秒 → マージン内
    await ctx.auth.getAccessToken();
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(n + 1);
  });

  it('同時に呼んでも更新は1回（getCredentials と同じ単一フライトを共有する）', async () => {
    const ctx = setup({ stored: storedCreds });
    const release = ctx.google.hold();
    const init = ctx.auth.init();
    await vi.waitFor(() => expect(ctx.auth.getState().status).toBe('checking'));
    const all = Promise.all([ctx.auth.getAccessToken(), ctx.auth.getAccessToken(), ctx.auth.getCredentials()]);
    release();
    const [a, b] = await all;
    await init;
    expect(a.ok && b.ok).toBe(true);
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(1);
  });

  it('更新に失敗したら、期限切れのトークンは返さず kind を伝える。トークンは保持し、次回回復する', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    ctx.clock.t += 7200 * 1000;
    ctx.google.failNext({ network: true });
    expect(await ctx.auth.getAccessToken()).toEqual({ ok: false, kind: 'network' });
    expect(ctx.auth.getState().status).toBe('linked');
    expect(ctx.tokenStorage.data).toEqual(storedCreds);

    expect(await ctx.auth.getAccessToken()).toMatchObject({ ok: true });
  });

  it('5xx は transient として伝える', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    ctx.clock.t += 7200 * 1000;
    ctx.google.failNext({ status: 503, body: { error: 'backendError' } });
    expect(await ctx.auth.getAccessToken()).toEqual({ ok: false, kind: 'transient' });
  });

  it('更新で invalid_grant になったら unlinked に戻り、unlinked として伝える', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    ctx.google.validRefreshTokens.clear();
    ctx.clock.t += 7200 * 1000;
    expect(await ctx.auth.getAccessToken()).toEqual({ ok: false, kind: 'unlinked' });
    expect(ctx.auth.getState()).toMatchObject({ status: 'unlinked', lastError: 'expired' });
  });
});

describe('invalidateAccessToken（API が 401 を返したとき）', () => {
  it('保持中のアクセストークンを捨て、次の getAccessToken で必ず更新する。refresh_token は残す', async () => {
    const ctx = setup({ stored: storedCreds });
    await ctx.auth.init();
    const n = ctx.google.callsTo(TOKEN_ENDPOINT).length;

    ctx.auth.invalidateAccessToken(); // 有効期限内でも更新させる
    expect(await ctx.auth.getAccessToken()).toMatchObject({ ok: true });
    expect(ctx.google.callsTo(TOKEN_ENDPOINT)).toHaveLength(n + 1);
    expect(ctx.google.callsTo(TOKEN_ENDPOINT).at(-1).params.refresh_token).toBe(FIXTURE.refreshToken);
  });

  it('未連携のときは何もしない', () => {
    expect(() => setup().auth.invalidateAccessToken()).not.toThrow();
  });
});

describe('configure（共有版：利用者が入力した Client ID/Secret への差し替え。2.4・v5.11）', () => {
  const USER_CLIENT = { ok: true, clientId: FIXTURE.clientId, clientSecret: FIXTURE.clientSecret };
  const MISSING = { ok: false, reason: 'missing_client_id' };

  it('初期値 clientConfig を渡すと .env を見ない（共有版は未設定から始まる）', () => {
    const ctx = setup({ env: ENV, clientConfig: MISSING });
    expect(ctx.auth.getState()).toMatchObject({ status: 'unconfigured', configProblem: 'missing_client_id' });
    expect(ctx.auth.canConfigure()).toBe(true);
  });

  it('未設定 → configure で unlinked になり、再起動なしで入力したクライアントで連携できる', async () => {
    const ctx = setup({ env: {}, clientConfig: MISSING });
    expect(ctx.auth.configure(USER_CLIENT)).toBe(true);
    expect(ctx.auth.getState()).toEqual({ status: 'unlinked', lastError: null });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));
    expect(authUrlParams(ctx).get('client_id')).toBe(FIXTURE.clientId);
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState().status).toBe('linked');
    // トークン交換にも入力した Client ID/Secret が使われた（偽の Google は一致しなければ invalid_client を返す）
    expect(ctx.google.calls.at(-1).params).toMatchObject({ client_id: FIXTURE.clientId, client_secret: FIXTURE.clientSecret });
  });

  it('誤ったクライアントを保存すると連携は invalid_client で失敗し、未連携に戻る', async () => {
    const ctx = setup({ env: {}, clientConfig: MISSING });
    ctx.auth.configure({ ok: true, clientId: FIXTURE.clientId, clientSecret: 'wrong-secret-value' });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    expect(ctx.auth.getState()).toEqual({ status: 'unlinked', lastError: 'invalid_client' });
  });

  it('削除（不正な設定）で unconfigured に戻り、連携は開始できない', async () => {
    const ctx = setup({ env: ENV });
    expect(ctx.auth.configure(MISSING)).toBe(true);
    expect(ctx.auth.getState()).toMatchObject({ status: 'unconfigured', configProblem: 'missing_client_id' });
    await ctx.auth.link();
    expect(ctx.loop.servers).toHaveLength(0);
  });

  it('連携中・同意フロー中・確認中は差し替えない（トークンは発行したクライアントに結び付く）', async () => {
    // 同意フロー中
    const ctx = setup({ env: ENV });
    const done = startLink(ctx);
    await vi.waitFor(() => expect(ctx.auth.getState().status).toBe('linking'));
    expect(ctx.auth.canConfigure()).toBe(false);
    expect(ctx.auth.configure(MISSING)).toBe(false);
    expect(ctx.auth.getState().status).toBe('linking');
    ctx.loop.servers[0].deliver({ code: FIXTURE.code });
    await done;
    // 連携中
    expect(ctx.auth.getState().status).toBe('linked');
    expect(ctx.auth.canConfigure()).toBe(false);
    expect(ctx.auth.configure(MISSING)).toBe(false);
    expect(ctx.auth.getState().status).toBe('linked');
    // 連携解除すれば差し替えられる
    await ctx.auth.unlink();
    expect(ctx.auth.canConfigure()).toBe(true);
    expect(ctx.auth.configure(MISSING)).toBe(true);
  });

  it('起動時の確認中（checking）も差し替えない', async () => {
    const google = createFakeGoogleOAuth();
    const ctx = setup({ stored: storedCreds, google });
    const release = google.hold();
    const init = ctx.auth.init();
    await vi.waitFor(() => expect(ctx.auth.getState().status).toBe('checking'));
    expect(ctx.auth.canConfigure()).toBe(false);
    expect(ctx.auth.configure(MISSING)).toBe(false);
    release();
    await init;
    expect(ctx.auth.getState().status).toBe('linked');
  });
});
