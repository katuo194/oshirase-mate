import { describe, expect, it } from 'vitest';
import {
  CHAT_COUNT_MAX,
  CHAT_LINE_MAX,
  DEFAULT_CHAT_LINES,
  DEFAULT_IDLE_LINES,
  DEFAULT_NOTIFY_LINES,
  IDLE_COUNT_MAX,
  IDLE_LINE_MAX,
  NOTIFY_COUNT_MAX,
  NOTIFY_LINE_MAX,
  SPEECH_MAX,
  describeLinesError,
  effectiveLines,
  emptyLines,
  isUsableLine,
  linesGuide,
  parseLines,
  renderSpeech,
  validateLines,
} from '../src/main/characterLines.js';
import { PHRASE_SETS } from '../src/main/idleTalkPhrases.js';

const ok = (value) => ({ ok: true, value });
/** emptyLines に一部の種類だけを入れたもの */
const withLines = ({ notify = {}, idle = {}, chat = {} }) => {
  const v = emptyLines();
  Object.assign(v.notify, notify);
  Object.assign(v.idle, idle);
  Object.assign(v.chat, chat);
  return v;
};

describe('characterLines / 入力の検証（validateLines）', () => {
  it('未設定（null・undefined・空の欄）はすべて空', () => {
    expect(validateLines(null)).toEqual(ok(emptyLines()));
    expect(validateLines(undefined)).toEqual(ok(emptyLines()));
    expect(validateLines({ notify: { calendar: '' }, idle: { normal: '\n\n' } })).toEqual(ok(emptyLines()));
  });

  it('textarea の文字列を1行1文に分ける（空行は無視・前後の空白を落とす・CRLF も可）', () => {
    const r = validateLines({ notify: { tasks: '  やることだよ。{title}  \r\n\r\n{title}、忘れないでね\n' }, idle: { morning: ['おはよう', '  ', '朝だよ'] } });
    expect(r).toEqual(ok(withLines({ notify: { tasks: ['やることだよ。{title}', '{title}、忘れないでね'] }, idle: { morning: ['おはよう', '朝だよ'] } })));
  });

  it('改行・タブ以外の制御文字は取り除く', () => {
    const r = validateLines({ idle: { normal: 'ね\u0000む\u0007い\tな\u007f' } });
    expect(r.value.idle.normal).toEqual(['ねむい\tな']);
  });

  it(`通知のセリフは差し込みを除いて ${NOTIFY_LINE_MAX} 字まで（差し込みは数えない）`, () => {
    const body = 'あ'.repeat(NOTIFY_LINE_MAX);
    expect(validateLines({ notify: { gmail: `${body}{from}{title}` } }).ok).toBe(true);
    expect(validateLines({ notify: { gmail: `ok{title}\n${body}い{title}` } })).toEqual({
      ok: false,
      error: { code: 'lines_too_long', group: 'notify', kind: 'gmail', line: 2 },
    });
  });

  it(`アイドルトークは1文 ${IDLE_LINE_MAX} 字まで（サロゲートペアも1字）`, () => {
    expect(validateLines({ idle: { normal: '𠮷'.repeat(IDLE_LINE_MAX) } }).ok).toBe(true);
    expect(validateLines({ idle: { normal: `\n\n${'あ'.repeat(IDLE_LINE_MAX + 1)}` } })).toEqual({
      ok: false,
      error: { code: 'lines_too_long', group: 'idle', kind: 'normal', line: 3 },
    });
  });

  it('文の数：通知は各10、朝・就寝前は各10、通常は30まで', () => {
    expect([NOTIFY_COUNT_MAX, IDLE_COUNT_MAX.morning, IDLE_COUNT_MAX.bedtime, IDLE_COUNT_MAX.normal]).toEqual([10, 10, 10, 30]);
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
    expect(validateLines({ notify: { calendar: many(10, (i) => `${i}{title}`) } }).ok).toBe(true);
    expect(validateLines({ notify: { calendar: many(11, (i) => `${i}{title}`) } })).toEqual({
      ok: false,
      error: { code: 'lines_too_many', group: 'notify', kind: 'calendar', max: 10 },
    });
    expect(validateLines({ idle: { normal: many(30, (i) => `文${i}`) } }).ok).toBe(true);
    expect(validateLines({ idle: { normal: many(31, (i) => `文${i}`) } }).error).toMatchObject({ code: 'lines_too_many', kind: 'normal', max: 30 });
    expect(validateLines({ idle: { bedtime: many(11, (i) => `文${i}`) } }).error).toMatchObject({ code: 'lines_too_many', kind: 'bedtime', max: 10 });
  });

  it('知らない差し込みは保存させない（種類ごとに使えるものが違う。アイドルトークは差し込みなし）', () => {
    expect(validateLines({ notify: { calendar: '{time}から{title}' } }).ok).toBe(true);
    expect(validateLines({ notify: { calendarAllDay: '{time}から{title}' } }).error).toEqual({
      code: 'lines_unknown_placeholder',
      placeholder: 'time',
      group: 'notify',
      kind: 'calendarAllDay',
      line: 1,
    });
    expect(validateLines({ notify: { tasks: '{from}さん{title}' } }).error).toMatchObject({ code: 'lines_unknown_placeholder', placeholder: 'from' });
    expect(validateLines({ notify: { gmail: '{from}から{subject}' } }).error).toMatchObject({ code: 'lines_unknown_placeholder', placeholder: 'subject' });
    expect(validateLines({ idle: { morning: 'おはよう{title}' } }).error).toMatchObject({ code: 'lines_unknown_placeholder', group: 'idle', kind: 'morning' });
  });

  it('差し込みはどれも任意（{title} の無い通知のセリフ・差し込みの無いセリフも保存できる）', () => {
    expect(validateLines({ notify: { gmail: '{title}だよ\n{from}さんからメール\nメールが来たよ' } })).toEqual(
      ok(withLines({ notify: { gmail: ['{title}だよ', '{from}さんからメール', 'メールが来たよ'] } })),
    );
    expect(validateLines({ notify: { calendar: '{time}から予定があるよ' } }).ok).toBe(true);
  });

  it('形の崩れた入力は lines_invalid', () => {
    expect(validateLines('text').error).toEqual({ code: 'lines_invalid' });
    expect(validateLines({ notify: [] }).error).toEqual({ code: 'lines_invalid', group: 'notify' });
    expect(validateLines({ idle: { normal: [1, 2] } }).error).toEqual({ code: 'lines_invalid', group: 'idle', kind: 'normal' });
  });

  it('エラーの文に種類と何行目かが入る', () => {
    expect(describeLinesError({ code: 'lines_unknown_placeholder', placeholder: 'date', group: 'notify', kind: 'gmail', line: 3 })).toBe(
      'セリフ「重要メール」の 3 行目：{date} は使えない差し込みです（使えるのは {title}・{from}）',
    );
    expect(describeLinesError({ code: 'lines_too_long', group: 'idle', kind: 'normal', line: 2 })).toContain(`${IDLE_LINE_MAX} 文字以内`);
    expect(describeLinesError({ code: 'lines_too_many', group: 'idle', kind: 'morning', max: 10 })).toBe('セリフ「朝の挨拶」：10 文までにしてください');
  });
});

