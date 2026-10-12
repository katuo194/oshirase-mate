import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_RETRY_MS,
  IDLE_TALK_DEFAULTS,
  createIdleTalk,
  decideCategory,
  isBedtimeHour,
  isMorningHour,
  isQuietHour,
  msUntilQuietEnd,
  normalizeIdleTalkConfig,
} from '../src/main/idleTalk.js';

const MIN = 60 * 1000;
/** ローカル時刻（タイムゾーンに依存しないよう、Date のローカル成分で作る）。 */
const at = (h, m = 0, s = 0, day = 21) => new Date(2026, 8, day, h, m, s).getTime();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('idleTalk / 設定の正規化（6.1 idleTalk）', () => {
  it('欠損・型不正は既定値（有効・15分・静粛 0〜6時）', () => {
    expect(normalizeIdleTalkConfig(undefined)).toEqual({ enabled: true, intervalMin: 15, quietHours: [0, 6] });
    expect(normalizeIdleTalkConfig({ enabled: 'yes', intervalMin: 'x', quietHours: [1] })).toEqual({ enabled: true, intervalMin: 15, quietHours: [0, 6] });
    expect(IDLE_TALK_DEFAULTS.intervalMin).toBe(15);
  });

  it('指定値を反映し、間隔は範囲内に丸める', () => {
    expect(normalizeIdleTalkConfig({ enabled: false, intervalMin: 30, quietHours: [22, 7] })).toEqual({ enabled: false, intervalMin: 30, quietHours: [22, 7] });
    expect(normalizeIdleTalkConfig({ intervalMin: 0 }).intervalMin).toBe(1);
    expect(normalizeIdleTalkConfig({ intervalMin: 99999 }).intervalMin).toBe(240);
    expect(normalizeIdleTalkConfig({ quietHours: [0, 24] }).quietHours).toEqual([0, 6]); // 範囲外の時刻は既定へ
  });
});

describe('idleTalk / 時間帯の判定（3.4）', () => {
  it('静粛時間帯 0:00〜6:00（6時ちょうどは明け）', () => {
    for (const h of [0, 1, 5]) expect(isQuietHour(h, [0, 6])).toBe(true);
    for (const h of [6, 12, 23]) expect(isQuietHour(h, [0, 6])).toBe(false);
  });

  it('日跨ぎの静粛時間帯 [22, 6]・静粛なし（start === end）', () => {
    for (const h of [22, 23, 0, 5]) expect(isQuietHour(h, [22, 6])).toBe(true);
    for (const h of [6, 12, 21]) expect(isQuietHour(h, [22, 6])).toBe(false);
    expect(isQuietHour(3, [3, 3])).toBe(false);
  });

  it('就寝前は静粛時間帯の開始の直前1時間（既定 23:00〜0:00）', () => {
    expect(isBedtimeHour(23, [0, 6])).toBe(true);
    expect(isBedtimeHour(22, [0, 6])).toBe(false);
    expect(isBedtimeHour(0, [0, 6])).toBe(false);
    expect(isBedtimeHour(21, [22, 6])).toBe(true);
    expect(isBedtimeHour(23, [3, 3])).toBe(false);
  });

  it('朝は 5:00〜10:00', () => {
    expect(isMorningHour(4)).toBe(false);
    expect(isMorningHour(5)).toBe(true);
    expect(isMorningHour(9)).toBe(true);
    expect(isMorningHour(10)).toBe(false);
  });

  it('カテゴリの優先順：静粛 → 就寝前 → 朝 → 通常。朝5〜6時は静粛が優先（実際に出るのは6〜10時）', () => {
    const fresh = { talked: false, bedtimeDone: false };
    expect(decideCategory({ hour: 5, quietHours: [0, 6], day: fresh })).toBe('quiet');
    expect(decideCategory({ hour: 6, quietHours: [0, 6], day: fresh })).toBe('morning');
    expect(decideCategory({ hour: 9, quietHours: [0, 6], day: fresh })).toBe('morning');
    expect(decideCategory({ hour: 10, quietHours: [0, 6], day: fresh })).toBe('normal');
    expect(decideCategory({ hour: 23, quietHours: [0, 6], day: fresh })).toBe('bedtime');
    expect(decideCategory({ hour: 3, quietHours: [0, 6], day: fresh })).toBe('quiet');
  });

  it('朝は「その日最初」だけ・就寝前はその日1回だけ', () => {
    expect(decideCategory({ hour: 8, quietHours: [0, 6], day: { talked: true, bedtimeDone: false } })).toBe('normal');
    expect(decideCategory({ hour: 23, quietHours: [0, 6], day: { talked: true, bedtimeDone: true } })).toBe('normal');
    expect(decideCategory({ hour: 23, quietHours: [0, 6], day: { talked: true, bedtimeDone: false } })).toBe('bedtime');
  });

  it('静粛時間帯の明けまでの待ち時間（余裕1秒つき）', () => {
    expect(msUntilQuietEnd(at(3, 0), [0, 6])).toBe(3 * 60 * MIN + 1000);
    expect(msUntilQuietEnd(at(23, 0), [22, 6])).toBe(7 * 60 * MIN + 1000); // 日跨ぎ：翌朝6時まで
  });
});

