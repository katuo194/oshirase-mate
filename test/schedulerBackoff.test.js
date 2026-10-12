// Phase 6：バックオフ（4章）とオフライン判定（F-14）。基本のポーリング間隔は scheduler.test.js。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleApiError, KINDS } from '../src/main/apiErrors.js';
import { localTimestamp } from '../src/main/logger.js';
import { backoffDelayMs, createScheduler, formatDelay } from '../src/main/scheduler.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;

const netError = () => new GoogleApiError({ kind: KINDS.NETWORK, detail: 'fetch failed' });
const quotaError = () => new GoogleApiError({ kind: KINDS.QUOTA, status: 403, reason: 'rateLimitExceeded' });
const ok = async () => {};

/** poll が呼ばれた時刻（開始からの分）を記録する。behavior が throw すれば失敗 */
function recorder(behavior) {
  const at = [];
  const poll = async () => {
    at.push((Date.now() - NOW) / MIN);
    return behavior();
  };
  return { at, poll };
}

/** 2.1 の4系統。指定しない系統は常に成功する */
function create({ polls = {}, runImmediately = true, log = { info() {}, warn() {} } } = {}) {
  return createScheduler({
    sources: [
      { name: 'calendar', intervalSec: 300, poll: polls.calendar ?? ok },
      { name: 'tasks', intervalSec: 300, poll: polls.tasks ?? ok },
      { name: 'gmail-important', intervalSec: 60, poll: polls['gmail-important'] ?? ok },
      { name: 'gmail-other', intervalSec: 60, poll: polls['gmail-other'] ?? ok },
    ],
    runImmediately,
    log,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler / バックオフ（4章：1分→2分→4分、最大15分）', () => {
  it('backoffDelayMs は 1→2→4→8→15→15分', () => {
    expect([1, 2, 3, 4, 5, 6, 10, 100].map((n) => backoffDelayMs(n) / MIN)).toEqual([1, 2, 4, 8, 15, 15, 15, 15]);
    expect(formatDelay(90 * SEC)).toBe('1分30秒');
    expect(formatDelay(30 * SEC)).toBe('30秒');
    expect(formatDelay(4 * MIN)).toBe('4分');
  });

  it('失敗が続くとメール系統の実行は 0→1→3→7→15→30→45分', async () => {
    const r = recorder(() => {
      throw netError();
    });
    const s = create({ polls: { 'gmail-important': r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(46 * MIN);
    expect(r.at).toEqual([0, 1, 3, 7, 15, 30, 45]);
    s.stop();
  });

  it('カレンダー（通常5分）も失敗後は1分基準で再試行する（3回失敗までの時間が系統間で揃う）', async () => {
    const r = recorder(() => {
      throw netError();
    });
    const s = create({ runImmediately: false, polls: { calendar: r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(13 * MIN);
    expect(r.at).toEqual([5, 6, 8, 12]);
    s.stop();
  });

  it('成功したら通常間隔に戻る', async () => {
    let fail = true;
    const r = recorder(() => {
      if (fail) throw netError();
    });
    const s = create({ runImmediately: false, polls: { calendar: r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(6 * MIN); // 5分失敗・6分失敗
    fail = false;
    await vi.advanceTimersByTimeAsync(14 * MIN); // 8分成功 → 13分・18分
    expect(r.at).toEqual([5, 6, 8, 13, 18]);
    expect(s.getStats().find((x) => x.name === 'calendar')).toMatchObject({ consecutiveFailures: 0, backoffUntil: null });
    s.stop();
  });

  it('retryable:false の失敗（forbidden）もバックオフする（retryable は判定に使わない）', async () => {
    const r = recorder(() => {
      throw new GoogleApiError({ kind: KINDS.FORBIDDEN, status: 403, reason: 'accessNotConfigured' });
    });
    const s = create({ polls: { 'gmail-important': r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(7 * MIN);
    expect(r.at).toEqual([0, 1, 3, 7]);
    s.stop();
  });

  it('Retry-After がバックオフより長ければそちらを使う', async () => {
    const r = recorder(() => {
      throw new GoogleApiError({ kind: KINDS.RATE_LIMITED, status: 429, retryAfterMs: 5 * MIN });
    });
    const s = create({ polls: { 'gmail-important': r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(11 * MIN);
    expect(r.at).toEqual([0, 5, 10]);
    s.stop();
  });

  it('poll が戻らないまま次の予定が来ても、見送って次の機会を待つ（タイマーが途切れない）', async () => {
    let n = 0;
    let release;
    const s = create({
      polls: {
        'gmail-important': async () => {
          n++;
          if (n === 1) throw netError();
          if (n === 2) await new Promise((r) => (release = r)); // 1分後の再試行がぶら下がる
        },
      },
    });
    const skipped = [];
    s.events.on('skipped', (e) => skipped.push(e.name));
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(n).toBe(2);
    expect(skipped).toContain('gmail-important');
    release();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(n).toBe(3);
    s.stop();
  });

  it('ログに次の再試行までの間隔が出る（実機でバックオフを確認するため）', async () => {
    const warns = [];
    const s = create({
      polls: {
        'gmail-important': async () => {
          throw netError();
        },
      },
      log: { info() {}, warn: (m) => warns.push(m) },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    const lines = warns.filter((m) => m.includes('poll failed'));
    expect(lines[0]).toMatch(/gmail-important poll failed \(1連続\): network.*→ 次の再試行 1分後/);
    expect(lines[0]).toContain(`(${localTimestamp(NOW + MIN).slice(11, 19)})`);
    expect(lines[1]).toMatch(/\(2連続\).*次の再試行 2分後/);
    expect(lines[2]).toMatch(/\(3連続\).*次の再試行 4分後/);
    expect(warns.some((m) => m.includes('オフライン状態へ遷移'))).toBe(true);
    s.stop();
  });
});

describe('scheduler / オフライン判定（F-14）', () => {
  it('いずれか1系統が3回連続で接続失敗したらオフラインへ遷移する', async () => {
    const s = create({
      polls: {
        'gmail-important': async () => {
          throw netError();
        },
      },
    });
    const changes = [];
    s.events.on('offline-change', (e) => changes.push(e));
    s.start();
    await vi.advanceTimersByTimeAsync(1 * MIN); // 2回
    expect(s.isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * MIN); // 3回目（3分）
    expect(s.isOffline()).toBe(true);
    expect(changes).toEqual([{ offline: true, cause: { name: 'gmail-important', kind: 'network' } }]);
    s.stop();
  });

  it('接続失敗でない失敗（クォータ等）はオフラインに数えず、連続回数を0に戻す', async () => {
    const seq = [netError, netError, quotaError, netError, netError];
    let i = 0;
    const s = create({
      polls: {
        'gmail-important': async () => {
          throw (seq[i++] ?? netError)();
        },
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(15 * MIN); // 0,1,3,7,15 分
    expect(i).toBe(5);
    expect(s.isOffline()).toBe(false);
    expect(s.getStats().find((x) => x.name === 'gmail-important').offlineStreak).toBe(2);
    s.stop();
  });

  it('更新時のネットワーク断（auth_unavailable・offlineCandidate）はオフラインに数える', async () => {
    const authNet = () => new GoogleApiError({ kind: KINDS.AUTH_UNAVAILABLE, offlineCandidate: true });
    const s = create({
      polls: {
        'gmail-important': async () => {
          throw authNet();
        },
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(s.isOffline()).toBe(true);
    s.stop();
  });

  it('全系統が回復したら解除する。オフライン中に1系統が成功すると、バックオフ待ちの他系統を即時再試行する', async () => {
    let down = true;
    const calls = { calendar: 0 };
    const failWhileDown = (name) => async () => {
      calls[name] = (calls[name] ?? 0) + 1;
      if (down) throw netError();
    };
    const s = create({
      polls: { calendar: failWhileDown('calendar'), 'gmail-important': failWhileDown('gmail-important'), 'gmail-other': failWhileDown('gmail-other') },
    });
    const changes = [];
    s.events.on('offline-change', (e) => changes.push(e.offline));
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(s.isOffline()).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * MIN); // 8分：まだ落ちている（次の再試行は15分）
    const calendarBefore = calls.calendar;
    down = false;
    await s.runNow('gmail-important'); // 1系統が成功
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.calendar).toBe(calendarBefore + 1); // 15分を待たずに再試行された
    expect(s.isOffline()).toBe(false);
    expect(changes).toEqual([true, false]);
    s.stop();
  });

  it('1系統が回復しても、別の系統が閾値以上ならオフラインのまま', async () => {
    let calendarDown = true;
    const s = create({
      polls: {
        calendar: async () => {
          if (calendarDown) throw netError();
        },
        'gmail-important': async () => {
          throw netError();
        },
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN); // 両方とも3回失敗
    expect(s.isOffline()).toBe(true);
    calendarDown = false;
    await s.runNow('calendar');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.isOffline()).toBe(true); // gmail-important がまだ落ちている
    s.stop();
  });

  it('retryAllNow() でバックオフ待ちの系統をすぐ再試行する（OSのネットワーク復帰時）', async () => {
    let down = true;
    const r = recorder(() => {
      if (down) throw netError();
    });
    const s = create({ polls: { 'gmail-important': r.poll } });
    s.start();
    await vi.advanceTimersByTimeAsync(8 * MIN); // 0,1,3,7 失敗 → 次は15分
    down = false;
    s.retryAllNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.at).toEqual([0, 1, 3, 7, 8]);
    expect(s.isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1 * MIN); // 通常間隔（1分）に戻っている
    expect(r.at).toEqual([0, 1, 3, 7, 8, 9]);
    s.stop();
  });

  it('resetOffline() で解除される（連携が外れたとき）', async () => {
    const s = create({
      polls: {
        'gmail-important': async () => {
          throw netError();
        },
      },
    });
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(s.isOffline()).toBe(true);
    s.resetOffline();
    expect(s.isOffline()).toBe(false);
    s.stop();
  });
});