describe('characterLines / チャットの終わり（chat.closing・Phase 14）', () => {
  it('空の lines に chat.closing がある', () => {
    expect(emptyLines().chat).toEqual({ closing: [] });
  });

  it(`1文 ${CHAT_LINE_MAX} 字まで・${CHAT_COUNT_MAX.closing} 文まで・差し込みなし`, () => {
    expect(validateLines({ chat: { closing: 'またね\nばいばい' } })).toEqual(ok(withLines({ chat: { closing: ['またね', 'ばいばい'] } })));
    expect(validateLines({ chat: { closing: 'あ'.repeat(CHAT_LINE_MAX + 1) } }).error).toMatchObject({ code: 'lines_too_long', group: 'chat', kind: 'closing', line: 1 });
    const six = Array.from({ length: CHAT_COUNT_MAX.closing + 1 }, (_, i) => `またね${i}`).join('\n');
    expect(validateLines({ chat: { closing: six } }).error).toMatchObject({ code: 'lines_too_many', group: 'chat', max: CHAT_COUNT_MAX.closing });
    expect(validateLines({ chat: { closing: '{title}またね' } }).error).toMatchObject({ code: 'lines_unknown_placeholder', group: 'chat', kind: 'closing' });
  });

  it('エラーの文', () => {
    expect(describeLinesError({ code: 'lines_too_long', group: 'chat', kind: 'closing', line: 2 })).toBe(
      `セリフ「チャットの終わり」の 2 行目：${CHAT_LINE_MAX} 文字以内にしてください`,
    );
    expect(describeLinesError({ code: 'lines_unknown_placeholder', group: 'chat', kind: 'closing', line: 1, placeholder: 'title' })).toBe(
      'セリフ「チャットの終わり」の 1 行目：{title} は使えない差し込みです（チャットの終わりには差し込みを使えません）',
    );
  });

  it('chat の無い古い lines も読め（空）、設定が無ければ定型の終了メッセージを使う', () => {
    expect(parseLines({ notify: {}, idle: {} }).chat).toEqual({ closing: [] });
    expect(parseLines({ chat: { closing: ['またね', '{x}', 3] } }).chat.closing).toEqual(['またね']);
    expect(effectiveLines(null).chat).toEqual(DEFAULT_CHAT_LINES);
    expect(effectiveLines(withLines({ chat: { closing: ['またね'] } })).chat.closing).toEqual(['またね']);
  });
});