function setup({ now = at(10, 0), config = {}, accept = true } = {}) {
  vi.setSystemTime(now);
  const cfg = { enabled: true, intervalMin: 15, quietHours: [0, 6], ...config };
  const shown = [];
  const state = { accept };
  const log = { info: vi.fn(), warn: vi.fn() };
  const idle = createIdleTalk({
    getConfig: () => cfg,
    pickPhrase: (category) => `${category}-text`,
    show: (talk) => {
      shown.push({ ...talk, at: Date.now() });
      return state.accept;
    },
    log,
  });
  idle.start();
  return { idle, shown, cfg, state, log };
}

describe('idleTalk / トリガー（無操作15分）', () => {
  it('最終操作（起動）から15分で通常アイドルトークが発火する', () => {
    const { shown } = setup({ now: at(10, 0) });
    vi.advanceTimersByTime(15 * MIN - 1000);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ category: 'normal', text: 'normal-text' });
  });

  it('操作（touch）があると、そこから15分に延びる', () => {
    const { idle, shown } = setup({ now: at(10, 0) });
    vi.advanceTimersByTime(10 * MIN);
    idle.touch();
    vi.advanceTimersByTime(14 * MIN);
    expect(shown).toEqual([]); // 起動から24分だが、操作から14分
    vi.advanceTimersByTime(1 * MIN);
    expect(shown).toHaveLength(1);
  });

  it('発話した時刻が最終操作になり、次はその15分後（連続して発火しない）', () => {
    const { shown } = setup({ now: at(10, 0) });
    vi.advanceTimersByTime(15 * MIN);
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(14 * MIN);
    expect(shown).toHaveLength(1);
    vi.advanceTimersByTime(1 * MIN);
    expect(shown).toHaveLength(2);
    expect(shown[1].at - shown[0].at).toBe(15 * MIN);
  });

  it('間隔は設定（intervalMin）に従う', () => {
    const { shown } = setup({ now: at(10, 0), config: { intervalMin: 30 } });
    vi.advanceTimersByTime(29 * MIN);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1 * MIN);
    expect(shown).toHaveLength(1);
  });

  it('enabled=false なら発話しない', () => {
    const { shown } = setup({ now: at(10, 0), config: { enabled: false } });
    vi.advanceTimersByTime(3 * 60 * MIN);
    expect(shown).toEqual([]);
  });

  it('stop() 後は発火しない・停止中の touch は何も張らない', () => {
    const { idle, shown } = setup({ now: at(10, 0) });
    idle.stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(shown).toEqual([]);
    idle.touch(); // 停止中：タイマーを張らない
    vi.advanceTimersByTime(60 * MIN);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('タイマーは常に1本だけ（常時ポーリングしない）', () => {
    const { idle } = setup({ now: at(10, 0) });
    expect(vi.getTimerCount()).toBe(1);
    for (let i = 0; i < 20; i++) idle.touch();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('idleTalk / 静粛時間帯（0:00〜6:00は発話しない）', () => {
  it('静粛時間帯は発話せず、6:00に明けたら発話する', () => {
    const { shown } = setup({ now: at(0, 10) });
    vi.advanceTimersByTime(at(5, 59, 59) - Date.now());
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(3000); // 6:00:02
    expect(shown).toHaveLength(1);
    expect(shown[0].category).toBe('morning'); // その日最初・6時台
  });

  it('日跨ぎの静粛時間帯 [22, 6] でも、22時以降は発話しない', () => {
    const { shown } = setup({ now: at(22, 0), config: { quietHours: [22, 6] } });
    vi.advanceTimersByTime(at(5, 59, 0, 22) - Date.now());
    expect(shown).toEqual([]);
  });

  it('静粛時間帯に入る直前から放置しても、明けるまで一度も発話しない', () => {
    const { shown } = setup({ now: at(23, 59) });
    // 23:59 起点の発火（0:14）は静粛時間帯として見送られる
    vi.advanceTimersByTime(at(5, 59, 0, 22) - Date.now());
    expect(shown).toEqual([]);
  });
});

describe('idleTalk / 朝の挨拶・就寝前の挨拶', () => {
  it('朝（6〜10時）：その日最初の発話が朝の挨拶、次からは通常', () => {
    const { shown } = setup({ now: at(8, 0) });
    vi.advanceTimersByTime(15 * MIN);
    vi.advanceTimersByTime(15 * MIN);
    expect(shown.map((s) => s.category)).toEqual(['morning', 'normal']);
  });

  it('その日最初の発話が10時以降なら、朝の挨拶は出ない', () => {
    const { shown } = setup({ now: at(10, 0) });
    vi.advanceTimersByTime(15 * MIN);
    expect(shown.map((s) => s.category)).toEqual(['normal']);
  });

  it('翌日になると、また朝の挨拶が出る', () => {
    const { idle, shown } = setup({ now: at(8, 0) });
    vi.advanceTimersByTime(15 * MIN);
    expect(shown.map((s) => s.category)).toEqual(['morning']);
    vi.setSystemTime(at(7, 50, 0, 22));
    idle.touch();
    vi.advanceTimersByTime(15 * MIN);
    expect(shown.map((s) => s.category)).toEqual(['morning', 'morning']);
  });

  it('就寝前（23時台）：その日最初の発話が就寝前の挨拶、その日の2回目は通常', () => {
    const { shown } = setup({ now: at(22, 50) });
    vi.advanceTimersByTime(15 * MIN); // 23:05
    vi.advanceTimersByTime(15 * MIN); // 23:20
    expect(shown.map((s) => s.category)).toEqual(['bedtime', 'normal']);
  });

  it('就寝前の挨拶は23時台より前（22時台）には出ない', () => {
    const { shown } = setup({ now: at(22, 30) });
    vi.advanceTimersByTime(15 * MIN); // 22:45
    expect(shown.map((s) => s.category)).toEqual(['normal']);
  });

  it('朝の挨拶を出した日でも、23時台の最初の発話は就寝前の挨拶になる', () => {
    const { idle, shown } = setup({ now: at(8, 0) });
    vi.advanceTimersByTime(15 * MIN); // 8:15 朝
    vi.setSystemTime(at(22, 50));
    idle.touch();
    vi.advanceTimersByTime(15 * MIN); // 23:05
    expect(shown.map((s) => s.category)).toEqual(['morning', 'bedtime']);
  });
});

describe('idleTalk / 表示できないとき（通知表示中など）', () => {
  it('断られたら1分後に再試行し、状態（朝の挨拶）は消費しない', () => {
    const { shown, state } = setup({ now: at(8, 0), accept: false });
    vi.advanceTimersByTime(15 * MIN);
    expect(shown).toHaveLength(1); // 試みたが断られた
    expect(shown[0].category).toBe('morning');

    vi.advanceTimersByTime(BUSY_RETRY_MS - 1000);
    expect(shown).toHaveLength(1);
    state.accept = true;
    vi.advanceTimersByTime(1000);
    expect(shown).toHaveLength(2);
    expect(shown[1].category).toBe('morning'); // 断られた分は朝の挨拶を消費していない
  });

  it('受理されるまで1分ごとに再試行し続ける', () => {
    const { shown } = setup({ now: at(10, 0), accept: false });
    vi.advanceTimersByTime(15 * MIN + 3 * BUSY_RETRY_MS);
    expect(shown).toHaveLength(4);
  });

  it('受理された後は、その時刻から15分後に再武装する', () => {
    const { shown, state } = setup({ now: at(10, 0), accept: false });
    vi.advanceTimersByTime(15 * MIN);
    state.accept = true;
    vi.advanceTimersByTime(BUSY_RETRY_MS);
    expect(shown).toHaveLength(2);
    vi.advanceTimersByTime(14 * MIN);
    expect(shown).toHaveLength(2);
    vi.advanceTimersByTime(1 * MIN);
    expect(shown).toHaveLength(3);
  });
});

describe('idleTalk / 開発用の即時発話（fireNow）', () => {
  it('間隔・静粛時間帯を無視して指定カテゴリを表示し、受理結果を返す', () => {
    const { idle, shown, state } = setup({ now: at(3, 0) }); // 静粛時間帯
    expect(idle.fireNow('bedtime')).toBe(true);
    expect(shown[0]).toMatchObject({ category: 'bedtime' });
    state.accept = false;
    expect(idle.fireNow()).toBe(false);
    expect(shown[1]).toMatchObject({ category: 'normal' });
  });

  it('その日の状態（朝の挨拶済み）を進めない', () => {
    const { idle, shown } = setup({ now: at(8, 0) });
    idle.fireNow('morning');
    vi.advanceTimersByTime(15 * MIN);
    expect(shown.map((s) => s.category)).toEqual(['morning', 'morning']);
  });
});
