import { describe, expect, it } from 'vitest';
import { createApiUsage } from '../src/main/apiUsage.js';

const HOUR = 60 * 60 * 1000;

function setup() {
  const clock = { t: 0 };
  return { clock, usage: createApiUsage({ now: () => clock.t }) };
}

describe('apiUsage / 呼び出し回数の実測', () => {
  it('メソッド別に回数を数え、失敗も数える', () => {
    const { usage } = setup();
    usage.record('calendar.events.list');
    usage.record('calendar.events.list');
    usage.record('calendar.events.list', { ok: false });
    const m = usage.snapshot().methods.find((x) => x.method === 'calendar.events.list');
    expect(m).toMatchObject({ calls: 3, failures: 1, units: 3, service: 'calendar' });
  });

  it('Gmail の list / get は1回5ユニットで数える', () => {
    const { usage } = setup();
    usage.record('gmail.users.messages.list');
    usage.record('gmail.users.messages.get');
    expect(usage.snapshot().services.gmail).toMatchObject({ calls: 2, units: 10 });
  });

  it('経過時間から1日換算する（1時間で Gmail 120回 → 1日 2880回・14400ユニット）', () => {
    const { usage, clock } = setup();
    for (let i = 0; i < 120; i++) usage.record('gmail.users.messages.list'); // 1分ごとに2系統 × 60分
    clock.t = HOUR;
    const s = usage.snapshot();
    expect(s.methods[0].unitsPerDay).toBe(14400);
    expect(s.services.gmail.unitsPerDay).toBe(14400);
  });

  it('サービスごとに合計する', () => {
    const { usage, clock } = setup();
    usage.record('tasks.tasklists.list');
    usage.record('tasks.tasks.list');
    usage.record('tasks.tasks.list');
    clock.t = HOUR;
    expect(usage.snapshot().services.tasks).toMatchObject({ calls: 3, units: 3, unitsPerDay: 72 });
  });

  it('ログ用テキストにメソッドと換算値が入る', () => {
    const { usage, clock } = setup();
    usage.record('calendar.events.list');
    clock.t = HOUR;
    const text = usage.format();
    expect(text).toContain('calendar.events.list: 1回（失敗0）');
    expect(text).toContain('1日換算 約24');
  });

  it('何も記録していなくても落ちない', () => {
    expect(setup().usage.snapshot().methods).toEqual([]);
    expect(setup().usage.format()).toContain('[apiUsage]');
  });
});
