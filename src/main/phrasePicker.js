// 文面選択（3.4 / v5.8・F-22）。Electron に依存しない純粋ロジック。乱数は注入する。
//
// 「シャッフル袋」方式：文面を1つの袋としてシャッフルし、1周するまで同じ文面は出さない。
// 周の切り替わりでは、直前に選んだ文面が新しい袋の先頭に来ないよう入れ替える（連続の防止を保証）。
// カテゴリ均等巡回にしない理由：独り言5種が全体の1/3の頻度で出て、同じ文が早く再登場するため。
//
// アイドルトーク（morning / bedtime / normal）と通知の読み上げのセリフ（calendar / calendarAllDay / tasks / gmail）、
// チャットの終了メッセージ（closing。Phase 14）を、
// 選択中のキャラクターのセリフ（characterLines.js）から選ぶ。設定の無い種類は今の固定文。キャラクターを切り替えたら作り直す。

import { effectiveLines } from './characterLines.js';

/** Fisher–Yates。rng は [0,1) を返す関数。 */
function shuffle(items, rng) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 1つの文面セットから、重複を避けて選ぶ袋。
 * @param {readonly string[]} phrases
 * @param {() => number} [rng]
 */
export function createBag(phrases, rng = Math.random) {
  if (!Array.isArray(phrases) || phrases.length === 0) throw new Error('phrases is empty');
  let queue = [];
  let last = null;

  function refill() {
    queue = shuffle(phrases, rng);
    // 周の境界で同じ文が連続しないように（2種以上あるときだけ入れ替えられる）
    if (queue.length > 1 && queue[0] === last) {
      [queue[0], queue[1]] = [queue[1], queue[0]];
    }
  }

  /** 袋の中で accept を満たす最初の文（直前の文はほかに無いときだけ） */
  function find(accept) {
    const i = queue.findIndex((p) => p !== last && accept(p));
    return i >= 0 ? i : queue.findIndex(accept);
  }

  return {
    /**
     * 次の文。accept を渡すと、それを満たす文だけから選ぶ（満たさない文は袋に残し、後で選ばれ得る）。
     * @param {(phrase: string) => boolean} [accept]
     * @returns {string | null} accept を満たす文が1つも無ければ null
     */
    next(accept = () => true) {
      if (queue.length === 0) refill();
      let i = find(accept);
      if (i < 0) {
        // 袋の残りに使える文が無い：新しい周を始める（どの文も使えなければ null）
        if (!phrases.some(accept)) return null;
        refill();
        i = find(accept);
      }
      [last] = queue.splice(i, 1);
      return last;
    },
  };
}

/**
 * 種類ごとの袋を持つピッカー。
 * @param {object} [opts]
 * @param {() => number} [opts.rng]
 * @param {unknown} [opts.lines] 選択中のキャラクターのセリフ（manifest.json の lines）。無い・空の種類は今の固定文
 * @param {Record<string, readonly string[]>} [opts.sets] アイドルトークの文面（テスト用に差し替え可能。既定は lines から）
 */
export function createPhrasePicker({ rng = Math.random, lines = null, sets } = {}) {
  const effective = effectiveLines(lines);
  const idleSets = sets ?? effective.idle;
  const bags = new Map();
  const bagOf = (key, phrases) => {
    if (!bags.has(key)) bags.set(key, createBag(phrases, rng));
    return bags.get(key);
  };
  return {
    /**
     * アイドルトークの文。
     * @param {'morning' | 'bedtime' | 'normal'} category
     * @returns {string}
     */
    pick(category) {
      if (!Object.hasOwn(idleSets, category)) throw new Error(`unknown category: ${category}`);
      return bagOf(`idle.${category}`, idleSets[category]).next();
    },

    /**
     * 通知の読み上げのセリフ（ひな形）。notificationView.toSpeechText の pickLine に渡す。
     * @param {'calendar' | 'calendarAllDay' | 'tasks' | 'gmail'} kind
     * @param {(line: string) => boolean} [accept] 使える文か（差し込みの値が空になる文を避ける）
     * @returns {string | null} 使える文が無ければ null（呼び出し側が既定の文を使う）
     */
    pickNotify(kind, accept) {
      if (!Object.hasOwn(effective.notify, kind)) throw new Error(`unknown kind: ${kind}`);
      return bagOf(`notify.${kind}`, effective.notify[kind]).next(accept);
    },

    /**
     * チャットのセリフ（Phase 14：終了メッセージ）。会話の開始時に1回選ぶ。
     * @param {'closing'} kind
     * @returns {string}
     */
    pickChat(kind) {
      if (!Object.hasOwn(effective.chat, kind)) throw new Error(`unknown kind: ${kind}`);
      return bagOf(`chat.${kind}`, effective.chat[kind]).next();
    },
  };
}
