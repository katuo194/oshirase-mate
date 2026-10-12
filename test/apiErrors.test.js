import { describe, expect, it } from 'vitest';
import { GoogleApiError, KINDS, authUnavailableError, classifyGoogleError, parseRetryAfter } from '../src/main/apiErrors.js';

/** GaxiosError 相当（status / response.data.error.errors[0].reason / response.headers）。 */
function apiError(status, { reason, headers, message = 'request failed' } = {}) {
  return Object.assign(new Error(message), {
    status,
    config: { headers: { Authorization: 'Bearer SECRET-ACCESS-TOKEN' } },
    response: {
      status,
      headers: headers ?? {},
      data: { error: { code: status, errors: reason ? [{ reason }] : [] } },
    },
  });
}

describe('classifyGoogleError / HTTPステータスの分類', () => {
  it('401 → unauthorized（再取得すれば回復し得る。オフラインではない）', () => {
    const e = classifyGoogleError(apiError(401), { api: 'calendar.events.list' });
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e).toMatchObject({ kind: KINDS.UNAUTHORIZED, status: 401, api: 'calendar.events.list', retryable: true, offlineCandidate: false });
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded'])(
    '403 + reason=%s → quota',
    (reason) => {
      expect(classifyGoogleError(apiError(403, { reason }))).toMatchObject({ kind: KINDS.QUOTA, reason, retryable: true, offlineCandidate: false });
    },
  );

  it.each(['accessNotConfigured', 'insufficientPermissions', 'forbidden'])(
    '403 + reason=%s → forbidden（バックオフしても直らない）',
    (reason) => {
      expect(classifyGoogleError(apiError(403, { reason }))).toMatchObject({ kind: KINDS.FORBIDDEN, reason, retryable: false });
    },
  );

  it('403 で reason が無い場合は forbidden', () => {
    expect(classifyGoogleError(apiError(403)).kind).toBe(KINDS.FORBIDDEN);
  });

  it('429 → rate_limited。Retry-After（秒）をミリ秒で保持する', () => {
    const e = classifyGoogleError(apiError(429, { headers: { 'retry-after': '30' } }));
    expect(e).toMatchObject({ kind: KINDS.RATE_LIMITED, status: 429, retryAfterMs: 30_000, retryable: true, offlineCandidate: false });
  });

  it('Retry-After は Headers インスタンスでも読める', () => {
    const e = classifyGoogleError(apiError(429, { headers: new Headers({ 'Retry-After': '5' }) }));
    expect(e.retryAfterMs).toBe(5000);
  });

  it('Retry-After が無ければ null', () => {
    expect(classifyGoogleError(apiError(429)).retryAfterMs).toBeNull();
  });

  it.each([500, 502, 503])('%i → server（オフラインの兆候として数える）', (status) => {
    expect(classifyGoogleError(apiError(status))).toMatchObject({ kind: KINDS.SERVER, status, retryable: true, offlineCandidate: true });
  });

  it('その他の4xx → unknown', () => {
    expect(classifyGoogleError(apiError(404))).toMatchObject({ kind: KINDS.UNKNOWN, status: 404, retryable: false });
  });
});

describe('classifyGoogleError / ネットワークエラー', () => {
  it.each(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'])('code=%s → network', (code) => {
    const e = classifyGoogleError(Object.assign(new Error('boom'), { code }));
    expect(e).toMatchObject({ kind: KINDS.NETWORK, status: null, retryable: true, offlineCandidate: true });
  });

  it('cause に code がある fetch 失敗も network', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
    expect(classifyGoogleError(err).kind).toBe(KINDS.NETWORK);
  });

  it('タイムアウト（TimeoutError）も network', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    expect(classifyGoogleError(err).kind).toBe(KINDS.NETWORK);
  });

  it.each(['net::ERR_INTERNET_DISCONNECTED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_PROXY_CONNECTION_FAILED'])(
    'Electron net.fetch の接続失敗（%s）も network',
    (message) => {
      const err = new Error(message, { cause: new Error(message) });
      expect(classifyGoogleError(err)).toMatchObject({ kind: KINDS.NETWORK, offlineCandidate: true });
    },
  );

  it('分類できないものは unknown', () => {
    expect(classifyGoogleError(new Error('something odd'))).toMatchObject({ kind: KINDS.UNKNOWN, offlineCandidate: false });
    expect(classifyGoogleError(undefined).kind).toBe(KINDS.UNKNOWN);
  });
});

describe('classifyGoogleError / 情報の扱い', () => {
  it('アクセストークンを含む生のエラー（config）を保持しない', () => {
    const e = classifyGoogleError(apiError(401));
    expect(JSON.stringify(e)).not.toContain('SECRET-ACCESS-TOKEN');
    expect(e.message).not.toContain('SECRET-ACCESS-TOKEN');
    expect(e.config).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });

  it('メッセージの先頭に kind と status が入る（scheduler の既存ログだけで種別が読める）', () => {
    const e = classifyGoogleError(apiError(403, { reason: 'quotaExceeded' }), { api: 'gmail.users.messages.list' });
    expect(e.message).toMatch(/^quota 403 quotaExceeded \(gmail\.users\.messages\.list\)/);
  });

  it('分類済みの GoogleApiError はそのまま返す', () => {
    const e = classifyGoogleError(apiError(401));
    expect(classifyGoogleError(e)).toBe(e);
  });
});

describe('parseRetryAfter', () => {
  it('秒数・HTTP日付・不正値', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('authUnavailableError', () => {
  it('トークン更新のネットワーク断・一時障害はオフラインの兆候として数える', () => {
    expect(authUnavailableError('network')).toMatchObject({ kind: KINDS.AUTH_UNAVAILABLE, offlineCandidate: true, retryable: true });
    expect(authUnavailableError('transient').offlineCandidate).toBe(true);
  });

  it('未連携・invalid_client などは数えない。元の kind は detail に残る', () => {
    const e = authUnavailableError('invalid_client', { api: 'calendar.events.list' });
    expect(e.offlineCandidate).toBe(false);
    expect(e.message).toContain('invalid_client');
  });
});
