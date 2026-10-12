import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WATCHDOG_MARGIN_MS, createNotificationPresenter } from '../src/main/notificationPresenter.js';
import { SOURCES, createNotifyQueue, makeNotificationId } from '../src/main/notifyQueue.js';
import { systemPresentation, toPresentation, totalMs } from '../src/main/notificationView.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');

const mail = (id) => ({
  id: makeNotificationId(SOURCES.GMAIL, id),
  source: SOURCES.GMAIL,
  title: `件名${id}`,
  body: '田中',
  notifyAt: NOW,
  data: {},
});
const mailId = (id) => makeNotificationId(SOURCES.GMAIL, id);

function setup({ ready = true } = {}) {
  const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
  const log = { info: vi.fn(), warn: vi.fn() };
  const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
  const shown = [];
  const finished = [];
  const presenter = createNotificationPresenter({
    notifyQueue,
    show: (p) => shown.push(p.id),
    finish: (p, reason) => finished.push([p.id, reason]),
    now: () => NOW,
    log,
  });
  presenter.start();
  if (ready) presenter.setRendererReady(true);
  return { notifyQueue, presenter, shown, finished, log, store };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('notificationPresenter / F-08 表示側：重ならずキュー順に1件ずつ', () => {
  it('通知が来ると表示を始める（take される＝通知済みとして記録される）', async () => {
    const { notifyQueue, shown } = setup();
    notifyQueue.push(mail('m1'));
    expect(shown).toEqual([mailId('m1')]);
    expect(notifyQueue.size()).toBe(0);
    expect(notifyQueue.isNotified(mailId('m1'))).toBe(true);
    await notifyQueue.whenPersisted();
  });

  it('5件同時に来ても、表示中は次を取り出さない（アニメーションが重ならない）', () => {
    const { notifyQueue, shown } = setup();
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) notifyQueue.push(mail(id));
    expect(shown).toEqual([mailId('m1')]);
    expect(notifyQueue.size()).toBe(4); // 残りは未取り出しのままキューに並ぶ
    expect(notifyQueue.isNotified(mailId('m2'))).toBe(false);
  });

  it('表示完了（done）ごとに、次の1件を到着順（FIFO）で取り出す', () => {
    const { notifyQueue, presenter, shown } = setup();
    for (const id of ['m1', 'm2', 'm3']) notifyQueue.push(mail(id));

    expect(presenter.done(mailId('m1'))).toBe(true);
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
    expect(notifyQueue.size()).toBe(1);

    presenter.done(mailId('m2'));
    presenter.done(mailId('m3'));
    expect(shown).toEqual([mailId('m1'), mailId('m2'), mailId('m3')]);
    expect(presenter.currentId()).toBeNull();
    expect(notifyQueue.size()).toBe(0);
  });

  it('take() は表示完了ごとに1回だけ（表示中に余分に取り出さない）', () => {
    const { notifyQueue, presenter } = setup();
    const take = vi.spyOn(notifyQueue, 'take');
    for (const id of ['m1', 'm2', 'm3']) notifyQueue.push(mail(id));
    // 最初の表示で1回（以降の push では表示中なので取り出さない）
    expect(take).toHaveBeenCalledTimes(1);

    presenter.done(mailId('m1'));
    expect(take).toHaveBeenCalledTimes(2);
    presenter.done(mailId('m2'));
    expect(take).toHaveBeenCalledTimes(3);
    presenter.done(mailId('m3'));
    expect(take).toHaveBeenCalledTimes(4); // 最後の done でキューが空か確認する1回
  });

  it('現在の演出と一致しない done（古い応答・重複応答）は無視する', () => {
    const { notifyQueue, presenter, shown } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    expect(presenter.done(mailId('m2'))).toBe(false); // まだ表示していない通知
    expect(presenter.done('mail:unknown')).toBe(false);
    expect(shown).toEqual([mailId('m1')]);

    expect(presenter.done(mailId('m1'))).toBe(true);
    expect(presenter.done(mailId('m1'))).toBe(false); // 二重応答
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
  });

  it('表示待ちの後続があると、保持時間が短縮された表示データが渡される', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const presentations = [];
    const presenter = createNotificationPresenter({ notifyQueue, show: (p) => presentations.push(p), now: () => NOW });
    presenter.start();
    presenter.setRendererReady(true);
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    presenter.done(mailId('m1'));
    expect(presentations[0].timing.holdMs).toBe(5000); // 表示開始時点で後続なし
    expect(presentations[1].timing.holdMs).toBe(5000);

    notifyQueue.push(mail('m3'));
    notifyQueue.push(mail('m4'));
    presenter.done(mailId('m2'));
    expect(presentations[2].timing.holdMs).toBe(3000); // m4 が待っている
  });
});

