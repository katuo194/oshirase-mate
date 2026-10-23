// Gemini によるセリフの自動生成（Phase 14・F-22）。Electron に依存しない：Gemini 呼び出し（client）は注入する。
//
// 作成・編集画面の「Gemini でセリフを作る」を押したときだけ呼ぶ（通知・アイドルトークのたびには呼ばない。1.4）。
// 送るのはキャラクター名とキャラクター設定（どちらもユーザーが入力した文章）と、セリフの決まりだけ。
// 応答は JSON（responseSchema で形を指定）で受け取り、1行ずつ characterLines.js と同じ決まり（checkLine）で確かめる。
// 決まりに合わない行（字数オーバー・知らない差し込み・改行入り・重複）と、{title} の無い通知の行は捨てる。
// 作った案は画面の欄に入れるだけで、保存はユーザーが「保存／取り込む」を押したとき（validateLines を通る）。

import {
  CHAT_LINE_MAX,
  IDLE_LINE_MAX,
  LINE_GROUPS,
  NOTIFY_LINE_MAX,
  checkLine,
  cleanLine,
  countMax,
  emptyLines,
  placeholdersIn,
} from './characterLines.js';
import { DEFAULT_CHARACTER_NAME } from './characterImport.js';
import { DEFAULT_TONE } from './chatPersona.js';

/** 種類ごとに作る文の数（標準の文と同じ数。上限いっぱいにすると出力が長くなり失敗しやすい） */
export const GENERATE_COUNTS = Object.freeze({
  notify: Object.freeze({ calendar: 3, calendarAllDay: 3, tasks: 3, gmail: 3 }),
  idle: Object.freeze({ morning: 5, bedtime: 5, normal: 20 }),
  chat: Object.freeze({ closing: 3 }),
});
/** 生成の出力の上限（7.3 のチャットの 1024 より多い。思考トークンも含めて数えるモデルがある） */
export const GENERATE_MAX_OUTPUT_TOKENS = 8192;
/** 生成の1リクエストの上限時間（チャットの 30 秒より長い） */
export const GENERATE_TIMEOUT_MS = 60000;

/** 種類ごとの場面の説明（プロンプトに入れる） */
const SCENES = Object.freeze({
  notify: Object.freeze({
    calendar: '予定の開始前のお知らせ。{title}＝予定の件名、{time}＝開始時刻（「10時30分」の形で入る。例「{time}から{title}だよ」）',
    calendarAllDay: 'その日の終日の予定のお知らせ（朝などに出る）。{title}＝予定の件名',
    tasks: 'TODO（やること）の期限のお知らせ。{title}＝TODOの件名',
    gmail: '重要なメールが届いたお知らせ。{title}＝メールの件名、{from}＝差出人の名前（例「{from}さんからだよ」）',
  }),
  idle: Object.freeze({
    morning: '朝（6時〜10時）に、その日はじめて話しかけるときのあいさつ',
    bedtime: '夜（寝る時間の1時間前ごろ）のあいさつ。休むことをすすめる',
    normal: '何もないときのひとりごと、ユーザーへの話しかけ、ちょっとした問いかけ（疑問形も混ぜる）',
  }),
  chat: Object.freeze({
    closing: 'ユーザーとのおしゃべり（チャット）を、回数の上限で終えるときのあいさつ',
  }),
});

const PLACEHOLDER_NAMES = Object.freeze({ calendar: '{title}・{time}', calendarAllDay: '{title}', tasks: '{title}', gmail: '{title}・{from}' });

/**
 * プロンプトを組み立てる（純粋関数）。
 * @param {{ builtin?: boolean, displayName?: string, persona?: string }} character persona は validatePersona 済み
 * @returns {{ systemPrompt: string, userText: string }}
 */
