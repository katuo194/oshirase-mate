import { describe, expect, it } from 'vitest';
import { MIN_INTERVAL_SEC, POLLING_DEFAULTS, TASK_NOTIFY_HOUR_DEFAULT, TASK_NOTIFY_MINUTE_DEFAULT, normalizePollingConfig } from '../src/main/pollingConfig.js';

describe('pollingConfig', () => {
  it('未設定なら2.1の既定値（メール1分・カレンダー5分・TODO5分・16:00）', () => {
    expect(normalizePollingConfig({})).toEqual({
      polling: POLLING_DEFAULTS,
      taskNotifyHour: TASK_NOTIFY_HOUR_DEFAULT,
      taskNotifyMinute: TASK_NOTIFY_MINUTE_DEFAULT,
    });
    expect(normalizePollingConfig(undefined).taskNotifyHour).toBe(16);
    expect(normalizePollingConfig(undefined).taskNotifyMinute).toBe(0);
    expect(POLLING_DEFAULTS).toEqual({ mailIntervalSec: 60, calendarIntervalSec: 300, taskIntervalSec: 300 });
  });

  it('config.json の値を読む（一部だけの指定も可）', () => {
    const c = normalizePollingConfig({ polling: { mailIntervalSec: 30 }, taskNotifyHour: 9 });
    expect(c.polling).toEqual({ mailIntervalSec: 30, calendarIntervalSec: 300, taskIntervalSec: 300 });
    expect(c.taskNotifyHour).toBe(9);
  });

  it('不正な型・範囲外は既定値に戻す', () => {
    const c = normalizePollingConfig({ polling: { mailIntervalSec: 'fast', calendarIntervalSec: NaN }, taskNotifyHour: 25 });
    expect(c.polling.mailIntervalSec).toBe(60);
    expect(c.polling.calendarIntervalSec).toBe(300);
    expect(c.taskNotifyHour).toBe(16);
    expect(normalizePollingConfig({ taskNotifyHour: 7.5 }).taskNotifyHour).toBe(16);
    expect(normalizePollingConfig({ polling: 'x' }).polling).toEqual(POLLING_DEFAULTS);
  });

  it('0時は有効な値（falsy で既定値に化けない）', () => {
    expect(normalizePollingConfig({ taskNotifyHour: 0 }).taskNotifyHour).toBe(0);
  });

  it('TODO の通知時刻の分（Phase 16）：0〜59 の整数だけを読み、ほかは 0 に戻す。分の無い古い config.json は 0 分', () => {
    expect(normalizePollingConfig({ taskNotifyHour: 9, taskNotifyMinute: 30 })).toMatchObject({ taskNotifyHour: 9, taskNotifyMinute: 30 });
    expect(normalizePollingConfig({ taskNotifyHour: 9 }).taskNotifyMinute).toBe(0);
    expect(normalizePollingConfig({ taskNotifyMinute: 59 }).taskNotifyMinute).toBe(59);
    for (const taskNotifyMinute of [60, -1, 7.5, '30', null]) {
      expect(normalizePollingConfig({ taskNotifyMinute }).taskNotifyMinute).toBe(0);
    }
  });

  it('下限未満の間隔は API を叩きすぎるため既定値に戻す', () => {
    expect(normalizePollingConfig({ polling: { mailIntervalSec: MIN_INTERVAL_SEC - 1 } }).polling.mailIntervalSec).toBe(60);
    expect(normalizePollingConfig({ polling: { mailIntervalSec: MIN_INTERVAL_SEC } }).polling.mailIntervalSec).toBe(MIN_INTERVAL_SEC);
  });
});
