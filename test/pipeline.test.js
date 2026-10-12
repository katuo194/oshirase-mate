import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, createFakeGoogleApi } from '../mocks/google/index.js';
import { GoogleApiError, KINDS } from '../src/main/apiErrors.js';
import { createMailSummary } from '../src/main/mailSummary.js';
import { createNotifyQueue } from '../src/main/notifyQueue.js';
import { SOURCE_NAMES, createPipeline } from '../src/main/pipeline.js';
import { createCalendarProvider } from '../src/main/providers/calendar.js';
import { createGmailProvider } from '../src/main/providers/gmail.js';
import { createTasksProvider } from '../src/main/providers/tasks.js';

const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms) => new Date(ms).toISOString();

const POLLING = { polling: { mailIntervalSec: 60, calendarIntervalSec: 300, taskIntervalSec: 300 }, taskNotifyHour: 16 };

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

/** 実 auth の代わり。status を動かして 'change' を流せる。 */
function fakeAuth(status = 'linked') {
  const events = new EventEmitter();
  let state = { status };
  return {
    events,
    getState: () => ({ ...state }),
    set(next) {
      state = { status: next };
      events.emit('change', { ...state });
    },
  };
}

/** 永続化層のフェイク（実物は notifiedStore.test.js で検証済み）。 */
function memoryStore(initial = {}) {
  const store = { data: { ...initial }, order: [] };
  store.load = vi.fn(async () => {
    store.order.push('load');
    return { ...store.data };
  });
  store.save = vi.fn(async (n) => {
    store.data = { ...n };
    return n;
  });
  return store;
}

/** カレンダー・TODO・Gmail のフェイクAPI（mocks/google）を、実 providers・実 notifyQueue・実 reminderTimers につないだ状態を作る。 */
function setup({ status = 'linked', api = createFakeGoogleApi(), store = memoryStore(), polling = POLLING, usage, withTasks = false } = {}) {
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) };
  const auth = fakeAuth(status);
  const gmail = createGmailProvider({ listMessages: api.listMessages, getMessage: api.getMessage, log });
  const providers = {
    calendar: createCalendarProvider({ listEvents: api.listEvents }),
    // fixture のタスクは期限超過を含み、即時に通知が出る。TODO のテスト以外では API は呼ぶが結果は空にして、他の系統の検証を邪魔しない
    tasks: createTasksProvider({
      listTaskLists: withTasks ? api.listTaskLists : async () => (await api.listTaskLists(), { items: [] }),
      listTasks: api.listTasks,
      notifyHour: () => polling.taskNotifyHour,
    }),
    gmail,
  };
  const notifyQueue = createNotifyQueue({ store, log });
  const mailSummary = createMailSummary();

  const enqueued = [];
  notifyQueue.events.on('enqueued', (n) => enqueued.push(n));
  const summaries = [];
  mailSummary.events.on('updated', (u) => summaries.push(u));

  const pipeline = createPipeline({ auth, providers, notifyQueue, mailSummary, getPollingConfig: () => polling, usage, log });
  const failed = [];
  pipeline.scheduler.events.on('failed', (f) => failed.push(f));

  api.setEvents([]); // 既定の fixture を外し、各テストが必要な予定だけ置く
  return { api, auth, store, logs, providers, notifyQueue, mailSummary, pipeline, enqueued, summaries, failed };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const event = (id, startMs, minutesBefore, summary = `予定${id}`) => ({
  id,
  summary,
  status: 'confirmed',
  start: { dateTime: iso(startMs) },
  end: { dateTime: iso(startMs + 30 * MIN) },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: minutesBefore }] },
});

