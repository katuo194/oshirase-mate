// config.json の polling.* と taskNotifyHour（6.1）の読み出し用の正規化。Electron に依存しない純粋ロジック。
// 読み取り専用：Phase 4 では設定画面から変更しない（config.json を直接編集して確認に使える）。
// settingsSchema.js（Phase 1 のキーのみ）とは分けてある。

export const POLLING_DEFAULTS = Object.freeze({
  mailIntervalSec: 60,
  calendarIntervalSec: 300,
  taskIntervalSec: 300,
});
export const TASK_NOTIFY_HOUR_DEFAULT = 16;

/** API を叩きすぎないための下限（誤設定でクォータを使い切らない）。 */
export const MIN_INTERVAL_SEC = 10;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const interval = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= MIN_INTERVAL_SEC ? Math.round(v) : fallback);

/**
 * @param {{ polling?: unknown, taskNotifyHour?: unknown }} raw config.json の生の値（欠損・型不正あり得る）
 * @returns {{ polling: { mailIntervalSec: number, calendarIntervalSec: number, taskIntervalSec: number }, taskNotifyHour: number }}
 */
export function normalizePollingConfig(raw) {
  const p = isPlainObject(raw?.polling) ? raw.polling : {};
  const h = raw?.taskNotifyHour;
  return {
    polling: {
      mailIntervalSec: interval(p.mailIntervalSec, POLLING_DEFAULTS.mailIntervalSec),
      calendarIntervalSec: interval(p.calendarIntervalSec, POLLING_DEFAULTS.calendarIntervalSec),
      taskIntervalSec: interval(p.taskIntervalSec, POLLING_DEFAULTS.taskIntervalSec),
    },
    taskNotifyHour: Number.isInteger(h) && h >= 0 && h <= 23 ? h : TASK_NOTIFY_HOUR_DEFAULT,
  };
}
