// キャラクターごとのセリフ（F-22・Phase 13）。Electron に依存しない純粋関数。
//
// lines … { notify: { calendar, calendarAllDay, tasks, gmail }, idle: { morning, bedtime, normal }, chat: { closing } }（各値は文の配列）
//   notify：通知の読み上げ文のひな形。差し込み {title}・{time}（予定・時刻ありのみ）・{from}（重要メールのみ）を使える。
//           どれも任意（{title} を入れない文は件名を読まない。吹き出しには件名が出る）
//   idle  ：アイドルトークの文（差し込みなし）
//   chat  ：チャットの終了メッセージ（Phase 14。差し込みなし。無い古いファイルも読める）
// 設定しなかった種類（空の配列）は、今の固定文（DEFAULT_NOTIFY_LINES・idleTalkPhrases.js・DEFAULT_CHAT_LINES）を使う（effectiveLines）。
// セリフは読み上げにだけ使い、吹き出しは今のまま（種別・件名・時刻）。
//
// 保存先：manifest.json の lines（6.2）、既定キャラクターは default-profile.json の lines。
// 入力（validateLines）は壊れた行があれば保存させない。保存済みの値（parseLines）は壊れた行だけを捨てる。

import { PHRASE_MAX_LENGTH, PHRASE_SETS } from './idleTalkPhrases.js';

/** 「TODO」の読み（VOICEVOX に渡す表記。実機で「TODO」のままだと発音が崩れた） */
export const SPOKEN_TODO = 'トゥードゥー';
/** 読み上げ文の最大長（1件の読み上げを長くしすぎない） */
export const SPEECH_MAX = 50;

export const NOTIFY_KINDS = Object.freeze(['calendar', 'calendarAllDay', 'tasks', 'gmail']);
export const IDLE_KINDS = Object.freeze(['morning', 'bedtime', 'normal']);
export const CHAT_KINDS = Object.freeze(['closing']);
/** グループと種類の並び（検証・読み込み・画面の欄の順） */
export const LINE_GROUPS = Object.freeze([
  ['notify', NOTIFY_KINDS],
  ['idle', IDLE_KINDS],
  ['chat', CHAT_KINDS],
]);

/** 通知のセリフで使える差し込み（種類ごと）。どれも任意 */
export const NOTIFY_PLACEHOLDERS = Object.freeze({
  calendar: Object.freeze(['title', 'time']),
  calendarAllDay: Object.freeze(['title']),
  tasks: Object.freeze(['title']),
  gmail: Object.freeze(['title', 'from']),
});

/** 通知のセリフ：差し込みを除いた部分の最大文字数と、1種類あたりの最大文数 */
export const NOTIFY_LINE_MAX = 30;
export const NOTIFY_COUNT_MAX = 10;
/** アイドルトーク：1文の最大文字数（idleTalkPhrases.js と同じ）と、種類ごとの最大文数 */
export const IDLE_LINE_MAX = PHRASE_MAX_LENGTH;
export const IDLE_COUNT_MAX = Object.freeze({ morning: 10, bedtime: 10, normal: 30 });
/** チャットの終了メッセージ：1文の最大文字数と最大文数 */
export const CHAT_LINE_MAX = 30;
export const CHAT_COUNT_MAX = Object.freeze({ closing: 5 });

/** 今の固定文を同じ形にしたもの（何も設定しないときの読み上げは今と同じ） */
export const DEFAULT_NOTIFY_LINES = Object.freeze({
  calendar: Object.freeze(['予定のお知らせです。{time}から、{title}']),
  calendarAllDay: Object.freeze(['今日の予定です。{title}']),
  tasks: Object.freeze([`${SPOKEN_TODO}の期限です。{title}`]),
  gmail: Object.freeze(['{from}さんから重要なメールです。{title}']),
});

/**
 * 使える文が無いとき（差出人が無いのに全部の文が {from} を含むなど）の文。{title} だけを使う。
 * 今の固定文の「時刻が無い予定」「差出人が無いメール」と同じ。
 */