describe('pipeline / 起動', () => {
  it('通知済み履歴を読み込んでからポーリングを始める', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await settle();
    expect(ctx.store.load).toHaveBeenCalledTimes(1);
    expect(ctx.api.callsTo('listEvents')).toHaveLength(1);
    expect(ctx.pipeline.scheduler.isRunning()).toBe(true);
  });

  it('履歴の読み込みに失敗しても空の履歴でポーリングを始める', async () => {
    const store = memoryStore();
    store.load.mockRejectedValue(new Error('disk error'));
    const ctx = setup({ store });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.pipeline.scheduler.isRunning()).toBe(true);
    expect(ctx.logs.some((l) => l.startsWith('WARN') && l.includes('通知済み履歴の読み込みに失敗'))).toBe(true);
  });

  it('config のポーリング間隔どおりに回す（メール1分・カレンダー/TODO 5分）', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await settle();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(ctx.api.callsTo('listEvents')).toHaveLength(2); // 起動時 + 5分後
    expect(ctx.api.callsTo('listTaskLists')).toHaveLength(2);
    expect(ctx.api.callsTo('listMessages').filter((c) => c.args.q.includes('-is:important'))).toHaveLength(6); // 起動時 + 毎分5回
  });

  it('start() を二重に呼んでも一度しか始めない', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await ctx.pipeline.start();
    await settle();
    expect(ctx.api.callsTo('listEvents')).toHaveLength(1);
  });
});

describe('pipeline / 未連携ではスキップする（エラー扱いにしない）', () => {
  it('unlinked：API を一切呼ばず、3系統（4ポーリング）とも「未連携のためスキップ」をログに残す。failed は出ない', async () => {
    const ctx = setup({ status: 'unlinked' });
    await ctx.pipeline.start();
    await settle();

    expect(ctx.api.calls).toEqual([]);
    expect(ctx.failed).toEqual([]);
    for (const name of Object.values(SOURCE_NAMES)) {
      expect(ctx.logs).toContain(`[pipeline] ${name}: 未連携のためスキップ`);
    }
    expect(ctx.logs.some((l) => l.startsWith('WARN'))).toBe(false);
  });

  it('同じ理由のスキップは毎回ログに出さない（メールは毎分2回走るため）', async () => {
    const ctx = setup({ status: 'unlinked' });
    await ctx.pipeline.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(ctx.logs.filter((l) => l.includes('gmail-important') && l.includes('スキップ'))).toHaveLength(1);
  });

  it('理由が変われば改めてログに出す', async () => {
    const ctx = setup({ status: 'checking' });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.logs).toContain('[pipeline] calendar: 認証確認中のためスキップ（確認完了後に即時実行）');
    ctx.auth.set('unlinked');
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(ctx.logs).toContain('[pipeline] calendar: 未連携のためスキップ');
  });

  it('unconfigured（.env 不備）も API を呼ばずスキップする', async () => {
    const ctx = setup({ status: 'unconfigured' });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.api.calls).toEqual([]);
    expect(ctx.logs).toContain('[pipeline] calendar: OAuth設定が未完了のためスキップ');
  });

  it('linked になった瞬間に全系統を即時実行する（次の間隔を待たない）', async () => {
    const ctx = setup({ status: 'checking' });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.api.calls).toEqual([]);

    ctx.auth.set('linked');
    await settle();
    expect(ctx.api.callsTo('listEvents')).toHaveLength(1);
    expect(ctx.api.callsTo('listTaskLists')).toHaveLength(1);
    expect(ctx.api.callsTo('listMessages')).toHaveLength(2); // 重要 + それ以外
  });

  it('未連携から連携した場合も同様（設定画面で「連携する」直後）', async () => {
    const ctx = setup({ status: 'unlinked' });
    await ctx.pipeline.start();
    await settle();
    ctx.auth.set('linking');
    await settle();
    expect(ctx.api.calls).toEqual([]);
    ctx.auth.set('linked');
    await settle();
    expect(ctx.api.callsTo('listEvents')).toHaveLength(1);
  });

  it('スキップ後に連携したら、次は通常どおりログに出す（スキップ状態が残らない）', async () => {
    const ctx = setup({ status: 'unlinked' });
    await ctx.pipeline.start();
    await settle();
    ctx.auth.set('linked');
    await settle();
    ctx.auth.set('unlinked');
    await settle();
    await ctx.pipeline.scheduler.runNow(SOURCE_NAMES.CALENDAR);
    expect(ctx.logs.filter((l) => l === '[pipeline] calendar: 未連携のためスキップ')).toHaveLength(2);
  });
});

