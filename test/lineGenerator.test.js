import { describe, expect, it, vi } from 'vitest';
import { createFakeGemini } from '../mocks/gemini/index.js';
import { CHAT_LINE_MAX, IDLE_COUNT_MAX, IDLE_LINE_MAX, NOTIFY_COUNT_MAX, NOTIFY_LINE_MAX, emptyLines, validateLines } from '../src/main/characterLines.js';
import { createGeminiClient } from '../src/main/geminiClient.js';
import {
  GENERATE_COUNTS,
  GENERATE_MAX_OUTPUT_TOKENS,
  GENERATE_TIMEOUT_MS,
  buildLinesPrompt,
  createLineGenerator,
  describeGenerateError,
  linesResponseSchema,
  parseGeneratedLines,
} from '../src/main/lineGenerator.js';

const KEY = 'AIzaSyFAKE-KEY-FOR-TESTS-0123456789abcd';

/** Gemini が返す JSON（すべての種類に使える文がある） */
const goodResponse = () => ({
  notify: {
    calendar: ['{time}から{title}だよ', 'そろそろ{title}の時間だよ', '{title}、忘れないでね'],
    calendarAllDay: ['今日は{title}の日だよ', '{title}があるよ', '今日の予定は{title}'],
    tasks: ['{title}の期限だよ', '{title}、終わったかな', 'そろそろ{title}をやろう'],
    gmail: ['{from}さんからメールだよ。{title}', '大事なメールだよ。{title}', 'メールが来たよ。{title}'],
  },
  idle: {
    morning: ['おはよう', 'いい朝だね', '今日もよろしくね', '朝ごはん食べた？', 'よく眠れたかな'],
    bedtime: ['そろそろ寝ようか', 'おやすみ', '今日もおつかれさま', '早めに休んでね', 'また明日ね'],
    normal: Array.from({ length: 20 }, (_, i) => `ひまだなあ${i}`),
  },
  chat: { closing: ['またお話ししようね', '今日はここまでにしよう', 'またね'] },
});

function setup(replies = [JSON.stringify(goodResponse())]) {
  const gm = createFakeGemini({ replies });
  const log = { info: vi.fn(), warn: vi.fn() };
  const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => KEY, logTag: 'lines', log });
  return { gm, log, generator: createLineGenerator({ client, log }) };
}

describe('lineGenerator / プロンプト（buildLinesPrompt）', () => {
  it('キャラクター名・キャラクター設定・8種類の場面と数・字数の上限・差し込みの決まりが入る', () => {
    const { systemPrompt, userText } = buildLinesPrompt({ displayName: '星空寝夢', persona: 'おっとりした女の子。一人称は「わたし」。' });
    expect(systemPrompt).toContain('「星空寝夢」');
    expect(systemPrompt).toContain('<character>\nおっとりした女の子。一人称は「わたし」。\n</character>');
    for (const key of ['notify.calendar', 'notify.calendarAllDay', 'notify.tasks', 'notify.gmail', 'idle.morning', 'idle.bedtime', 'idle.normal', 'chat.closing']) {
      expect(systemPrompt).toContain(`- ${key}：`);
    }
    expect(systemPrompt).toContain(`${GENERATE_COUNTS.idle.normal}文`);
    expect(systemPrompt).toContain(`${NOTIFY_LINE_MAX}文字以内`);
    expect(systemPrompt).toContain(`${IDLE_LINE_MAX}文字以内`);
    expect(systemPrompt).toContain(`${CHAT_LINE_MAX}文字以内`);
    expect(systemPrompt).toContain('必ず {title} を入れる');
    expect(userText).toContain('JSON');
  });

  it('キャラクター設定が空なら標準の口調。黄色い丸は名前ではなく見た目で紹介する', () => {
    const builtin = buildLinesPrompt({ builtin: true, displayName: '無視される名前', persona: '' }).systemPrompt;
    expect(builtin).toContain('黄色い丸い形のマスコット');
    expect(builtin).not.toContain('無視される名前');
    expect(builtin).not.toContain('<character>');
    expect(builtin).toContain('友だちのような口調');

    const unnamed = buildLinesPrompt({ displayName: '  ', persona: '' }).systemPrompt;
    expect(unnamed).toContain('マスコットキャラクターです');
  });

  it('作る数は保存できる上限以内', () => {
    for (const n of Object.values(GENERATE_COUNTS.notify)) expect(n).toBeLessThanOrEqual(NOTIFY_COUNT_MAX);
    for (const [k, n] of Object.entries(GENERATE_COUNTS.idle)) expect(n).toBeLessThanOrEqual(IDLE_COUNT_MAX[k]);
  });
});

