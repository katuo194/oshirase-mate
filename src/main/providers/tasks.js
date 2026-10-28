// TODO通知（2.1 / 7.1）。tasklists.list → 各リストの tasks.list を、通知オブジェクトへ正規化する。
//
// Phase 3 では実通信を行わない。Phase 4 では取得関数を googleapis のラッパに差し替える：
//   listTaskLists: () => tasks.tasklists.list().then((r) => r.data)
//   listTasks: (id) => tasks.tasks.list({ tasklist: id, showCompleted: false }).then((r) => r.data)
//
// Google Tasks の due は日付単位で、常にUTC 0時のタイムスタンプとして返る。
// 通知時刻は「その日付のローカルの指定時刻」（既定 16:00。設定画面で変えられ、config.json の taskNotifyHour・taskNotifyMinute に保存する）。
// 発火はポーリング判定ではなくタイマー（4章の応答性要件のため。7.1参照）。

import { SOURCES, makeNotificationId } from '../notifyQueue.js';
import { dateKey, localTimeOnDate } from './dateOnly.js';

/** config.json の taskNotifyHour・taskNotifyMinute の既定値（6.1）。 */
export const DEFAULT_NOTIFY_HOUR = 16;
export const DEFAULT_NOTIFY_MINUTE = 0;

/**
 * due（UTC0時のタイムスタンプ）から、ローカルのその日 hour 時 minute 分を返す。
 * 日付部分だけを使うのが要点。ローカル変換してから日付を取ると西側のタイムゾーンで1日ずれる。
 * @returns {number | null} エポックms
 */
export function taskNotifyTime(due, hour = DEFAULT_NOTIFY_HOUR, minute = DEFAULT_NOTIFY_MINUTE) {
  return localTimeOnDate(due, hour, minute);
}

/** 通知対象のタスクか（未完了・未削除・期限あり）。 */
export function isNotifiable(task) {
  return task?.deleted !== true && task?.status !== 'completed' && typeof task?.due === 'string';
}

/**
 * タスクリストと各リストのタスクを、通知オブジェクトの配列にする（純粋関数）。通知時刻の昇順。
 *
 * @param {Array<{ taskList: object, tasks: object }>} lists [{ taskList: tasklists の1件, tasks: tasks.list のレスポンス }]
 * @param {{ notifyHour?: number, notifyMinute?: number }} [ctx]
 */
export function normalizeTasks(lists, { notifyHour = DEFAULT_NOTIFY_HOUR, notifyMinute = DEFAULT_NOTIFY_MINUTE } = {}) {
  const out = [];

  for (const { taskList, tasks } of lists ?? []) {
    const listId = taskList?.id;
    if (!listId) continue;

    for (const task of tasks?.items ?? []) {
      if (!isNotifiable(task)) continue;
      const notifyAt = taskNotifyTime(task.due, notifyHour, notifyMinute);
      const due = dateKey(task.due);
      if (notifyAt === null || due === null) continue;

      out.push({
        // タスクIDはリスト内でしか一意でないため、リストIDも含める。
        // 期限日も含めるので、期限が変更されたタスクは改めて通知される。
        id: makeNotificationId(SOURCES.TASKS, listId, task.id, due),
        source: SOURCES.TASKS,
        title: task.title || '(無題のタスク)',
        body: `期限：${due}`,
        notifyAt,
        data: {
          taskListId: listId,
          taskListTitle: taskList.title ?? '',
          taskId: task.id,
          due,
          notes: task.notes ?? '',
        },
      });
    }
  }

  return out.sort((a, b) => a.notifyAt - b.notifyAt);
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.listTaskLists tasklists.list の生レスポンス
 * @param {(taskListId: string) => Promise<object>} deps.listTasks tasks.list の生レスポンス
 * @param {() => number} [deps.notifyHour] config.json の taskNotifyHour を返す関数（Phase 4 で store と繋ぐ）
 * @param {() => number} [deps.notifyMinute] config.json の taskNotifyMinute を返す関数
 */
export function createTasksProvider({ listTaskLists, listTasks, notifyHour = () => DEFAULT_NOTIFY_HOUR, notifyMinute = () => DEFAULT_NOTIFY_MINUTE }) {
  return {
    /** @returns {Promise<object[]>} 予約通知の配列（reminderTimers.reconcile にそのまま渡せる） */
    async poll() {
      const taskLists = (await listTaskLists())?.items ?? [];
      const lists = [];
      for (const taskList of taskLists) {
        lists.push({ taskList, tasks: await listTasks(taskList.id) });
      }
      return normalizeTasks(lists, { notifyHour: notifyHour(), notifyMinute: notifyMinute() });
    },
  };
}
