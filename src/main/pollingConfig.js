// config.json の polling.* と taskNotifyHour・taskNotifyMinute（6.1）の読み出し用の正規化。Electron に依存しない純粋ロジック。
// polling.* は読み取り専用（config.json を直接編集する）。TODO の通知時刻は Phase 16 から設定画面で変えられ、
// 書き込みは settingsSchema.js（sanitizePatch・diffPatch）の経路で行う。ここは読み出しだけを担う。

export const POLLING_DEFAULTS = Object.freeze({
  mailIntervalSec: 60,
  calendarIntervalSec: 300,
  taskIntervalSec: 300,
});
export const TASK_NOTIFY_HOUR_DEFAULT = 16;
export const TASK_NOTIFY_MINUTE_DEFAULT = 0;

/** API を叩きすぎないための下限（誤設定でクォータを使い切らない）。 */
export const MIN_INTERVAL_SEC = 10;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const interval = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= MIN_INTERVAL_SEC ? Math.round(v) : fallback);

/**
 * @param {{ polling?: unknown, taskNotifyHour?: unknown, taskNotifyMinute?: unknown }} raw config.json の生の値（欠損・型不正あり得る）
 * @returns {{ polling: { mailIntervalSec: number, calendarIntervalSec: number, taskIntervalSec: number }, taskNotifyHour: number, taskNotifyMinute: number }}
 */
export function normalizePollingConfig(raw) {
  const p = isPlainObject(raw?.polling) ? raw.polling : {};
  const h = raw?.taskNotifyHour;
  const m = raw?.taskNotifyMinute;
  return {
    polling: {
      mailIntervalSec: interval(p.mailIntervalSec, POLLING_DEFAULTS.mailIntervalSec),
      calendarIntervalSec: interval(p.calendarIntervalSec, POLLING_DEFAULTS.calendarIntervalSec),
      taskIntervalSec: interval(p.taskIntervalSec, POLLING_DEFAULTS.taskIntervalSec),
    },
    taskNotifyHour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : TASK_NOTIFY_HOUR_DEFAULT,
    taskNotifyMinute: Number.isInteger(m) && m >= 0 && m <= 59 ? m : TASK_NOTIFY_MINUTE_DEFAULT,
  };
}
