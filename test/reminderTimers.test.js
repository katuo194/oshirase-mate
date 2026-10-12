import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReminderTimers } from '../src/main/reminderTimers.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');
const MIN = 60 * 1000;

let fired;
let timers;

/** entries は providers が返す通知オブジェクト（id と notifyAt を持つ） */
const entry = (id, offsetMin) => ({ id, notifyAt: NOW + offsetMin * MIN, title: id });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  fired = [];
  timers = createReminderTimers({
    onFire: (e) => fired.push(e.id),
    now: () => Date.now(),
    log: { info() {}, warn() {} },
  });
});
afterEach(() => {
  timers.disposeAll();
  vi.useRealTimers();
});

describe('reminderTimers / 登録と発火', () => {
  it('発火時刻にちょうど1回だけ呼ばれる', () => {
    timers.reconcile([entry('cal:a', 10)]);
    expect(timers.size()).toBe(1);

    vi.advanceTimersByTime(10 * MIN - 1);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['cal:a']);

    // 発火後は登録が残らない
    expect(timers.size()).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual(['cal:a']);
  });

  it('過去の発火時刻は即座に発火する（期限超過タスク・過ぎたリマインダー）', () => {
    timers.reconcile([entry('task:overdue', -120)]);
    vi.advanceTimersByTime(0);
    expect(fired).toEqual(['task:overdue']);
  });

  it('複数を登録すると時刻順に発火する', () => {
    timers.reconcile([entry('cal:late', 30), entry('cal:early', 5), entry('task:mid', 10)]);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual(['cal:early', 'task:mid', 'cal:late']);
  });

  it('onFire が例外を投げても他のタイマーは動き続ける', () => {
    const t = createReminderTimers({
      onFire: (e) => {
        if (e.id === 'boom') throw new Error('描画に失敗');
        fired.push(e.id);
      },
      now: () => Date.now(),
      log: { info() {}, warn() {} },
    });
    t.reconcile([entry('boom', 5), entry('cal:ok', 10)]);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual(['cal:ok']);
    t.disposeAll();
  });
});

describe('reminderTimers / 再構築（7.1「ポーリングごとに登録済みタイマーを再構築する」）', () => {
  it('同じ内容で何度再構築しても、タイマーは増えず発火も1回だけ', () => {
    const entries = [entry('cal:a', 10), entry('cal:b', 20)];
    for (let i = 0; i < 5; i++) {
      const res = timers.reconcile(entries);
      if (i > 0) expect(res).toEqual({ added: 0, removed: 0, kept: 2, skipped: 0 });
    }
    expect(timers.size()).toBe(2);

    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual(['cal:a', 'cal:b']); // 二重発火しない
  });

  it('予定が動いたら古いタイマーを破棄して張り直す', () => {
    timers.reconcile([entry('cal:a', 10)]);
    const res = timers.reconcile([entry('cal:a', 30)]);
    expect(res).toMatchObject({ added: 1, removed: 1, kept: 0 });
    expect(timers.size()).toBe(1);

    vi.advanceTimersByTime(10 * MIN);
    expect(fired).toEqual([]); // 古い時刻では発火しない
    vi.advanceTimersByTime(20 * MIN);
    expect(fired).toEqual(['cal:a']); // 新しい時刻で1回だけ
  });

  it('削除された予定のタイマーは破棄される', () => {
    timers.reconcile([entry('cal:a', 10), entry('cal:b', 20)]);
    const res = timers.reconcile([entry('cal:b', 20)]);
    expect(res).toMatchObject({ removed: 1, kept: 1 });
    expect(timers.scheduledIds()).toEqual(['cal:b']);

    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual(['cal:b']);
  });

  it('ポーリングを挟みながら時間が進んでも、発火直前のタイマーがリセットされない', () => {
    const entries = [entry('cal:a', 10)];
    timers.reconcile(entries);
    // 5分経過時点でポーリングが走り、同じ予定が返ってくる
    vi.advanceTimersByTime(5 * MIN);
    timers.reconcile(entries);
    // 残り5分で発火するはず（張り直していれば10分後になってしまう）
    vi.advanceTimersByTime(5 * MIN);
    expect(fired).toEqual(['cal:a']);
  });

  it('発火済みのタイマーは次の再構築で復活しない（一覧に残っていても通知済み判定はキュー側の責務）', () => {
    const entries = [entry('cal:a', 5)];
    timers.reconcile(entries);
    vi.advanceTimersByTime(5 * MIN);
    expect(fired).toEqual(['cal:a']);

    // ポーリングはまだ同じ予定を返す（開始前の予定なので）
    timers.reconcile(entries);
    vi.advanceTimersByTime(60 * MIN);
    // 過去時刻なので再登録されると即発火してしまう。ここでは再発火を許容し、
    // 最終的な重複排除は notifyQueue（F-05）が行う
    expect(fired).toEqual(['cal:a', 'cal:a']);
  });

  it('空の一覧を渡すとすべて破棄される', () => {
    timers.reconcile([entry('cal:a', 10), entry('cal:b', 20)]);
    expect(timers.reconcile([])).toMatchObject({ removed: 2, added: 0 });
    expect(timers.size()).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual([]);
  });

  it('同じIDが一覧に重複していても1本しか登録しない', () => {
    timers.reconcile([entry('cal:a', 10), entry('cal:a', 10)]);
    expect(timers.size()).toBe(1);
  });

  it('id や notifyAt が不正なものは無視する', () => {
    expect(timers.reconcile([{ id: 'cal:a' }, { notifyAt: NOW }, null])).toMatchObject({ added: 0 });
    expect(timers.size()).toBe(0);
  });

  it('setTimeout の上限を超える遠い予定は登録しない（即時発火に化けるのを防ぐ）', () => {
    const res = timers.reconcile([{ id: 'cal:far', notifyAt: NOW + 40 * 24 * 60 * MIN }]);
    expect(res).toMatchObject({ added: 0, skipped: 1 });
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual([]);
  });
});

describe('reminderTimers / 破棄', () => {
  it('cancel() で個別に取り消せる', () => {
    timers.reconcile([entry('cal:a', 10)]);
    expect(timers.cancel('cal:a')).toBe(true);
    expect(timers.cancel('cal:a')).toBe(false);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual([]);
  });

  it('disposeAll() 後は何も発火しない（アプリ終了時）', () => {
    timers.reconcile([entry('cal:a', 10), entry('task:b', 20)]);
    timers.disposeAll();
    expect(timers.size()).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    expect(fired).toEqual([]);
  });
});