export const FALLBACK_NOTIFY_LINES = Object.freeze({
  calendar: '予定のお知らせです。{title}',
  calendarAllDay: '今日の予定です。{title}',
  tasks: `${SPOKEN_TODO}の期限です。{title}`,
  gmail: '重要なメールです。{title}',
});

export const DEFAULT_IDLE_LINES = PHRASE_SETS;

/** チャットの終了メッセージの既定（v5.8 からの定型文） */
export const DEFAULT_CHAT_LINES = Object.freeze({
  closing: Object.freeze(['今日はこのくらいにしようか。またお話ししようね。']),
});

/** 画面に出す種類の名前（エラーの文に使う） */
export const LINE_KIND_LABELS = Object.freeze({
  notify: Object.freeze({ calendar: '予定（時刻あり）', calendarAllDay: '予定（終日）', tasks: 'TODO', gmail: '重要メール' }),
  idle: Object.freeze({ morning: '朝の挨拶', bedtime: '就寝前の挨拶', normal: 'アイドルトーク（通常）' }),
  chat: Object.freeze({ closing: 'チャットの終わり' }),
});

const DEFAULT_LINES = Object.freeze({ notify: DEFAULT_NOTIFY_LINES, idle: DEFAULT_IDLE_LINES, chat: DEFAULT_CHAT_LINES });
/** 差し込みの無いグループの1文の最大文字数 */
const PLAIN_LINE_MAX = Object.freeze({ idle: IDLE_LINE_MAX, chat: CHAT_LINE_MAX });

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s) => [...s].length;

/** 改行・タブ以外の制御文字を取り除き、前後の空白を落とす */
// eslint-disable-next-line no-control-regex
export const cleanLine = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

