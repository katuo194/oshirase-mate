// Google API（Calendar / Tasks / Gmail）のスタブ。ネットワークには一切出ない。
// Phase 3 では実通信を行わないため、providers には「生レスポンスを返す関数」を注入する設計にしてある（1.6 / 7.1）。
// ここが返すのは *.json の固定レスポンスそのもので、Phase 4 では同じ形の関数を googleapis のラッパに差し替える。
//
//   const api = createFakeGoogleApi();
//   const calendar = createCalendarProvider({ listEvents: api.listEvents, now });
//
// fixture の時刻はすべて固定（基準 now = 2026-09-20T09:00:00Z）。テスト側も now を注入し、実行時刻に依存させない。

import fs from 'node:fs';

/** テストの基準時刻。fixture 内の日時はこれを前提に組んである。 */
export const NOW = Date.parse('2026-09-20T09:00:00Z');

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));

// 読み込みは1回だけ。呼び出しごとに structuredClone して返すので、テストが結果を書き換えても他に漏れない。
const CALENDAR = load('calendar');
const TASKS = load('tasks');
const GMAIL = load('gmail');

export const fixtures = Object.freeze({ calendar: CALENDAR, tasks: TASKS, gmail: GMAIL });

/** fixture のコピーを取り出す（テストが期待値の組み立てに使う）。 */
export const cloneFixture = (obj) => structuredClone(obj);

export const QUERY_IMPORTANT = 'is:important is:unread';
export const QUERY_OTHER = 'is:unread -is:important';

/**
 * @param {object} [opts]
 * @param {string[]} [opts.importantIds] 重要メールの初期ID（省略時は importantInitial）
 * @param {number} [opts.unreadOtherCount] 重要でない未読の初期件数（省略時は unreadOtherInitial）
 */
export function createFakeGoogleApi({ importantIds, unreadOtherCount } = {}) {
  /** 呼び出し記録 [{ name, args }] */
  const calls = [];
  /** 関数名 → 次の1回だけ throw させる（オフライン・APIエラーのテスト用） */
  const failures = new Map();

  let events = structuredClone(CALENDAR.items);
  let defaultReminders = structuredClone(CALENDAR.defaultReminders);
  const taskLists = structuredClone(TASKS.tasklists.items);
  const tasksByList = structuredClone(TASKS.tasks);

  let important = importantIds
    ? [...importantIds]
    : GMAIL.importantInitial.messages.map((m) => m.id);
  /** 重要メールの届いた時刻（after: の検索用。Phase 16）。無いものは昔に届いたもの */
  const receivedAt = new Map();
  let otherCount = unreadOtherCount ?? GMAIL.unreadOtherInitial.resultSizeEstimate;
  const messageMeta = structuredClone(GMAIL.messages);

  function record(name, args) {
    calls.push({ name, args });
    if (failures.get(name) > 0) {
      failures.set(name, failures.get(name) - 1);
      throw new Error(`fake google api: ${name} failed`);
    }
  }

  /** messages.list 形式に整える。0件のとき Gmail は messages キーを返さない。 */
  const messageList = (ids) => {
    const res = { resultSizeEstimate: ids.length };
    if (ids.length > 0) res.messages = ids.map((id) => ({ id, threadId: id }));
    return res;
  };

  return {
    calls,
    callsTo: (name) => calls.filter((c) => c.name === name),

    // ---- providers に注入する取得関数（Phase 4 で googleapis のラッパに差し替わる） ----

    async listEvents() {
      record('listEvents');
      return { ...structuredClone(CALENDAR), defaultReminders: structuredClone(defaultReminders), items: structuredClone(events) };
    },

    async listTaskLists() {
      record('listTaskLists');
      return { kind: 'tasks#taskLists', items: structuredClone(taskLists) };
    },

    async listTasks(taskListId) {
      record('listTasks', { taskListId });
      return structuredClone(tasksByList[taskListId] ?? { kind: 'tasks#tasks', items: [] });
    },

    async listMessages({ q, maxResults = 100, pageToken } = {}) {
      record('listMessages', { q, maxResults, pageToken });
      if (q === QUERY_IMPORTANT) return messageList(important);
      // 連携が切れていた間の分（Phase 16）：`is:important is:unread after:<エポック秒>`。新しい順に maxResults 件まで
      const after = new RegExp(`^${QUERY_IMPORTANT} after:(\\d+)$`).exec(q ?? '');
      if (after) {
        const sinceMs = Number(after[1]) * 1000;
        return messageList(important.filter((id) => (receivedAt.get(id) ?? 0) > sinceMs).slice(0, maxResults));
      }
      if (q === QUERY_OTHER) {
        // 実 Gmail API と同じく maxResults / pageToken でページングする（pageToken は開始位置）。
        // 結果が1ページに収まらないとき resultSizeEstimate は実件数ではなく 201 の固定値になる（実機ログで確認済みの癖）。
        const start = pageToken ? Number(pageToken) : 0;
        const end = Math.min(start + maxResults, otherCount);
        const res = messageList(Array.from({ length: end - start }, (_, i) => `other-${start + i}`));
        if (otherCount > maxResults) res.resultSizeEstimate = 201;
        if (end < otherCount) res.nextPageToken = String(end);
        return res;
      }
      return { resultSizeEstimate: 0 };
    },

    async getMessage(id) {
      record('getMessage', { id });
      const m = messageMeta[id];
      if (!m) throw new Error(`fake google api: message ${id} not found`);
      return structuredClone(m);
    },

    // ---- テストから状態を動かすヘルパ ----

    /** 重要メールの新着。metadata が fixture に無ければ最小限のものを作る。届いた時刻は今（テストの偽の時計） */
    addImportantMessage(id, { subject, from, at = Date.now() } = {}) {
      important = [id, ...important];
      receivedAt.set(id, at);
      messageMeta[id] ??= {
        id,
        threadId: id,
        labelIds: ['UNREAD', 'IMPORTANT', 'INBOX'],
        snippet: '',
        payload: {
          headers: [
            ...(subject === undefined ? [] : [{ name: 'Subject', value: subject }]),
            { name: 'From', value: from ?? 'someone@example.com' },
          ],
        },
      };
    },
    /** 重要メールを既読にする（一覧から消える）。 */
    readImportantMessage(id) {
      important = important.filter((x) => x !== id);
    },
    setImportantIds(ids) {
      important = [...ids];
    },
    setUnreadOtherCount(n) {
      otherCount = n;
    },

    setEvents(items) {
      events = structuredClone(items);
    },
    removeEvent(eventId) {
      events = events.filter((e) => e.id !== eventId);
    },
    /** 予定を動かす（タイマー再構築のテスト用）。 */
    setEventStart(eventId, dateTime) {
      const e = events.find((x) => x.id === eventId);
      if (e) e.start = { dateTime };
    },
    setDefaultReminders(reminders) {
      defaultReminders = structuredClone(reminders);
    },

    completeTask(taskListId, taskId) {
      const t = tasksByList[taskListId]?.items.find((x) => x.id === taskId);
      if (t) t.status = 'completed';
    },
    setTaskDue(taskListId, taskId, due) {
      const t = tasksByList[taskListId]?.items.find((x) => x.id === taskId);
      if (t) t.due = due;
    },

    /** 次の n 回だけ指定の関数を失敗させる。 */
    failNext(name, n = 1) {
      failures.set(name, n);
    },
  };
}
