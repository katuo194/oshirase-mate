import { describe, expect, it } from 'vitest';
import {
  BURST_MS,
  LOOP_CYCLE_MS,
  MIN_HOLD_MS,
  OUT_MS,
  formatBadgeText,
  formatDueDate,
  formatRelativeStart,
  MAX_VOICE_HOLD_MS,
  SPEECH_MAX,
  VOICE_TAIL_MS,
  systemPresentation,
  toPresentation,
  toSpeechText,
  totalMs,
} from '../src/main/notificationView.js';
import { DEFAULT_NOTIFY_LINES } from '../src/main/characterLines.js';

// ローカル時刻で組み立てる（テストがタイムゾーンに依存しないように、表示側と同じくローカル基準で比較する）
const NOW = new Date(2026, 8, 20, 9, 0, 0).getTime(); // 2026-09-20 09:00 ローカル
const at = (h, mi) => new Date(2026, 8, 20, h, mi, 0).getTime();

const cal = (extra = {}) => ({
  id: 'cal:e1:1', source: 'calendar', title: '定例ミーティング', body: '10分後に開始',
  data: { startAt: at(9, 10), allDay: false }, ...extra,
});
const task = (extra = {}) => ({
  id: 'task:l:t:2026-09-20', source: 'tasks', title: '書類を出す', body: '期限：2026-09-20',
  data: { due: '2026-09-20' }, ...extra,
});
const mail = (extra = {}) => ({
  id: 'mail:m1', source: 'gmail', title: '見積のご確認', body: '田中', data: {}, ...extra,
});

describe('notificationView / F-11 種別ごとに見た目が変わる', () => {
  const [c, t, m] = [cal(), task(), mail()].map((n) => toPresentation(n, { now: NOW }));

  it('種別・ラベル・sfxKey が種別ごとに決まる', () => {
    expect([c.kind, t.kind, m.kind]).toEqual(['calendar', 'tasks', 'gmail']);
    expect([c.label, t.label, m.label]).toEqual(['予定', 'TODO', '重要メール']);
    expect([c.sfxKey, t.sfxKey, m.sfxKey]).toEqual(['calendar', 'tasks', 'gmail']);
  });

  it('色味が3種別で互いに異なる', () => {
    expect(new Set([c.params.accent, t.params.accent, m.params.accent]).size).toBe(3);
    expect(new Set([c.params.tint, t.params.tint, m.params.tint]).size).toBe(3);
  });

  it('動きのパターン（冒頭の動き・ループ）が3種別で互いに異なる', () => {
    expect(new Set([c.params.burst, t.params.burst, m.params.burst]).size).toBe(3);
    expect(new Set([c.params.loop, t.params.loop, m.params.loop]).size).toBe(3);
  });

  it('マスコットは常時表示なので、出現・退場の動き（appear / leave）は持たない', () => {
    for (const p of [c, t, m]) {
      expect(p.params).not.toHaveProperty('appear');
      expect(p.params).not.toHaveProperty('idle');
      expect(p.params).not.toHaveProperty('leave');
    }
  });

  it('未知の種別は中立の見た目にフォールバックする', () => {
    const p = toPresentation({ id: 'x:1', source: 'unknown', title: 'a', body: 'b' }, { now: NOW });
    expect(p).toMatchObject({ kind: 'generic', label: '通知', sfxKey: 'default', sub: 'b' });
  });

  it('params は呼び出しごとの別オブジェクト（共有定数を書き換えられない）', () => {
    const a = toPresentation(cal(), { now: NOW });
    a.params.accent = '#000000';
    expect(toPresentation(cal(), { now: NOW }).params.accent).not.toBe('#000000');
  });
});