describe('notificationPresenter / 3.7 ドラッグ中は pause、終了で resume', () => {
  it('ドラッグ中に来た通知は表示されずキューに溜まり、終了後に到着順で表示される', () => {
    const { notifyQueue, presenter, shown } = setup();
    presenter.setDragging(true);
    expect(notifyQueue.isPaused()).toBe(true);

    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    expect(shown).toEqual([]);
    expect(notifyQueue.size()).toBe(2);

    presenter.setDragging(false);
    expect(notifyQueue.isPaused()).toBe(false);
    expect(shown).toEqual([mailId('m1')]);
    presenter.done(mailId('m1'));
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
  });

  it('すでに始まっている表示はドラッグで止まらず、完了後の次の取り出しだけが待たされる', () => {
    const { notifyQueue, presenter, shown, finished } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    presenter.setDragging(true);

    presenter.done(mailId('m1')); // ドラッグ中に m1 の演出が終わる
    expect(finished).toEqual([[mailId('m1'), 'done']]);
    expect(shown).toEqual([mailId('m1')]); // m2 はまだ
    expect(notifyQueue.size()).toBe(1);

    presenter.setDragging(false);
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
  });

  it('setDragging の重複呼び出しは無害（pause/resume は各1回）', () => {
    const { notifyQueue, presenter } = setup();
    const pause = vi.spyOn(notifyQueue, 'pause');
    const resume = vi.spyOn(notifyQueue, 'resume');
    presenter.setDragging(true);
    presenter.setDragging(true);
    presenter.setDragging(false);
    presenter.setDragging(false);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(presenter.isDragging()).toBe(false);
  });
});

describe('notificationPresenter / レンダラーの準備状態', () => {
  it('準備完了前は取り出さず、準備完了で表示を始める', () => {
    const { notifyQueue, presenter, shown } = setup({ ready: false });
    notifyQueue.push(mail('m1'));
    expect(shown).toEqual([]);
    expect(notifyQueue.size()).toBe(1);

    presenter.setRendererReady(true);
    expect(shown).toEqual([mailId('m1')]);
  });

  it('レンダラーが落ちたら表示中を中断し、戻ったら続きを表示する', () => {
    const { notifyQueue, presenter, shown, finished } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));

    presenter.setRendererReady(false);
    expect(finished).toEqual([[mailId('m1'), 'renderer-gone']]);
    expect(presenter.currentId()).toBeNull();
    expect(shown).toEqual([mailId('m1')]); // m2 は取り出されない

    presenter.setRendererReady(true);
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
  });
});

