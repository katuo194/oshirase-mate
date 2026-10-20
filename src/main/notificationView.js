// 通知1件 → 吹き出しの内容・アニメーションパラメータ・タイミング（F-04 / F-11）。Electron に依存しない純粋ロジック。
//
// 通知アニメーションは「通知なし（静止）→ 通知中 → 通知なし（静止）」の2状態（マスコットは常時表示のため、出現・退場のフェーズは持たない）。
// 通知中は「冒頭の動き（burst・約1秒・1回だけ。注意を引く）→ 内容表示中のループ（loop）」で、
// 表示時間（holdMs）が過ぎたら outMs をかけて吹き出しと動きを絞り、静止へ戻る。
//
// レンダラーはここで決めた params / timing をそのまま描画するだけ（Canvas 手続き描画。素材が用意できたら
// character.js の描画を drawImage に差し替える。ここで決める kind / motion 名は素材のクリップ選択にも使える）。
// 種別（kind）は通知の source と同じ文字列：'calendar' | 'tasks' | 'gmail'。
//
// 読み上げ文（speech）はキャラクターのセリフ（F-22・characterLines.js）から作る。セリフを渡さなければ今の固定文と同じ。
// 吹き出し（ラベル・主題・副題）はセリフによらず今のまま。

import { DEFAULT_NOTIFY_LINES, FALLBACK_NOTIFY_LINES, SPEECH_MAX, SPOKEN_TODO, isUsableLine, plainSpeech, renderSpeech, toSpoken } from './characterLines.js';

const TITLE_MAX = 120;
const SUB_MAX = 80;

/** 冒頭の動き（burst）の長さ。 */
export const BURST_MS = 1000;
/** 表示時間の終わりで、吹き出しと動きを絞って静止へ戻す時間。 */
export const OUT_MS = 500;
/** ループの動き1周期。 */
export const LOOP_CYCLE_MS = 1500;
/** 後続の通知が溜まっているときの保持時間の倍率と下限（表示待ちの長時間化を避ける）。 */
export const BACKLOG_HOLD_RATIO = 0.6;
export const MIN_HOLD_MS = 3000;
/**
 * 読み上げ（F-13）がある場合の保持時間の延長。絞りの開始 = max(holdMs, 音声の終了 + VOICE_TAIL_MS)、
 * ただし表示開始から MAX_VOICE_HOLD_MS を上限とする（上限に達したら音声も絞りに合わせて止める）。
 * バックログで holdMs が縮んでいても、音声の長さを優先する。
 */
export const VOICE_TAIL_MS = 600;
export const MAX_VOICE_HOLD_MS = 20000;
/** 効果音の終わりから読み上げを始めるまでの間。効果音の終了が分からない場合は表示開始から VOICE_GATE_MAX_MS で解禁する */
export const VOICE_AFTER_SFX_MS = 200;
export const VOICE_GATE_MAX_MS = 1500;
/** 「TODO」の読み（SPOKEN_TODO）と読み上げ文の最大長（SPEECH_MAX）は、セリフの展開（characterLines.js）と共有する */
export { SPEECH_MAX, SPOKEN_TODO };

/**
 * 種別ごとの見た目（F-11）。motion 名は renderer/mascot/character.js が解釈する。
 *   burst：pop（オーバーシュート拡大）／hop（上下バウンド）／drop（上から落下してバウンド）
 *   loop ：pulse（ゆっくり脈動）／sway（左右にゆれる）／shake（小刻みな震え）
 */
const KINDS = Object.freeze({
  calendar: {
    label: '予定',
    holdMs: 8000,
    params: { accent: '#3b82f6', tint: '#3b82f6', mouth: 'smile', burst: 'pop', loop: 'pulse' },
  },
  tasks: {
    label: 'TODO',
    holdMs: 6000,
    params: { accent: '#22a06b', tint: '#22a06b', mouth: 'smile', burst: 'hop', loop: 'sway' },
  },
  gmail: {
    label: '重要メール',
    holdMs: 5000,
    params: { accent: '#e8590c', tint: '#e8590c', mouth: 'open', burst: 'drop', loop: 'shake' },
  },
});

/** 未知の種別用（通常は notifyQueue が弾くので到達しない）。 */
const FALLBACK = Object.freeze({
  label: '通知',
  holdMs: 5000,
  params: { accent: '#6b7280', tint: '#6b7280', mouth: 'smile', burst: 'pop', loop: 'pulse' },
});

/** オフライン等のアプリからのお知らせ（F-14）。控えめなグレー。 */
const SYSTEM = Object.freeze({
  label: 'お知らせ',
  holdMs: 6000,
  params: { accent: '#6b7280', tint: '#6b7280', mouth: 'worried', burst: 'pop', loop: 'pulse' },
});

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const pad2 = (n) => String(n).padStart(2, '0');

