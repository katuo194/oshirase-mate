import { afterEach, describe, expect, it } from 'vitest';
import { NOW, createFakeGoogleApi } from '../../mocks/google/index.js';
import { dateKey, localTimeOnDate } from '../../src/main/providers/dateOnly.js';
import {
  DEFAULT_NOTIFY_HOUR,
  createTasksProvider,
  isNotifiable,
  normalizeTasks,
  taskNotifyTime,
} from '../../src/main/providers/tasks.js';

/** ローカル時刻の期待値は同じ組み立て方で作る（タイムゾーンに依存しないアサーションにするため） */
const localAt = (y, m, d, hour, minute = 0) => new Date(y, m - 1, d, hour, minute, 0, 0).getTime();

function poll(notifyHour = () => DEFAULT_NOTIFY_HOUR, notifyMinute = undefined) {
  const api = createFakeGoogleApi();
  return createTasksProvider({ listTaskLists: api.listTaskLists, listTasks: api.listTasks, notifyHour, notifyMinute }).poll();
}
const byId = (list, id) => list.find((n) => n.id === id);

describe('dateOnly / localTimeOnDate', () => {
  it('日付部分だけを取り出してローカルの指定時刻を返す', () => {
    expect(localTimeOnDate('2026-09-21T00:00:00.000Z', 16)).toBe(localAt(2026, 9, 21, 16));
    expect(localTimeOnDate('2026-09-21', 0)).toBe(localAt(2026, 9, 21, 0));
    expect(localTimeOnDate('2026-09-21T00:00:00.000Z', 9, 45)).toBe(localAt(2026, 9, 21, 9, 45));
  });

  it('UTCより西のタイムゾーンでも日付が前日にずれない（new Date(due) 経由との違い）', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles'; // UTC-7/-8
      const due = '2026-09-21T00:00:00.000Z';
      const t = new Date(localTimeOnDate(due, 16));
      expect(t.getFullYear()).toBe(2026);
      expect(t.getMonth()).toBe(8); // 9月
      expect(t.getDate()).toBe(21); // 20日になってはいけない
      expect(t.getHours()).toBe(16);
      // 素直にローカル変換すると前日になってしまうことを、対比として記録しておく
      expect(new Date(due).getDate()).toBe(20);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('日付として読めない値は null', () => {
    expect(localTimeOnDate('', 16)).toBeNull();
    expect(localTimeOnDate(undefined, 16)).toBeNull();
    expect(localTimeOnDate('2026-02-30', 16)).toBeNull(); // 存在しない日付を繰り上げない
  });

  it('dateKey は日付部分だけを返す', () => {
    expect(dateKey('2026-09-21T00:00:00.000Z')).toBe('2026-09-21');
    expect(dateKey('なにか')).toBeNull();
  });
});

describe('taskNotifyTime / isNotifiable', () => {
  it('既定の通知時刻は16:00（6.1 taskNotifyHour）', () => {
    expect(DEFAULT_NOTIFY_HOUR).toBe(16);
    expect(new Date(taskNotifyTime('2026-09-20T00:00:00.000Z')).getHours()).toBe(16);
  });

  it('未完了・未削除・期限ありのタスクだけが対象', () => {
    expect(isNotifiable({ status: 'needsAction', due: '2026-09-20T00:00:00.000Z' })).toBe(true);
    expect(isNotifiable({ status: 'completed', due: '2026-09-20T00:00:00.000Z' })).toBe(false);
    expect(isNotifiable({ status: 'needsAction', due: '2026-09-20T00:00:00.000Z', deleted: true })).toBe(false);
    expect(isNotifiable({ status: 'needsAction' })).toBe(false);
  });
});

describe('providers/tasks / F-02 TODO通知の検知', () => {
  it('期限日のローカル16:00を通知時刻にする', async () => {
    const n = byId(await poll(), 'task:list-main:task-milk:2026-09-20');
    expect(n.notifyAt).toBe(localAt(2026, 9, 20, 16));
    expect(new Date(n.notifyAt).getHours()).toBe(16);
    expect(n.source).toBe('tasks');
    expect(n.title).toBe('牛乳を買う');
    expect(n.body).toBe('期限：2026-09-20');
    expect(n.data).toMatchObject({ taskListId: 'list-main', taskListTitle: 'マイタスク', taskId: 'task-milk', due: '2026-09-20' });
  });

  it('期限超過のタスクは通知時刻が過去になる（次のポーリングで即時発火する）', async () => {
    const n = byId(await poll(), 'task:list-main:task-overdue:2026-09-18');
    expect(n.notifyAt).toBe(localAt(2026, 9, 18, 16));
    expect(n.notifyAt).toBeLessThan(NOW);
  });

  it('未来の期限はタイマー登録になる', async () => {
    const n = byId(await poll(), 'task:list-main:task-future:2026-09-25');
    expect(n.notifyAt).toBeGreaterThan(NOW);
  });

  it('完了済み・期限なし・削除済みは通知しない', async () => {
    const ids = (await poll()).map((n) => n.data.taskId);
    expect(ids).not.toContain('task-done');
    expect(ids).not.toContain('task-no-due');
    expect(ids).not.toContain('task-deleted');
  });

  it('別リストの同じタスクIDでも通知IDが衝突しない', async () => {
    const list = await poll();
    expect(byId(list, 'task:list-main:task-milk:2026-09-20').title).toBe('牛乳を買う');
    expect(byId(list, 'task:list-work:task-milk:2026-09-20').title).toBe('経費精算');
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
  });

  it('taskNotifyHour を変えると通知時刻が変わる', async () => {
    const n = byId(await poll(() => 9), 'task:list-main:task-milk:2026-09-20');
    expect(n.notifyAt).toBe(localAt(2026, 9, 20, 9));
  });

  it('taskNotifyMinute で分まで指定できる（Phase 16。省略時は 0 分）', async () => {
    const n = byId(await poll(() => 8, () => 30), 'task:list-main:task-milk:2026-09-20');
    expect(n.notifyAt).toBe(localAt(2026, 9, 20, 8, 30));
    expect(taskNotifyTime('2026-09-20T00:00:00.000Z', 23, 59)).toBe(localAt(2026, 9, 20, 23, 59));
    expect(new Date(taskNotifyTime('2026-09-20T00:00:00.000Z')).getMinutes()).toBe(0);
  });

  it('時刻を変えても通知 ID は変わらない（その日にすでに知らせた TODO を、時刻の変更でもう一度知らせない）', async () => {
    const before = byId(await poll(), 'task:list-main:task-milk:2026-09-20');
    const after = byId(await poll(() => 18, () => 15), 'task:list-main:task-milk:2026-09-20');
    expect(after.id).toBe(before.id);
    expect(after.notifyAt).toBe(localAt(2026, 9, 20, 18, 15));
  });

  it('期限が変更されたタスクは別IDになり、改めて通知される', () => {
    const base = { taskList: { id: 'list-main', title: 'マイタスク' } };
    const before = normalizeTasks([{ ...base, tasks: { items: [{ id: 't1', title: 'X', status: 'needsAction', due: '2026-09-20T00:00:00.000Z' }] } }]);
    const after = normalizeTasks([{ ...base, tasks: { items: [{ id: 't1', title: 'X', status: 'needsAction', due: '2026-09-22T00:00:00.000Z' }] } }]);
    expect(before[0].id).not.toBe(after[0].id);
  });

  it('全タスクリストを走査し、通知時刻の昇順で返す', async () => {
    const api = createFakeGoogleApi();
    const list = await createTasksProvider({ listTaskLists: api.listTaskLists, listTasks: api.listTasks }).poll();
    expect(api.callsTo('listTasks').map((c) => c.args.taskListId)).toEqual(['list-main', 'list-work']);
    expect(list).toHaveLength(4);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].notifyAt).toBeGreaterThanOrEqual(list[i - 1].notifyAt);
    }
  });

  it('空のレスポンスでも落ちない', () => {
    expect(normalizeTasks([])).toEqual([]);
    expect(normalizeTasks(null)).toEqual([]);
    expect(normalizeTasks([{ taskList: { id: 'l' }, tasks: {} }])).toEqual([]);
  });
});
