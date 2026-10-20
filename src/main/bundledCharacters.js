// 同梱キャラクター（F-23・Phase 15）。Electron に依存しない：fs とディレクトリは注入する。
//
// assets/characters/<id>/（アプリの中。読み取り専用。id は characterImport.BUNDLED_CHARACTER_IDS）
//   manifest.json … 同梱用の形（取り込んだキャラクターの manifest とは別。枚数は持たず、読み込むときにフォルダの連番を数える）：
//     { version: 1, id, displayName, canvasSize, updatedAt, slots: { [slot]: { fps } | null },
//       voice, voiceCredit, persona, lines, fallbackLines }
//     fallbackLines … 通知の種類ごとの件名なしの文（VOICEVOX が無いときの固定ボイス。差し込みなし・30字以内・5文まで）。編集画面では変えない
//     voiceCredit   … 固定ボイスのクレジット表記（「VOICEVOX:ずんだもん」）
//   rest/000.png… など … モーションの画像（取り込みと同じ ImageSequence。フォルダ名は slotFolderName）
//   voice/        … 固定ボイス（fixedVoice.js）
// 必須のモーション（rest・notify）の画像が無い・連番が欠けているキャラクターは一覧に出さない（素材を置く前の開発中も動くように）。
//
// 利用者が変えられるのは声・キャラクター設定・セリフだけ（名前・画像は変えられず、削除もできない）。
// 変えた値は userData/characters/<id>-profile.json（default-profile.json と同じ形）に保存し、無ければ同梱の値を使う。
// 「同梱の状態に戻す」はこのファイルを消す。

import path from 'node:path';
import {
  BUNDLED_CHARACTER_IDS,
  CANVAS_SIZE,
  FPS_MAX,
  FPS_MIN,
  REQUIRED_SLOTS,
  SLOT_NAMES,
  SOURCE_EMOTELAB,
  frameFileNames,
  isBundledCharacterId,
  slotFolderName,
  validateDisplayName,
} from './characterImport.js';
import { NOTIFY_KINDS, NOTIFY_LINE_MAX, cleanLine, parseLines, placeholdersIn } from './characterLines.js';
import { parseDefaultProfile, parsePersona, parseVoice, validateCharacterProfile } from './characterProfile.js';
import { VOICE_DIR, VOICE_INDEX_FILE, createFixedVoice, parseVoiceIndex } from './fixedVoice.js';

export const BUNDLED_MANIFEST_VERSION = 1;
/** 件名なしの固定ボイスの文：通知の種類ごとの最大文数（1文の字数は通知のセリフと同じ NOTIFY_LINE_MAX） */
export const FALLBACK_COUNT_MAX = 5;
const CREDIT_MAX = 60;
const MANIFEST_FILE = 'manifest.json';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = (s) => [...s].length;

/** 利用者が編集した声・キャラクター設定・セリフの保存先のファイル名（userData/characters の中） */
export const profileFileName = (id) => `${id}-profile.json`;

/**
 * 件名なしの固定ボイスの文を読む。差し込みのある文・長すぎる文・文字列でないものは捨て、種類ごとに最大 FALLBACK_COUNT_MAX 文。
 * @returns {Record<string, string[]>}
 */
export function parseFallbackLines(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const kind of NOTIFY_KINDS) {
    const lines = Array.isArray(src[kind]) ? src[kind] : [];
    out[kind] = lines
      .filter((v) => typeof v === 'string' && !/[\r\n]/.test(v))
      .map(cleanLine)
      .filter((v) => v !== '' && placeholdersIn(v).length === 0 && codePoints(v) <= NOTIFY_LINE_MAX)
      .slice(0, FALLBACK_COUNT_MAX);
  }
  return out;
}

/** クレジット表記（1行・60文字まで）。無い・不正なら null */
function parseCredit(raw) {
  if (typeof raw !== 'string') return null;
  const v = cleanLine(raw);
  return v !== '' && !/[\r\n\t]/.test(v) && codePoints(v) <= CREDIT_MAX ? v : null;
}