/** 予定開始までの相対表記。 */
export function formatRelativeStart(minutes) {
  if (minutes < 1) return 'まもなく';
  if (minutes < 60) return `${minutes}分後`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}時間後` : `${h}時間${m}分後`;
  }
  return `${Math.floor(minutes / (24 * 60))}日後`;
}

function calendarSub(n, now) {
  const { startAt, allDay } = n.data;
  if (allDay === true) return '終日';
  if (!Number.isFinite(startAt)) return n.body;
  const d = new Date(startAt);
  const minutes = Math.round((startAt - now) / 60000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} 開始（${formatRelativeStart(minutes)}）`;
}

/** 'YYYY-MM-DD' を「9/20（今日）」の形にする。今日・明日・昨日以外は M/D のみ。 */
export function formatDueDate(due, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const today = new Date(now);
  // UTC の暦日どうしで差を取る（夏時間の23/25時間日に左右されない）
  const days = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const rel = days === 0 ? '（今日）' : days === 1 ? '（明日）' : days === -1 ? '（昨日）' : '';
  return `${mo}/${d}${rel}`;
}

function tasksSub(n, now) {
  const due = formatDueDate(n.data.due, now);
  return due ? `期限：${due}` : n.body;
}

/** 読み上げ文の「10時30分」「10時」。 */
function spokenTime(ms) {
  const d = new Date(ms);
  return d.getMinutes() === 0 ? `${d.getHours()}時` : `${d.getHours()}時${d.getMinutes()}分`;
}

/**
 * 通知 → セリフの種類（characterLines.js の notify のキー）と差し込みの値。種類の無い通知（未知の source）は kind: null。
 * @returns {{ kind: string | null, values: { title: string, time: string, from: string } }}
 */
export function speechSlots(notification) {
  const title = (notification.title ?? '').trim();
  const data = notification.data ?? {};
  const values = { title, time: '', from: '' };
  switch (notification.source) {
    case 'calendar':
      if (data.allDay === true) return { kind: 'calendarAllDay', values };
      if (Number.isFinite(data.startAt)) values.time = spokenTime(data.startAt);
      return { kind: 'calendar', values };
    case 'tasks':
      return { kind: 'tasks', values };
    case 'gmail':
      values.from = (notification.body ?? '').trim();
      return { kind: 'gmail', values };
    default:
      return { kind: null, values };
  }
}

/**
 * 読み上げる文（F-13・F-22）。吹き出しより短く、耳で聞いて分かる形にする。最大 SPEECH_MAX 文字（長いときは件名の側を切り詰める）。
 * セリフは、差し込みの値が空になる文（差出人が無いのに {from} を含むなど）を避けて選び、使える文が無ければ既定の文
 * （FALLBACK_NOTIFY_LINES）を使う。何も渡さなければ今の固定文と同じ結果になる。
 * @param {{ source: string, title?: string, body?: string, data?: object }} notification
 * @param {object} [opts]
 * @param {Record<string, readonly string[]>} [opts.lines] 種類 → セリフ（characterLines.effectiveLines().notify）。pickLine が無いときに使う（先頭の使える文）
 * @param {(kind: string, accept: (line: string) => boolean) => string | null} [opts.pickLine]
 *   文の選び方（phrasePicker.pickNotify。キャラクターのセリフをシャッフル袋で選ぶ）。accept を満たす文を返す。無ければ null
 * @returns {string | null} 読み上げるものが無ければ null
 */
export function toSpeechText(notification, { lines = DEFAULT_NOTIFY_LINES, pickLine = null } = {}) {
  const { kind, values } = speechSlots(notification);
  let text;
  if (kind === null) {
    text = toSpoken(values.title).trim();
    text = [...text].slice(0, SPEECH_MAX).join('');
  } else {
    const accept = (line) => isUsableLine(line, values);
    const candidates = lines?.[kind]?.length > 0 ? lines[kind] : DEFAULT_NOTIFY_LINES[kind];
    const line = (pickLine ? pickLine(kind, accept) : candidates.find(accept)) ?? FALLBACK_NOTIFY_LINES[kind];
    // VOICEVOX は「TODO」をうまく読めないため、件名に含まれる分も含めて読みに置き換える（吹き出しの表記はそのまま）
    text = renderSpeech(line, values, { max: SPEECH_MAX });
  }
  return text === '' ? null : text;
}

const timingFor = (holdMs) => ({
  holdMs,
  outMs: OUT_MS,
  burstMs: BURST_MS,
  loopCycleMs: LOOP_CYCLE_MS,
  voiceTailMs: VOICE_TAIL_MS,
  maxVoiceHoldMs: MAX_VOICE_HOLD_MS,
  voiceAfterSfxMs: VOICE_AFTER_SFX_MS,
  voiceGateMaxMs: VOICE_GATE_MAX_MS,
});