describe('lineGenerator / 応答の読み込み（parseGeneratedLines）', () => {
  it('正しい JSON はそのまま使え、保存の検証（validateLines）にも通る', () => {
    const r = parseGeneratedLines(JSON.stringify(goodResponse()));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.lines).toEqual(goodResponse());
    expect(validateLines(r.lines)).toEqual({ ok: true, value: r.lines });
  });

  it('```json で囲まれた応答も読める', () => {
    const r = parseGeneratedLines(`\`\`\`json\n${JSON.stringify(goodResponse())}\n\`\`\``);
    expect(r.ok).toBe(true);
  });

  it('決まりに合わない行（字数オーバー・知らない差し込み・改行入り・文字列でない・重複・空）は捨てる', () => {
    const data = goodResponse();
    data.notify.tasks = [
      '{title}の期限だよ',
      '{title}の期限だよ', // 重複
      `${'あ'.repeat(NOTIFY_LINE_MAX + 1)}{title}`, // 差し込みを除いて長すぎる
      '{date}までに{title}', // 知らない差し込み
      '{title}\nだよ', // 改行入り
      42,
      '   ',
      '  前後の空白は{title}落とす  ',
    ];
    data.idle.morning = ['おはよう', '{title}おはよう', 'あ'.repeat(IDLE_LINE_MAX + 1)];
    data.chat.closing = ['またね', 'あ'.repeat(CHAT_LINE_MAX + 1)];
    const r = parseGeneratedLines(JSON.stringify(data));
    expect(r.lines.notify.tasks).toEqual(['{title}の期限だよ', '前後の空白は{title}落とす']);
    expect(r.lines.idle.morning).toEqual(['おはよう']);
    expect(r.lines.chat.closing).toEqual(['またね']);
  });

  it('{title} の無い通知の行は捨てる（生成する案は件名を必ず読む）', () => {
    const data = goodResponse();
    data.notify.gmail = ['メールだよ', '{from}さんからだよ', '{from}さんから。{title}'];
    expect(parseGeneratedLines(JSON.stringify(data)).lines.notify.gmail).toEqual(['{from}さんから。{title}']);
  });

  it('保存できる上限より多ければ先頭から上限まで', () => {
    const data = goodResponse();
    data.idle.morning = Array.from({ length: IDLE_COUNT_MAX.morning + 3 }, (_, i) => `朝${i}`);
    expect(parseGeneratedLines(JSON.stringify(data)).lines.idle.morning).toHaveLength(IDLE_COUNT_MAX.morning);
  });

  it('使える文が残らなかった種類は missing に入れ、空のまま返す', () => {
    const data = goodResponse();
    data.notify.calendar = ['件名なし'];
    delete data.idle.bedtime;
    data.chat = 'x';
    const r = parseGeneratedLines(JSON.stringify(data));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(['notify.calendar', 'idle.bedtime', 'chat.closing']);
    expect(r.lines.notify.calendar).toEqual([]);
    expect(r.lines.idle.normal).toHaveLength(20);
  });

  it('JSON でない・途中で切れた・オブジェクトでない・使える文が1つも無いものは invalid_response', () => {
    const bad = { ok: false, reason: 'invalid_response' };
    expect(parseGeneratedLines('セリフを作りました！')).toEqual(bad);
    expect(parseGeneratedLines(JSON.stringify(goodResponse()).slice(0, 100))).toEqual(bad);
    expect(parseGeneratedLines('[]')).toEqual(bad);
    expect(parseGeneratedLines('null')).toEqual(bad);
    expect(parseGeneratedLines(JSON.stringify(emptyLines()))).toEqual(bad);
    expect(parseGeneratedLines(undefined)).toEqual(bad);
  });
});

