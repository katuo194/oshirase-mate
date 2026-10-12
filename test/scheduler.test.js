import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from '../src/main/scheduler.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');
const SEC = 1000;

// 2.1 / 6.1 のポーリング間隔
const INTERVALS = { calendar: 300, tasks: 300, mailImportant: 60, mailOther: 60 };

let counts;

/** 4系統ぶんの sources を作る。poll は呼ばれた回数を数えるだけ */
function makeSources(overrides = {}) {
  counts = { calendar: 0, tasks: 0, mailImportant: 0, mailOther: 0 };
  return Object.entries(INTERVALS).map(([name, intervalSec]) => ({
    name,
    intervalSec,
    poll:
      overrides[name] ??
      (async () => {
        counts[name]++;
      }),
  }));
}

const create = (opts = {}) => createScheduler({ sources: makeSources(opts.overrides), log: { info() {}, warn() {} }, ...opts });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler / ポーリング間隔（2.1）', () => {
  it('メールは1分ごと、カレンダーとTODOは5分ごとに呼ばれる', async () => {
    const s = create({ runImmediately: false });
    s.start();

    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(counts).toEqual({ calendar: 0, tasks: 0, mailImportant: 1, mailOther: 1 });

    await vi.advanceTimersByTimeAsync(4 * 60 * SEC); // 通算5分
    expect(counts).toEqual({ calendar: 1, tasks: 1, mailImportant: 5, mailOther: 5 });

    await vi.advanceTimersByTimeAsync(5 * 60 * SEC); // 通算10分
    expect(counts).toEqual({ calendar: 2, tasks: 2, mailImportant: 10, mailOther: 10 });
  });

  it('start() 直後に1回実行する（起動直後の通知を取りこぼさない）', async () => {
    const s = create();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toEqual({ calendar: 1, tasks: 1, mailImportant: 1, mailOther: 1 });
  });

  it('stop() で全系統が止まる', async () => {
    const s = create({ runImmediately: false });
    s.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * SEC);
    s.stop();
    expect(s.isRunning()).toBe(false);

    const before = { ...counts };
    await vi.advanceTimersByTimeAsync(30 * 60 * SEC);
    expect(counts).toEqual(before);
  });

  it('多重 start() は無視する（タイマーが二重に走らない）', async () => {
    const s = create({ runImmediately: false });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(counts.mailImportant).toBe(1);
  });

  it('runNow() で指定系統だけ即座に実行できる', async () => {
    const s = create({ runImmediately: false });
    s.start();
    await s.runNow('calendar');
    expect(counts).toMatchObject({ calendar: 1, tasks: 0 });
    await s.runNow('存在しない系統'); // 落ちない
  });
});

describe('scheduler / 失敗と滞留への耐性', () => {
  it('1系統が例外を投げても他系統は止まらない', async () => {
    const s = create({
      runImmediately: false,
      overrides: {
        calendar: async () => {
          throw new Error('オフライン');
        },
      },
    });
    const errors = [];
    s.events.on('failed', (e) => errors.push(e));
    s.start();

    await vi.advanceTimersByTimeAsync(10 * 60 * SEC);
    expect(counts.mailImportant).toBe(10);
    expect(counts.tasks).toBe(2);
    // 5分で初回失敗 → 1分後（6分）→ 2分後（8分）。失敗後はバックオフで再試行される
    expect(errors).toHaveLength(3);
    expect(errors.at(-1)).toMatchObject({ name: 'calendar', consecutiveFailures: 3 });
  });

  it('失敗イベントの購読者が誰もいなくても落ちない', async () => {
    // EventEmitter は 'error' という名前のイベントにリスナーが無いと emit で throw する。
    // 失敗通知にその名前を使っていないことの回帰テスト
    const s = create({
      runImmediately: false,
      overrides: {
        calendar: async () => {
          throw new Error('オフライン');
        },
      },
    });
    s.start();
    await expect(vi.advanceTimersByTimeAsync(10 * 60 * SEC)).resolves.not.toThrow();
    expect(s.getStats().find((x) => x.name === 'calendar').consecutiveFailures).toBe(3);
    s.stop();
  });

  it('連続失敗回数を数え、成功したらリセットする（Phase 6 のオフライン判定の入力）', async () => {
    let fail = true;
    const s = create({
      runImmediately: false,
      overrides: {
        mailImportant: async () => {
          if (fail) throw new Error('オフライン');
        },
      },
    });
    s.start();

    await vi.advanceTimersByTimeAsync(4 * 60 * SEC); // 失敗：1分・2分・4分
    expect(s.getStats().find((x) => x.name === 'mailImportant').consecutiveFailures).toBe(3);

    fail = false;
    await vi.advanceTimersByTimeAsync(4 * 60 * SEC); // 次の再試行は4分後
    expect(s.getStats().find((x) => x.name === 'mailImportant').consecutiveFailures).toBe(0);
  });

  it('前回のポーリングが終わっていなければ今回は見送る（応答が遅くても積み上がらない）', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let started = 0;
    const s = create({
      runImmediately: false,
      overrides: {
        mailImportant: async () => {
          started++;
          await gate;
        },
      },
    });
    const skipped = [];
    s.events.on('skipped', (e) => skipped.push(e.name));
    s.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * SEC); // 5回ぶんの間隔が経過
    expect(started).toBe(1);
    expect(skipped).toHaveLength(4);

    release();
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(started).toBe(2);
  });

  it('成功のたびに polled イベントで結果を渡す（Phase 4 で通知キューに繋ぐ口）', async () => {
    const s = create({
      runImmediately: false,
      overrides: { calendar: async () => ['通知1', '通知2'] },
    });
    const seen = [];
    s.events.on('polled', (e) => seen.push(e));
    s.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * SEC);
    expect(seen.find((e) => e.name === 'calendar').result).toEqual(['通知1', '通知2']);
  });
});