/** 文に含まれる差し込みの名前（出てきた順・重複あり） */
export function placeholdersIn(line) {
  return [...line.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/** 空の lines（すべての種類が空の配列） */
export function emptyLines() {
  return Object.fromEntries(LINE_GROUPS.map(([group, kinds]) => [group, Object.fromEntries(kinds.map((k) => [k, []]))]));
}

/**
 * 1文を検証する（cleanLine 済み・空でない文）。セリフの生成（lineGenerator.js）でも同じ決まりで確かめる。
 * @param {'notify' | 'idle' | 'chat'} group
 * @param {string} kind
 * @param {string} line
 * @returns {{ code: string, placeholder?: string } | null} 問題が無ければ null
 */
export function checkLine(group, kind, line) {
  const names = placeholdersIn(line);
  if (group === 'notify') {
    const allowed = NOTIFY_PLACEHOLDERS[kind];
    const unknown = names.find((n) => !allowed.includes(n));
    if (unknown !== undefined) return { code: 'lines_unknown_placeholder', placeholder: unknown };
    if (codePoints(line.replace(PLACEHOLDER_RE, '')) > NOTIFY_LINE_MAX) return { code: 'lines_too_long' };
    return null;
  }
  if (names.length > 0) return { code: 'lines_unknown_placeholder', placeholder: names[0] };
  if (codePoints(line) > PLAIN_LINE_MAX[group]) return { code: 'lines_too_long' };
  return null;
}

/** 1種類あたりの最大文数 */
export const countMax = (group, kind) => {
  if (group === 'notify') return NOTIFY_COUNT_MAX;
  if (group === 'chat') return CHAT_COUNT_MAX[kind];
  return IDLE_COUNT_MAX[kind];
};

/** 入力の1種類分（textarea の文字列、または文の配列）を行に分ける。行番号は1から（空行も数える） */
function splitInput(raw) {
  if (raw === null || raw === undefined) return [];
  let text;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) text = raw.join('\n');
  else return null;
  return text.split(/\r\n|\r|\n/).map((s, i) => ({ text: cleanLine(s), line: i + 1 }));
}

/**
 * 画面から来たセリフを検証する（壊れた行があれば保存させない）。改行・タブ以外の制御文字を取り除き、前後の空白を落とし、空行は無視する。
 * @param {unknown} raw { notify?: { [kind]: string | string[] }, idle?: …, chat?: … }。null・undefined は「設定なし」
 * @returns {{ ok: true, value: ReturnType<typeof emptyLines> } |
 *   { ok: false, error: { code: string, group?: string, kind?: string, line?: number, placeholder?: string, max?: number } }}
 */
export function validateLines(raw) {
  const value = emptyLines();
  if (raw === null || raw === undefined) return { ok: true, value };
  if (!isPlainObject(raw)) return { ok: false, error: { code: 'lines_invalid' } };
  for (const [group, kinds] of LINE_GROUPS) {
    const src = raw[group];
    if (src === null || src === undefined) continue;
    if (!isPlainObject(src)) return { ok: false, error: { code: 'lines_invalid', group } };
    for (const kind of kinds) {
      const rows = splitInput(src[kind]);
      if (rows === null) return { ok: false, error: { code: 'lines_invalid', group, kind } };
      const out = [];
      for (const { text, line } of rows) {
        if (text === '') continue;
        const problem = checkLine(group, kind, text);
        if (problem) return { ok: false, error: { ...problem, group, kind, line } };
        out.push(text);
      }
      const max = countMax(group, kind);
      if (out.length > max) return { ok: false, error: { code: 'lines_too_many', group, kind, max } };
      value[group][kind] = out;
    }
  }
  return { ok: true, value };
}

/**
 * 保存済みの lines を読む。無い・壊れた種類は空、壊れた行（文字列でない・字数超え・知らない差し込み）はその行だけを捨てる。
 * 多すぎる分は先頭から上限まで残す。キャラクター自体は一覧から外さない。
 * @returns {ReturnType<typeof emptyLines>}
 */
export function parseLines(raw) {
  const value = emptyLines();
  if (!isPlainObject(raw)) return value;
  for (const [group, kinds] of LINE_GROUPS) {
    const src = isPlainObject(raw[group]) ? raw[group] : {};
    for (const kind of kinds) {
      if (!Array.isArray(src[kind])) continue;
      const out = [];
      for (const v of src[kind]) {
        if (typeof v !== 'string' || /[\r\n]/.test(v)) continue;
        const text = cleanLine(v);
        if (text === '' || checkLine(group, kind, text)) continue;
        out.push(text);
      }
      value[group][kind] = out.slice(0, countMax(group, kind));
    }
  }
  return value;
}

/**
 * 実際に使うセリフ。キャラクターのセリフがある種類はそれ、空の種類は既定（今の固定文）。
 * @param {unknown} lines parseLines / validateLines 済みの値（壊れていれば既定だけ）
 * @returns {{ notify: Record<string, readonly string[]>, idle: Record<string, readonly string[]>, chat: Record<string, readonly string[]> }}
 */
export function effectiveLines(lines) {
  const parsed = parseLines(lines);
  return Object.fromEntries(
    LINE_GROUPS.map(([group, kinds]) => [
      group,
      Object.fromEntries(kinds.map((k) => [k, parsed[group][k].length > 0 ? parsed[group][k] : DEFAULT_LINES[group][k]])),
    ]),
  );
}

/**
 * 文が使えるか：{title} 以外の差し込みの値がすべて空でないこと（差出人が無いのに {from} を含む文などは避ける）。
 * {title} は件名が空でも使える（今の固定文と同じく、件名なしで読む）。
 * @param {string} line
 * @param {Record<string, string>} values
 */
export function isUsableLine(line, values) {
  return placeholdersIn(line).every((n) => n === 'title' || (typeof values[n] === 'string' && values[n] !== ''));
}

/** 読み上げ用の表記に直す：「TODO」を読みに置き換える（TODO / ToDo / To-Do。英文の "to do" は対象外） */
export function toSpoken(text) {
  return text.replace(/\bto-?do\b/gi, SPOKEN_TODO);
}

const expand = (line, values) => line.replace(PLACEHOLDER_RE, (_, name) => values[name] ?? '');
const sliceCodePoints = (s, n) => [...s].slice(0, n).join('');

/**
 * 差し込みの無い文（アイドルトーク・同梱キャラクターの件名なしの固定ボイス）の読み上げ文。TODO を読みに置き換え、最大 SPEECH_MAX 文字。
 * 固定ボイス（fixedVoice.js）は、録音した文とこの結果が一字一句同じときに使う。
 * @param {string} text
 */
export function plainSpeech(text) {
  return sliceCodePoints(toSpoken(text), SPEECH_MAX);
}

/**
 * 差し込みを展開して読み上げ文にする。TODO の読み替えは展開した後の文全体に行う。
 * 長すぎるときは、セリフの部分を残して件名（{title}）の側を切り詰め、全体を max 以内にする。
 * それでも収まらなければ差出人（{from}）を切り詰め、最後の手段として文全体を切る。
 * @param {string} line ひな形
 * @param {Record<string, string>} values 差し込みの値（title / time / from）
 * @param {{ max?: number }} [opts]
 * @returns {string}
 */
export function renderSpeech(line, values, { max = SPEECH_MAX } = {}) {
  let vals = { ...values };
  const render = (v) => toSpoken(expand(line, v)).trim();
  let text = render(vals);
  for (const name of ['title', 'from']) {
    if (codePoints(text) <= max) break;
    const full = [...(vals[name] ?? '')];
    if (full.length === 0 || !placeholdersIn(line).includes(name)) continue;
    // 収まる最長の先頭部分を二分探索で探す（TODO の読み替えで長さが変わるため、展開・読み替えした後の長さで確かめる）
    const withPrefix = (n) => ({ ...vals, [name]: full.slice(0, n).join('') });
    let lo = 0;
    let hi = full.length - 1; // full.length は収まらないと分かっている
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (codePoints(render(withPrefix(mid))) <= max) lo = mid;
      else hi = mid - 1;
    }
    vals = withPrefix(lo);
    text = render(vals);
  }
  return codePoints(text) > max ? sliceCodePoints(text, max) : text;
}

