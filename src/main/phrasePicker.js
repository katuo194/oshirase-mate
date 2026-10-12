// アイドルトークの文面選択（3.4 / v5.8）。Electron に依存しない純粋ロジック。乱数は注入する。
//
// 「シャッフル袋」方式：文面を1つの袋としてシャッフルし、1周するまで同じ文面は出さない。
// 周の切り替わりでは、直前に選んだ文面が新しい袋の先頭に来ないよう入れ替える（連続の防止を保証）。
// カテゴリ均等巡回にしない理由：独り言5種が全体の1/3の頻度で出て、同じ文が早く再登場するため。

import { PHRASE_SETS } from './idleTalkPhrases.js';

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

  return {
    next() {
      if (queue.length === 0) refill();
      last = queue.shift();
      return last;
    },
  };
}

/**
 * カテゴリ（morning / bedtime / normal）ごとの袋を持つピッカー。
 * @param {object} [opts]
 * @param {() => number} [opts.rng]
 * @param {Record<string, readonly string[]>} [opts.sets] テスト用に差し替え可能
 */
export function createPhrasePicker({ rng = Math.random, sets = PHRASE_SETS } = {}) {
  const bags = new Map();
  return {
    /** @returns {string} */
    pick(category) {
      if (!Object.hasOwn(sets, category)) throw new Error(`unknown category: ${category}`);
      if (!bags.has(category)) bags.set(category, createBag(sets[category], rng));
      return bags.get(category).next();
    },
  };
}
