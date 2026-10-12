import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHDOG_MARGIN_MS, createNotificationPresenter } from '../src/main/notificationPresenter.js';
import { SOURCES, createNotifyQueue, makeNotificationId } from '../src/main/notifyQueue.js';
import { IDLE_HOLD_MS, idlePresentation, systemPresentation } from '../src/main/notificationView.js';

const NOW = Date.parse('2026-09-21T09:00:00Z');

const mail = (id) => ({
  id: makeNotificationId(SOURCES.GMAIL, id),
  source: SOURCES.GMAIL,
  title: `件名${id}`,
  body: '田中',
  notifyAt: NOW,
  data: {},
});
const mailId = (id) => makeNotificationId(SOURCES.GMAIL, id);
const idle = (n = 1) => idlePresentation({ id: `idle:${n}`, text: 'ふわぁ…ちょっとぼーっとしちゃった。' });

function setup({ ready = true } = {}) {
  const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
  const log = { info: vi.fn(), warn: vi.fn() };
  const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
  const shown = [];
  const finished = [];
  const aborted = [];
  const presenter = createNotificationPresenter({
    notifyQueue,
    show: (p, n) => shown.push({ id: p.id, notification: n }),
    finish: (p, reason) => finished.push([p.id, reason]),
    abort: (p) => aborted.push(p.id),
    now: () => Date.now(),
    log,
  });
  presenter.start();
  if (ready) presenter.setRendererReady(true);
  return { notifyQueue, presenter, shown, finished, aborted, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('notificationPresenter / アイドルトークの受理条件（showIdle・F-15）', () => {
  it('何も表示しておらずキューも空なら受理して表示する（通知として記録されない）', () => {
    const { presenter, shown, notifyQueue } = setup();
    expect(presenter.showIdle(idle())).toBe(true);
    expect(shown).toEqual([{ id: 'idle:1', notification: null }]);
    expect(presenter.currentId()).toBe('idle:1');
    expect(notifyQueue.size()).toBe(0);
  });

  it('通知の表示中は受理しない', () => {
    const { presenter, notifyQueue, shown } = setup();
    notifyQueue.push(mail('m1'));
    expect(presenter.showIdle(idle())).toBe(false);
    expect(shown.map((s) => s.id)).toEqual([mailId('m1')]);
  });

  it('通知がキューで待っている間（ドラッグで取り出しが止まっているとき）は受理しない', () => {
    const { presenter, notifyQueue } = setup();
    presenter.setDragging(true);
    notifyQueue.push(mail('m1'));
    presenter.setDragging(false); // 取り出しが再開して m1 を表示
    presenter.done(mailId('m1'));
    notifyQueue.pause();
    notifyQueue.push(mail('m2'));
    expect(notifyQueue.size()).toBe(1);
    expect(presenter.showIdle(idle())).toBe(false);
  });

  it('システム通知の待ち・ドラッグ中・レンダラー未準備・開始前は受理しない', () => {
    const a = setup({ ready: false });
    expect(a.presenter.showIdle(idle())).toBe(false);

    const b = setup();
    b.presenter.setDragging(true);
    expect(b.presenter.showIdle(idle())).toBe(false);

    const c = setup();
    c.presenter.showSystem(systemPresentation({ id: 'sys:1', title: 'お知らせ' }));
    // システム通知が表示中なので受理しない（表示中の演出は中断しない）
    expect(c.presenter.showIdle(idle())).toBe(false);

    const d = setup();
    d.presenter.stop();
    expect(d.presenter.showIdle(idle())).toBe(false);
  });

  it('アイドルトーク表示中は、次のアイドルトークを受理しない（1件ずつ）', () => {
    const { presenter } = setup();
    expect(presenter.showIdle(idle(1))).toBe(true);
    expect(presenter.showIdle(idle(2))).toBe(false);
  });

  it('表示完了（done）で終わり、reason は done。その後は再び受理できる', () => {
    const { presenter, finished } = setup();
    presenter.showIdle(idle(1));
    expect(presenter.done('idle:1')).toBe(true);
    expect(finished).toEqual([['idle:1', 'done']]);
    expect(presenter.showIdle(idle(2))).toBe(true);
  });

  it('表示の開始で例外が出ても止まらない（次のアイドルトークを受理できる）', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const log = { info: vi.fn(), warn: vi.fn() };
    let fail = true;
    const presenter = createNotificationPresenter({
      notifyQueue,
      show: () => {
        if (fail) throw new Error('boom');
      },
      log,
    });
    presenter.start();
    presenter.setRendererReady(true);
    expect(presenter.showIdle(idle(1))).toBe(false);
    expect(presenter.currentId()).toBeNull();
    fail = false;
    expect(presenter.showIdle(idle(2))).toBe(true);
  });
});

describe('notificationPresenter / 通知が優先：アイドルトークの中断（v5.8）', () => {
  it('アイドルトーク表示中に通知が来たら abort を発行し、その done の後に通知を表示する', () => {
    const { presenter, notifyQueue, shown, aborted, finished } = setup();
    presenter.showIdle(idle());
    notifyQueue.push(mail('m1'));

    expect(aborted).toEqual(['idle:1']);
    // まだ絞りの途中：通知は始めない（表示は重ならない）
    expect(shown.map((s) => s.id)).toEqual(['idle:1']);
    expect(notifyQueue.size()).toBe(1);

    presenter.done('idle:1'); // レンダラーが絞りを終えて返す
    expect(finished).toEqual([['idle:1', 'done']]);
    expect(shown.map((s) => s.id)).toEqual(['idle:1', mailId('m1')]);
    expect(notifyQueue.size()).toBe(0);
  });

  it('システム通知（オフライン等）が来たときも中断し、その完了後にシステム通知を表示する', () => {
    const { presenter, shown, aborted } = setup();
    presenter.showIdle(idle());
    presenter.showSystem(systemPresentation({ id: 'sys:1', title: 'つながらないみたい' }));
    expect(aborted).toEqual(['idle:1']);
    presenter.done('idle:1');
    expect(shown.map((s) => s.id)).toEqual(['idle:1', 'sys:1']);
  });

  it('中断の指示は1回だけ（通知が続けて来ても重ねて abort しない）', () => {
    const { presenter, notifyQueue, aborted } = setup();
    presenter.showIdle(idle());
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    expect(aborted).toEqual(['idle:1']);
  });

  it('通知の表示中に来た通知は、中断の対象にならない（通常どおりキューに並ぶ）', () => {
    const { presenter, notifyQueue, aborted, shown } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    expect(aborted).toEqual([]);
    expect(shown.map((s) => s.id)).toEqual([mailId('m1')]);
    expect(presenter.currentId()).toBe(mailId('m1'));
  });

  it('中断後にレンダラーが応答しなくても、絞りの時間＋余裕で強制完了し、通知が始まる（キューが止まらない）', () => {
    const { presenter, notifyQueue, shown, finished, log } = setup();
    presenter.showIdle(idle());
    notifyQueue.push(mail('m1'));
    expect(shown.map((s) => s.id)).toEqual(['idle:1']);

    const { outMs } = idle().timing;
    vi.advanceTimersByTime(outMs + WATCHDOG_MARGIN_MS - 1);
    expect(shown.map((s) => s.id)).toEqual(['idle:1']);
    vi.advanceTimersByTime(1);
    expect(finished).toEqual([['idle:1', 'timeout']]);
    expect(shown.map((s) => s.id)).toEqual(['idle:1', mailId('m1')]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('中断後の読み上げ延長（extend）は受け付けない（絞りに入った後に延ばさない）', () => {
    const { presenter, notifyQueue } = setup();
    presenter.showIdle(idle());
    expect(presenter.extend('idle:1', 20000)).toBe(true); // 中断前は延長できる（読み上げが届いた場合）
    notifyQueue.push(mail('m1'));
    expect(presenter.extend('idle:1', 20000)).toBe(false);
  });

  it('abort の例外は握りつぶし、通知はウォッチドッグ経由で進む', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const log = { info: vi.fn(), warn: vi.fn() };
    const shown = [];
    const presenter = createNotificationPresenter({
      notifyQueue,
      show: (p) => shown.push(p.id),
      abort: () => {
        throw new Error('window gone');
      },
      now: () => Date.now(),
      log,
    });
    presenter.start();
    presenter.setRendererReady(true);
    presenter.showIdle(idle());
    expect(() => notifyQueue.push(mail('m1'))).not.toThrow();
    vi.advanceTimersByTime(idle().timing.outMs + WATCHDOG_MARGIN_MS);
    expect(shown).toEqual(['idle:1', mailId('m1')]);
  });

  it('通常のアイドルトーク完了（保持時間の経過）ではウォッチドッグは発火しない（done が来る）', () => {
    const { presenter, finished } = setup();
    presenter.showIdle(idle());
    vi.advanceTimersByTime(IDLE_HOLD_MS);
    presenter.done('idle:1');
    vi.advanceTimersByTime(60_000);
    expect(finished).toEqual([['idle:1', 'done']]);
  });
});
