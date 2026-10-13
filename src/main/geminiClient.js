// Gemini API（generateContent）の REST 呼び出しとエラー分類（3.5 / 7.3）。Electron に依存しない：fetch とキーの取得は注入する。
//
// SDK（@google/generative-ai）は使わず fetch で呼ぶ（v5.8）。依存を増やさず、voicevox.js / googleApi.js と同じく fetch を注入して
// mocks/gemini の偽 fetch でテストできるため。キーは x-goog-api-key ヘッダで送り、URL・ログ・例外メッセージには一切出さない。
// ユーザーの入力文以外（カレンダー・メール等）はここに渡らない。ログに出すのは失敗の種別・HTTP ステータス・Google のエラー区分
// （status 列挙値と短いメッセージ。キーは伏せる）だけで、発言本文・プロンプトは出さない。

/**
 * 使用するモデルの候補（先頭から試す）。提供状況はキー（プロジェクト）ごとに違い、古いモデルが新規ユーザーに提供されない場合もあるため、
 * 404（モデルが無い／使えない）のときは次の候補へ切り替え、使えたモデルを覚えて以降はそれを使う。
 */
export const GEMINI_MODELS = Object.freeze(['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash']);
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** 1リクエスト（1モデルの試行）の上限時間。思考を行うモデルもあるので余裕を持たせる。 */
export const REQUEST_TIMEOUT_MS = 30000;
/** 読み上げ前提で短く返してもらう（プロンプトで指示）。思考トークンも含めて数えられるモデルがあるため、余裕を持たせる。 */
export const MAX_OUTPUT_TOKENS = 1024;
/** ログに出す Google のエラーメッセージの最大長。 */
const LOG_MESSAGE_MAX = 200;

/**
 * 失敗の種別（gemini.js がフォールバック文言の出し分けに使う）。
 *   auth              … キー未設定・不正（400 のキー不正／401／403）
 *   rate_limit        … 429（レート制限・無料枠の上限）
 *   quota             … 402（プリペイドのクレジット切れ。AI Studio の課金設定を確認する必要がある）
 *   model_unavailable … 404（候補のモデルがすべて見つからない・使えない）
 *   server            … 5xx
 *   network           … 接続できない
 *   timeout           … 応答が遅い
 *   blocked           … 安全フィルタ等で応答が得られない
 *   empty             … 応答が空
 *   aborted           … 呼び出し側が中止した（ウィンドウを閉じた等）
 *   unknown           … その他（想定外の 4xx など）
 */