describe('characterLines / 保存済みの値の読み込み（parseLines）', () => {
  it('lines が無い・壊れている古いファイルは空', () => {
    expect(parseLines(undefined)).toEqual(emptyLines());
    expect(parseLines('broken')).toEqual(emptyLines());
    expect(parseLines({ notify: 'x', idle: { normal: 'x' } })).toEqual(emptyLines());
  });

  it('壊れた行だけを捨て、残りは使う', () => {
    const raw = {
      notify: {
        calendar: ['{time}から{title}', 42, '{title}', '件名なし', '{who}{title}', `${'あ'.repeat(NOTIFY_LINE_MAX + 1)}{title}`, '行\nまたぎ{title}', '  '],
        unknownKind: ['{title}'],
      },
      idle: { normal: ['ふわぁ', null, '{title}だよ', 'あ'.repeat(IDLE_LINE_MAX + 1)] },
    };
    expect(parseLines(raw)).toEqual(withLines({ notify: { calendar: ['{time}から{title}', '{title}', '件名なし'] }, idle: { normal: ['ふわぁ'] } }));
  });

  it('多すぎる分は先頭から上限まで残す', () => {
    const raw = { idle: { morning: Array.from({ length: 15 }, (_, i) => `朝${i}`) } };
    expect(parseLines(raw).idle.morning).toHaveLength(IDLE_COUNT_MAX.morning);
    expect(parseLines(raw).idle.morning[0]).toBe('朝0');
  });
});

describe('characterLines / 実際に使うセリフ（effectiveLines）', () => {
  it('何も設定していなければ今の固定文', () => {
    const e = effectiveLines(null);
    expect(e.notify).toEqual(DEFAULT_NOTIFY_LINES);
    expect(e.idle).toEqual(DEFAULT_IDLE_LINES);
    expect(DEFAULT_IDLE_LINES).toBe(PHRASE_SETS);
  });

  it('設定した種類だけキャラクターのセリフ、空の種類は既定に戻る', () => {
    const e = effectiveLines(withLines({ notify: { tasks: ['やることだよ。{title}'] }, idle: { normal: ['ひま'] } }));
    expect(e.notify.tasks).toEqual(['やることだよ。{title}']);
    expect(e.notify.gmail).toEqual(DEFAULT_NOTIFY_LINES.gmail);
    expect(e.idle.normal).toEqual(['ひま']);
    expect(e.idle.morning).toEqual(DEFAULT_IDLE_LINES.morning);
  });

  it('既定の通知のセリフ自体が検証に通る', () => {
    const r = validateLines({ notify: Object.fromEntries(Object.entries(DEFAULT_NOTIFY_LINES).map(([k, v]) => [k, [...v]])) });
    expect(r.ok).toBe(true);
  });
});