/**
 * 同梱の manifest.json を、取り込んだキャラクターと同じ形（characterImport.parseManifest の結果）に揃えて読む。
 * 必須のモーションの画像が無ければ null（一覧に出さない）。任意のモーションは画像が無ければ未設定。
 * @param {unknown} raw
 * @param {string} id フォルダの名前（BUNDLED_CHARACTER_IDS のどれか）
 * @param {Record<string, number | null>} frameCounts スロット → フォルダの連番の枚数（無い・欠けていれば null）
 */
export function parseBundledManifest(raw, id, frameCounts) {
  if (!isPlainObject(raw) || raw.version !== BUNDLED_MANIFEST_VERSION) return null;
  if (!isBundledCharacterId(id) || raw.id !== id) return null;
  const name = validateDisplayName(raw.displayName);
  if (!name.ok) return null;
  const canvasSize = raw.canvasSize ?? CANVAS_SIZE;
  if (canvasSize !== CANVAS_SIZE) return null;
  if (!isPlainObject(raw.slots)) return null;
  const slots = {};
  for (const s of SLOT_NAMES) {
    const v = raw.slots[s];
    const frameCount = frameCounts?.[s] ?? null;
    const fps = isPlainObject(v) ? v.fps : undefined;
    if (!isPlainObject(v) || !Number.isInteger(fps) || fps < FPS_MIN || fps > FPS_MAX || !frameCount) {
      if (REQUIRED_SLOTS.includes(s)) return null;
      slots[s] = null;
      continue;
    }
    slots[s] = { folder: slotFolderName(s), frameCount, fps };
  }
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  return {
    version: BUNDLED_MANIFEST_VERSION,
    id,
    displayName: name.value,
    canvasSize,
    source: SOURCE_EMOTELAB,
    importedAt: '',
    updatedAt,
    voice: parseVoice(raw.voice),
    voiceCredit: parseCredit(raw.voiceCredit),
    persona: parsePersona(raw.persona),
    lines: parseLines(raw.lines),
    fallbackLines: parseFallbackLines(raw.fallbackLines),
    slots,
  };
}

/**
 * 同梱キャラクターの読み込みと、利用者が編集した声・キャラクター設定・セリフの保存。
 * @param {object} opts
 * @param {string} opts.assetsDir assets/characters（アプリの中）
 * @param {string} opts.profileDir userData/characters
 * @param {typeof import('node:fs/promises')} opts.fs
 * @param {{ info?: Function, warn?: Function }} [opts.log]
 * @param {readonly string[]} [opts.ids]
 */
