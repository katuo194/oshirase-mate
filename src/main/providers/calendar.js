// カレンダー通知（2.1 / 7.1）。events.list のレスポンスを、リマインダー時刻付きの通知オブジェクトへ正規化する。
//
// Phase 3 では実通信を行わない。ここにあるのは「生レスポンス → 通知」の純粋関数と、
// 取得関数を注入するファクトリだけ（authCore.js / auth.js と同じ分割）。
// Phase 4 では listEvents に googleapis の events.list ラッパを渡す：
//   listEvents: () => calendar.events.list({
//     calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
//   }).then((r) => r.data)
//
// 生成した通知は即時発火ではなく「予約通知」で、reminderTimers に渡して setTimeout に載せる。

import { SOURCES, makeNotificationId } from '../notifyQueue.js';
import { localTimeOnDate } from './dateOnly.js';

/** events.list の取得範囲（2.1「今後24時間分」）。 */
export const LOOKAHEAD_HOURS = 24;

/** 本人が「欠席」で返答済みの予定は通知しない。 */
function isDeclinedBySelf(event) {
  return (event.attendees ?? []).some((a) => a.self === true && a.responseStatus === 'declined');
}

/**
 * 予定の開始時刻（エポックms）。終日予定は start.date しか持たないため、ローカル0時として扱う。
 * @returns {{ startAt: number, allDay: boolean } | null}
 */
export function eventStartAt(event) {
  const dateTime = event.start?.dateTime;
  if (typeof dateTime === 'string') {
    const t = Date.parse(dateTime);
    return Number.isFinite(t) ? { startAt: t, allDay: false } : null;
  }
  const t = localTimeOnDate(event.start?.date, 0);
  return t === null ? null : { startAt: t, allDay: true };
}

/**
 * 予定に紐づくリマインダーの一覧。useDefault ならカレンダーの defaultReminders を使う（7.1）。
 * @returns {Array<{ minutes: number, method: string }>}
 */
export function remindersOf(event, defaultReminders = []) {
  const r = event.reminders;
  const list = r?.useDefault ? defaultReminders : (r?.overrides ?? []);
  return list.filter((x) => Number.isFinite(x?.minutes)).map((x) => ({ minutes: x.minutes, method: x.method ?? 'popup' }));
}

/**
 * events.list のレスポンスを通知オブジェクトの配列にする（純粋関数）。発火時刻の昇順。
 *
 * 1予定に複数のリマインダー（10分前・1時間前など）があれば、その数だけ通知を作る。
 * method（popup / email）では絞らない。Googleがメールしか出さない設定でも、
 * ユーザーに気付かせるという本アプリの目的（1.3）からは通知すべきだから。
 *
 * @param {object} response events.list のレスポンス
 * @param {{ now: number }} ctx
 */
export function normalizeEvents(response, { now }) {
  const defaultReminders = response?.defaultReminders ?? [];
  const out = [];

  for (const event of response?.items ?? []) {
    if (event.status === 'cancelled') continue;
    if (isDeclinedBySelf(event)) continue;

    const start = eventStartAt(event);
    if (!start) continue;
    // 既に始まっている予定のリマインダーは意味がないので出さない
    // （timeMin=now でも、開始済みで終了前の予定は返ってくる）
    if (start.startAt <= now) continue;

    const seen = new Set();
    for (const reminder of remindersOf(event, defaultReminders)) {
      const notifyAt = start.startAt - reminder.minutes * 60 * 1000;
      if (seen.has(notifyAt)) continue; // 同じ時刻のリマインダーが重複定義されている場合
      seen.add(notifyAt);

      out.push({
        id: makeNotificationId(SOURCES.CALENDAR, event.id, notifyAt),
        source: SOURCES.CALENDAR,
        title: event.summary || '(タイトルなし)',
        body: reminder.minutes > 0 ? `${reminder.minutes}分後に開始` : 'まもなく開始',
        notifyAt,
        data: {
          eventId: event.id,
          startAt: start.startAt,
          allDay: start.allDay,
          minutesBefore: reminder.minutes,
          method: reminder.method,
          location: event.location ?? '',
          htmlLink: event.htmlLink ?? '',
        },
      });
    }
  }

  return out.sort((a, b) => a.notifyAt - b.notifyAt);
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.listEvents events.list の生レスポンスを返す（Phase 4 で googleapis に差し替え）
 * @param {() => number} deps.now
 */
export function createCalendarProvider({ listEvents, now = Date.now }) {
  return {
    /** @returns {Promise<object[]>} 予約通知の配列（reminderTimers.reconcile にそのまま渡せる） */
    async poll() {
      return normalizeEvents(await listEvents(), { now: now() });
    },
  };
}