describe('notificationView / F-04 タイミング（通知なし→通知アニメーション→通知なし）', () => {
  it('冒頭の動き・終わりの絞り・ループ周期が決まっている。出現・退場の遷移時間は持たない', () => {
    for (const n of [cal(), task(), mail()]) {
      const { timing } = toPresentation(n, { now: NOW });
      expect(timing).toMatchObject({ burstMs: BURST_MS, outMs: OUT_MS, loopCycleMs: LOOP_CYCLE_MS });
      expect(timing).not.toHaveProperty('appearMs');
      expect(timing).not.toHaveProperty('leaveMs');
    }
    expect([BURST_MS, OUT_MS, LOOP_CYCLE_MS]).toEqual([1000, 500, 1500]);
  });

  it('表示保持は種別ごとの長さ：カレンダー8秒／TODO6秒／メール5秒（内容を読み切れる長さ）', () => {
    const hold = (n) => toPresentation(n, { now: NOW }).timing.holdMs;
    expect([hold(cal()), hold(task()), hold(mail())]).toEqual([8000, 6000, 5000]);
  });

  it('冒頭の動きは表示保持の内側に収まる（保持が最短の3秒でも burst が終わってからループに入る）', () => {
    expect(BURST_MS).toBeLessThan(MIN_HOLD_MS);
  });

  it('後続が溜まっていれば保持時間を×0.6に縮め、下限は3秒', () => {
    const hold = (n, backlog) => toPresentation(n, { now: NOW, backlog }).timing.holdMs;
    expect(hold(cal(), 1)).toBe(4800);
    expect(hold(task(), 4)).toBe(3600);
    expect(hold(mail(), 1)).toBe(MIN_HOLD_MS); // 5000×0.6=3000
    expect(hold(cal(), 0)).toBe(8000);
  });

  it('totalMs は表示保持＋終わりの絞り', () => {
    expect(totalMs(toPresentation(cal(), { now: NOW }).timing)).toBe(8000 + 500);
    expect(totalMs(toPresentation(mail(), { now: NOW, backlog: 1 }).timing)).toBe(3000 + 500);
  });
});

describe('notificationView / 吹き出しの内容', () => {
  it('カレンダー：予定名と開始時刻（開始までの相対表記つき）', () => {
    const p = toPresentation(cal(), { now: NOW });
    expect(p.title).toBe('定例ミーティング');
    expect(p.sub).toBe('09:10 開始（10分後）');
  });

  it('カレンダー：表示時点の時刻から相対表記を計算する（キュー待ちで時間が進んだ分を反映）', () => {
    expect(toPresentation(cal(), { now: at(9, 5) }).sub).toBe('09:10 開始（5分後）');
    expect(toPresentation(cal(), { now: at(9, 10) }).sub).toBe('09:10 開始（まもなく）');
  });

  it('カレンダー：終日予定は「終日」', () => {
    expect(toPresentation(cal({ data: { startAt: at(0, 0), allDay: true } }), { now: NOW }).sub).toBe('終日');
  });

  it('カレンダー：開始時刻が無ければ元の body を使う', () => {
    expect(toPresentation(cal({ data: {} }), { now: NOW }).sub).toBe('10分後に開始');
  });

  it('TODO：タスク名と期限（今日／明日／昨日／それ以外）', () => {
    expect(toPresentation(task(), { now: NOW })).toMatchObject({ title: '書類を出す', sub: '期限：9/20（今日）' });
    expect(toPresentation(task({ data: { due: '2026-09-21' } }), { now: NOW }).sub).toBe('期限：9/21（明日）');
    expect(toPresentation(task({ data: { due: '2026-09-19' } }), { now: NOW }).sub).toBe('期限：9/19（昨日）');
    expect(toPresentation(task({ data: { due: '2026-10-05' } }), { now: NOW }).sub).toBe('期限：10/5');
  });

  it('TODO：期限が読めなければ元の body を使う', () => {
    expect(toPresentation(task({ data: {} }), { now: NOW }).sub).toBe('期限：2026-09-20');
  });

  it('重要メール：件名と差出人', () => {
    expect(toPresentation(mail(), { now: NOW })).toMatchObject({ title: '見積のご確認', sub: '田中' });
  });

  it('メール本文（snippet）は表示用データに含めない', () => {
    const p = toPresentation(mail({ data: { snippet: '本文の一部' } }), { now: NOW });
    expect(JSON.stringify(p)).not.toContain('本文の一部');
  });

  it('長い主題・副題は切り詰める（省略記号つき）', () => {
    const p = toPresentation(mail({ title: 'あ'.repeat(500), body: 'い'.repeat(500) }), { now: NOW });
    expect(p.title).toHaveLength(120);
    expect(p.title.endsWith('…')).toBe(true);
    expect(p.sub).toHaveLength(80);
  });

  it('data が無い通知でも落ちない', () => {
    expect(() => toPresentation({ id: 'a', source: 'tasks', title: 't', body: 'b' }, { now: NOW })).not.toThrow();
  });
});

