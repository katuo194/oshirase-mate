// チャットボットのセッション（F-16 / 3.5 / 7.3）。Electron に依存しない：Gemini 呼び出し（client）は注入する。
//
// 1回の「話しかける」＝1セッション。会話履歴はメモリのみ（直近 maxTurns 往復）で、ウィンドウを閉じる時に呼び出し側が破棄する。
//   往復数（turn）は「Gemini から実際の応答が得られた往復」だけを数える。失敗（フォールバック応答）は往復を消費せず、履歴にも積まない
//   （通信エラーで残り回数が減らないように）。表示のカウンターは「残り {max − turn}/{max} 往復」（開始時 10/10 → 終了時 0/10：v5.8）。
//   maxTurns 往復目の応答には、定型の終了メッセージ（closing）を付けて final: true を返す。呼び出し側は送信・読み上げの後にウィンドウを閉じる。
//   終了メッセージは生成せず定型にする（オフラインでも確実に終わらせるため）。

import { SYSTEM_PROMPT } from './chatPersona.js';

export const CHAT_DEFAULTS = Object.freeze({ maxTurns: 10, showRemainingCount: true });
export const MIN_TURNS = 1;
export const MAX_TURNS = 50;
/** ユーザー入力の最大長（Gemini への送信量と表示を抑える）。 */
export const MAX_INPUT_LENGTH = 500;

export const CLOSING_MESSAGE = '今日はこのくらいにしようか。またお話ししようね。';

/** 失敗時のフォールバック応答（7.3）。 */
export const FALLBACK_MESSAGES = Object.freeze({
  auth: 'APIキーが正しくないみたい。設定画面で確認してね。',
  rate_limit: '今はちょっと考えられないみたい。少し待ってからまた話しかけてね。',
  quota: 'APIの利用枠（クレジット）が足りないみたい。AI Studioの課金設定を確認してね。',
  model_unavailable: '使えるモデルが見つからなかったみたい。ログを確認してね。',
  default: '今はちょっと考えられないみたい。',
});

/** 失敗の種別（geminiClient.js の GeminiError.kind）→ フォールバック文言。 */
export function fallbackFor(kind) {
  if (kind === 'auth') return FALLBACK_MESSAGES.auth;
  if (kind === 'rate_limit') return FALLBACK_MESSAGES.rate_limit;
  if (kind === 'quota') return FALLBACK_MESSAGES.quota;
  if (kind === 'model_unavailable') return FALLBACK_MESSAGES.model_unavailable;
  return FALLBACK_MESSAGES.default;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * config.json の chat（6.1）の読み出し用の正規化。読み取り専用。
 * @param {unknown} raw
 * @returns {{ maxTurns: number, showRemainingCount: boolean }}
 */
export function normalizeChatConfig(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const t = r.maxTurns;
  return {
    maxTurns: Number.isInteger(t) && t >= MIN_TURNS && t <= MAX_TURNS ? t : CHAT_DEFAULTS.maxTurns,
    showRemainingCount: typeof r.showRemainingCount === 'boolean' ? r.showRemainingCount : CHAT_DEFAULTS.showRemainingCount,
  };
}

/**
 * @typedef {{ ok: true, reply: string, closing: string | null, turn: number, max: number, remaining: number, final: boolean, fallback: boolean }} ChatReply
 * @typedef {{ ok: false, reason: 'empty' | 'too_long' | 'busy' | 'finished' | 'aborted' }} ChatRejected
 *
 * @param {object} deps
 * @param {{ generate: (req: { systemPrompt: string, contents: { role: 'user' | 'model', text: string }[], signal?: AbortSignal }) => Promise<string> }} deps.client
 * @param {() => number} [deps.getMaxTurns]
 * @param {string} [deps.systemPrompt] 固定のシステムプロンプト
 * @param {() => string} [deps.getSystemPrompt] 会話ごとのシステムプロンプト（Phase 8：選択中のキャラクターの人格）。
 *   作成時と reset（新しい会話の開始）のたびに呼んで確定する。会話の途中でキャラクターが変わっても混ざらない
 */
export function createChatSession({ client, getMaxTurns = () => CHAT_DEFAULTS.maxTurns, systemPrompt = SYSTEM_PROMPT, getSystemPrompt = null }) {
  const currentPrompt = () => (getSystemPrompt ? getSystemPrompt() : systemPrompt);
  let prompt = currentPrompt();
  /** @type {{ role: 'user' | 'model', text: string }[]} */
  let history = [];
  let turn = 0;
  let max = getMaxTurns();
  let busy = false;
  let finished = false;
  let controller = null;
  /** reset のたびに進める世代。古いリクエストの結果が新しい会話に混ざらないようにする */
  let epoch = 0;

  const view = () => ({ turn, max, remaining: Math.max(0, max - turn) });

  return {
    /** 現在の往復数（表示用）。 */
    state: () => ({ ...view(), finished, busy }),

    /**
     * ユーザーの発言を送り、応答を得る。
     * @param {string} input
     * @returns {Promise<ChatReply | ChatRejected>}
     */
    async send(input) {
      const text = typeof input === 'string' ? input.trim() : '';
      if (text === '') return { ok: false, reason: 'empty' };
      if (text.length > MAX_INPUT_LENGTH) return { ok: false, reason: 'too_long' };
      if (finished) return { ok: false, reason: 'finished' };
      if (busy) return { ok: false, reason: 'busy' };

      busy = true;
      const mine = new AbortController();
      controller = mine;
      const myEpoch = epoch;
      try {
        const reply = await client.generate({
          systemPrompt: prompt,
          contents: [...history, { role: 'user', text }],
          signal: mine.signal,
        });
        if (epoch !== myEpoch) return { ok: false, reason: 'aborted' }; // 応答を待つ間にリセットされた（新しい会話へ混ぜない）
        history.push({ role: 'user', text }, { role: 'model', text: reply });
        turn += 1;
        const final = turn >= max;
        if (final) finished = true;
        return { ok: true, reply, closing: final ? CLOSING_MESSAGE : null, ...view(), final, fallback: false };
      } catch (e) {
        if (e?.kind === 'aborted' || epoch !== myEpoch) return { ok: false, reason: 'aborted' };
        // 往復は消費しない・履歴にも積まない。種別ごとのフォールバック応答を返す
        return { ok: true, reply: fallbackFor(e?.kind), closing: null, ...view(), final: false, fallback: true };
      } finally {
        if (epoch === myEpoch) {
          busy = false;
          if (controller === mine) controller = null;
        }
      }
    },

    /** 送信中のリクエストを中止する（ウィンドウを閉じた時）。 */
    abort() {
      controller?.abort();
    },

    /** 履歴を破棄し、往復数を 0 に戻す（ウィンドウを閉じた時）。 */
    reset() {
      epoch += 1; // 送信中のリクエストの結果を無効にする
      controller?.abort();
      controller = null;
      history = [];
      turn = 0;
      max = getMaxTurns();
      prompt = currentPrompt();
      busy = false;
      finished = false;
    },
  };
}
