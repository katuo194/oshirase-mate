import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HIDE_DELAY_MS, allowsIdleTalk, createMascotVisibility } from '../src/main/mascotVisibility.js';

let calls;
function setup(mode = 'notifyOnly', { ready = true } = {}) {
  calls = [];
  const v = createMascotVisibility({
    mode,
    showWindow: () => calls.push('show'),
    hideWindow: () => calls.push('hide'),
    fade: (opaque) => calls.push(opaque ? 'fade-in' : 'fade-out'),
  });
  if (ready) v.windowReady();
  return v;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('常時表示（always）', () => {
  it('初回描画が終わったら表示してフェードインする（それまでは表示しない）', () => {
    const v = setup('always', { ready: false });
    expect(calls).toEqual([]);
    v.windowReady();
    expect(calls).toEqual(['show', 'fade-in']);
    expect(v.isOpaque()).toBe(true);
  });

  it('通知が終わっても消えない', () => {
    const v = setup('always');
    v.notifyPresenting();
    v.notifyCollapsed();
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in']);
  });

  it('不正なモードは always として扱う', () => {
    setup('sometimes');
    expect(calls).toEqual(['show', 'fade-in']);
  });
});

describe('通知時のみ表示（notifyOnly）', () => {
  it('起動時は表示しない', () => {
    const v = setup();
    expect(calls).toEqual([]);
    expect(v.isOpaque()).toBe(false);
  });

  it('通知で表示→フェードインし、縮小が終わったらフェードアウト→少し後に隠す', () => {
    const v = setup();
    v.notifyPresenting();
    expect(calls).toEqual(['show', 'fade-in']);
    v.notifyCollapsed();
    expect(calls).toEqual(['show', 'fade-in', 'fade-out']);
    vi.advanceTimersByTime(HIDE_DELAY_MS - 1);
    expect(calls).not.toContain('hide');
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'hide']);
  });

  it('連続する通知（縮小しない間）は消えない・表示し直さない', () => {
    const v = setup();
    v.notifyPresenting();
    v.notifyPresenting();
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in']);
  });

  it('フェードアウト中に次の通知が来たら、隠さずにフェードインし直す', () => {
    const v = setup();
    v.notifyPresenting();
    v.notifyCollapsed();
    vi.advanceTimersByTime(HIDE_DELAY_MS / 2);
    v.notifyPresenting();
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'fade-in']);
  });

  it('隠した後の通知では、もう一度表示してフェードインする', () => {
    const v = setup();
    v.notifyPresenting();
    v.notifyCollapsed();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    v.notifyPresenting();
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'hide', 'show', 'fade-in']);
  });

  it('ドラッグ中・右クリックメニュー表示中は消さず、両方終わってから消す', () => {
    const v = setup();
    v.notifyPresenting();
    v.setBusy('drag', true);
    v.setBusy('menu', true);
    v.notifyCollapsed();
    v.setBusy('drag', false);
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in']);
    v.setBusy('menu', false);
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'hide']);
  });

  it('ウィンドウの初回描画より前に来た通知は、描画後に表示する', () => {
    const v = setup('notifyOnly', { ready: false });
    v.notifyPresenting();
    expect(calls).toEqual([]);
    v.windowReady();
    expect(calls).toEqual(['show', 'fade-in']);
  });
});

describe('モードの切り替え', () => {
  it('always → notifyOnly：待機中ならすぐ消す', () => {
    const v = setup('always');
    v.setMode('notifyOnly');
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'hide']);
  });

  it('always → notifyOnly：通知の表示中なら、その通知が終わってから消す', () => {
    const v = setup('always');
    v.notifyPresenting();
    v.setMode('notifyOnly');
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in']);
    v.notifyCollapsed();
    vi.advanceTimersByTime(HIDE_DELAY_MS);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'hide']);
  });

  it('notifyOnly → always：すぐ表示する（フェードアウト中なら取り消す）', () => {
    const v = setup();
    v.setMode('always');
    expect(calls).toEqual(['show', 'fade-in']);
    v.setMode('notifyOnly');
    vi.advanceTimersByTime(HIDE_DELAY_MS / 2);
    v.setMode('always');
    vi.advanceTimersByTime(HIDE_DELAY_MS * 4);
    expect(calls).toEqual(['show', 'fade-in', 'fade-out', 'fade-in']);
  });
});

describe('allowsIdleTalk', () => {
  it('通知時のみ表示ではアイドルトークを出さない', () => {
    expect(allowsIdleTalk('always')).toBe(true);
    expect(allowsIdleTalk('notifyOnly')).toBe(false);
  });
});