describe('pipeline / カレンダー：リマインダー時刻に notifyQueue へ', () => {
  it('予約通知をタイマーに登録し、リマインダー時刻に notifyQueue.push される', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10, '定例会議')]);
    await ctx.pipeline.start();
    await settle();

    expect(ctx.pipeline.reminderTimers.size()).toBe(1);
    expect(ctx.enqueued).toEqual([]); // まだ

    await vi.advanceTimersByTimeAsync(19 * MIN + 59 * SEC);
    expect(ctx.enqueued).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * SEC); // 開始10分前ちょうど
    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.enqueued[0]).toMatchObject({ source: 'calendar', title: '定例会議', body: '10分後に開始', notifyAt: NOW + 20 * MIN });
  });

  it('登録した予約通知を時刻つきでログに残す（実機確認用）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10, '定例会議')]);
    await ctx.pipeline.start();
    await settle();
    expect(ctx.logs.some((l) => l.includes('登録: [calendar] 定例会議 → '))).toBe(true);
    expect(ctx.logs.some((l) => l.includes('予約通知 追加1 / 削除0 / 維持0'))).toBe(true);
  });

  it('リマインダー時刻が既に過ぎた予定は即時に notifyQueue へ', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-late', NOW + 3 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    expect(ctx.enqueued.map((n) => n.data.eventId)).toEqual(['evt-late']);
  });

  it('予定が動いたら、次のポーリングでタイマーを張り直す（古い時刻では発火しない）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();

    ctx.api.setEventStart('evt-1', iso(NOW + 60 * MIN)); // 30分後 → 1時間後へ
    await vi.advanceTimersByTimeAsync(5 * MIN); // 次のポーリング
    await vi.advanceTimersByTimeAsync(15 * MIN + 1 * SEC); // 元のリマインダー時刻（+20分）を過ぎる
    expect(ctx.enqueued).toEqual([]);
    await vi.advanceTimersByTimeAsync(30 * MIN); // 新しいリマインダー時刻（+50分）
    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.enqueued[0].notifyAt).toBe(NOW + 50 * MIN);
  });

  it('同じ予定を何度ポーリングしても二重に発火しない', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 12 * MIN, 10)]);
    await ctx.pipeline.start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(ctx.enqueued).toHaveLength(1);
  });

  it('キュー待機中の同じ通知が発火しても二重に積まず、ログに残す（キュー側の重複排除 F-05）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    const id = ctx.pipeline.reminderTimers.scheduledIds()[0];
    ctx.notifyQueue.push({ id, source: 'calendar', title: 'x', notifyAt: NOW }); // 待機中

    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(ctx.enqueued).toHaveLength(1); // 上で手動で積んだ1件だけ
    expect(ctx.logs.some((l) => l.includes('通知済みのため破棄 (duplicate)'))).toBe(true);
  });

  it('通知済みの予約通知は、次のポーリングでタイマーを張り直さない（毎回の再発火・再ログを防ぐ）', async () => {
    const ctx = setup();
    ctx.notifyQueue.events.on('enqueued', () => ctx.notifyQueue.take()); // 表示側（取り出して通知済みにする）の代わり
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10)]);
    await ctx.pipeline.start();
    await vi.advanceTimersByTimeAsync(60 * MIN); // リマインダー後・開始後まで、5分ごとのポーリングを何度も挟む

    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);
    expect(ctx.logs.filter((l) => l.includes('通知済みのため破棄'))).toEqual([]);
  });

  it('別系統のポーリングでも、発火済みの通知を張り直さない（実機ログで見つかった不具合：TODO のポーリングでカレンダーの通知済み分が再登録されていた）', async () => {
    const ctx = setup({ withTasks: true });
    ctx.notifyQueue.events.on('enqueued', () => ctx.notifyQueue.take());
    ctx.api.setEvents([event('evt-late', NOW + 3 * MIN, 10)]); // リマインダーは既に過去 → 初回のカレンダーポーリングで即時発火
    await ctx.pipeline.start();
    await settle();
    expect(ctx.enqueued.filter((n) => n.source === 'calendar')).toHaveLength(1);
    const logsBefore = ctx.logs.length;

    await ctx.pipeline.scheduler.runNow(SOURCE_NAMES.TASKS); // 別系統のポーリング
    await settle();
    expect(ctx.enqueued.filter((n) => n.source === 'calendar')).toHaveLength(1);
    expect(ctx.logs.slice(logsBefore).filter((l) => l.includes('通知済みのため破棄') || l.includes('登録: [calendar]'))).toEqual([]);
  });

  it('再起動後：履歴にある通知済みのリマインダーは、期限が過ぎていても即時発火しない（F-05）', async () => {
    const id = `cal:evt-1:${NOW - 5 * MIN}`;
    const ctx = setup({ store: memoryStore({ [id]: NOW - 5 * MIN }) });
    ctx.api.setEvents([event('evt-1', NOW + 5 * MIN, 10)]); // リマインダー時刻は5分前 = 過去
    await ctx.pipeline.start();
    await settle();
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);
  });
});

