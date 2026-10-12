// OAuth 2.0 Loopback + PKCE の純粋ロジック（2.3）。Electron・ネットワークに依存しない（Vitest で直接テストする）。
// 実際の fetch / ブラウザ起動 / サーバー受信は auth.js 側から注入する。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
]);

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const ENV_CLIENT_ID = 'GOOGLE_OAUTH_CLIENT_ID';
export const ENV_CLIENT_SECRET = 'GOOGLE_OAUTH_CLIENT_SECRET';

const base64url = (buf) => buf.toString('base64url');

/** PKCE code_verifier（RFC 7636）。32バイト乱数 → 43文字の base64url。 */
export function generateCodeVerifier(random = randomBytes) {
  return base64url(random(32));
}

/** code_challenge = BASE64URL(SHA256(code_verifier))（method=S256）。 */
export function codeChallengeFromVerifier(verifier) {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** CSRF対策の state。 */
export function generateState(random = randomBytes) {
  return base64url(random(32));
}

/** 認可URL。refresh_token を確実に得るため access_type=offline と prompt=consent を付ける。 */
export function buildAuthUrl({ clientId, redirectUri, codeChallenge, state }) {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

const formPost = (url, params) => ({
  url,
  init: {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  },
});

/** 認可コード → トークン交換のリクエスト。デスクトップアプリ型でも Google は client_secret を要求する。 */
export function buildTokenExchangeRequest({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  return formPost(TOKEN_ENDPOINT, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

/** リフレッシュトークン → アクセストークン再取得のリクエスト。 */
export function buildRefreshRequest({ clientId, clientSecret, refreshToken }) {
  return formPost(TOKEN_ENDPOINT, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

/** 連携解除時の revoke リクエスト。 */
export function buildRevokeRequest(token) {
  return formPost(REVOKE_ENDPOINT, { token });
}

/**
 * トークンエンドポイントのレスポンスを解釈する。
 * 失敗の種類：
 *  - invalid_grant  … リフレッシュトークンが失効・取り消し済み（保存トークンを破棄してよい唯一のケース）
 *  - invalid_client … Client ID/Secret が Google に拒否された（設定不備。トークンは破棄しない）
 *  - transient      … 5xx / 429 / 本文が読めない（一時的な障害。トークンは保持する）
 *  - other          … 上記以外の 4xx
 * ネットワーク断（fetch が throw）は呼び出し側で { ok:false, kind:'network' } とする。
 * @param {{ status: number, body: any }} res body はパース済み JSON（読めなければ null）
 */
export function interpretTokenResponse({ status, body }) {
  if (status >= 200 && status < 300 && body && typeof body.access_token === 'string') {
    const expiresIn = Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    return {
      ok: true,
      tokens: {
        access_token: body.access_token,
        expires_in: expiresIn,
        refresh_token: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : undefined,
        scope: typeof body.scope === 'string' ? body.scope : '',
        token_type: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
      },
    };
  }
  if (status >= 500 || status === 429 || (status >= 200 && status < 300)) return { ok: false, kind: 'transient' };
  const code = body && typeof body.error === 'string' ? body.error : '';
  if (code === 'invalid_grant') return { ok: false, kind: 'invalid_grant' };
  if (code === 'invalid_client' || code === 'unauthorized_client') return { ok: false, kind: 'invalid_client' };
  return { ok: false, kind: 'other' };
}

/** スコープ文字列に必要な3スコープがすべて含まれるか（同意画面で一部を外された場合の検出）。 */
export function hasAllScopes(scopeString) {
  const granted = new Set(String(scopeString ?? '').split(/\s+/).filter(Boolean));
  return SCOPES.every((s) => granted.has(s));
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * ループバックへのコールバックを解釈する。
 *  - ok:true, code        … 正常
 *  - reason:'invalid'     … state 不一致・欠落（偽造や別フローの可能性。フローは継続してよい）
 *  - reason:'denied'      … ユーザーが同意を拒否（error=access_denied）
 *  - reason:'error'       … その他の error / code 欠落
 * @param {URLSearchParams} params
 */
export function parseCallback(params, expectedState) {
  const state = params.get('state');
  if (!state || !safeEqual(state, expectedState)) return { ok: false, reason: 'invalid' };
  const error = params.get('error');
  if (error) return { ok: false, reason: error === 'access_denied' ? 'denied' : 'error' };
  const code = params.get('code');
  if (!code) return { ok: false, reason: 'error' };
  return { ok: true, code };
}

/**
 * .env 由来の Client ID/Secret を検証する。値そのものはエラーに含めない。
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, clientId: string, clientSecret: string } | { ok: false, reason: 'missing_client_id' | 'missing_client_secret' | 'invalid_client_id' }}
 */
export function validateOAuthEnv(env) {
  const clientId = (env[ENV_CLIENT_ID] ?? '').trim();
  const clientSecret = (env[ENV_CLIENT_SECRET] ?? '').trim();
  if (!clientId) return { ok: false, reason: 'missing_client_id' };
  if (!isClientIdFormat(clientId)) return { ok: false, reason: 'invalid_client_id' };
  if (!clientSecret) return { ok: false, reason: 'missing_client_secret' };
  return { ok: true, clientId, clientSecret };
}

const isClientIdFormat = (v) => /^[\w-]+(\.[\w-]+)*\.apps\.googleusercontent\.com$/.test(v);

/** 利用者が入力する Client Secret の長さの範囲（Google の Secret は35文字前後）。明らかな誤入力だけを弾く */
export const CLIENT_SECRET_MIN_LENGTH = 8;
export const CLIENT_SECRET_MAX_LENGTH = 256;

/**
 * 共有版で利用者が設定画面に入力した Client ID/Secret の検証（2.4・3.6。v5.11）。前後の空白は取り除く。値そのものは理由に含めない。
 * .env（validateOAuthEnv）より厳しく、Secret の文字種・長さと、ID欄／Secret欄の取り違えも見る。
 * @param {{ clientId?: unknown, clientSecret?: unknown }} input
 * @returns {{ ok: true, clientId: string, clientSecret: string } |
 *   { ok: false, reason: 'missing_client_id' | 'missing_client_secret' | 'swapped' | 'invalid_client_id' | 'invalid_client_secret' }}
 */
export function validateOAuthClient(input) {
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
  if (!clientId) return { ok: false, reason: 'missing_client_id' };
  if (!clientSecret) return { ok: false, reason: 'missing_client_secret' };
  // Secret 欄に Client ID の形式の値がある（ID を2回貼った／欄を逆にした）
  if (isClientIdFormat(clientSecret)) return { ok: false, reason: 'swapped' };
  if (!isClientIdFormat(clientId)) return { ok: false, reason: 'invalid_client_id' };
  if (
    !/^[\x21-\x7e]+$/.test(clientSecret) ||
    clientSecret.length < CLIENT_SECRET_MIN_LENGTH ||
    clientSecret.length > CLIENT_SECRET_MAX_LENGTH
  ) {
    return { ok: false, reason: 'invalid_client_secret' };
  }
  return { ok: true, clientId, clientSecret };
}
