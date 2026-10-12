import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotificationPresenter } from '../src/main/notificationPresenter.js';
import { SOURCES, createNotifyQueue, makeNotificationId } from '../src/main/notifyQueue.js';
import { idlePresentation, systemPresentation } from '../src/main/notificationView.js';

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

function setup({ ready = true, getSpeechOptions } = {}) {
  const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
  const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
  const shown = [];
  const aborted = [];
  const presenter = createNotificationPresenter({
    notifyQueue,
    show: (p, n) => shown.push({ presentation: p, notification: n }),
    abort: (p) => aborted.push(p.id),
    now: () => Date.now(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...(getSpeechOptions ? { getSpeechOptions } : {}),
  });
  presenter.start();
  if (ready) presenter.setRendererReady(true);
  return { notifyQueue, presenter, shown, aborted };
}

/** 通知を1件表示し終えた状態にする */
function showAndFinish({ notifyQueue, presenter }, raw) {
  notifyQueue.push(raw);
  presenter.done(raw.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('notificationPresenter / 直前のお知らせの再表示（replayLast・F-21）', () => {
  it('まだ通知を表示していなければ none', () => {
    const { presenter, shown } = setup();
    expect(presenter.replayLast()).toBe('none');
    expect(shown).toEqual([]);
  });

  it('最後に表示した通知を、元とは別の id でもう一度表示する（通知としては渡さない）', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    showAndFinish(t, mail('m2'));

    expect(t.presenter.replayLast()).toBe('shown');
    const last = t.shown.at(-1);
    expect(last.notification).toBeNull();
    expect(last.presentation.id).toBe(`replay:${mailId('m2')}:1`);
    expect(last.presentation).toMatchObject({ kind: 'gmail', label: '重要メール', title: '件名m2', sfxKey: 'gmail' });
    expect(last.presentation.speech).toContain('件名m2');
    expect(t.presenter.currentId()).toBe(last.presentation.id);
  });

  it('再表示を繰り返しても id は毎回変わり、覚えている通知は変わらない', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    t.presenter.replayLast();
    t.presenter.done(`replay:${mailId('m1')}:1`);
    expect(t.presenter.replayLast()).toBe('shown');
    expect(t.shown.at(-1).presentation.id).toBe(`replay:${mailId('m1')}:2`);
  });

  it('notifyQueue と通知済みIDには影響しない', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    t.presenter.replayLast();
    expect(t.notifyQueue.size()).toBe(0);
    expect(t.notifyQueue.isNotified(mailId('m1'))).toBe(true);
    // 新しい通知は再表示の完了後に通常どおり表示される
    t.notifyQueue.push(mail('m2'));
    t.presenter.done(`replay:${mailId('m1')}:1`);
    expect(t.presenter.currentId()).toBe(mailId('m2'));
  });

  it('システム通知・アイドルトークは覚えない（直前の通知が再表示される）', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    t.presenter.showSystem(systemPresentation({ id: 'sys:1', title: 'オフライン' }));
    t.presenter.done('sys:1');
    t.presenter.showIdle(idle());
    t.presenter.done('idle:1');

    expect(t.presenter.replayLast()).toBe('shown');
    expect(t.shown.at(-1).presentation.id).toBe(`replay:${mailId('m1')}:1`);
  });

  it('通知の表示中・システム通知の表示中は busy（積み重ならない）', () => {
    const t = setup();
    t.notifyQueue.push(mail('m1'));
    expect(t.presenter.replayLast()).toBe('busy');
    t.presenter.done(mailId('m1'));

    t.presenter.showSystem(systemPresentation({ id: 'sys:1', title: 'オフライン' }));
    expect(t.presenter.replayLast()).toBe('busy');
    t.presenter.done('sys:1');

    expect(t.presenter.replayLast()).toBe('shown');
    expect(t.presenter.replayLast()).toBe('busy'); // 再表示中の連打
    expect(t.shown.filter((s) => s.presentation.id.startsWith('replay:'))).toHaveLength(1);
  });

  it('通知がキューで待っている・ドラッグ中・レンダラー未準備なら busy', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    t.presenter.setDragging(true);
    expect(t.presenter.replayLast()).toBe('busy');
    t.notifyQueue.push(mail('m2'));
    t.presenter.setDragging(false); // m2 を表示
    t.presenter.done(mailId('m2'));
    t.notifyQueue.pause();
    t.notifyQueue.push(mail('m3'));
    expect(t.presenter.replayLast()).toBe('busy');

    const u = setup({ ready: false });
    expect(u.presenter.replayLast()).toBe('busy');
  });

  it('アイドルトークの表示中なら中断して、その完了後に再表示する', () => {
    const t = setup();
    showAndFinish(t, mail('m1'));
    t.presenter.showIdle(idle());

    expect(t.presenter.replayLast()).toBe('shown');
    expect(t.aborted).toEqual(['idle:1']);
    expect(t.presenter.currentId()).toBe('idle:1'); // 絞りの間はまだアイドルトーク
    t.presenter.done('idle:1');
    expect(t.presenter.currentId()).toBe(`replay:${mailId('m1')}:1`);
  });

  it('表示の内容は今の時刻で作り直す（予定の「n分後」）', () => {
    const t = setup();
    const startAt = NOW + 10 * 60000;
    const cal = {
      id: makeNotificationId(SOURCES.CALENDAR, 'e1', startAt - 10 * 60000),
      source: SOURCES.CALENDAR,
      title: '定例',
      body: '',
      notifyAt: NOW,
      data: { startAt, allDay: false },
    };
    showAndFinish(t, cal);
    expect(t.shown[0].presentation.sub).toContain('10分後');

    vi.setSystemTime(NOW + 7 * 60000);
    t.presenter.replayLast();
    expect(t.shown.at(-1).presentation.sub).toContain('3分後');
  });
});

