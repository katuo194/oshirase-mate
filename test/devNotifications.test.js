import { describe, expect, it, vi } from 'vitest';
import { makeDevNotification } from '../src/main/devNotifications.js';
import { SOURCES, createNotifyQueue, normalizeNotification } from '../src/main/notifyQueue.js';
import { toPresentation } from '../src/main/notificationView.js';

const NOW = new Date(2026, 8, 20, 9, 0, 0).getTime();

describe('devNotifications / 開発用テスト通知', () => {
  it('3種別とも notifyQueue が受け付ける形で、表示データにも変換できる', () => {
    for (const source of Object.values(SOURCES)) {
      const raw = makeDevNotification(source, 1, NOW);
      expect(normalizeNotification(raw, { now: NOW })).not.toBeNull();
      const p = toPresentation(normalizeNotification(raw, { now: NOW }), { now: NOW });
      expect(p.kind).toBe(source);
      expect(p.title).toContain('【テスト】');
    }
  });

  it('同じ時刻・同じ種別でも連番でIDが変わり、キューに重複として弾かれない', () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const q = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    for (let seq = 1; seq <= 5; seq++) {
      expect(q.push(makeDevNotification(SOURCES.GMAIL, seq, NOW)).accepted).toBe(true);
    }
    expect(q.size()).toBe(5);
  });

  it('カレンダー：開始は10分後、TODO：期限は今日（ローカル日付）', () => {
    const cal = makeDevNotification(SOURCES.CALENDAR, 1, NOW);
    expect(cal.data.startAt).toBe(NOW + 10 * 60 * 1000);
    expect(toPresentation(cal, { now: NOW }).sub).toBe('09:10 開始（10分後）');
    expect(toPresentation(makeDevNotification(SOURCES.TASKS, 1, NOW), { now: NOW }).sub).toBe('期限：9/20（今日）');
  });

  it('未知の種別は例外', () => {
    expect(() => makeDevNotification('x', 1, NOW)).toThrow();
  });
});
