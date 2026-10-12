import { describe, expect, it } from 'vitest';
import {
  AUTH_ENDPOINT,
  REVOKE_ENDPOINT,
  SCOPES,
  TOKEN_ENDPOINT,
  buildAuthUrl,
  buildRefreshRequest,
  buildRevokeRequest,
  buildTokenExchangeRequest,
  codeChallengeFromVerifier,
  generateCodeVerifier,
  generateState,
  hasAllScopes,
  interpretTokenResponse,
  parseCallback,
  validateOAuthClient,
  validateOAuthEnv,
} from '../src/main/authCore.js';

const bodyOf = (req) => Object.fromEntries(new URLSearchParams(req.init.body));

describe('PKCE', () => {
  it('code_verifier は RFC 7636 の長さ・文字種を満たし、毎回異なる', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(generateCodeVerifier()).not.toBe(v);
  });

  it('code_challenge は RFC 7636 付録B のテストベクトルと一致する', () => {
    expect(codeChallengeFromVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('state は base64url の十分な長さ', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('buildAuthUrl', () => {
  const url = new URL(
    buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555/callback', codeChallenge: 'chal', state: 'st' }),
  );
  const q = url.searchParams;

  it('Google の認可エンドポイントを指す', () => {
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_ENDPOINT);
  });

  it('PKCE(S256)・offline・consent と必須パラメータを含む', () => {
    expect(Object.fromEntries(q)).toEqual({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 'st',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('スコープは読み取り専用の3つだけ', () => {
    expect(SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/tasks.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
    ]);
  });
});

describe('トークンリクエストの組み立て', () => {
  it('コード交換', () => {
    const req = buildTokenExchangeRequest({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'CODE',
      codeVerifier: 'VER',
      redirectUri: 'http://127.0.0.1:5555/callback',
    });
    expect(req.url).toBe(TOKEN_ENDPOINT);
    expect(req.init.method).toBe('POST');
    expect(req.init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(bodyOf(req)).toEqual({
      grant_type: 'authorization_code',
      code: 'CODE',
      code_verifier: 'VER',
      redirect_uri: 'http://127.0.0.1:5555/callback',
      client_id: 'cid',
      client_secret: 'sec',
    });
  });

  it('リフレッシュ', () => {
    const req = buildRefreshRequest({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'RT' });
    expect(req.url).toBe(TOKEN_ENDPOINT);
    expect(bodyOf(req)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'cid', client_secret: 'sec' });
  });

  it('revoke', () => {
    const req = buildRevokeRequest('RT');
    expect(req.url).toBe(REVOKE_ENDPOINT);
    expect(bodyOf(req)).toEqual({ token: 'RT' });
  });
});

describe('interpretTokenResponse', () => {
  it('成功レスポンスを正規化する', () => {
    const r = interpretTokenResponse({
      status: 200,
      body: { access_token: 'AT', expires_in: 3599, refresh_token: 'RT', scope: 'a b', token_type: 'Bearer' },
    });
    expect(r).toEqual({
      ok: true,
      tokens: { access_token: 'AT', expires_in: 3599, refresh_token: 'RT', scope: 'a b', token_type: 'Bearer' },
    });
  });

  it('refresh_token が無い成功レスポンス（リフレッシュ時）は undefined', () => {
    const r = interpretTokenResponse({ status: 200, body: { access_token: 'AT', expires_in: 10 } });
    expect(r.ok && r.tokens.refresh_token).toBeUndefined();
  });

  it.each([
    [400, { error: 'invalid_grant' }, 'invalid_grant'],
    [401, { error: 'invalid_client' }, 'invalid_client'],
    [401, { error: 'unauthorized_client' }, 'invalid_client'],
    [400, { error: 'invalid_request' }, 'other'],
    [500, null, 'transient'],
    [503, { error: 'backendError' }, 'transient'],
    [429, { error: 'rate_limit' }, 'transient'],
    [200, null, 'transient'], // 本文が読めない
  ])('status=%i body=%j → %s', (status, body, kind) => {
    expect(interpretTokenResponse({ status, body })).toEqual({ ok: false, kind });
  });

  it('invalid_grant は 5xx のときは transient 扱い（5xx で保存トークンを消さない）', () => {
    expect(interpretTokenResponse({ status: 500, body: { error: 'invalid_grant' } })).toEqual({ ok: false, kind: 'transient' });
  });
});

describe('hasAllScopes', () => {
  it('3つ揃っていれば true（順不同・余分なスコープは許容）', () => {
    expect(hasAllScopes([...SCOPES].reverse().concat('openid').join(' '))).toBe(true);
  });
  it('1つでも欠ければ false', () => {
    expect(hasAllScopes(SCOPES.slice(0, 2).join(' '))).toBe(false);
    expect(hasAllScopes('')).toBe(false);
    expect(hasAllScopes(undefined)).toBe(false);
  });
});

describe('parseCallback', () => {
  const p = (s) => new URLSearchParams(s);
  it('state 一致・code あり → ok', () => {
    expect(parseCallback(p('code=C&state=S'), 'S')).toEqual({ ok: true, code: 'C' });
  });
  it('state 不一致・欠落 → invalid', () => {
    expect(parseCallback(p('code=C&state=X'), 'S')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCallback(p('code=C'), 'S')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCallback(p('code=C&state=SS'), 'S')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('error=access_denied → denied', () => {
    expect(parseCallback(p('error=access_denied&state=S'), 'S')).toEqual({ ok: false, reason: 'denied' });
  });
  it('その他の error / code 欠落 → error', () => {
    expect(parseCallback(p('error=server_error&state=S'), 'S')).toEqual({ ok: false, reason: 'error' });
    expect(parseCallback(p('state=S'), 'S')).toEqual({ ok: false, reason: 'error' });
  });
  it('state が不正なら error パラメータがあっても invalid（偽造で拒否扱いにされない）', () => {
    expect(parseCallback(p('error=access_denied&state=X'), 'S')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('validateOAuthEnv', () => {
  const ID = 'abc-123.apps.googleusercontent.com';
  it('正しい値 → ok（前後の空白は除去）', () => {
    expect(validateOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: ` ${ID} `, GOOGLE_OAUTH_CLIENT_SECRET: ' sec ' })).toEqual({
      ok: true,
      clientId: ID,
      clientSecret: 'sec',
    });
  });
  it('未設定・空白のみ', () => {
    expect(validateOAuthEnv({})).toEqual({ ok: false, reason: 'missing_client_id' });
    expect(validateOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: '   ', GOOGLE_OAUTH_CLIENT_SECRET: 's' })).toEqual({
      ok: false,
      reason: 'missing_client_id',
    });
    expect(validateOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: ID })).toEqual({ ok: false, reason: 'missing_client_secret' });
  });
  it('Client ID の形式不正', () => {
    expect(validateOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: 'not-a-client-id', GOOGLE_OAUTH_CLIENT_SECRET: 's' })).toEqual({
      ok: false,
      reason: 'invalid_client_id',
    });
  });
});

describe('validateOAuthClient（共有版の設定画面の入力。2.4・3.6）', () => {
  const ID = 'abc-123.apps.googleusercontent.com';
  const SECRET = 'GOCSPX-abcdefghijklmnop_QRSTUV';

  it('正しい値 → ok（前後の空白・改行は除去）', () => {
    expect(validateOAuthClient({ clientId: ` ${ID}\n`, clientSecret: `\t${SECRET} ` })).toEqual({ ok: true, clientId: ID, clientSecret: SECRET });
  });

  it('空・空白のみ・未指定・文字列以外は missing（ID を先に見る）', () => {
    expect(validateOAuthClient({ clientId: '', clientSecret: '' })).toEqual({ ok: false, reason: 'missing_client_id' });
    expect(validateOAuthClient({ clientId: '   ', clientSecret: SECRET })).toEqual({ ok: false, reason: 'missing_client_id' });
    expect(validateOAuthClient({ clientId: ID, clientSecret: '  ' })).toEqual({ ok: false, reason: 'missing_client_secret' });
    expect(validateOAuthClient({ clientId: ID })).toEqual({ ok: false, reason: 'missing_client_secret' });
    expect(validateOAuthClient({ clientId: 123, clientSecret: SECRET })).toEqual({ ok: false, reason: 'missing_client_id' });
    for (const input of [undefined, null, 'x', 1]) expect(validateOAuthClient(input)).toEqual({ ok: false, reason: 'missing_client_id' });
  });

  it('Client ID の形式違い', () => {
    for (const clientId of ['not-a-client-id', `${ID}x`, 'abc.apps.googleusercontent.com.evil', 'abc def.apps.googleusercontent.com', SECRET]) {
      expect(validateOAuthClient({ clientId, clientSecret: SECRET })).toEqual({ ok: false, reason: 'invalid_client_id' });
    }
  });

  it('ID欄とSecret欄の取り違え（Secret 欄に Client ID の形式）は swapped', () => {
    expect(validateOAuthClient({ clientId: SECRET, clientSecret: ID })).toEqual({ ok: false, reason: 'swapped' });
    expect(validateOAuthClient({ clientId: ID, clientSecret: ID })).toEqual({ ok: false, reason: 'swapped' });
  });

  it('Secret の文字種（空白・全角・制御文字）と長さ（8〜256）', () => {
    for (const clientSecret of ['short12', 'has space-inside', 'ＧＯＣＳＰＸ－ａｂｃｄｅｆｇｈ', 'abc\u0000defghij', 'x'.repeat(257)]) {
      expect(validateOAuthClient({ clientId: ID, clientSecret })).toEqual({ ok: false, reason: 'invalid_client_secret' });
    }
    expect(validateOAuthClient({ clientId: ID, clientSecret: 'x'.repeat(8) }).ok).toBe(true);
    expect(validateOAuthClient({ clientId: ID, clientSecret: 'x'.repeat(256) }).ok).toBe(true);
  });

  it('エラーに値そのものを含めない', () => {
    const r = validateOAuthClient({ clientId: ID, clientSecret: 'bad secret value' });
    expect(JSON.stringify(r)).not.toContain('bad secret value');
    expect(JSON.stringify(r)).not.toContain(ID);
  });

  it('.env の検証（validateOAuthEnv）は従来どおり緩いまま（個人版の既存の .env を壊さない）', () => {
    expect(validateOAuthEnv({ GOOGLE_OAUTH_CLIENT_ID: ID, GOOGLE_OAUTH_CLIENT_SECRET: 'sec' }).ok).toBe(true);
  });
});