describe('characterLines / 差し込みの展開（renderSpeech・isUsableLine）', () => {
  it('差し込みを展開する', () => {
    expect(renderSpeech('{time}から{title}だよ', { title: '会議', time: '10時30分', from: '' })).toBe('10時30分から会議だよ');
  });

  it('{title} の無いセリフは件名を読まない（長い件名でも切り詰めは要らない）', () => {
    expect(renderSpeech('{from}さんからメールだよ', { title: 'あ'.repeat(200), from: '田中' })).toBe('田中さんからメールだよ');
    expect(renderSpeech('予定があるよ', { title: '会議', time: '' })).toBe('予定があるよ');
  });

  it('{title} 以外の差し込みの値が空になる文は使えない（{title} は空でも使える）', () => {
    expect(isUsableLine('{from}さんから。{title}', { title: '件名', from: '' })).toBe(false);
    expect(isUsableLine('メールだよ。{title}', { title: '件名', from: '' })).toBe(true);
    expect(isUsableLine('{time}から{title}', { title: '', time: '9時' })).toBe(true);
    expect(isUsableLine('{time}から{title}', { title: 'x', time: '' })).toBe(false);
  });

  it(`長いときは件名の側を切り詰め、セリフの部分は残して ${SPEECH_MAX} 字以内にする`, () => {
    const t = renderSpeech('ねえねえ、{title}の時間だよ！', { title: 'あ'.repeat(100) });
    expect([...t]).toHaveLength(SPEECH_MAX);
    expect(t.startsWith('ねえねえ、あ')).toBe(true);
    expect(t.endsWith('の時間だよ！')).toBe(true);
  });

  it('TODO の読み替えは展開した後の文全体に行い、読み替え後の長さで切り詰める', () => {
    expect(renderSpeech('ToDoだよ。{title}', { title: '週次TODO整理' })).toBe('トゥードゥーだよ。週次トゥードゥー整理');
    // 「TODO 」（5字）は読み替えで「トゥードゥー 」（7字）になる。読み替えた後の長さで収める
    const t = renderSpeech('{title}のTODOだよ', { title: 'TODO '.repeat(20) });
    expect([...t].length).toBeLessThanOrEqual(SPEECH_MAX);
    expect([...t].length).toBeGreaterThan(SPEECH_MAX - 7);
    expect(t.startsWith('トゥードゥー トゥードゥー')).toBe(true);
    expect(t.endsWith('のトゥードゥーだよ')).toBe(true);
  });

  it('件名を空にしても収まらなければ差出人を切り詰め、それでも長ければ全体を切る', () => {
    const t = renderSpeech('{from}さんからだよ。{title}', { title: '件名', from: 'い'.repeat(60) });
    expect([...t]).toHaveLength(SPEECH_MAX);
    expect(t.endsWith('さんからだよ。')).toBe(true);
    const long = renderSpeech('{title}', { title: 'う'.repeat(80) }, { max: 10 });
    expect(long).toBe('う'.repeat(10));
  });
});

describe('characterLines / 画面の案内（linesGuide）', () => {
  it('8種類の欄の名前・既定の文・使える差し込み・上限', () => {
    const g = linesGuide();
    expect(g.map((d) => `${d.group}.${d.kind}`)).toEqual([
      'notify.calendar',
      'notify.calendarAllDay',
      'notify.tasks',
      'notify.gmail',
      'idle.morning',
      'idle.bedtime',
      'idle.normal',
      'chat.closing',
    ]);
    expect(g[0]).toMatchObject({ label: '予定（時刻あり）', defaults: ['予定のお知らせです。{time}から、{title}'], placeholders: ['title', 'time'], countMax: 10 });
    expect(g[6]).toMatchObject({ placeholders: [], lineMax: IDLE_LINE_MAX, countMax: 30 });
    expect(g[6].defaults).toHaveLength(20);
    expect(g[7]).toMatchObject({ label: 'チャットの終わり', defaults: [...DEFAULT_CHAT_LINES.closing], placeholders: [], lineMax: CHAT_LINE_MAX, countMax: 5 });
  });
});