export class GeminiError extends Error {
  /**
   * @param {string} kind
   * @param {{ status?: number, apiStatus?: string, apiMessage?: string }} [opts] apiStatus / apiMessage はログ用（キー伏せ済みの Google のエラー区分・短いメッセージ）
   */
  constructor(kind, { status, apiStatus, apiMessage } = {}) {
    super(`gemini ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'GeminiError';
    this.kind = kind;
    this.status = status;
    this.apiStatus = apiStatus;
    this.apiMessage = apiMessage;
  }
}

/** エラー応答から種別を決める（純粋関数）。errorBody は error オブジェクト（{ code, message, status, details }）または null。 */
export function classifyHttpFailure(status, errorBody) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  // 402：プリペイドのクレジット切れ（RESOURCE_EXHAUSTED）。429（レート制限）とは別物で、待っても直らない
  if (status === 402) return 'quota';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 400) {
    // キー不正は 400 INVALID_ARGUMENT（"API key not valid"）で返る。それ以外の 400 は想定外
    const reasons = Array.isArray(errorBody?.details) ? errorBody.details.map((d) => d?.reason) : [];
    if (reasons.includes('API_KEY_INVALID') || /api key/i.test(errorBody?.message ?? '')) return 'auth';
  }
  return 'unknown';
}

/** Google のエラーメッセージをログ用に整える（キーの値を伏せ、長さを切る）。 */
export function safeApiMessage(message, key) {
  if (typeof message !== 'string') return undefined;
  let m = message;
  if (key) m = m.split(key).join('***');
  m = m.replace(/AIza[0-9A-Za-z_-]{10,}/g, '***').replace(/\s+/g, ' ').trim();
  return m.length > LOG_MESSAGE_MAX ? `${m.slice(0, LOG_MESSAGE_MAX)}…` : m;
}

/**
 * 成功応答（200）から本文を取り出す。応答が得られない場合は GeminiError を投げる。
 * @param {any} data
 */
export function extractText(data) {
  if (data?.promptFeedback?.blockReason) throw new GeminiError('blocked');
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : undefined;
  if (!candidate) throw new GeminiError('empty');
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (text === '') throw new GeminiError(candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS' ? 'blocked' : 'empty');
  return text;
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {() => Promise<string | null>} deps.getApiKey 保存済みキー（未設定なら null）
 * @param {readonly string[]} [deps.models] 使用するモデルの候補（先頭から試す。404 で次へ）
 * @param {string} [deps.baseUrl]
 * @param {number} [deps.timeoutMs] 1リクエストの上限時間（generate の timeoutMs で呼び出しごとに変えられる）
 * @param {string} [deps.logTag] ログの頭（[chat] など。使い道ごとにクライアントを分けるため）
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createGeminiClient({
  fetch,
  getApiKey,
  models = GEMINI_MODELS,
  baseUrl = GEMINI_BASE_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  logTag = 'chat',
  log = console,
}) {
  /** 最後に成功したモデルの位置。次回以降はここから試す（毎回 404 を踏まない） */
  let activeIndex = 0;

  /** 1つのモデルで1回リクエストする。 */
  async function attempt({ model, key, systemPrompt, contents, signal, generationConfig, limitMs }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limitMs);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let res;
      try {
        res = await fetch(`${baseUrl}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] })),
            generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.9, ...generationConfig },
          }),
          signal: controller.signal,
        });
      } catch {
        if (signal?.aborted) throw new GeminiError('aborted');
        if (timedOut) throw new GeminiError('timeout');
        throw new GeminiError('network');
      }

      if (!res.ok) {
        let errorBody = null;
        try {
          errorBody = (await res.json())?.error ?? null;
        } catch {
          // 本文が JSON でなくても、ステータスだけで分類する
        }
        throw new GeminiError(classifyHttpFailure(res.status, errorBody), {
          status: res.status,
          apiStatus: typeof errorBody?.status === 'string' ? errorBody.status : undefined,
          apiMessage: safeApiMessage(errorBody?.message, key),
        });
      }

      let data;
      try {
        data = await res.json();
      } catch {
        if (signal?.aborted) throw new GeminiError('aborted');
        throw new GeminiError(timedOut ? 'timeout' : 'network');
      }
      return extractText(data);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const describe = (e, model) =>
    `${e.kind}${e.status ? `（HTTP ${e.status}` : ''}${e.apiStatus ? ` ${e.apiStatus}` : ''}${e.status ? '）' : ''} model=${model}${e.apiMessage ? ` message=${e.apiMessage}` : ''}`;

  return {
    /**
     * @param {{ systemPrompt: string, contents: { role: 'user' | 'model', text: string }[], signal?: AbortSignal,
     *   generationConfig?: object, timeoutMs?: number }} req
     *   generationConfig は既定（maxOutputTokens・temperature）に上書きして送る（セリフの生成の JSON 出力など：Phase 14）。
     *   timeoutMs は1リクエストの上限時間（省略時はクライアントの既定）
     * @returns {Promise<string>} 応答本文
     * @throws {GeminiError}
     */
    async generate({ systemPrompt, contents, signal, generationConfig = {}, timeoutMs: limitMs = timeoutMs }) {
      const key = await getApiKey();
      if (!key) throw new GeminiError('auth');

      let lastError = null;
      for (let i = activeIndex; i < models.length; i++) {
        const model = models[i];
        try {
          const text = await attempt({ model, key, systemPrompt, contents, signal, generationConfig, limitMs });
          if (i !== activeIndex) log.info(`[${logTag}] Gemini のモデルを ${model} に切り替えました`);
          activeIndex = i;
          return text;
        } catch (e) {
          if (!(e instanceof GeminiError)) {
            log.warn(`[${logTag}] Gemini の呼び出しで想定外のエラー: ${e?.name ?? 'Error'}`);
            throw new GeminiError('unknown');
          }
          lastError = e;
          if (e.kind === 'aborted') throw e;
          if ((e.kind === 'model_unavailable' || e.kind === 'quota') && i < models.length - 1) {
            // このモデルは使えない（404）／課金条件で断られた（402。モデルごとに条件が違い得る）。次の候補を試す
            log.warn(`[${logTag}] Gemini のモデルが使えません。次の候補を試します: ${describe(e, model)}`);
            continue;
          }
          log.warn(`[${logTag}] Gemini の呼び出しに失敗: ${describe(e, model)}`);
          throw e;
        }
      }
      // activeIndex が末尾を超えることはない（成功時のみ更新）が、念のため
      throw lastError ?? new GeminiError('unknown');
    },
  };
}
