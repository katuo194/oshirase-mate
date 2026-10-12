// 開発用のテスト通知（--dev 起動時のトレイ／右クリックメニューからのみ使う）。
// 実際の Google イベントを待たずに、種別ごとの見た目・キュー順・ドラッグ・ミュート・バッジを実機で確認するためのもの。
// 本物と同じ形（providers が作る通知と同じフィールド）の通知を作るだけで、Electron・API には触れない。
// 内容はすべてダミー（実在のメール・予定は使わない）。IDは連番＋時刻で毎回一意なので、通知済み判定（F-05）には弾かれない。

import { SOURCES, makeNotificationId } from './notifyQueue.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** ローカルの今日を 'YYYY-MM-DD' で返す（Tasks の期限日と同じ形式）。 */
function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * @param {'calendar' | 'tasks' | 'gmail'} source
 * @param {number} seq 連番（IDを一意にする。同じ source・同じ時刻でも衝突しない）
 * @param {number} [now]
 */
export function makeDevNotification(source, seq, now = Date.now()) {
  const tag = `dev${now}x${seq}`;
  switch (source) {
    case SOURCES.CALENDAR:
      return {
        id: makeNotificationId(SOURCES.CALENDAR, tag, now),
        source,
        title: `【テスト】定例ミーティング ${seq}`,
        body: '10分後に開始',
        notifyAt: now,
        data: { eventId: tag, startAt: now + 10 * 60 * 1000, allDay: false },
      };
    case SOURCES.TASKS: {
      const due = localDateKey(now);
      return {
        id: makeNotificationId(SOURCES.TASKS, 'dev', tag, due),
        source,
        title: `【テスト】書類を提出する ${seq}`,
        body: `期限：${due}`,
        notifyAt: now,
        data: { taskListId: 'dev', taskListTitle: 'テスト', taskId: tag, due },
      };
    }
    case SOURCES.GMAIL:
      return {
        id: makeNotificationId(SOURCES.GMAIL, tag),
        source,
        title: `【テスト】見積書のご確認のお願い ${seq}`,
        body: 'テスト 太郎',
        notifyAt: now,
        data: { messageId: tag, threadId: tag, subject: `見積書のご確認のお願い ${seq}`, date: '' },
      };
    default:
      throw new Error(`unknown notification source: ${source}`);
  }
}
