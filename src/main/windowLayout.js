// マスコットウィンドウのレイアウト計算（6.1 characterAnchor）。Electron に依存しない純粋ロジック。
//
// 保存・保持するのは「キャラクター中心のスクリーン座標（anchor）」だけ。ウィンドウの bounds は、
// 相対レイアウト（ウィンドウ左上から見たキャラクター中心の位置 characterOffset とウィンドウ寸法 size）を使って
// anchor から毎回逆算する。吹き出しの表示でウィンドウが拡大・縮小しても anchor は動かないので、
// キャラクターの見た目位置がずれない。座標はすべて DIP。

/** キャラクター描画枠（正方形）。キャラクター中心は枠の中央。 */
export const CHARACTER_SIZE = 200;

/** 吹き出し枠（尻尾の領域を含む）。高さ = 本体 96 + 尻尾 14。 */
export const BUBBLE_SIZE = Object.freeze({ width: 260, height: 110 });

/** 吹き出しの縁を、キャラクター枠の内側へ食い込ませる量。枠の余白（円の外側 20px）の中に収まり、尻尾の先が円の近くに来る。 */
export const BUBBLE_OVERLAP = 16;

/** 尻尾の位置を吹き出しの端から離す最小距離。 */
const TAIL_MARGIN = 24;

/** 吹き出しなし（通常時）のレイアウト。Phase 0 の 200×200・キャラクター中心 (100,100) と同一。 */
export const COLLAPSED_LAYOUT = Object.freeze({
  size: Object.freeze({ width: CHARACTER_SIZE, height: CHARACTER_SIZE }),
  characterOffset: Object.freeze({ x: CHARACTER_SIZE / 2, y: CHARACTER_SIZE / 2 }),
  bubble: null,
});

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * anchor と相対レイアウトから、ウィンドウの bounds（スクリーン座標）を逆算する。
 * @param {{ x: number, y: number }} anchor キャラクター中心
 * @param {{ size: { width: number, height: number }, characterOffset: { x: number, y: number } }} [layout]
 */
export function boundsFromAnchor(anchor, layout = COLLAPSED_LAYOUT) {
  return {
    x: Math.round(anchor.x - layout.characterOffset.x),
    y: Math.round(anchor.y - layout.characterOffset.y),
    width: layout.size.width,
    height: layout.size.height,
  };
}

/**
 * 2つの相対レイアウトが同じ配置か。連続する通知で同じ配置なら、ウィンドウの拡大・縮小（＝キャラクターを隠す切り替え）を省くための判定。
 */
export function layoutsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const sameBubble =
    a.bubble === b.bubble ||
    (a.bubble !== null && b.bubble !== null &&
      a.bubble.x === b.bubble.x && a.bubble.y === b.bubble.y &&
      a.bubble.width === b.bubble.width && a.bubble.height === b.bubble.height &&
      a.bubble.side === b.bubble.side && a.bubble.tailX === b.bubble.tailX);
  return (
    sameBubble &&
    a.size.width === b.size.width && a.size.height === b.size.height &&
    a.characterOffset.x === b.characterOffset.x && a.characterOffset.y === b.characterOffset.y
  );
}

/**
 * 吹き出し表示用の拡大レイアウトを求める。
 * 吹き出しはキャラクターの上（尻尾は下向き）。上に余白がなければ下へ反転する。
 * 横はキャラクター中央に合わせ、作業領域からはみ出す分だけずらす（尻尾はキャラクターを指したまま）。
 * ウィンドウ = キャラクター枠と吹き出し枠の和集合。返す値はすべて anchor 基準の相対値（整数）。
 *
 * @param {object} opts
 * @param {{ x: number, y: number }} opts.anchor
 * @param {{ x: number, y: number, width: number, height: number }} opts.workArea anchor のあるディスプレイの作業領域
 * @param {{ width: number, height: number }} [opts.bubbleSize]
 * @returns {{
 *   size: { width: number, height: number },
 *   characterOffset: { x: number, y: number },
 *   bubble: { x: number, y: number, width: number, height: number, side: 'top' | 'bottom', tailX: number },
 * }}
 */
export function computeLayout({ anchor, workArea, bubbleSize = BUBBLE_SIZE }) {
  const ax = Math.round(anchor.x);
  const ay = Math.round(anchor.y);
  const half = CHARACTER_SIZE / 2;
  const charLeft = ax - half;
  const charTop = ay - half;
  const { width: bw, height: bh } = bubbleSize;

  const topY = charTop + BUBBLE_OVERLAP - bh;
  const bottomY = charTop + CHARACTER_SIZE - BUBBLE_OVERLAP;
  const side = topY >= workArea.y || bottomY + bh > workArea.y + workArea.height ? 'top' : 'bottom';
  const bubbleY = side === 'top' ? topY : bottomY;

  const maxX = workArea.x + workArea.width - bw;
  const bubbleX = Math.round(maxX < workArea.x ? workArea.x : clamp(ax - bw / 2, workArea.x, maxX));
  const tailX = Math.round(clamp(ax - bubbleX, Math.min(TAIL_MARGIN, bw / 2), Math.max(bw - TAIL_MARGIN, bw / 2)));

  const left = Math.min(charLeft, bubbleX);
  const top = Math.min(charTop, bubbleY);
  const right = Math.max(charLeft + CHARACTER_SIZE, bubbleX + bw);
  const bottom = Math.max(charTop + CHARACTER_SIZE, bubbleY + bh);

  return {
    size: { width: right - left, height: bottom - top },
    characterOffset: { x: ax - left, y: ay - top },
    bubble: { x: bubbleX - left, y: bubbleY - top, width: bw, height: bh, side, tailX },
  };
}