describe('notificationView / 整形ヘルパー', () => {
  it('formatRelativeStart', () => {
    expect([0, 1, 10, 59, 60, 90, 120, 1440, 2880].map(formatRelativeStart)).toEqual([
      'まもなく', '1分後', '10分後', '59分後', '1時間後', '1時間30分後', '2時間後', '1日後', '2日後',
    ]);
    expect(formatRelativeStart(-3)).toBe('まもなく');
  });

  it('formatDueDate：不正な値は null', () => {
    expect(formatDueDate('2026-09-20T00:00:00.000Z', NOW)).toBeNull();
    expect(formatDueDate(undefined, NOW)).toBeNull();
  });
});

describe('notificationView / サマリバッジの表示（7.1）', () => {
  it('0件・不正値は非表示（null）', () => {
    expect(formatBadgeText({ count: 0 })).toBeNull();
    expect(formatBadgeText({ count: NaN })).toBeNull();
    expect(formatBadgeText({ count: -1 })).toBeNull();
  });

  it('1〜99件はそのまま、100件以上と上限到達は「99+」', () => {
    expect(formatBadgeText({ count: 1 })).toBe('1');
    expect(formatBadgeText({ count: 99 })).toBe('99');
    expect(formatBadgeText({ count: 100 })).toBe('99+');
    expect(formatBadgeText({ count: 2500, capped: true })).toBe('99+');
    expect(formatBadgeText({ count: 5, capped: true })).toBe('99+');
  });
});

describe('notificationView / F-13 読み上げ文', () => {
  it('種別ごとに短い読み上げ文を作る', () => {
    expect(toSpeechText(cal())).toBe('予定のお知らせです。9時10分から、定例ミーティング');
    expect(toSpeechText(cal({ data: { startAt: at(10, 0), allDay: false } }))).toBe('予定のお知らせです。10時から、定例ミーティング');
    expect(toSpeechText(cal({ data: { allDay: true } }))).toBe('今日の予定です。定例ミーティング');
    expect(toSpeechText(task())).toBe('トゥードゥーの期限です。書類を出す');
    expect(toSpeechText(mail())).toBe('田中さんから重要なメールです。見積のご確認');
    expect(toSpeechText(mail({ body: '' }))).toBe('重要なメールです。見積のご確認');
  });

  it('「TODO」は読み（トゥードゥー）に置き換えて渡す。件名中の表記揺れも含む', () => {
    expect(toSpeechText(task({ title: '週次TODO整理' }))).toBe('トゥードゥーの期限です。週次トゥードゥー整理');
    expect(toSpeechText(mail({ title: 'ToDo リスト / To-Do の件' }))).toBe('田中さんから重要なメールです。トゥードゥー リスト / トゥードゥー の件');
    expect(toSpeechText(mail({ title: 'things to do' }))).toBe('田中さんから重要なメールです。things to do');
    // 吹き出しの表記は変えない
    expect(toPresentation(task(), { now: NOW }).label).toBe('TODO');
  });

  it(`長い件名は件名の側を切り詰めて ${SPEECH_MAX} 文字に収める（セリフの部分は残す。v5.16）`, () => {
    const t = toSpeechText(mail({ title: 'あ'.repeat(200) }));
    expect(t).toHaveLength(SPEECH_MAX);
    expect(t.startsWith('田中さんから重要なメールです。あ')).toBe(true);
    // 件名が文の途中にあるセリフでも、後ろのセリフは切らない
    const lines = { tasks: ['{title}、期限だよ！'] };
    const u = toSpeechText(task({ title: 'い'.repeat(200) }), { lines });
    expect(u).toHaveLength(SPEECH_MAX);
    expect(u.endsWith('、期限だよ！')).toBe(true);
  });

  it('時刻の無い予定（startAt なし）は今と同じ「予定のお知らせです。件名」', () => {
    expect(toSpeechText(cal({ data: {} }))).toBe('予定のお知らせです。定例ミーティング');
  });
});