describe('lineGenerator / Gemini への送信（createLineGenerator）', () => {
  it('JSON 出力（responseMimeType・responseSchema）・出力の上限・60 秒の上限で送り、案を返す', async () => {
    const { gm, generator, log } = setup();
    const r = await generator.generate({ displayName: 'ねむ', persona: 'のんびり屋' });
    expect(r).toEqual({ ok: true, lines: goodResponse(), missing: [] });

    const body = gm.calls[0].body;
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: GENERATE_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: linesResponseSchema(),
    });
    expect(body.systemInstruction.parts[0].text).toContain('のんびり屋');
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
    expect(GENERATE_TIMEOUT_MS).toBe(60000);
    expect(log.info.mock.calls[0][0]).toMatch(/^\[lines\] セリフを作りました: 45 文$/);
  });

  it('応答の形（responseSchema）は3グループ・8種類の文字列の配列', () => {
    const s = linesResponseSchema();
    expect(s.required).toEqual(['notify', 'idle', 'chat']);
    expect(Object.keys(s.properties.notify.properties)).toEqual(['calendar', 'calendarAllDay', 'tasks', 'gmail']);
    expect(s.properties.chat.properties.closing).toEqual({ type: 'ARRAY', items: { type: 'STRING' } });
  });

  it('Gemini の失敗は種類を返す（キー不正・レート制限・接続断・ブロック・空）', async () => {
    const cases = [
      ['invalidKeyNext', 'auth'],
      ['networkDownNext', 'network'],
      ['blockNext', 'blocked'],
      ['emptyNext', 'empty'],
    ];
    for (const [method, reason] of cases) {
      const { gm, generator } = setup();
      gm[method]();
      expect(await generator.generate({})).toEqual({ ok: false, reason });
    }
    const { gm, generator } = setup();
    gm.failNext(429, { errorStatus: 'RESOURCE_EXHAUSTED' });
    expect(await generator.generate({})).toEqual({ ok: false, reason: 'rate_limit' });
  });

  it('出力の上限で途中まで返った応答は invalid_response。本文はログに出さない', async () => {
    const { gm, generator, log } = setup();
    gm.truncatedNext('{"notify":{"calendar":["秘密の設定ふう{title}"');
    expect(await generator.generate({ persona: '秘密の設定' })).toEqual({ ok: false, reason: 'invalid_response' });
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain('秘密の設定');
    expect(logged).toContain('[lines]');
  });

  it('中止されたら aborted', async () => {
    const { gm, generator } = setup();
    gm.hangNext();
    const controller = new AbortController();
    const p = generator.generate({ signal: controller.signal });
    controller.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
  });
});

describe('lineGenerator / 画面に出す文（describeGenerateError）', () => {
  it('種類ごとに案内し、知らない種類は一般的な文', () => {
    expect(describeGenerateError('not_configured')).toContain('設定画面の「チャット」');
    expect(describeGenerateError('auth')).toContain('API キーが正しくない');
    expect(describeGenerateError('network')).toContain('インターネット');
    expect(describeGenerateError('invalid_response')).toContain('もう一度');
    expect(describeGenerateError('busy')).toContain('作っているところ');
    expect(describeGenerateError('server')).toContain('エラー');
    expect(describeGenerateError('???')).toBe(describeGenerateError('server'));
  });
});
