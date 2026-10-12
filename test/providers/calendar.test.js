import { describe, expect, it } from 'vitest';
import { NOW, createFakeGoogleApi } from '../../mocks/google/index.js';
import {
  createCalendarProvider,
  eventStartAt,
  normalizeEvents,
  remindersOf,
} from '../../src/main/providers/calendar.js';

const now = () => NOW;
const at = (iso) => Date.parse(iso);
/** 終日予定はローカル0時基準なので、期待値も同じ組み立て方で作る（タイムゾーン非依存にするため） */
const localMidnight = (y, m, d) => new Date(y, m - 1, d, 0, 0, 0, 0).getTime();

const poll = () => createCalendarProvider({ listEvents: createFakeGoogleApi().listEvents, now }).poll();
const byEvent = (list, eventId) => list.filter((n) => n.data.eventId === eventId);

describe('eventStartAt', () => {
  it('時刻付きの予定は dateTime をそのまま使う', () => {
    expect(eventStartAt({ start: { dateTime: '2026-09-20T12:00:00Z' } })).toEqual({
      startAt: at('2026-09-20T12:00:00Z'),
      allDay: false,
    });
  });

  it('終日予定は date からローカル0時を組み立てる', () => {
    expect(eventStartAt({ start: { date: '2026-09-21' } })).toEqual({
      startAt: localMidnight(2026, 9, 21),
      allDay: true,
    });
  });

  it('開始時刻が読めない予定は null', () => {
    expect(eventStartAt({ start: {} })).toBeNull();
    expect(eventStartAt({})).toBeNull();
  });
});

describe('remindersOf', () => {
  const defaults = [{ method: 'popup', minutes: 10 }];

  it('useDefault なら defaultReminders を使う', () => {
    expect(remindersOf({ reminders: { useDefault: true } }, defaults)).toEqual(defaults);
  });

  it('overrides があればそちらを使う', () => {
    expect(remindersOf({ reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] } }, defaults)).toEqual([
      { method: 'popup', minutes: 5 },
    ]);
  });

  it('リマインダーが無ければ空', () => {
    expect(remindersOf({ reminders: { useDefault: false } }, defaults)).toEqual([]);
    expect(remindersOf({}, defaults)).toEqual([]);
  });
});

describe('providers/calendar / F-02 カレンダー通知の検知', () => {
  it('既定リマインダー（10分前）から発火時刻を算出する', async () => {
    const [n] = byEvent(await poll(), 'evt-default-reminder');
    expect(n.notifyAt).toBe(at('2026-09-20T11:50:00Z'));
    expect(n.id).toBe(`cal:evt-default-reminder:${at('2026-09-20T11:50:00Z')}`);
    expect(n.source).toBe('calendar');
    expect(n.title).toBe('チームミーティング');
    expect(n.body).toBe('10分後に開始');
    expect(n.data).toMatchObject({
      startAt: at('2026-09-20T12:00:00Z'),
      allDay: false,
      minutesBefore: 10,
      location: '会議室A',
    });
  });

  it('overrides が複数あればリマインダーの数だけ通知を作る', async () => {
    const list = byEvent(await poll(), 'evt-multi-overrides');
    expect(list.map((n) => n.notifyAt)).toEqual([at('2026-09-20T14:00:00Z'), at('2026-09-20T14:30:00Z')]);
    expect(list.map((n) => n.data.minutesBefore)).toEqual([60, 30]);
    // 同一予定でもIDが衝突しない（発火時刻をIDに含めているため）
    expect(new Set(list.map((n) => n.id)).size).toBe(2);
  });

  it('終日予定はローカル0時を開始時刻として扱う（タイムゾーンで日付がずれない）', async () => {
    const [n] = byEvent(await poll(), 'evt-all-day');
    expect(n.notifyAt).toBe(localMidnight(2026, 9, 21) - 10 * 60 * 1000);
    expect(n.data.allDay).toBe(true);
    expect(new Date(n.data.startAt).getDate()).toBe(21);
  });

  it('リマインダー時刻が既に過ぎていても通知対象にする（即時発火させるため）', async () => {
    const [n] = byEvent(await poll(), 'evt-past-reminder');
    expect(n.notifyAt).toBe(at('2026-09-20T08:55:00Z'));
    expect(n.notifyAt).toBeLessThan(NOW);
  });

  it('リマインダーが無い予定・キャンセル済み・本人が欠席の予定は通知しない', async () => {
    const list = await poll();
    expect(byEvent(list, 'evt-no-reminders')).toEqual([]);
    expect(byEvent(list, 'evt-cancelled')).toEqual([]);
    expect(byEvent(list, 'evt-declined')).toEqual([]);
  });

  it('繰り返し予定は展開済みインスタンスのIDで通知する', async () => {
    const [n] = byEvent(await poll(), 'evt-recurring_20260920T200000Z');
    expect(n.id).toBe(`cal:evt-recurring_20260920T200000Z:${at('2026-09-20T19:55:00Z')}`);
  });

  it('既に始まっている予定のリマインダーは出さない', () => {
    const list = normalizeEvents(
      {
        defaultReminders: [{ method: 'popup', minutes: 10 }],
        items: [
          {
            id: 'evt-ongoing',
            status: 'confirmed',
            summary: '進行中の会議',
            start: { dateTime: '2026-09-20T08:30:00Z' },
            end: { dateTime: '2026-09-20T09:30:00Z' },
            reminders: { useDefault: true },
          },
        ],
      },
      { now: NOW },
    );
    expect(list).toEqual([]);
  });

  it('同じ時刻のリマインダーが重複定義されていても1件にまとめる', () => {
    const list = normalizeEvents(
      {
        defaultReminders: [],
        items: [
          {
            id: 'evt-dup',
            status: 'confirmed',
            summary: '重複',
            start: { dateTime: '2026-09-20T12:00:00Z' },
            reminders: {
              useDefault: false,
              overrides: [
                { method: 'popup', minutes: 10 },
                { method: 'email', minutes: 10 },
              ],
            },
          },
        ],
      },
      { now: NOW },
    );
    expect(list).toHaveLength(1);
  });

  it('発火時刻の昇順で返す', async () => {
    const list = await poll();
    expect(list).toHaveLength(6);
    for (let i = 1; i < list.length; i++) {
      expect(list[i].notifyAt).toBeGreaterThanOrEqual(list[i - 1].notifyAt);
    }
  });

  it('通知IDはすべて cal: プレフィックスで一意', async () => {
    const list = await poll();
    expect(list.every((n) => n.id.startsWith('cal:'))).toBe(true);
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
  });

  it('空のレスポンスでも落ちない', () => {
    expect(normalizeEvents({}, { now: NOW })).toEqual([]);
    expect(normalizeEvents(null, { now: NOW })).toEqual([]);
  });
});