/**
 * @param {{ id: string, source: string, title: string, body: string, data?: object }} notification 正規化済みの通知
 * @param {object} [opts]
 * @param {number} [opts.now] 現在時刻（ms）
 * @param {number} [opts.backlog] 表示待ちの後続通知の件数
 * @param {Record<string, readonly string[]>} [opts.lines] 読み上げのセリフ（toSpeechText）
 * @param {(kind: string, accept: (line: string) => boolean) => string | null} [opts.pickLine] セリフの選び方（toSpeechText）
 * @returns {{
 *   id: string, kind: string, label: string, title: string, sub: string,
 *   params: { accent: string, tint: string, mouth: string, burst: string, loop: string },
 *   timing: { holdMs: number, outMs: number, burstMs: number, loopCycleMs: number, voiceTailMs: number, maxVoiceHoldMs: number, voiceAfterSfxMs: number, voiceGateMaxMs: number },
 *   sfxKey: string | null,
 *   speech: string | null,
 *   speechKind: string | null,
 * }}
 * speechKind はセリフの種類（speechSlots の kind）。VOICEVOX で読み上げられないとき、同梱キャラクターの件名なしの固定ボイスを選ぶのに使う（Phase 15）
 */
export function toPresentation(notification, { now = Date.now(), backlog = 0, lines, pickLine } = {}) {
  const def = KINDS[notification.source] ?? FALLBACK;
  const n = { ...notification, data: notification.data ?? {} };

  let sub = n.body ?? '';
  if (notification.source === 'calendar') sub = calendarSub(n, now);
  else if (notification.source === 'tasks') sub = tasksSub(n, now);

  const holdMs = backlog > 0 ? Math.max(MIN_HOLD_MS, Math.round(def.holdMs * BACKLOG_HOLD_RATIO)) : def.holdMs;

  return {
    id: n.id,
    kind: notification.source in KINDS ? notification.source : 'generic',
    label: def.label,
    title: clip(n.title ?? '', TITLE_MAX),
    sub: clip(sub, SUB_MAX),
    params: { ...def.params },
    timing: timingFor(holdMs),
    sfxKey: notification.source in KINDS ? notification.source : 'default',
    speech: toSpeechText(n, { lines, pickLine }),
    speechKind: speechSlots(n).kind,
  };
}

/**
 * アプリからのお知らせ（オフライン遷移時の「接続を確認してね」など）の演出。notifyQueue・通知済みIDには載せない。
 * 効果音・読み上げなし（控えめに知らせる）。
 * @param {{ id: string, title: string, sub?: string }} p
 */
export function systemPresentation({ id, title, sub = '' }) {
  return {
    id,
    kind: 'system',
    label: SYSTEM.label,
    title: clip(title, TITLE_MAX),
    sub: clip(sub, SUB_MAX),
    params: { ...SYSTEM.params },
    timing: timingFor(SYSTEM.holdMs),
    sfxKey: null,
    speech: null,
  };
}

/** アイドルトーク（F-15）の保持時間。動きなしの軽い表現なので、通知（5〜8秒）と同程度の短さにする。 */
export const IDLE_HOLD_MS = 7000;

/**
 * アイドルトーク（F-15）の演出。通知と紛らわしくならないよう、動き・リング・効果音・種別ラベルなしの軽い表現
 * （吹き出しと読み上げのみ。ミュート中は voiceReader が合成しないので吹き出しのみ）。notifyQueue・通知済みIDには載せない。
 * @param {{ id: string, text: string }} p
 */
export function idlePresentation({ id, text }) {
  return {
    id,
    kind: 'idle',
    label: '',
    title: clip(text, TITLE_MAX),
    sub: '',
    params: { accent: '#c99a00', tint: '#c99a00', mouth: 'smile', burst: 'none', loop: 'none' },
    timing: timingFor(IDLE_HOLD_MS),
    sfxKey: null,
    // キャラクターのセリフ（F-22）に「TODO」と書かれても読めるように、通知と同じく読みに置き換える
    speech: plainSpeech(text),
  };
}

/** 1件の演出にかかる合計時間（ウォッチドッグの基準）。表示時間＋終わりの絞り。読み上げで延びる場合は presenter.extend() で延長する。 */
export const totalMs = (timing) => timing.holdMs + timing.outMs;

/**
 * サマリバッジの表示テキスト（7.1）。0件は非表示（null）、100件以上と上限到達は「99+」。
 * 正確な件数（2500+件を含む）はログで確認する。
 * @param {{ count: number, capped?: boolean }} view mailSummary.get() の値
 * @returns {string | null}
 */
export function formatBadgeText({ count, capped = false }) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return capped || count > 99 ? '99+' : String(count);
}