export function buildLinesPrompt({ builtin = false, displayName = '', persona = '' } = {}) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  const intro = builtin
    ? `デスクトップに常駐している、黄色い丸い形のマスコット「${DEFAULT_CHARACTER_NAME}」`
    : `デスクトップに常駐しているマスコットキャラクター${name ? `「${name}」` : ''}`;
  const hasPersona = typeof persona === 'string' && persona.trim() !== '';
  const character = hasPersona
    ? [
        `${intro}です。以下はユーザーが書いたキャラクターの設定です。性格・口調・一人称などはこの設定に従ってください。`,
        '<character>',
        persona.trim(),
        '</character>',
      ]
    : [`${intro}です。次の話し方をします。`, ...DEFAULT_TONE];

  const kinds = LINE_GROUPS.flatMap(([group, ks]) =>
    ks.map((kind) => `- ${group}.${kind}：${SCENES[group][kind]}。${GENERATE_COUNTS[group][kind]}文`),
  );

  const systemPrompt = [
    'あなたは、デスクトップマスコットのセリフを書く脚本家です。指定のキャラクターになりきったセリフを作り、JSON だけで返します。',
    '',
    '# キャラクター',
    ...character,
    '',
    '# 作るセリフ（キー：場面。数）',
    ...kinds,
    '',
    '# 決まり（キャラクター設定より優先）',
    '- 1つの文を配列の1つの要素にする。改行は入れない。',
    `- notify の文には必ず {title} を入れる（半角の波かっこのまま書く。中身は読み上げのときに入る）。notify.calendar にはなるべく {time} も入れる。`,
    `- 差し込みは種類ごとに使えるものだけを使う（notify.calendar は ${PLACEHOLDER_NAMES.calendar}、notify.calendarAllDay と notify.tasks は {title}、notify.gmail は ${PLACEHOLDER_NAMES.gmail}）。idle と chat には差し込み（波かっこ）を使わない。`,
    `- 長さ：notify は差し込みを除いて${NOTIFY_LINE_MAX}文字以内、idle は${IDLE_LINE_MAX}文字以内、chat は${CHAT_LINE_MAX}文字以内。短めがよい。`,
    '- 件名・差出人・時刻の中身は分からないので、具体的な内容を決めつけない（「会議」「打ち合わせ」などを書かない）。',
    '- 文は音声で読み上げる。絵文字・顔文字・記号（♪・★・w・（笑）など）・Markdown・ふりがなは使わない。',
    '- 同じ種類の中で、似た文や同じ言い回しをくり返さない。',
    '- 不快・攻撃的な内容や、個人情報をたずねる文は作らない。',
  ].join('\n');

  return { systemPrompt, userText: '上の決まりに従って、すべての種類のセリフを JSON で作ってください。' };
}

