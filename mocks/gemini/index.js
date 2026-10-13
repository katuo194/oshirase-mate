// Gemini API（generateContent）のスタブ。ネットワークには一切出ない。
// geminiClient.js に fetch として注入する（mocks/voicevox と同じ「呼び出し記録・失敗注入」の構え）。
//
//   const gm = createFakeGemini({ replies: ['やあ'] });
//   const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => 'KEY' });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 接続できない（オフライン）ときと同じ形の例外。 */
function networkFailure() {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'), { code: 'ENOTFOUND' });
  return err;
}

const abortError = (signal) => signal?.reason ?? new DOMException('aborted', 'AbortError');

/**
 * @param {object} [opts]
 * @param {string[]} [opts.replies] 呼び出しごとの応答（尽きたら最後のものを繰り返す）
 */
export function createFakeGemini({ replies = ['こんにちは。今日もいい天気だね。'] } = {}) {
  /** [{ url, method, headers, body }] */
  const calls = [];
  /** 次の1回だけの挙動（先頭から消費）。{ type: 'http'|'network'|'block'|'empty'|'hang'|'truncated', ... } */
  const queue = [];
  let replyIndex = 0;

  async function fetch(url, init = {}) {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(url), method: (init.method ?? 'GET').toUpperCase(), headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });

    if (init.signal?.aborted) throw abortError(init.signal);

    const next = queue.shift();
    if (next) {
      switch (next.type) {
        case 'network':
          throw networkFailure();
        case 'http':
          return json({ error: { code: next.status, message: next.message ?? 'error', status: next.errorStatus ?? 'UNKNOWN', details: next.details } }, next.status);
        case 'block':
          return json({ promptFeedback: { blockReason: 'SAFETY' } });
        case 'empty':
          return json({ candidates: [] });
        case 'truncated':
          // 出力の上限で途中まで（セリフの生成の JSON が閉じていない形のテスト用）
          return json({ candidates: [{ content: { role: 'model', parts: [{ text: next.text }] }, finishReason: 'MAX_TOKENS' }] });
        case 'hang':
          // 応答を返さない（タイムアウト・中止のテスト用）。abort されたら拒否する
          await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(abortError(init.signal))));
          break;
        default:
          break;
      }
    }

    const text = replies[Math.min(replyIndex, replies.length - 1)];
    replyIndex += 1;
    return json({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
  }

  return {
    fetch,
    calls,
    /** 次の1回を HTTP エラーにする。 */
    failNext(status, { message, errorStatus, details } = {}) {
      queue.push({ type: 'http', status, message, errorStatus, details });
    },
    /** APIキー不正（400 INVALID_ARGUMENT / API_KEY_INVALID）。 */
    invalidKeyNext() {
      queue.push({ type: 'http', status: 400, message: 'API key not valid. Please pass a valid API key.', errorStatus: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] });
    },
    networkDownNext() {
      queue.push({ type: 'network' });
    },
    blockNext() {
      queue.push({ type: 'block' });
    },
    emptyNext() {
      queue.push({ type: 'empty' });
    },
    hangNext() {
      queue.push({ type: 'hang' });
    },
    /** 次の1回を、出力の上限（MAX_TOKENS）で途中まで返す。 */
    truncatedNext(text) {
      queue.push({ type: 'truncated', text });
    },
  };
}
