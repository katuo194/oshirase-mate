// VOICEVOX の話者名の覚え書き（v5.18）。Electron に依存しない：fs・話者一覧の取得は注入する。
//
// キャラクターの声は話者の番号（スタイルID）だけを保存しているため、名前は VOICEVOX（GET /speakers）に問い合わせないと分からない。
// キャラクター選択画面で VOICEVOX が止まっていても「声：ずんだもん（ノーマル）」と出せるよう、
// 一覧を取れたときに「スタイルID → 話者名（スタイル名）」を userData/voicevox-speakers.json に保存しておく。
// 一度も取れていなければ名前は分からない（呼び出し側が「話者 113」のように番号で出す）。

import path from 'node:path';
import { sameVoice } from './fixedVoice.js';

export const SPEAKER_NAMES_VERSION = 1;
const NAME_MAX = 80;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 話者一覧（voicevox.listSpeakers の結果）→ スタイルID → 「話者名（スタイル名）」。
 * @param {{ name: string, styles: { id: number, name: string }[] }[]} speakers
 * @returns {Map<number, string>}
 */
export function speakerNameMap(speakers) {
  const out = new Map();
  for (const sp of Array.isArray(speakers) ? speakers : []) {
    for (const st of sp?.styles ?? []) {
      if (Number.isInteger(st?.id) && typeof sp.name === 'string' && typeof st.name === 'string') out.set(st.id, `${sp.name}（${st.name}）`);
    }
  }
  return out;
}

/**
 * キャラクター選択画面に出す声の説明（例「声：ずんだもん（ノーマル）・録音あり」「声：四国めたん（ノーマル）（既定の声）」）。
 * @param {object} opts
 * @param {{ speakerId: number, speedScale: number, pitchScale: number } | null} opts.voice キャラクターの声（null は config.json の声）
 * @param {{ speakerId: number, speedScale: number, pitchScale: number }} opts.defaultVoice config.json の voicevox
 * @param {(id: number) => string | null} opts.nameOf
 * @param {{ voice: object | null, credit: string | null } | null} [opts.recorded] 同梱キャラクターの録音の声とクレジット（同梱でなければ null）
 */
export function voiceLabel({ voice, defaultVoice, nameOf, recorded = null }) {
  const effective = voice ?? defaultVoice;
  const usesRecording = Boolean(recorded?.voice) && sameVoice(effective, recorded.voice);
  // 名前：覚えている一覧 → 録音のクレジット（「VOICEVOX:ずんだもん」。スタイル名は分からない）→ 番号
  const name =
    nameOf(effective.speakerId) ??
    (usesRecording && recorded.credit ? recorded.credit.replace(/^VOICEVOX:/, '') : null) ??
    `話者 ${effective.speakerId}`;
  return `声：${name}${voice ? '' : '（既定の声）'}${usesRecording ? '・録音あり' : ''}`;
}

/** 保存したファイルを読む。形が違えば空。壊れた項目はその項目だけを捨てる */
export function parseSpeakerNames(raw) {
  const out = new Map();
  if (!isPlainObject(raw) || raw.version !== SPEAKER_NAMES_VERSION || !isPlainObject(raw.styles)) return out;
  for (const [key, name] of Object.entries(raw.styles)) {
    const id = Number(key);
    if (Number.isInteger(id) && id >= 0 && typeof name === 'string' && name !== '' && [...name].length <= NAME_MAX && !/[\r\n]/.test(name)) {
      out.set(id, name);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath userData/voicevox-speakers.json
 * @param {typeof import('node:fs/promises')} opts.fs
 * @param {() => Promise<{ name: string, styles: { id: number, name: string }[] }[]>} opts.listSpeakers 起動していなければ reject
 * @param {{ warn?: Function }} [opts.log]
 */
export function createSpeakerNames({ filePath, fs, listSpeakers, log = {} }) {
  let names = new Map();
  let loaded = null;

  async function save() {
    const value = { version: SPEAKER_NAMES_VERSION, styles: Object.fromEntries(names) };
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(`${filePath}.tmp`, JSON.stringify(value, null, 2));
      await fs.rename(`${filePath}.tmp`, filePath);
    } catch (e) {
      log.warn?.(`[voicevox] 話者名を保存できません: ${e?.message ?? e}`);
    }
  }

  return {
    /** 保存したファイルを読む（起動時。何度呼んでも1回だけ読む） */
    load() {
      loaded ??= fs
        .readFile(filePath, 'utf8')
        .then((text) => {
          // 読み込みの前に refresh が済んでいれば、新しいほうを残す
          if (names.size === 0) names = parseSpeakerNames(JSON.parse(text));
        })
        .catch(() => {});
      return loaded;
    },

    /**
     * 取れた話者一覧を覚える（一覧を取ったところから呼ぶ）。前と同じなら書き込まない。
     * @returns {Promise<boolean>} 覚えている名前が変わったか
     */
    async remember(speakers) {
      const next = speakerNameMap(speakers);
      if (next.size === 0) return false;
      const same = next.size === names.size && [...next].every(([id, name]) => names.get(id) === name);
      if (same) return false;
      names = next;
      await save();
      return true;
    },

    /**
     * VOICEVOX から一覧を取り直して覚える。起動していなければ何もしない（覚えている名前はそのまま）。
     * @returns {Promise<boolean>} 覚えている名前が変わったか
     */
    async refresh() {
      await this.load();
      try {
        return await this.remember(await listSpeakers());
      } catch {
        return false;
      }
    },

    /** スタイルID → 「話者名（スタイル名）」。分からなければ null */
    nameOf: (id) => names.get(id) ?? null,
  };
}