/** 応答の形（Gemini の responseSchema。OpenAPI の一部） */
export function linesResponseSchema() {
  const arrayOfStrings = { type: 'ARRAY', items: { type: 'STRING' } };
  const group = (kinds) => ({
    type: 'OBJECT',
    properties: Object.fromEntries(kinds.map((k) => [k, arrayOfStrings])),
    required: [...kinds],
    propertyOrdering: [...kinds],
  });
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(LINE_GROUPS.map(([g, kinds]) => [g, group(kinds)])),
    required: LINE_GROUPS.map(([g]) => g),
    propertyOrdering: LINE_GROUPS.map(([g]) => g),
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** ```json … ``` で囲まれていれば中身を取り出す */
function unfence(text) {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i.exec(text);
  return m ? m[1] : text;
}

/**
 * 応答の本文を読み、使える文だけを残す（純粋関数）。
 * @param {string} text Gemini の応答本文
 * @returns {{ ok: true, lines: ReturnType<typeof emptyLines>, missing: string[] } | { ok: false, reason: 'invalid_response' }}
 *   missing は使える文が1つも残らなかった種類（'notify.calendar' など）。全種類が空なら invalid_response
 */
export function parseGeneratedLines(text) {
  let data;
  try {
    data = JSON.parse(unfence(String(text ?? '')));
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid_response' };

  const lines = emptyLines();
  const missing = [];
  for (const [group, kinds] of LINE_GROUPS) {
    const src = isPlainObject(data[group]) ? data[group] : {};
    for (const kind of kinds) {
      const out = [];
      for (const v of Array.isArray(src[kind]) ? src[kind] : []) {
        if (typeof v !== 'string' || /[\r\n]/.test(v)) continue;
        const line = cleanLine(v);
        if (line === '' || out.includes(line) || checkLine(group, kind, line)) continue;
        // 通知のセリフは件名を必ず読む（保存の決まりでは任意だが、生成する案は耳だけでどの通知か分かるものにする）
        if (group === 'notify' && !placeholdersIn(line).includes('title')) continue;
        out.push(line);
      }
      lines[group][kind] = out.slice(0, countMax(group, kind));
      if (out.length === 0) missing.push(`${group}.${kind}`);
    }
  }
  const total = LINE_GROUPS.reduce((n, [group, kinds]) => n + kinds.reduce((m, k) => m + lines[group][k].length, 0), 0);
  if (total === 0) return { ok: false, reason: 'invalid_response' };
  return { ok: true, lines, missing };
}

/** 失敗の種類（geminiClient の GeminiError.kind・invalid_response・not_configured・invalid_persona・busy）→ 画面に出す文 */
export function describeGenerateError(reason) {
  switch (reason) {
    case 'not_configured':
      return 'Gemini の API キーが設定されていません。設定画面の「チャット」で入力すると使えます。';
    case 'auth':
      return 'Gemini の API キーが正しくないようです。設定画面で確認してください。';
    case 'rate_limit':
      return 'Gemini が混み合っているか、利用の上限に達したようです。少し待ってからもう一度試してください。';
    case 'quota':
      return 'API の利用枠（クレジット）が足りないようです。AI Studio の課金設定を確認してください。';
    case 'model_unavailable':
      return '使える Gemini のモデルが見つかりませんでした。ログを確認してください。';
    case 'network':
      return 'インターネットにつながらないようです。接続を確認してください。';
    case 'timeout':
      return '応答に時間がかかりすぎました。もう一度試してください。';
    case 'blocked':
      return 'このキャラクター設定ではセリフを作れませんでした。キャラクター設定を見直してください。';
    case 'busy':
      return 'セリフを作っているところです。終わるまでお待ちください。';
    case 'invalid_persona':
      return 'キャラクター設定が長すぎます（1000 文字まで）。';
    case 'empty':
    case 'invalid_response':
      return 'うまく作れませんでした。もう一度試してください。';
    default:
      return 'Gemini でエラーが起きました。少し待ってからもう一度試してください。';
  }
}

/**
 * @param {object} deps
 * @param {{ generate: Function }} deps.client geminiClient.createGeminiClient()
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createLineGenerator({ client, log = console }) {
  return {
    /**
     * セリフの案を作る。
     * @param {{ builtin?: boolean, displayName?: string, persona?: string, signal?: AbortSignal }} req persona は validatePersona 済み
     * @returns {Promise<{ ok: true, lines: ReturnType<typeof emptyLines>, missing: string[] } |
     *   { ok: false, reason: string }>} reason は describeGenerateError の種類（中止は 'aborted'）
     */
    async generate({ builtin = false, displayName = '', persona = '', signal } = {}) {
      const { systemPrompt, userText } = buildLinesPrompt({ builtin, displayName, persona });
      let text;
      try {
        text = await client.generate({
          systemPrompt,
          contents: [{ role: 'user', text: userText }],
          signal,
          timeoutMs: GENERATE_TIMEOUT_MS,
          generationConfig: {
            maxOutputTokens: GENERATE_MAX_OUTPUT_TOKENS,
            temperature: 1.0,
            responseMimeType: 'application/json',
            responseSchema: linesResponseSchema(),
          },
        });
      } catch (e) {
        return { ok: false, reason: typeof e?.kind === 'string' ? e.kind : 'unknown' };
      }
      const parsed = parseGeneratedLines(text);
      if (!parsed.ok) {
        // 本文はログに出さない（キャラクター設定を含み得るため）。長さだけ
        log.warn(`[lines] Gemini の応答をセリフとして読めませんでした（${String(text ?? '').length} 文字）`);
        return parsed;
      }
      const count = LINE_GROUPS.reduce((n, [g, kinds]) => n + kinds.reduce((m, k) => m + parsed.lines[g][k].length, 0), 0);
      log.info(`[lines] セリフを作りました: ${count} 文${parsed.missing.length > 0 ? `（作れなかった種類: ${parsed.missing.join(', ')}）` : ''}`);
      return parsed;
    },
  };
}