describe('notificationView / F-22 キャラクターのセリフ', () => {
  it('セリフを渡さなければ今の固定文と同じ（既定のセリフを明示しても同じ）', () => {
    const cases = [cal(), cal({ data: { allDay: true } }), cal({ data: {} }), task({ title: '週次TODO' }), mail(), mail({ body: '' })];
    const before = [
      '予定のお知らせです。9時10分から、定例ミーティング',
      '今日の予定です。定例ミーティング',
      '予定のお知らせです。定例ミーティング',
      'トゥードゥーの期限です。週次トゥードゥー',
      '田中さんから重要なメールです。見積のご確認',
      '重要なメールです。見積のご確認',
    ];
    expect(cases.map((n) => toSpeechText(n))).toEqual(before);
    expect(cases.map((n) => toSpeechText(n, { lines: DEFAULT_NOTIFY_LINES }))).toEqual(before);
    expect(cases.map((n) => toPresentation(n, { now: NOW }).speech)).toEqual(before);
  });

  it('キャラクターのセリフで読み上げる（予定・終日・TODO・メール）。吹き出しは変わらない', () => {
    const lines = {
      calendar: ['{time}から{title}があるよ'],
      calendarAllDay: ['今日は{title}の日だね'],
      tasks: ['{title}、そろそろやろう'],
      gmail: ['{from}さんからだよ。{title}'],
    };
    expect(toSpeechText(cal(), { lines })).toBe('9時10分から定例ミーティングがあるよ');
    expect(toSpeechText(cal({ data: { allDay: true } }), { lines })).toBe('今日は定例ミーティングの日だね');
    expect(toSpeechText(task(), { lines })).toBe('書類を出す、そろそろやろう');
    expect(toSpeechText(mail(), { lines })).toBe('田中さんからだよ。見積のご確認');
    const p = toPresentation(mail(), { now: NOW, lines });
    expect(p).toMatchObject({ label: '重要メール', title: '見積のご確認', speech: '田中さんからだよ。見積のご確認' });
  });

  it('値が空になる差し込みを含む文は避け、使える文が無ければ既定の文', () => {
    const lines = { gmail: ['{from}さんからだよ。{title}', 'メールだよ。{title}'], calendar: ['{time}から{title}'] };
    expect(toSpeechText(mail({ body: '' }), { lines })).toBe('メールだよ。見積のご確認');
    expect(toSpeechText(mail({ body: '' }), { lines: { gmail: ['{from}さんからだよ。{title}'] } })).toBe('重要なメールです。見積のご確認');
    expect(toSpeechText(cal({ data: {} }), { lines })).toBe('予定のお知らせです。定例ミーティング');
  });

  it('文の選び方（pickLine）を渡すと、それで選ぶ（使えるかの判定も渡す）', () => {
    const calls = [];
    const pickLine = (kind, accept) => {
      calls.push([kind, accept('{from}さん{title}'), accept('{title}')]);
      return 'えらんだ{title}';
    };
    expect(toSpeechText(mail({ body: '' }), { pickLine })).toBe('えらんだ見積のご確認');
    expect(calls).toEqual([['gmail', false, true]]);
    // 選べなかった（null）ときは既定の文
    expect(toSpeechText(cal({ data: { allDay: true } }), { pickLine: () => null })).toBe('今日の予定です。定例ミーティング');
  });

});

describe('notificationView / 読み上げの presentation', () => {
  it('presentation に speech と読み上げ用のタイミングが載る', () => {
    const p = toPresentation(mail(), { now: NOW, backlog: 2 });
    expect(p.speech).toBe('田中さんから重要なメールです。見積のご確認');
    // バックログで holdMs が縮んでも、音声の長さを優先するための上限は変わらない
    expect(p.timing).toMatchObject({ holdMs: MIN_HOLD_MS, maxVoiceHoldMs: MAX_VOICE_HOLD_MS, voiceTailMs: VOICE_TAIL_MS });
  });

  it('systemPresentation は効果音・読み上げなしのお知らせ', () => {
    const p = systemPresentation({ id: 'system:offline:1', title: 'つながらないみたい', sub: '接続を確認してね' });
    expect(p).toMatchObject({ kind: 'system', label: 'お知らせ', sfxKey: null, speech: null, title: 'つながらないみたい' });
    expect(p.timing.holdMs).toBe(6000);
  });
});
