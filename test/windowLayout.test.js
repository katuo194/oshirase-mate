import { describe, expect, it } from 'vitest';
import {
  BUBBLE_OVERLAP,
  BUBBLE_SIZE,
  CHARACTER_SIZE,
  COLLAPSED_LAYOUT,
  boundsFromAnchor,
  computeLayout,
  layoutsEqual,
} from '../src/main/windowLayout.js';

const WORK = { x: 0, y: 0, width: 1920, height: 1040 };

describe('windowLayout / boundsFromAnchor（通常時）', () => {
  it('Phase 0 と同じ：anchor はキャラクター中心、ウィンドウは 200×200', () => {
    expect(boundsFromAnchor({ x: 500, y: 400 })).toEqual({ x: 400, y: 300, width: 200, height: 200 });
  });

  it('端数は丸める', () => {
    expect(boundsFromAnchor({ x: 500.4, y: 400.6 })).toEqual({ x: 400, y: 301, width: 200, height: 200 });
  });

  it('通常レイアウトは 200×200・キャラクター中心 (100,100)・吹き出しなし', () => {
    expect(COLLAPSED_LAYOUT).toMatchObject({ size: { width: 200, height: 200 }, characterOffset: { x: 100, y: 100 }, bubble: null });
  });
});

describe('windowLayout / layoutsEqual（連続表示で拡大・縮小を省く判定）', () => {
  const a = () => computeLayout({ anchor: { x: 900, y: 600 }, workArea: WORK });

  it('同じ anchor・作業領域から作ったレイアウトは等しい', () => {
    expect(layoutsEqual(a(), a())).toBe(true);
    expect(layoutsEqual(COLLAPSED_LAYOUT, COLLAPSED_LAYOUT)).toBe(true);
  });

  it('anchor が動いて配置（上下反転・左右のずれ）が変われば等しくない', () => {
    expect(layoutsEqual(a(), computeLayout({ anchor: { x: 900, y: 100 }, workArea: WORK }))).toBe(false); // 反転
    expect(layoutsEqual(a(), computeLayout({ anchor: { x: 60, y: 600 }, workArea: WORK }))).toBe(false); // 左端で寄せ
  });

  it('通常レイアウトと拡大レイアウトは等しくない（null との比較でも落ちない）', () => {
    expect(layoutsEqual(a(), COLLAPSED_LAYOUT)).toBe(false);
    expect(layoutsEqual(COLLAPSED_LAYOUT, a())).toBe(false);
    expect(layoutsEqual(null, a())).toBe(false);
  });
});

