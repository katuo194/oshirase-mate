// Google API 呼び出しの失敗を種別に分類する（純粋関数。Electron・googleapis に依存しない）。
//
// scheduler.js の 'failed' イベントの error にこの GoogleApiError がそのまま載る。
// Phase 6 のオフライン判定（F-14）とバックオフは kind / retryable / offlineCandidate だけを見て分岐できる。
//
// 生のエラーは保持しない。GaxiosError は config に Authorization ヘッダ（アクセストークン）を含むため、
// ログや inspect 経由で漏れないよう、必要な情報だけを取り出した新しいエラーにする。

export const KINDS = Object.freeze({
  UNAUTHORIZED: 'unauthorized', // 401：アクセストークンが無効
  QUOTA: 'quota', // 403：クォータ・レート超過
  FORBIDDEN: 'forbidden', // 403：API未有効化・スコープ不足など。バックオフしても直らない
  RATE_LIMITED: 'rate_limited', // 429
  SERVER: 'server', // 5xx
  NETWORK: 'network', // 接続失敗・タイムアウト
  AUTH_UNAVAILABLE: 'auth_unavailable', // アクセストークンを用意できなかった（auth.getAccessToken が ok:false）
  UNKNOWN: 'unknown',
});

/** 403 の reason のうち、クォータ・レート超過を表すもの。 */
const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'TimeoutError',
  'AbortError',
]);

// retryable：時間を置けば成功し得るか。offlineCandidate：F-14「接続失敗の連続」に数えるべきか。
const TRAITS = Object.freeze({
  [KINDS.UNAUTHORIZED]: { retryable: true, offlineCandidate: false },
  [KINDS.QUOTA]: { retryable: true, offlineCandidate: false },
  [KINDS.FORBIDDEN]: { retryable: false, offlineCandidate: false },
  [KINDS.RATE_LIMITED]: { retryable: true, offlineCandidate: false },
  [KINDS.SERVER]: { retryable: true, offlineCandidate: true },
  [KINDS.NETWORK]: { retryable: true, offlineCandidate: true },
  [KINDS.AUTH_UNAVAILABLE]: { retryable: true, offlineCandidate: false },
  [KINDS.UNKNOWN]: { retryable: false, offlineCandidate: false },
});

export class GoogleApiError extends Error {
  /**
   * @param {object} p
   * @param {string} p.kind KINDS のいずれか
   * @param {string} [p.api] 'calendar.events.list' など
   * @param {number|null} [p.status] HTTPステータス
   * @param {string|null} [p.reason] Google が返した reason（403の切り分けに使う）
   * @param {number|null} [p.retryAfterMs] Retry-After ヘッダ（あれば）
   * @param {string|null} [p.detail] 元のメッセージ（トークンを含み得る情報は入れない）
   * @param {boolean} [p.offlineCandidate] 既定の判定を上書きする（auth_unavailable の内訳用）
   */
  constructor({ kind, api = null, status = null, reason = null, retryAfterMs = null, detail = null, offlineCandidate }) {
    const head = [kind, status, reason].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
    super(`${head}${api ? ` (${api})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'GoogleApiError';
    this.kind = kind;
    this.api = api;
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
    const traits = TRAITS[kind] ?? TRAITS[KINDS.UNKNOWN];
    this.retryable = traits.retryable;
    this.offlineCandidate = offlineCandidate ?? traits.offlineCandidate;
  }
}

/** Headers インスタンスにもプレーンオブジェクトにも対応する。 */
function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/** Retry-After は秒数または HTTP 日付。ミリ秒にして返す。 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** 403 のレスポンス本文から reason を取り出す（Calendar/Tasks/Gmail は同じ error.errors[] 形式）。 */
function reasonOf(err) {
  const body = err?.response?.data?.error;
  return body?.errors?.[0]?.reason ?? body?.details?.[0]?.reason ?? body?.status ?? null;
}

function statusOf(err) {
  const s = err?.status ?? err?.response?.status;
  if (Number.isInteger(s)) return s;
  // 古い gaxios では code に数値ステータスが入る
  const c = Number(err?.code);
  return Number.isInteger(c) && c >= 100 && c < 600 ? c : null;
}

/**
 * 任意の例外を GoogleApiError にする。すでに GoogleApiError ならそのまま返す。
 * @param {unknown} err
 * @param {{ api?: string, now?: number }} [ctx]
 */
export function classifyGoogleError(err, { api = null, now = Date.now() } = {}) {
  if (err instanceof GoogleApiError) return err;

  const status = statusOf(err);
  const reason = status === null ? null : reasonOf(err);
  const detail = typeof err?.message === 'string' ? err.message.slice(0, 200) : null;
  const make = (kind, extra = {}) => new GoogleApiError({ kind, api, status, reason, detail, ...extra });

  if (status === 401) return make(KINDS.UNAUTHORIZED);
  if (status === 403) return make(QUOTA_REASONS.has(reason) ? KINDS.QUOTA : KINDS.FORBIDDEN);
  if (status === 429) {
    return make(KINDS.RATE_LIMITED, { retryAfterMs: parseRetryAfter(headerOf(err?.response?.headers, 'retry-after'), now) });
  }
  if (status !== null && status >= 500) return make(KINDS.SERVER);
  if (status !== null) return make(KINDS.UNKNOWN);

  const code = typeof err?.code === 'string' ? err.code : typeof err?.cause?.code === 'string' ? err.cause.code : null;
  if ((code && NETWORK_CODES.has(code)) || err?.name === 'TimeoutError' || /fetch failed|network|socket hang up|net::ERR_/i.test(detail ?? '')) {
    return make(KINDS.NETWORK);
  }
  return make(KINDS.UNKNOWN);
}

/**
 * auth.getAccessToken() の失敗（{ ok:false, kind }）を GoogleApiError にする。
 * kind は auth 側の値（network / transient / invalid_client / other / unlinked など）をそのまま detail に残す。
 */
export function authUnavailableError(authKind, { api = null } = {}) {
  return new GoogleApiError({
    kind: KINDS.AUTH_UNAVAILABLE,
    api,
    detail: `access token unavailable (${authKind})`,
    // 更新時のネットワーク断・5xx はオフラインの兆候として数える
    offlineCandidate: authKind === 'network' || authKind === 'transient',
  });
}