describe('pipeline / TODO', () => {
  it('期限超過のタスクは即時、未来のタスクはタイマーで notifyQueue へ', async () => {
    const ctx = setup({ withTasks: true });
    ctx.api.setTaskDue('list-main', 'task-milk', '2026-09-25T00:00:00.000Z');
    await ctx.pipeline.start();
    await settle();

    const ids = ctx.enqueued.map((n) => n.id);
    expect(ids).toContain('task:list-main:task-overdue:2026-09-18'); // 期限超過 → 即時
    expect(ctx.pipeline.reminderTimers.has('task:list-main:task-milk:2026-09-25')).toBe(true); // 未来 → タイマー
    expect(ctx.enqueued.every((n) => n.source === 'tasks')).toBe(true);
  });

  it('カレンダーの再ポーリングでTODOのタイマーが消えない（タイマー管理の共有）', async () => {
    const ctx = setup({ withTasks: true });
    ctx.api.setTaskDue('list-main', 'task-milk', '2026-09-25T00:00:00.000Z');
    ctx.api.setEvents([event('evt-1', NOW + 3 * 60 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    expect(ctx.pipeline.reminderTimers.has('task:list-main:task-milk:2026-09-25')).toBe(true);
    expect(ctx.pipeline.reminderTimers.scheduledIds().some((id) => id.startsWith('cal:'))).toBe(true);

    await ctx.pipeline.scheduler.runNow(SOURCE_NAMES.CALENDAR);
    expect(ctx.pipeline.reminderTimers.has('task:list-main:task-milk:2026-09-25')).toBe(true);

    await ctx.pipeline.scheduler.runNow(SOURCE_NAMES.TASKS);
    expect(ctx.pipeline.reminderTimers.scheduledIds().some((id) => id.startsWith('cal:'))).toBe(true);
  });

  it('タスクを完了したら、次のポーリングでタイマーが消える', async () => {
    const ctx = setup({ withTasks: true });
    ctx.api.setTaskDue('list-main', 'task-milk', '2026-09-25T00:00:00.000Z');
    await ctx.pipeline.start();
    await settle();
    ctx.api.completeTask('list-main', 'task-milk');
    await ctx.pipeline.scheduler.runNow(SOURCE_NAMES.TASKS);
    expect(ctx.pipeline.reminderTimers.has('task:list-main:task-milk:2026-09-25')).toBe(false);
  });
});

describe('pipeline / 重要メール：検知時点で notifyQueue へ', () => {
  it('初回は既存の未読を通知しない。以降の新着だけを、ポーリング検知時点で積む', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await settle();
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.logs).toContain('[pipeline] gmail-important: 初回取得（既存の未読は通知済み扱い）');

    ctx.api.addImportantMessage('new-1', { subject: '至急のお知らせ', from: '上司 <boss@example.com>' });
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.enqueued[0]).toMatchObject({ source: 'gmail', id: 'mail:new-1', title: '至急のお知らせ', body: '上司' });

    await vi.advanceTimersByTimeAsync(3 * MIN); // 同じメールは再度積まない
    expect(ctx.enqueued).toHaveLength(1);
  });

  it('5件同時に届いたら到着順にキューへ並ぶ（F-08）', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await settle();
    for (let i = 1; i <= 5; i++) ctx.api.addImportantMessage(`m${i}`, { subject: `件名${i}` });
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.enqueued.map((n) => n.title)).toEqual(['件名1', '件名2', '件名3', '件名4', '件名5']);
  });
});

