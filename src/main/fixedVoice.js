// 同梱キャラクターの固定ボイス（F-23・Phase 15）。Electron に依存しない純粋関数。
//
// VOICEVOX で事前に合成した音声（WAV）を assets/characters/<id>/voice/ に同梱し、VOICEVOX が無くても鳴らす。
// voices.json … { version: 1, voice: { speakerId, speedScale, pitchScale }, clips: { "<読み上げ文>": { file: "<16桁の16進>.wav", durationMs } } }
//   読み上げ文は、実際に VOICEVOX へ渡す文（TODO の読み替え・切り詰めの後）。作るのは scripts/bundle-character.mjs の voices
// 使い方（voiceReader.js）：
//   match(text, voice)     … 読み上げる文と一字一句同じ録音があればそれを使う（VOICEVOX が起動していても録音を優先する）
//   fallback(kind, voice)  … 通知の読み上げを VOICEVOX で合成できなかったとき、通知の種類ごとの件名なしの文（fallbackLines）の録音
// 声（話者・話速・音高）が録音と違えば（利用者が同梱キャラクターの声を変えた）どちらも使わない。
// 文を編集した場合は、その文の録音が無いだけ（VOICEVOX で合成し、無ければ読み上げない）。

import { createHash } from 'node:crypto';
import path from 'node:path';
import { NOTIFY_KINDS, effectiveLines, placeholdersIn, plainSpeech, renderSpeech } from './characterLines.js';
import { parseVoice } from './characterProfile.js';
import { createBag } from './phrasePicker.js';

export const VOICE_INDEX_VERSION = 1;
/** 固定ボイスの置き場所（キャラクターのフォルダの中）と対応表のファイル名 */
export const VOICE_DIR = 'voice';
export const VOICE_INDEX_FILE = 'voices.json';

const CLIP_FILE_RE = /^[0-9a-f]{16}\.wav$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 声が同じか（話速・音高は保存時に小数2桁へ丸めてある：characterProfile.validateVoice） */
export function sameVoice(a, b) {
  if (!a || !b) return false;
  return a.speakerId === b.speakerId && a.speedScale === b.speedScale && a.pitchScale === b.pitchScale;
}

/**
 * 録音のファイル名（文と声のハッシュ）。文か声が変われば別のファイルになるので、作り直しで古い録音と混ざらない。
 * @param {string} text 読み上げ文
 * @param {{ speakerId: number, speedScale: number, pitchScale: number }} voice
 */
export function clipFileName(text, voice) {
  const key = JSON.stringify([text, voice.speakerId, voice.speedScale, voice.pitchScale]);
  return `${createHash('sha256').update(key).digest('hex').slice(0, 16)}.wav`;
}

/**
 * voices.json を読む。形が違えば null（固定ボイスなし）。壊れた項目はその項目だけを捨てる。
 * @returns {{ voice: { speakerId: number, speedScale: number, pitchScale: number }, clips: Map<string, { file: string, durationMs: number | null }> } | null}
 */
export function parseVoiceIndex(raw) {
  if (!isPlainObject(raw) || raw.version !== VOICE_INDEX_VERSION) return null;
  const voice = parseVoice(raw.voice);
  if (!voice || !isPlainObject(raw.clips)) return null;
  const clips = new Map();
  for (const [text, v] of Object.entries(raw.clips)) {
    if (text === '' || !isPlainObject(v) || typeof v.file !== 'string' || !CLIP_FILE_RE.test(v.file)) continue;
    const durationMs = Number.isInteger(v.durationMs) && v.durationMs > 0 ? v.durationMs : null;
    clips.set(text, { file: v.file, durationMs });
  }
  return { voice, clips };
}

/**
 * 録音しておく読み上げ文（重複なし）。アイドルトークの文（空の種類は標準の文）、差し込みの無い通知のセリフ、件名なしの固定ボイスの文。
 * 差し込みのある通知のセリフ（件名などで毎回変わる）と、チャットの終わり（返事とつなげて合成する）は録音しない。
 * @param {{ lines: unknown, fallbackLines: Record<string, string[]> }} character
 * @returns {string[]}
 */
export function recordingTexts({ lines, fallbackLines }) {
  const effective = effectiveLines(lines);
  const out = new Set();
  for (const phrases of Object.values(effective.idle)) for (const p of phrases) out.add(plainSpeech(p));
  for (const kind of NOTIFY_KINDS) {
    for (const line of effective.notify[kind]) if (placeholdersIn(line).length === 0) out.add(renderSpeech(line, {}));
    for (const line of fallbackLines?.[kind] ?? []) out.add(plainSpeech(line));
  }
  out.delete('');
  return [...out];
}

/**
 * 選択中の同梱キャラクターの固定ボイス。
 * @param {object} opts
 * @param {ReturnType<typeof parseVoiceIndex>} opts.index
 * @param {string} opts.dir 録音のフォルダ（assets/characters/<id>/voice の絶対パス）
 * @param {Record<string, string[]>} [opts.fallbackLines] 通知の種類 → 件名なしの文
 * @param {string | null} [opts.credit] クレジット表記（「VOICEVOX:ずんだもん」）
 * @param {() => number} [opts.rng]
 */
export function createFixedVoice({ index, dir, fallbackLines = {}, credit = null, rng = Math.random }) {
  const clipFor = (text) => {
    const c = index.clips.get(text);
    return c ? { text, filePath: path.join(dir, c.file), durationMs: c.durationMs } : null;
  };
  // 件名なしの文は、録音のあるものだけをシャッフル袋で選ぶ（アイドルトークと同じく、続けて同じ文にならない）
  const bags = new Map();
  for (const kind of NOTIFY_KINDS) {
    const texts = (fallbackLines[kind] ?? []).map(plainSpeech).filter((t) => index.clips.has(t));
    if (texts.length > 0) bags.set(kind, createBag([...new Set(texts)], rng));
  }

  return {
    credit,
    /** 今の声で録音を使えるか（クレジット表記を出すかの判定にも使う） */
    usable: (voice) => sameVoice(index.voice, voice),

    /**
     * 読み上げる文と同じ録音。
     * @returns {{ text: string, filePath: string, durationMs: number | null } | null}
     */
    match(text, voice) {
      if (!sameVoice(index.voice, voice) || typeof text !== 'string') return null;
      return clipFor(text);
    },

    /**
     * 通知の種類ごとの件名なしの固定ボイス（VOICEVOX で合成できなかったとき）。
     * @param {string} kind 'calendar' | 'calendarAllDay' | 'tasks' | 'gmail'
     * @returns {{ text: string, filePath: string, durationMs: number | null } | null}
     */
    fallback(kind, voice) {
      if (!sameVoice(index.voice, voice)) return null;
      const bag = bags.get(kind);
      return bag ? clipFor(bag.next()) : null;
    },
  };
}