describe('notificationPresenter / ウォッチドッグ', () => {
  it('done が来なければ、想定時間＋余裕のあとに強制完了して次へ進む', () => {
    const { notifyQueue, shown, finished, log } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    // m1 の表示開始時点では後続（m2）はまだ積まれていない（backlog 0）
    const limit = totalMs(toPresentation(mail('m1'), { now: NOW, backlog: 0 }).timing) + WATCHDOG_MARGIN_MS;

    vi.advanceTimersByTime(limit - 1);
    expect(shown).toEqual([mailId('m1')]);

    vi.advanceTimersByTime(1);
    expect(finished).toEqual([[mailId('m1'), 'timeout']]);
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('done が間に合えばウォッチドッグは発火しない', () => {
    const { notifyQueue, presenter, finished, log } = setup();
    notifyQueue.push(mail('m1'));
    presenter.done(mailId('m1'));
    vi.advanceTimersByTime(60_000);
    expect(finished).toEqual([[mailId('m1'), 'done']]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('notificationPresenter / 障害耐性・ライフサイクル', () => {
  it('show が例外を投げても、その通知を諦めて次の通知へ進む', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const shown = [];
    const finished = [];
    const log = { info() {}, warn: vi.fn() };
    const presenter = createNotificationPresenter({
      notifyQueue,
      show: (p) => {
        shown.push(p.id);
        if (p.id === mailId('bad')) throw new Error('boom');
      },
      finish: (p, reason) => finished.push([p.id, reason]),
      now: () => NOW,
      log,
    });
    presenter.start();
    presenter.setRendererReady(true);

    notifyQueue.push(mail('bad'));
    notifyQueue.push(mail('ok'));
    expect(shown).toEqual([mailId('bad'), mailId('ok')]);
    expect(finished).toEqual([[mailId('bad'), 'stopped']]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('stop() 後は購読しない。表示中なら終了させる。start() の二重呼び出しでも二重に表示しない', () => {
    const { notifyQueue, presenter, shown, finished } = setup();
    presenter.start();
    notifyQueue.push(mail('m1'));
    expect(shown).toHaveLength(1);

    presenter.stop();
    expect(finished).toEqual([[mailId('m1'), 'stopped']]);
    notifyQueue.push(mail('m2'));
    expect(shown).toHaveLength(1);
    expect(notifyQueue.size()).toBe(1);
  });

  it('finish の例外は握りつぶして次へ進む', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const shown = [];
    const presenter = createNotificationPresenter({
      notifyQueue,
      show: (p) => shown.push(p.id),
      finish: () => {
        throw new Error('resize failed');
      },
      now: () => NOW,
      log: { info() {}, warn() {} },
    });
    presenter.start();
    presenter.setRendererReady(true);
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    expect(() => presenter.done(mailId('m1'))).not.toThrow();
    expect(shown).toEqual([mailId('m1'), mailId('m2')]);
  });
});

describe('notificationPresenter / Phase 6：読み上げによる延長・システム通知', () => {
  it('extend() でウォッチドッグが「表示開始から指定時間＋余裕」まで延びる', () => {
    const { notifyQueue, presenter, finished } = setup();
    notifyQueue.push(mail('m1'));
    const base = totalMs(toPresentation(mail('m1'), { now: NOW }).timing) + WATCHDOG_MARGIN_MS;
    expect(presenter.extend(mailId('m1'), 20000 + 500)).toBe(true);
    vi.advanceTimersByTime(base + 1);
    expect(finished).toEqual([]); // 元のウォッチドッグでは切られない
    vi.advanceTimersByTime(20000 + 500 + WATCHDOG_MARGIN_MS - base);
    expect(finished).toEqual([[mailId('m1'), 'timeout']]);
  });

  it('extend() は表示中でない id を無視する', () => {
    const { notifyQueue, presenter } = setup();
    expect(presenter.extend('nothing', 10000)).toBe(false);
    notifyQueue.push(mail('m1'));
    expect(presenter.extend(mailId('m2'), 10000)).toBe(false);
  });

  it('showSystem() はキューの次の通知より先に、表示中の演出の後に出る', () => {
    const { notifyQueue, presenter, shown } = setup();
    notifyQueue.push(mail('m1'));
    notifyQueue.push(mail('m2'));
    presenter.showSystem(systemPresentation({ id: 'system:offline:1', title: 'つながらない' }));
    expect(shown).toEqual([mailId('m1')]); // 表示中は割り込まない
    presenter.done(mailId('m1'));
    expect(shown).toEqual([mailId('m1'), 'system:offline:1']);
    presenter.done('system:offline:1');
    expect(shown).toEqual([mailId('m1'), 'system:offline:1', mailId('m2')]);
  });

  it('何も表示していなければ showSystem() はすぐ出る。notifyQueue の通知済みには載らない', () => {
    const { notifyQueue, presenter, shown } = setup();
    presenter.showSystem(systemPresentation({ id: 'system:offline:1', title: 'つながらない' }));
    expect(shown).toEqual(['system:offline:1']);
    expect(notifyQueue.isNotified('system:offline:1')).toBe(false);
  });

  it('レンダラー未準備なら showSystem() は準備完了まで待つ', () => {
    const { presenter, shown } = setup({ ready: false });
    presenter.showSystem(systemPresentation({ id: 'system:offline:1', title: 'つながらない' }));
    expect(shown).toEqual([]);
    presenter.setRendererReady(true);
    expect(shown).toEqual(['system:offline:1']);
  });
});