describe('pipeline / 重要でないメール：サマリ更新', () => {
  it('初回は基準値のみ。増減は mailSummary の updated イベントで外に伝わる', async () => {
    const ctx = setup();
    await ctx.pipeline.start();
    await settle();
    expect(ctx.summaries).toMatchObject([{ kind: 'initial', count: 3 }]);

    ctx.api.setUnreadOtherCount(5);
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.summaries.at(-1)).toMatchObject({ kind: 'increased', previous: 3, count: 5, text: '5件' });

    ctx.api.setUnreadOtherCount(4);
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.summaries.at(-1)).toMatchObject({ kind: 'decreased', count: 4 });

    await vi.advanceTimersByTimeAsync(60 * SEC); // 変化なし
    expect(ctx.summaries).toHaveLength(3);
    expect(ctx.enqueued).toEqual([]); // サマリは個別通知にならない
  });
});

describe('pipeline / 大量の未読でもサマリが動く（実機で 201 固定になっていた不具合）', () => {
  it('未読が500件を超えていても、実件数で基準値を置き、増減に追随する', async () => {
    const api = createFakeGoogleApi({ unreadOtherCount: 300 });
    const ctx = setup({ api });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.summaries).toMatchObject([{ kind: 'initial', count: 300, capped: false }]);

    api.setUnreadOtherCount(299);
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.summaries.at(-1)).toMatchObject({ kind: 'decreased', previous: 300, count: 299, text: '299件' });

    api.setUnreadOtherCount(301);
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(ctx.summaries.at(-1)).toMatchObject({ kind: 'increased', delta: 2, count: 301 });
  });

  it('上限（2,500件）を超える場合は「2500+件」', async () => {
    const ctx = setup({ api: createFakeGoogleApi({ unreadOtherCount: 9000 }) });
    await ctx.pipeline.start();
    await settle();
    expect(ctx.summaries).toMatchObject([{ kind: 'initial', count: 2500, capped: true, text: '2500+件' }]);
  });
});

describe('pipeline / 連携が外れたときの後始末', () => {
  it('unlinked になったら予約通知を破棄し、再連携後は既存未読を通知済み扱いにし直す', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 60 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    expect(ctx.pipeline.reminderTimers.size()).toBe(1);
    expect(ctx.mailSummary.isSeeded()).toBe(true);

    ctx.auth.set('unlinked');
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);
    expect(ctx.mailSummary.isSeeded()).toBe(false);

    // 連携解除中に届いた重要メール。再連携後の初回ポーリングでは通知しない
    ctx.api.addImportantMessage('while-unlinked', { subject: '解除中に届いた' });
    ctx.auth.set('linked');
    await settle();
    expect(ctx.enqueued).toEqual([]);
    expect(ctx.summaries.at(-1).kind).toBe('initial');
    expect(ctx.pipeline.reminderTimers.size()).toBe(1); // 予定は取り直されて再登録
  });

  it('invalid_grant で unlinked に戻った場合も同じ（status の遷移だけを見る）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 60 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    ctx.auth.set('checking');
    ctx.auth.set('unlinked');
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);
  });

  it('ポーリング中に連携解除されたら、その結果は捨てる（解除後にタイマーが復活しない）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 60 * MIN, 10)]);
    const original = ctx.api.listEvents;
    let release;
    const gate = new Promise((r) => (release = r));
    ctx.providers.calendar.poll = async () => {
      await gate;
      return original().then((r) => r.items.length && [{ id: 'cal:evt-1:1', source: 'calendar', title: 'x', notifyAt: NOW + 50 * MIN }]);
    };

    await ctx.pipeline.start();
    await settle();
    ctx.auth.set('unlinked'); // calendar のポーリングは保留中
    release();
    await settle();
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);
    expect(ctx.failed).toEqual([]);
  });

  it('解除との競合でトークン取得に失敗しても、エラー扱いにしない', async () => {
    const ctx = setup();
    ctx.providers.calendar.poll = async () => {
      ctx.auth.set('unlinked');
      throw new GoogleApiError({ kind: KINDS.AUTH_UNAVAILABLE, detail: 'access token unavailable (unlinked)' });
    };
    await ctx.pipeline.start();
    await settle();
    expect(ctx.failed.filter((f) => f.name === 'calendar')).toEqual([]);
  });
});

