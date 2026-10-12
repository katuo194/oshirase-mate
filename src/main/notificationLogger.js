// 通知のログ出力（デバッグ・実測用）。Phase 4 では暫定のコンシューマー（キューを取り出してログに出す）だったが、
// Phase 5 で取り出しと表示は notificationPresenter.js に移った。ここは「ログに出すだけ」で、take() は一切しない。
//
//   logShown(n)             … 表示を始めた通知を1行で出す（4章「リマインダー時刻から10秒以内」の遅延確認用の検知時刻つき）
//   mailSummary 'updated'   … 未読件数の更新（バッジの数字は「99+」に丸めるが、正確な件数はこのログで確認する：7.1）
//   mailSummary 'reset'     … 連携解除などでバッジを消したこと
//
// Electron に依存しない。メール本文（snippet）はログに出さない。

import { localTimestamp } from './logger.js';

const SOURCE_LABEL = Object.freeze({ calendar: 'カレンダー', tasks: 'TODO', gmail: '重要メール' });

/** 遅延（ms）を読みやすくする。 */
function formatLatency(ms) {
  const sign = ms >= 0 ? '+' : '-';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(1)}秒`;
}

/**
 * 通知1件の、ログ用の1行。
 * カレンダー・TODO は予定時刻と実際にキューへ積まれた時刻の差を出す（4章「リマインダー時刻から10秒以内」の確認用）。
 */
export function formatNotification(n) {
  const label = SOURCE_LABEL[n.source] ?? n.source;
  const head = `[notify] ${label} 「${n.title}」 ${n.body}`;
  if (n.source === 'gmail') {
    return `${head} | 検知 ${localTimestamp(n.queuedAt)} | Date: ${n.data.date || '(なし)'} | ${n.id}`;
  }
  return `${head} | 予定 ${localTimestamp(n.notifyAt)} → 検知 ${localTimestamp(n.queuedAt)}（${formatLatency(n.queuedAt - n.notifyAt)}）| ${n.id}`;
}

export function formatSummary(u) {
  const from = u.previous === null ? '-' : `${u.previous}`;
  return `[summary] 重要以外の未読: ${from} → ${u.count}${u.capped ? '+' : ''}件（${u.kind}${u.delta ? ` ${u.delta > 0 ? '+' : ''}${u.delta}` : ''}）`;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./mailSummary.js').createMailSummary>} deps.mailSummary
 * @param {{ info: Function }} [deps.log]
 * @returns {{ start: () => void, stop: () => void, logShown: (notification: object) => void }}
 */
export function createNotificationLogger({ mailSummary, log = console }) {
  const onSummary = (u) => log.info(formatSummary(u));
  const onReset = () => log.info('[summary] 重要以外の未読: リセット（バッジを消去）');

  let started = false;
  return {
    /** 表示を始めた通知を出す（presenter の show から呼ぶ）。 */
    logShown: (n) => log.info(formatNotification(n)),

    start() {
      if (started) return;
      started = true;
      mailSummary.events.on('updated', onSummary);
      mailSummary.events.on('reset', onReset);
    },

    stop() {
      if (!started) return;
      started = false;
      mailSummary.events.off('updated', onSummary);
      mailSummary.events.off('reset', onReset);
    },
  };
}