export function createBundledCharacters({ assetsDir, profileDir, fs, log = {}, ids = BUNDLED_CHARACTER_IDS }) {
  /** 一覧から外した理由のログは ID ごとに1回だけ（一覧は画面を開くたびに読む） */
  const reported = new Set();
  const reportOnce = (id, message) => {
    if (reported.has(id)) return;
    reported.add(id);
    log.info?.(message);
  };

  async function countFrames(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const listed = frameFileNames(entries.filter((e) => e.isFile()).map((e) => e.name));
      return listed.ok ? listed.frames.length : null;
    } catch {
      return null;
    }
  }

  async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  }

  /** 同梱の値だけ（利用者の編集を重ねる前）。読めなければ null */
  async function readBundled(id) {
    if (!isBundledCharacterId(id) || !ids.includes(id)) return null;
    let raw;
    try {
      raw = await readJson(path.join(assetsDir, id, MANIFEST_FILE));
    } catch {
      reportOnce(id, `[character] 同梱キャラクターの manifest.json が無いため一覧に出しません: ${id}`);
      return null;
    }
    const frameCounts = {};
    for (const s of SLOT_NAMES) {
      frameCounts[s] = isPlainObject(raw?.slots?.[s]) ? await countFrames(path.join(assetsDir, id, slotFolderName(s))) : null;
    }
    const manifest = parseBundledManifest(raw, id, frameCounts);
    if (!manifest) reportOnce(id, `[character] 同梱キャラクターの画像か manifest.json がそろっていないため一覧に出しません: ${id}`);
    return manifest;
  }

  /** 利用者が編集した値。無い・読めなければ null（同梱の値を使う） */
  async function readProfile(id) {
    try {
      return parseDefaultProfile(await readJson(path.join(profileDir, profileFileName(id))));
    } catch {
      return null;
    }
  }

  /**
   * 同梱キャラクター（利用者の編集を重ねたもの）。
   * defaults は同梱の声・キャラクター設定・セリフ、customized は利用者が編集して保存したか。
   */
  async function get(id) {
    const bundled = await readBundled(id);
    if (!bundled) return null;
    const profile = await readProfile(id);
    const defaults = { voice: bundled.voice, persona: bundled.persona, lines: bundled.lines };
    return { ...bundled, ...(profile ?? defaults), defaults, customized: profile !== null };
  }

  return {
    get,

    /** 一覧（BUNDLED_CHARACTER_IDS の順）。画像がそろっていないものは出さない */
    async list() {
      const out = [];
      for (const id of ids) {
        const c = await get(id);
        if (c) out.push(c);
      }
      return out;
    },

    /**
     * 声・キャラクター設定・セリフを保存する（名前・画像は変えられない）。
     * @returns {Promise<{ ok: true, profile: { voice: object | null, persona: string, lines: object } } | { ok: false, error: object }>}
     */
    async saveProfile(id, { voice = null, persona = '', lines = null }) {
      if (!(await readBundled(id))) return { ok: false, error: { code: 'not_found' } };
      const profile = validateCharacterProfile({ voice, persona, lines });
      if (!profile.ok) return profile;
      const value = { voice: profile.voice, persona: profile.persona, lines: profile.lines };
      const filePath = path.join(profileDir, profileFileName(id));
      try {
        await fs.mkdir(profileDir, { recursive: true });
        await fs.writeFile(`${filePath}.tmp`, JSON.stringify(value, null, 2));
        await fs.rename(`${filePath}.tmp`, filePath);
      } catch (e) {
        log.warn?.(`[character] 同梱キャラクターの設定の保存に失敗: ${e?.message ?? e}`);
        return { ok: false, error: { code: 'write_failed' } };
      }
      log.info?.(`[character] 同梱キャラクターの設定を保存: ${id}`);
      return { ok: true, profile: value };
    },

    /**
     * 同梱の状態に戻す（編集した声・キャラクター設定・セリフを消す）。
     * @returns {Promise<{ ok: true, character: object } | { ok: false, error: object }>}
     */
    async resetProfile(id) {
      if (!(await readBundled(id))) return { ok: false, error: { code: 'not_found' } };
      try {
        await fs.rm(path.join(profileDir, profileFileName(id)), { force: true });
      } catch (e) {
        log.warn?.(`[character] 同梱キャラクターの設定を戻せません: ${e?.message ?? e}`);
        return { ok: false, error: { code: 'write_failed' } };
      }
      log.info?.(`[character] 同梱キャラクターを同梱の状態に戻しました: ${id}`);
      return { ok: true, character: await get(id) };
    },

    /**
     * 固定ボイス（voice/voices.json）。無い・読めなければ null（VOICEVOX だけで読み上げる）。
     * @param {{ id: string, fallbackLines: Record<string, string[]>, voiceCredit: string | null }} character get の結果
     * @param {{ rng?: () => number }} [opts]
     */
    async loadFixedVoice(character, { rng } = {}) {
      if (!character || !isBundledCharacterId(character.id)) return null;
      const dir = path.join(assetsDir, character.id, VOICE_DIR);
      let index;
      try {
        index = parseVoiceIndex(await readJson(path.join(dir, VOICE_INDEX_FILE)));
      } catch {
        return null;
      }
      if (!index) {
        log.warn?.(`[voice] 固定ボイスの ${VOICE_INDEX_FILE} を読めません: ${character.id}`);
        return null;
      }
      return createFixedVoice({ index, dir, fallbackLines: character.fallbackLines, credit: character.voiceCredit, rng });
    },
  };
}
