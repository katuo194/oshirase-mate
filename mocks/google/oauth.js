// Google OAuth エンドポイント（token / revoke）のスタブ。ネットワークには一切出ない。
// createFakeGoogleOAuth().fetch を auth.js の fetch として注入して使う。

import { REVOKE_ENDPOINT, SCOPES, TOKEN_ENDPOINT } from '../../src/main/authCore.js';

export const FIXTURE = Object.freeze({
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  code: 'valid-auth-code',
  refreshToken: 'stored-refresh-token',
  accessToken: 'fake-access-token',
  scope: SCOPES.join(' '),
});

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * @param {object} [opts]
 * @param {string} [opts.grantedScope] 交換・更新で返す scope（スコープ不足のテスト用に差し替える）
 */
export function createFakeGoogleOAuth({ grantedScope = FIXTURE.scope } = {}) {
  /** リクエスト記録 [{ url, params }] */
  const calls = [];
  /** 有効なリフレッシュトークン。ここに無いものは invalid_grant */
  const validRefreshTokens = new Set([FIXTURE.refreshToken, 'new-refresh-token']);
  /** 次のトークンエンドポイント呼び出しだけ失敗させる: { network: true } | { status, body } */
  let nextFailure = null;
  let revokeFails = false;
  let rotateRefreshTokenTo = null;
  let gate = null; // 次のトークンエンドポイント呼び出しを release() まで待たせる（通信中の状態を観測するテスト用）

  async function fetch(url, init = {}) {
    const params = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    calls.push({ url: String(url), params });

    if (String(url) === REVOKE_ENDPOINT) {
      if (revokeFails) throw new TypeError('network down');
      return json(200, {});
    }
    if (String(url) !== TOKEN_ENDPOINT) return json(404, {});

    if (gate) {
      const g = gate;
      gate = null;
      await g;
    }
    if (nextFailure) {
      const f = nextFailure;
      nextFailure = null;
      if (f.network) throw new TypeError('network down');
      return json(f.status, f.body ?? null);
    }
    if (params.client_id !== FIXTURE.clientId || params.client_secret !== FIXTURE.clientSecret) {
      return json(401, { error: 'invalid_client' });
    }

    if (params.grant_type === 'authorization_code') {
      if (params.code !== FIXTURE.code || !params.code_verifier || !params.redirect_uri) {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, {
        access_token: FIXTURE.accessToken,
        expires_in: 3599,
        refresh_token: 'new-refresh-token',
        scope: grantedScope,
        token_type: 'Bearer',
      });
    }
    if (params.grant_type === 'refresh_token') {
      if (!validRefreshTokens.has(params.refresh_token)) {
        return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      return json(200, {
        access_token: `${FIXTURE.accessToken}-refreshed`,
        expires_in: 3599,
        scope: grantedScope,
        token_type: 'Bearer',
        ...(rotateRefreshTokenTo ? { refresh_token: rotateRefreshTokenTo } : {}),
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  return {
    fetch,
    calls,
    validRefreshTokens,
    failNext: (f) => {
      nextFailure = f;
    },
    /** 次のトークン呼び出しを保留する。返る関数を呼ぶと再開する */
    hold: () => {
      let release;
      gate = new Promise((r) => {
        release = r;
      });
      return release;
    },
    setRevokeFails: (v) => {
      revokeFails = v;
    },
    rotateRefreshTokenTo: (t) => {
      rotateRefreshTokenTo = t;
      validRefreshTokens.add(t);
    },
    callsTo: (url) => calls.filter((c) => c.url === url),
  };
}