describe('pipeline / API失敗（Phase 6 のバックオフの入力を落とさない）', () => {
  it('GoogleApiError はそのまま scheduler の failed イベントに載る。他の系統は動き続ける', async () => {
    const ctx = setup();
    const error = new GoogleApiError({ kind: KINDS.RATE_LIMITED, status: 429, api: 'calendar.events.list', retryAfterMs: 30_000 });
    ctx.providers.calendar.poll = async () => {
      throw error;
    };
    await ctx.pipeline.start();
    await settle();

    const f = ctx.failed.find((x) => x.name === 'calendar');
    expect(f.error).toBe(error);
    expect(f.error).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 30_000, retryable: true, offlineCandidate: false });
    expect(f.consecutiveFailures).toBe(1);
    expect(ctx.api.callsTo('listTaskLists')).toHaveLength(1);
    expect(ctx.summaries).toHaveLength(1);
    // scheduler の warn ログだけで種別が読める
    expect(ctx.logs.some((l) => l.startsWith('WARN [scheduler] calendar poll failed') && l.includes('rate_limited 429'))).toBe(true);
  });

  it('失敗した間も登録済みのタイマーは残り、予定の時刻に発火する（オフラインでも通知を落とさない）', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();

    ctx.api.failNext('listEvents', 3);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(ctx.failed.filter((f) => f.name === 'calendar').length).toBeGreaterThan(0);
    expect(ctx.enqueued).toHaveLength(1);
  });

  it('連続失敗の回数が数えられ、成功でリセットされる', async () => {
    const ctx = setup();
    ctx.api.failNext('listEvents', 2);
    await ctx.pipeline.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(ctx.failed.filter((f) => f.name === 'calendar').map((f) => f.consecutiveFailures)).toEqual([1, 2]);
    expect(ctx.pipeline.scheduler.getStats().find((s) => s.name === 'calendar').consecutiveFailures).toBe(0);
  });
});

describe('pipeline / 停止・実測ログ', () => {
  it('stop() でポーリングと予約通知をすべて止める', async () => {
    const ctx = setup();
    ctx.api.setEvents([event('evt-1', NOW + 30 * MIN, 10)]);
    await ctx.pipeline.start();
    await settle();
    ctx.pipeline.stop();
    expect(ctx.pipeline.scheduler.isRunning()).toBe(false);
    expect(ctx.pipeline.reminderTimers.size()).toBe(0);

    const calls = ctx.api.calls.length;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(ctx.api.calls.length).toBe(calls);
    expect(ctx.enqueued).toEqual([]);
  });

  it('API呼び出しの実測を1時間ごと・停止時にログへ出す', async () => {
    const usage = { format: vi.fn(() => '[apiUsage] test') };
    const ctx = setup({ usage });
    await ctx.pipeline.start();
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(usage.format).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(usage.format).toHaveBeenCalledTimes(1);
    ctx.pipeline.stop();
    expect(usage.format).toHaveBeenCalledTimes(2);
    expect(ctx.logs.filter((l) => l === '[apiUsage] test')).toHaveLength(2);
  });
});