describe('windowLayout / computeLayout（吹き出し表示時の拡大）', () => {
  it('画面中央：吹き出しはキャラクターの上、横はキャラクター中央に合う', () => {
    const l = computeLayout({ anchor: { x: 900, y: 600 }, workArea: WORK });
    expect(l.bubble.side).toBe('top');
    expect(l.bubble.width).toBe(BUBBLE_SIZE.width);
    expect(l.bubble.tailX).toBe(BUBBLE_SIZE.width / 2);
    expect(l.size.width).toBe(BUBBLE_SIZE.width); // 260 > 200 なので横幅は吹き出し基準
    // 縦：吹き出し高さ＋キャラクター枠 − 食い込み量
    expect(l.size.height).toBe(BUBBLE_SIZE.height + CHARACTER_SIZE - BUBBLE_OVERLAP);
  });

  it('キャラクターの見た目位置（anchor）が拡大しても動かない：bounds + characterOffset === anchor', () => {
    const anchors = [
      { x: 900, y: 600 },
      { x: 100, y: 100 }, // 左上端
      { x: 1820, y: 940 }, // 右下端（既定位置付近）
      { x: 1900, y: 20 }, // 右上端
      { x: 20, y: 1020 }, // 左下端
      { x: 333.4, y: 777.7 }, // 端数
    ];
    for (const anchor of anchors) {
      const layout = computeLayout({ anchor, workArea: WORK });
      const b = boundsFromAnchor(anchor, layout);
      expect(b.x + layout.characterOffset.x).toBe(Math.round(anchor.x));
      expect(b.y + layout.characterOffset.y).toBe(Math.round(anchor.y));
      expect(b.width).toBe(layout.size.width);
      expect(b.height).toBe(layout.size.height);
    }
  });

  it('ウィンドウはキャラクター枠と吹き出し枠の両方を含む', () => {
    for (const anchor of [{ x: 900, y: 600 }, { x: 60, y: 60 }, { x: 1880, y: 1000 }]) {
      const l = computeLayout({ anchor, workArea: WORK });
      const c = { x: l.characterOffset.x - 100, y: l.characterOffset.y - 100 };
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + CHARACTER_SIZE).toBeLessThanOrEqual(l.size.width);
      expect(c.y + CHARACTER_SIZE).toBeLessThanOrEqual(l.size.height);
      expect(l.bubble.x).toBeGreaterThanOrEqual(0);
      expect(l.bubble.y).toBeGreaterThanOrEqual(0);
      expect(l.bubble.x + l.bubble.width).toBeLessThanOrEqual(l.size.width);
      expect(l.bubble.y + l.bubble.height).toBeLessThanOrEqual(l.size.height);
    }
  });

  it('上に余白がなければ吹き出しは下に反転する（画面上端のキャラクター）', () => {
    const anchor = { x: 900, y: 100 };
    const l = computeLayout({ anchor, workArea: WORK });
    expect(l.bubble.side).toBe('bottom');
    // 反転時はキャラクターが窓の上側、吹き出しが下側
    expect(l.characterOffset.y).toBe(100);
    expect(l.bubble.y).toBeGreaterThanOrEqual(CHARACTER_SIZE - BUBBLE_OVERLAP);
    // 吹き出しが作業領域の中に収まる
    const b = boundsFromAnchor(anchor, l);
    expect(b.y + l.bubble.y).toBeGreaterThanOrEqual(WORK.y);
    expect(b.y + l.bubble.y + l.bubble.height).toBeLessThanOrEqual(WORK.y + WORK.height);
  });

  it('上下どちらにも収まらないときは上に置く', () => {
    const tiny = { x: 0, y: 0, width: 800, height: 150 };
    expect(computeLayout({ anchor: { x: 400, y: 75 }, workArea: tiny }).bubble.side).toBe('top');
  });

  it('画面の左右端では吹き出しを作業領域内へずらし、尻尾はキャラクターを指し続ける', () => {
    const left = computeLayout({ anchor: { x: 60, y: 600 }, workArea: WORK });
    const bl = boundsFromAnchor({ x: 60, y: 600 }, left);
    expect(bl.x + left.bubble.x).toBe(WORK.x); // 左端に揃う
    expect(bl.x + left.bubble.x + left.bubble.tailX).toBe(60); // 尻尾の先がキャラクター中心の真上

    const right = computeLayout({ anchor: { x: 1880, y: 600 }, workArea: WORK });
    const br = boundsFromAnchor({ x: 1880, y: 600 }, right);
    expect(br.x + right.bubble.x + right.bubble.width).toBe(WORK.x + WORK.width); // 右端に揃う
    expect(br.x + right.bubble.x + right.bubble.tailX).toBe(1880);
  });

  it('尻尾は吹き出しの角に寄りすぎない', () => {
    const l = computeLayout({ anchor: { x: 5, y: 600 }, workArea: WORK });
    expect(l.bubble.tailX).toBeGreaterThanOrEqual(24);
  });

  it('副ディスプレイ（負の座標）でも成り立つ', () => {
    const work = { x: -1920, y: 0, width: 1920, height: 1040 };
    const anchor = { x: -1850, y: 500 };
    const l = computeLayout({ anchor, workArea: work });
    const b = boundsFromAnchor(anchor, l);
    expect(b.x + l.characterOffset.x).toBe(-1850);
    expect(b.x + l.bubble.x).toBe(-1920);
  });

  it('作業領域が吹き出しより狭くても落ちない（左端に寄せる）', () => {
    const narrow = { x: 100, y: 0, width: 200, height: 1000 };
    const anchor = { x: 200, y: 500 };
    const l = computeLayout({ anchor, workArea: narrow });
    expect(boundsFromAnchor(anchor, l).x + l.bubble.x).toBe(100);
  });

  it('返す値はすべて整数（setBounds に渡せる）', () => {
    const l = computeLayout({ anchor: { x: 333.4, y: 777.7 }, workArea: WORK });
    for (const v of [l.size.width, l.size.height, l.characterOffset.x, l.characterOffset.y, l.bubble.x, l.bubble.y, l.bubble.tailX]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('ドラッグで anchor が動いても、同じレイアウトで bounds が anchor に追従する（表示中のドラッグ）', () => {
    const layout = computeLayout({ anchor: { x: 900, y: 600 }, workArea: WORK });
    const a = boundsFromAnchor({ x: 900, y: 600 }, layout);
    const b = boundsFromAnchor({ x: 950, y: 580 }, layout);
    expect({ dx: b.x - a.x, dy: b.y - a.y }).toEqual({ dx: 50, dy: -20 });
    expect({ w: b.width, h: b.height }).toEqual({ w: a.width, h: a.height });
  });
});
