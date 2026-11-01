import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRY_WARNING_LEAD_MS, TEST_MODE_LIFETIME_MS, createLinkExpiryWatch, expiryWarningAt } from '../src/main/linkExpiry.js';

// Google 連携が切れた・切れそうなときのお知らせ（Phase 16）。自分で作ったクライアントはテストモードのため 7 日で切れる
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T09:00:00+09:00');

function fakeAuth(initial) {
  const events = new EventEmitter();
  let state = initial;
  return {
    events,
    getState: () => ({ ...state }),
    set(next) {
      state = next;
      events.emit('change', { ...state });
    },
  };
}

function setup({ state = { status: 'linked', lastError: null, linkedAt: T0 }, origin = 'self' } = {}) {
  const auth = fakeAuth(state);
  const notify = vi.fn();
  const onChange = vi.fn();
  const ctx = { origin };
  const watch = createLinkExpiryWatch({
    auth,
    getOrigin: () => ctx.origin,
    notify,
    onChange,
    now: () => Date.now(),
    log: { info: () => {} },
  });
  return { auth, notify, onChange, watch, ctx };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe('expiryWarningAt', () => {
  it('自分で作ったクライアントだけ、同意から 6 日後', () => {
    expect(TEST_MODE_LIFETIME_MS).toBe(7 * DAY);
    expect(EXPIRY_WARNING_LEAD_MS).toBe(DAY);
    expect(expiryWarningAt({ origin: 'self', linkedAt: T0 })).toBe(T0 + 6 * DAY);
  });

  it('受け取ったクライアント・入手の道が不明・同意の時刻が不明なら予告しない（null）', () => {
    expect(expiryWarningAt({ origin: 'received', linkedAt: T0 })).toBeNull();
    expect(expiryWarningAt({ origin: null, linkedAt: T0 })).toBeNull();
    expect(expiryWarningAt({ origin: 'self', linkedAt: null })).toBeNull();
    expect(expiryWarningAt({ origin: 'self', linkedAt: undefined })).toBeNull();
  });
});

describe('createLinkExpiryWatch', () => {
  it('自分で作ったクライアント：6 日目に 1 回だけ予告し、右クリックメニューに出す', () => {
    const ctx = setup();
    expect(ctx.watch.needsRelink()).toBe(false);
    vi.advanceTimersByTime(6 * DAY - 1);
    expect(ctx.notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ctx.notify).toHaveBeenCalledExactlyOnceWith('expiring');
    expect(ctx.watch.needsRelink()).toBe(true);
    expect(ctx.onChange).toHaveBeenCalledTimes(1);
    // 同じ連携のまま状態が変わっても（連携し直しの途中など）、もう一度は予告しない
    ctx.auth.set({ status: 'linked', lastError: null, linkedAt: T0, relinking: true });
    ctx.auth.set({ status: 'linked', lastError: 'denied', linkedAt: T0 });
    vi.advanceTimersByTime(DAY);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    expect(ctx.watch.needsRelink()).toBe(true);
  });

  it('起動したときにもう 6 日を過ぎていれば、すぐに予告する', () => {
    vi.setSystemTime(T0 + 6.5 * DAY);
    const ctx = setup();
    expect(ctx.notify).toHaveBeenCalledExactlyOnceWith('expiring');
    expect(ctx.watch.needsRelink()).toBe(true);
  });

  it('連携し直したら（同意の時刻が変わったら）メニューから消し、新しい連携の 6 日目にまた予告する', () => {
    const ctx = setup();
    vi.advanceTimersByTime(6 * DAY);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    const relinkedAt = Date.now();
    ctx.auth.set({ status: 'linked', lastError: null, linkedAt: relinkedAt });
    expect(ctx.watch.needsRelink()).toBe(false);
    vi.advanceTimersByTime(6 * DAY);
    expect(ctx.notify).toHaveBeenCalledTimes(2);
    expect(ctx.watch.needsRelink()).toBe(true);
  });

  it('予告の前に連携し直した・解除したら予告しない', () => {
    const ctx = setup();
    vi.advanceTimersByTime(3 * DAY);
    ctx.auth.set({ status: 'linked', lastError: null, linkedAt: Date.now() }); // 連携し直した
    vi.advanceTimersByTime(3 * DAY);
    expect(ctx.notify).not.toHaveBeenCalled();
    ctx.auth.set({ status: 'unlinked', lastError: null }); // 解除した
    vi.advanceTimersByTime(10 * DAY);
    expect(ctx.notify).not.toHaveBeenCalled();
    expect(ctx.watch.needsRelink()).toBe(false);
  });

  it('受け取ったクライアント・入手の道が不明・同意の時刻が不明（Phase 16 より前の連携）は予告しない', () => {
    for (const [origin, linkedAt] of [
      ['received', T0],
      [null, T0],
      ['self', null],
    ]) {
      const ctx = setup({ origin, state: { status: 'linked', lastError: null, linkedAt } });
      vi.advanceTimersByTime(8 * DAY);
      expect(ctx.notify).not.toHaveBeenCalled();
      expect(ctx.watch.needsRelink()).toBe(false);
      ctx.watch.dispose();
    }
  });

  it('連携が切れたら（invalid_grant で未連携）知らせ、連携するまでメニューに出す。受け取ったクライアントでも同じ', () => {
    const ctx = setup({ origin: 'received' });
    ctx.auth.set({ status: 'unlinked', lastError: 'expired' });
    expect(ctx.notify).toHaveBeenCalledExactlyOnceWith('expired');
    expect(ctx.watch.needsRelink()).toBe(true);
    // 連携し直そうとして失敗しても、メニューは出したまま（お知らせは繰り返さない）
    ctx.auth.set({ status: 'linking', lastError: null });
    ctx.auth.set({ status: 'unlinked', lastError: 'denied' });
    expect(ctx.watch.needsRelink()).toBe(true);
    expect(ctx.notify).toHaveBeenCalledTimes(1);
    ctx.auth.set({ status: 'linked', lastError: null, linkedAt: Date.now() });
    expect(ctx.watch.needsRelink()).toBe(false);
  });

  it('作る前に起動時の確認で切れていた場合も知らせる', () => {
    const ctx = setup({ state: { status: 'unlinked', lastError: 'expired' } });
    expect(ctx.notify).toHaveBeenCalledExactlyOnceWith('expired');
    expect(ctx.watch.needsRelink()).toBe(true);
  });

  it('クライアントを削除したら（未設定）メニューから消す', () => {
    const ctx = setup({ state: { status: 'unlinked', lastError: 'expired' } });
    ctx.auth.set({ status: 'unconfigured', configProblem: 'missing_client_id', lastError: null });
    expect(ctx.watch.needsRelink()).toBe(false);
  });

  it('クライアントの入手の道が後から分かったら（refresh）、合わせ直す', () => {
    const ctx = setup({ origin: null });
    vi.advanceTimersByTime(6 * DAY);
    expect(ctx.notify).not.toHaveBeenCalled();
    ctx.ctx.origin = 'self';
    ctx.watch.refresh();
    expect(ctx.notify).toHaveBeenCalledExactlyOnceWith('expiring');
  });

  it('dispose したら予告しない', () => {
    const ctx = setup();
    ctx.watch.dispose();
    vi.advanceTimersByTime(7 * DAY);
    ctx.auth.set({ status: 'unlinked', lastError: 'expired' });
    expect(ctx.notify).not.toHaveBeenCalled();
  });
});
