import { describe, expect, it, vi } from 'vitest';
import { createMailSummary } from '../src/main/mailSummary.js';
import { formatNotification, formatSummary, createNotificationLogger } from '../src/main/notificationLogger.js';
import { SOURCES, createNotifyQueue, makeNotificationId } from '../src/main/notifyQueue.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');

function setup() {
  const mailSummary = createMailSummary();
  const lines = [];
  const consumer = createNotificationLogger({ mailSummary, log: { info: (l) => lines.push(l) } });
  return { mailSummary, consumer, lines };
}

const cal = (id, extra = {}) => ({
  id: makeNotificationId(SOURCES.CALENDAR, id, NOW),
  source: SOURCES.CALENDAR,
  title: `予定${id}`,
  body: '10分後に開始',
  notifyAt: NOW,
  ...extra,
});
const mail = (id) => ({
  id: makeNotificationId(SOURCES.GMAIL, id),
  source: SOURCES.GMAIL,
  title: `件名${id}`,
  body: '田中',
  notifyAt: NOW,
  data: { date: 'Sun, 20 Sep 2026 18:00:00 +0900', snippet: '本文の一部（ログに出さない）' },
});

describe('notificationLogger / 通知のログ出力（Phase 5：取り出しは presenter の担当。ここはログのみ）', () => {
  it('logShown は通知を1行で出す', () => {
    const { consumer, lines } = setup();
    consumer.logShown({ ...cal('a'), queuedAt: NOW, data: {} });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[notify] カレンダー 「予定a」 10分後に開始');
  });

  it('キューを取り出さない（購読も take もしない）：ログ用のコンシューマーがキューを奪わない', async () => {
    const store = { load: vi.fn(async () => ({})), save: vi.fn(async (n) => n) };
    const notifyQueue = createNotifyQueue({ store, now: () => NOW, log: { info() {}, warn() {} } });
    const { consumer, lines } = setup();
    consumer.start();
    notifyQueue.push(mail('m1'));
    expect(lines).toEqual([]);
    expect(notifyQueue.size()).toBe(1);
    expect(notifyQueue.isNotified(makeNotificationId(SOURCES.GMAIL, 'm1'))).toBe(false);
    await notifyQueue.whenPersisted();
  });
});

describe('notificationLogger / サマリのログ出力', () => {
  it('mailSummary の updated を受けて件数の更新をログに出す', () => {
    const { mailSummary, consumer, lines } = setup();
    consumer.start();
    mailSummary.update(3);
    mailSummary.update(5);
    mailSummary.update(5); // 変化なし → 出ない
    expect(lines).toEqual([
      '[summary] 重要以外の未読: - → 3件（initial）',
      '[summary] 重要以外の未読: 3 → 5件（increased +2）',
    ]);
  });

  it('reset（連携解除）をログに出す', () => {
    const { mailSummary, consumer, lines } = setup();
    consumer.start();
    mailSummary.update(3);
    mailSummary.reset();
    expect(lines.at(-1)).toContain('リセット');
  });

  it('stop() 後は購読しない。start() の二重呼び出しでも二重にログしない', () => {
    const { mailSummary, consumer, lines } = setup();
    consumer.start();
    consumer.start();
    mailSummary.update(1);
    expect(lines).toHaveLength(1);

    consumer.stop();
    mailSummary.update(2);
    mailSummary.reset();
    expect(lines).toHaveLength(1);
  });
});

describe('notificationLogger / 整形', () => {
  it('カレンダー：予定時刻・検知時刻・遅延を出す（4章の応答性の確認用）', () => {
    const line = formatNotification({ ...cal('a'), queuedAt: NOW + 1200, data: {} });
    expect(line).toContain('予定 ');
    expect(line).toContain('（+1.2秒）');
  });

  it('メール：件名・差出人・Date ヘッダは出すが、本文（snippet）は出さない', () => {
    const line = formatNotification({ ...mail('m1'), queuedAt: NOW, data: mail('m1').data });
    expect(line).toContain('重要メール 「件名m1」 田中');
    expect(line).toContain('Date: Sun, 20 Sep 2026 18:00:00 +0900');
    expect(line).not.toContain('本文の一部');
  });

  it('サマリ：上限で頭打ちのときは「2500+件」（バッジは99+に丸めるが、ログには正確な件数を残す）', () => {
    expect(formatSummary({ previous: null, count: 2500, capped: true, kind: 'initial', delta: 0 })).toBe('[summary] 重要以外の未読: - → 2500+件（initial）');
  });

  it('サマリ：初回は「-」から', () => {
    expect(formatSummary({ previous: null, count: 3, kind: 'initial', delta: 0 })).toBe('[summary] 重要以外の未読: - → 3件（initial）');
    expect(formatSummary({ previous: 5, count: 2, kind: 'decreased', delta: -3 })).toContain('（decreased -3）');
  });
});
