import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// TODO のお知らせ時刻のリール（Phase 16）。設定画面のスクリプトは classic script なので、vm で読み込んで純粋関数を確かめる
const source = fs.readFileSync(new URL('../src/renderer/settings/timeReel.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const { wrap, createWheelStepper, typeDigit } = context.globalThis.TimeReel;

describe('wrap', () => {
  it('0〜max で回り込む（23 時の次は 0 時、0 分の前は 59 分）', () => {
    expect(wrap(24, 23)).toBe(0);
    expect(wrap(-1, 23)).toBe(23);
    expect(wrap(-1, 59)).toBe(59);
    expect(wrap(60, 59)).toBe(0);
    expect(wrap(16, 23)).toBe(16);
    expect(wrap(-6, 59)).toBe(54);
  });
});

describe('createWheelStepper', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, advance: (ms) => (t += ms) };
  };

  it('マウスの 1 目盛りは、量（100・125 など）や向きによらず 1 つだけ動かす', () => {
    const c = clock();
    const step = createWheelStepper({ now: c.now });
    expect(step({ deltaY: 100, deltaMode: 0 })).toBe(1);
    c.advance(300);
    expect(step({ deltaY: -125, deltaMode: 0 })).toBe(-1);
    c.advance(300);
    expect(step({ deltaY: -300, deltaMode: 0 })).toBe(-1); // 大きな量でも 1 回のイベントで 2 つ以上は動かさない
    c.advance(300);
    expect(step({ deltaY: 240, deltaMode: 0 })).toBe(1);
  });

  it('上へ回したときと下へ回したときで、同じ回数なら同じだけ動く', () => {
    const c = clock();
    const step = createWheelStepper({ now: c.now });
    let down = 0;
    let up = 0;
    for (let i = 0; i < 10; i++) {
      down += step({ deltaY: 100, deltaMode: 0 });
      c.advance(30);
    }
    for (let i = 0; i < 10; i++) {
      up += step({ deltaY: -125, deltaMode: 0 });
      c.advance(30);
    }
    expect(down).toBe(10);
    expect(up).toBe(-10);
  });

  it('行・ページ単位のイベントも 1 つずつ', () => {
    const step = createWheelStepper({ now: () => 0 });
    expect(step({ deltaY: 3, deltaMode: 1 })).toBe(1);
    expect(step({ deltaY: -3, deltaMode: 1 })).toBe(-1);
    expect(step({ deltaY: 1, deltaMode: 2 })).toBe(1);
  });

  it('タッチパッドの小さい量は、しきい値まで貯めてから 1 つ動かす。向きが変わったら貯めた量を捨てる', () => {
    const c = clock();
    const step = createWheelStepper({ threshold: 50, now: c.now });
    expect(step({ deltaY: 20, deltaMode: 0 })).toBe(0);
    c.advance(16);
    expect(step({ deltaY: 20, deltaMode: 0 })).toBe(0);
    c.advance(16);
    expect(step({ deltaY: 20, deltaMode: 0 })).toBe(1);
    c.advance(16);
    expect(step({ deltaY: 30, deltaMode: 0 })).toBe(0);
    c.advance(16);
    expect(step({ deltaY: -30, deltaMode: 0 })).toBe(0); // 向きが変わったので +30 は捨てる
    c.advance(16);
    expect(step({ deltaY: -30, deltaMode: 0 })).toBe(-1);
  });

  it('しばらく（idleMs）あいたら貯めた量を捨てる。量が 0 のイベントは何もしない', () => {
    const c = clock();
    const step = createWheelStepper({ threshold: 50, idleMs: 250, now: c.now });
    expect(step({ deltaY: 40, deltaMode: 0 })).toBe(0);
    c.advance(1000);
    expect(step({ deltaY: 40, deltaMode: 0 })).toBe(0);
    expect(step({ deltaY: 0, deltaMode: 0 })).toBe(0);
  });
});

describe('typeDigit', () => {
  it('2 桁まで打って値を入れる', () => {
    let r = typeDigit('', '1', 23);
    expect(r).toEqual({ buffer: '1', value: 1 });
    r = typeDigit(r.buffer, '7', 23);
    expect(r).toEqual({ buffer: '', value: 17 });
  });

  it('範囲を超える 2 桁目は、その数字から打ち直したことにする', () => {
    expect(typeDigit('3', '5', 23)).toEqual({ buffer: '5', value: 5 });
    expect(typeDigit('5', '9', 59)).toEqual({ buffer: '', value: 59 });
    expect(typeDigit('7', '0', 59)).toEqual({ buffer: '0', value: 0 });
  });
});