describe('notificationPresenter / キャラクターのセリフ（F-22）', () => {
  it('通常の表示と再表示の両方で、そのとき選択中のキャラクターのセリフを使う', () => {
    let lines = { gmail: ['{from}さんからだよ。{title}'] };
    const t = setup({ getSpeechOptions: () => ({ lines }) });
    showAndFinish(t, mail('m1'));
    expect(t.shown[0].presentation.speech).toBe('田中さんからだよ。件名m1');

    t.presenter.replayLast();
    expect(t.shown.at(-1).presentation.speech).toBe('田中さんからだよ。件名m1');
    t.presenter.done(`replay:${mailId('m1')}:1`);

    // キャラクターを切り替えたら、再表示もそのキャラクターのセリフになる
    lines = { gmail: ['メールが来たよ。{title}'] };
    t.presenter.replayLast();
    expect(t.shown.at(-1).presentation.speech).toBe('メールが来たよ。件名m1');
  });

  it('文の選び方（pickLine）を渡すと、表示のたびにそれで選ぶ', () => {
    const picked = [];
    const pickLine = (kind, accept) => {
      picked.push(kind);
      return accept('{from}さん{title}') ? `${picked.length}回目{title}` : null;
    };
    const t = setup({ getSpeechOptions: () => ({ pickLine }) });
    showAndFinish(t, mail('m1'));
    t.presenter.replayLast();
    expect(t.shown.map((s) => s.presentation.speech)).toEqual(['1回目件名m1', '2回目件名m1']);
    expect(picked).toEqual(['gmail', 'gmail']);
  });

  it('セリフの取得に失敗しても既定の文で表示する', () => {
    const t = setup({
      getSpeechOptions: () => {
        throw new Error('boom');
      },
    });
    showAndFinish(t, mail('m1'));
    expect(t.shown[0].presentation.speech).toBe('田中さんから重要なメールです。件名m1');
  });
});