/**
 * セリフのエラーを画面に出す文にする（例：「セリフ「重要メール」の 3 行目：{date} は使えない差し込みです」）。
 * @param {{ code: string, group?: string, kind?: string, line?: number, placeholder?: string, max?: number }} error
 */
export function describeLinesError(error) {
  const label = LINE_KIND_LABELS[error?.group]?.[error?.kind];
  const where = label ? `セリフ「${label}」${error.line ? `の ${error.line} 行目` : ''}：` : 'セリフ：';
  switch (error?.code) {
    case 'lines_too_long':
      return error.group === 'notify'
        ? `${where}差し込みを除いて ${NOTIFY_LINE_MAX} 文字以内にしてください`
        : `${where}${PLAIN_LINE_MAX[error.group] ?? IDLE_LINE_MAX} 文字以内にしてください`;
    case 'lines_too_many':
      return `${where}${error.max ?? ''} 文までにしてください`;
    case 'lines_unknown_placeholder': {
      const allowed = error.group === 'notify' ? NOTIFY_PLACEHOLDERS[error.kind] : null;
      const plainName = error.group === 'chat' ? 'チャットの終わり' : 'アイドルトーク';
      const hint = allowed ? `（使えるのは ${allowed.map((n) => `{${n}}`).join('・')}）` : `（${plainName}には差し込みを使えません）`;
      return `${where}{${error.placeholder ?? ''}} は使えない差し込みです${hint}`;
    }
    default:
      return `${where}形式が正しくありません`;
  }
}

/**
 * 作成／編集画面のセリフ欄の案内（種類ごとの名前・既定の文〔placeholder に出す〕・使える差し込み・字数と文数の上限）。
 * @returns {{ group: 'notify' | 'idle' | 'chat', kind: string, label: string, defaults: string[], placeholders: string[], lineMax: number, countMax: number }[]}
 */
export function linesGuide() {
  return LINE_GROUPS.flatMap(([group, kinds]) =>
    kinds.map((kind) => ({
      group,
      kind,
      label: LINE_KIND_LABELS[group][kind],
      defaults: [...DEFAULT_LINES[group][kind]],
      placeholders: group === 'notify' ? [...NOTIFY_PLACEHOLDERS[kind]] : [],
      lineMax: group === 'notify' ? NOTIFY_LINE_MAX : PLAIN_LINE_MAX[group],
      countMax: countMax(group, kind),
    })),
  );
}

/** エラーがセリフのものか（characterImport の describeImportError から振り分ける） */
export const isLinesError = (error) => typeof error?.code === 'string' && error.code.startsWith('lines_');
