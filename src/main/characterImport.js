// EmoteLab キャラクターの取り込み（F-17・2.6・6.2）。Electron に依存しない。
//
// 前半は純粋関数（PNG ヘッダーの解析、ImageSequence フォルダの検証、manifest.json の生成・検証、mascot-character:// の URL⇔パス変換）、
// 後半の createCharacterRepository が I/O（fs/promises とルートディレクトリを注入）。notifiedStore.js と同じく、
// 一時ディレクトリで実ファイルを使ってユニットテストできるようにしてある。
//
// 保存先：<rootDir>/<characterId>/manifest.json と <rootDir>/<characterId>/<slotFolderName>/000.png…
// 取り込みは <rootDir>/.importing-<id>/ に書いてから rename する（途中で失敗・中断しても一覧に中途半端なものが出ない）。
// 編集（v5.9）：フォルダを変えない編集は manifest.json の置き換えだけ。フォルダを差し替える編集は .importing-<id>/ で組み直し、
// 旧フォルダを .removing-<id>/ へ退避してから入れ替える（途中で失敗しても元のキャラクターは残る）。
// 既定キャラクターの声とキャラクター設定は <rootDir>/default-profile.json（6.2）。
// セリフ（lines。F-22・Phase 13）は manifest.json・default-profile.json に持つ。無い古いファイルも読め、壊れた行だけを捨てる。

import path from 'node:path';
import { describeLinesError, emptyLines, isLinesError, parseLines } from './characterLines.js';
import { parseDefaultProfile, parsePersona, parseVoice, validateCharacterProfile } from './characterProfile.js';

export const MANIFEST_VERSION = 1;
/** EmoteLab の書き出しキャンバス（2.6。自動リサイズはしない） */
export const CANVAS_SIZE = 400;
export const SOURCE_EMOTELAB = 'EmoteLab';
/** 組み込みの既定キャラクター（黄色い丸）の ID。取り込んだキャラクターには使えない */
export const DEFAULT_CHARACTER_ID = 'default';
/** 組み込みの既定キャラクター（黄色い丸）の名前（v5.19。ユーザーが決めた）。変えられない。チャットとセリフの生成でもこの名前で紹介する */
export const DEFAULT_CHARACTER_NAME = 'メイト';
/**
 * 同梱キャラクター（F-23・Phase 15）の ID（一覧の並び順）。画像・セリフ・固定ボイスはアプリの中の assets/characters/<id>/ にある（bundledCharacters.js）。
 * 取り込んだキャラクターには使えない（bundled- で始まる ID はすべて予約）
 */
export const BUNDLED_CHARACTER_IDS = Object.freeze(['bundled-boy', 'bundled-girl']);
const BUNDLED_PREFIX = 'bundled-';
export const isBundledCharacterId = (id) => BUNDLED_CHARACTER_IDS.includes(id);

export const SLOT_NAMES = Object.freeze(['rest', 'notify', 'notify.calendar', 'notify.tasks', 'notify.gmail']);
export const REQUIRED_SLOTS = Object.freeze(['rest', 'notify']);

export const FPS_DEFAULT = 60;
export const FPS_MIN = 1;
export const FPS_MAX = 60;
export const DISPLAY_NAME_MAX = 40;
/** 3桁連番（000〜999）の上限 */
export const MAX_FRAMES = 1000;

/** PNG のシグネチャ（8）＋ IHDR チャンク（長さ4・型4・データ13）。色タイプ（オフセット25）まで読めればよい */
export const PNG_HEADER_BYTES = 29;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_RGBA = 6;

export const PROTOCOL_SCHEME = 'mascot-character';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRAME_RE = /^(\d{3})\.png$/i;
const SAVED_FRAME_RE = /^\d{3}\.png$/;
const IMPORTING_PREFIX = '.importing-';
const REMOVING_PREFIX = '.removing-';
const MANIFEST_FILE = 'manifest.json';
const DEFAULT_PROFILE_FILE = 'default-profile.json';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/** 取り込んだキャラクターの ID として使えるか（パスに使うため英小文字・数字・ハイフンのみ。default と bundled- で始まるものは予約） */
export function isValidCharacterId(id) {
  return typeof id === 'string' && ID_RE.test(id) && id !== DEFAULT_CHARACTER_ID && !id.startsWith(BUNDLED_PREFIX);
}

/** スロットのフォルダ名（'notify-calendar' など）として正しいか */
export const isSlotFolderName = (folder) => SLOT_FOLDERS.has(folder);

/** スロット名 → キャラクターフォルダ内の保存先の名前（'notify.calendar' → 'notify-calendar'） */
export function slotFolderName(slot) {
  return slot.replace(/\./g, '-');
}

const SLOT_FOLDERS = new Set(SLOT_NAMES.map(slotFolderName));

/** フレーム番号 → 保存するファイル名（3桁ゼロ埋め） */
export function frameFileName(index) {
  return `${String(index).padStart(3, '0')}.png`;
}

/**
 * PNG の先頭（シグネチャ＋IHDR）から寸法と色形式を読む。PNG でなければ null。
 * @param {Buffer | Uint8Array} buf 先頭 PNG_HEADER_BYTES バイト以上
 * @returns {{ width: number, height: number, bitDepth: number, colorType: number } | null}
 */
export function readPngHeader(buf) {
  if (!buf || buf.length < PNG_HEADER_BYTES) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    bitDepth: b[24],
    colorType: b[25],
  };
}

/**
 * フォルダ内のファイル名から、3桁連番のフレームを番号順に並べて返す。
 * 連番名でないファイル（Thumbs.db・desktop.ini など）は無視する。000 から欠番なく続いていなければエラー。
 * @param {string[]} fileNames
 * @returns {{ ok: true, frames: string[] } | { ok: false, error: { code: string, file?: string } }}
 */
export function frameFileNames(fileNames) {
  const byIndex = new Map();
  for (const name of fileNames) {
    const m = FRAME_RE.exec(name);
    if (!m) continue;
    const index = Number(m[1]);
    // 000.png と 000.PNG のような重複（大文字小文字違い）は、どちらを使うべきか決められない
    if (byIndex.has(index)) return { ok: false, error: { code: 'duplicate_frame', file: name } };
    byIndex.set(index, name);
  }
  if (byIndex.size === 0) return { ok: false, error: { code: 'empty' } };
  const frames = [];
  for (let i = 0; i < byIndex.size; i++) {
    if (!byIndex.has(i)) return { ok: false, error: { code: 'missing_frame', file: frameFileName(i) } };
    frames.push(byIndex.get(i));
  }
  return { ok: true, frames };
}

/**
 * 各フレームの PNG ヘッダーを検証する（キャンバスサイズ・RGBA）。
 * @param {string[]} frames frameFileNames の結果（番号順）
 * @param {Array<ReturnType<typeof readPngHeader>>} headers frames と同じ順
 * @param {{ canvasSize?: number }} [opts]
 * @returns {{ ok: true, frameCount: number } | { ok: false, error: { code: string, file: string, detail?: string } }}
 */
export function checkFrameHeaders(frames, headers, { canvasSize = CANVAS_SIZE } = {}) {
  for (let i = 0; i < frames.length; i++) {
    const h = headers[i];
    const file = frames[i];
    if (!h) return { ok: false, error: { code: 'invalid_png', file } };
    if (h.width !== canvasSize || h.height !== canvasSize) {
      return { ok: false, error: { code: 'size_mismatch', file, detail: `${h.width}×${h.height}` } };
    }
    if (h.colorType !== PNG_COLOR_RGBA || (h.bitDepth !== 8 && h.bitDepth !== 16)) {
      return { ok: false, error: { code: 'not_rgba', file } };
    }
  }
  return { ok: true, frameCount: frames.length };
}

/**
 * fps の入力値を検証する。未入力（undefined / null / ''）は既定の 30。
 * @returns {{ ok: true, value: number } | { ok: false, error: { code: 'invalid_fps' } }}
 */
export function validateFps(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: FPS_DEFAULT };
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(n) || n < FPS_MIN || n > FPS_MAX) return { ok: false, error: { code: 'invalid_fps' } };
  return { ok: true, value: n };
}

/**
 * キャラクター名（表示名）を検証する。前後の空白を除いて 1〜40 文字。
 * @returns {{ ok: true, value: string } | { ok: false, error: { code: 'invalid_name' } }}
 */
export function validateDisplayName(value) {
  if (typeof value !== 'string') return { ok: false, error: { code: 'invalid_name' } };
  const v = value.trim();
  const length = [...v].length;
  // 改行・制御文字は表示を崩すので受け付けない
  // eslint-disable-next-line no-control-regex
  if (length === 0 || length > DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/.test(v)) {
    return { ok: false, error: { code: 'invalid_name' } };
  }
  return { ok: true, value: v };
}

/**
 * 割り当てるスロットの組を検証する（rest・notify は必須、未知のスロットは拒否）。
 * @param {string[]} slots
 * @returns {{ ok: true } | { ok: false, error: { code: string, slot: string } }}
 */
export function validateSlotSelection(slots) {
  for (const s of slots) {
    if (!SLOT_NAMES.includes(s)) return { ok: false, error: { code: 'unknown_slot', slot: String(s) } };
  }
  for (const s of REQUIRED_SLOTS) {
    if (!slots.includes(s)) return { ok: false, error: { code: 'missing_required_slot', slot: s } };
  }
  return { ok: true };
}

/**
 * manifest.json の内容を組み立てる（6.2）。未割り当ての任意スロットは null。
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.displayName
 * @param {number} [opts.canvasSize]
 * @param {string} opts.importedAt ISO 8601
 * @param {string} [opts.updatedAt] ISO 8601（既定は importedAt）
 * @param {Record<string, { frameCount: number, fps: number }>} opts.slots
 * @param {{ speakerId: number, speedScale: number, pitchScale: number } | null} [opts.voice]
 * @param {string} [opts.persona]
 * @param {ReturnType<typeof emptyLines>} [opts.lines] セリフ（validateLines 済み。既定は空＝今の固定文）
 */
export function buildManifest({
  id,
  displayName,
  canvasSize = CANVAS_SIZE,
  importedAt,
  updatedAt = importedAt,
  slots,
  voice = null,
  persona = '',
  lines = emptyLines(),
}) {
  const out = {};
  for (const s of SLOT_NAMES) {
    const v = slots[s];
    out[s] = v ? { folder: slotFolderName(s), frameCount: v.frameCount, fps: v.fps } : null;
  }
  return {
    version: MANIFEST_VERSION,
    id,
    displayName,
    canvasSize,
    source: SOURCE_EMOTELAB,
    importedAt,
    updatedAt,
    voice,
    persona,
    lines,
    slots: out,
  };
}

function parseSlot(slot, raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.folder !== slotFolderName(slot)) return null;
  if (!isPositiveInt(raw.frameCount) || raw.frameCount > MAX_FRAMES) return null;
  if (!Number.isInteger(raw.fps) || raw.fps < FPS_MIN || raw.fps > FPS_MAX) return null;
  return { folder: raw.folder, frameCount: raw.frameCount, fps: raw.fps };
}

/**
 * 保存済みの manifest.json（パース済みの値）を検証・正規化する。壊れていれば null（一覧から除外する）。
 * @param {unknown} raw
 * @param {string} [expectedId] キャラクターフォルダの名前。manifest の id と一致しなければ null
 */
export function parseManifest(raw, expectedId) {
  if (!isPlainObject(raw) || raw.version !== MANIFEST_VERSION) return null;
  if (!isValidCharacterId(raw.id)) return null;
  if (expectedId !== undefined && raw.id !== expectedId) return null;
  const name = validateDisplayName(raw.displayName);
  if (!name.ok) return null;
  if (!isPositiveInt(raw.canvasSize) || raw.canvasSize > 2000) return null;
  if (!isPlainObject(raw.slots)) return null;
  const slots = {};
  for (const s of SLOT_NAMES) {
    const v = raw.slots[s];
    if (v === null || v === undefined) {
      if (REQUIRED_SLOTS.includes(s)) return null;
      slots[s] = null;
      continue;
    }
    const parsed = parseSlot(s, v);
    if (!parsed) return null;
    slots[s] = parsed;
  }
  return {
    version: MANIFEST_VERSION,
    id: raw.id,
    displayName: name.value,
    canvasSize: raw.canvasSize,
    source: typeof raw.source === 'string' ? raw.source : SOURCE_EMOTELAB,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : '',
    // 編集で加わった項目（v5.9）。無い・壊れていても一覧からは外さず、未設定として扱う
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : typeof raw.importedAt === 'string' ? raw.importedAt : '',
    voice: parseVoice(raw.voice),
    persona: parsePersona(raw.persona),
    // セリフ（Phase 13）。無い古い manifest も読め、壊れた行だけを捨てる（キャラクター自体は一覧から外さない）
    lines: parseLines(raw.lines),
    slots,
  };
}

/**
 * レンダラーが読むフレーム画像の URL（mascot-character://<id>/<folder>/<NNN>.png）。
 * revision（manifest の updatedAt）を付けると ?v=… が付き、編集で画像が差し替わったときに古い画像がキャッシュから出ない。
 */
export function characterFrameUrl(id, folder, index, revision) {
  const base = `${PROTOCOL_SCHEME}://${id}/${folder}/${frameFileName(index)}`;
  return revision ? `${base}?v=${encodeURIComponent(revision)}` : base;
}

/** URL の検索部は、キャッシュよけの v だけを許す（値はパスに使わない） */
function isAllowedSearch(search) {
  if (search === '') return true;
  const params = new URLSearchParams(search);
  return [...params.keys()].every((k) => k === 'v') && params.getAll('v').length === 1;
}

/**
 * mascot-character:// の URL を、rootDir 配下の実ファイルのパスへ変換する。
 * ID・フォルダ名・ファイル名をすべて許可リスト／正規表現で検証するので、rootDir の外（..・絶対パス・別名）は指せない。
 * 同梱キャラクター（BUNDLED_CHARACTER_IDS）は bundledDir（アプリの中の assets/characters）の下を指す。bundledDir が無ければ不正。
 * @param {string} url
 * @param {string} rootDir userData/characters
 * @param {string} [bundledDir] assets/characters
 * @returns {string | null} 不正なら null
 */
export function resolveCharacterUrl(url, rootDir, bundledDir) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${PROTOCOL_SCHEME}:` || u.username || u.password || u.port || !isAllowedSearch(u.search) || u.hash) return null;
  const id = u.hostname;
  const bundled = isBundledCharacterId(id);
  if (bundled ? !bundledDir : !isValidCharacterId(id)) return null;
  const parts = u.pathname.split('/');
  // '' / folder / file の3要素だけを許す
  if (parts.length !== 3 || parts[0] !== '') return null;
  const [, folder, file] = parts;
  if (!SLOT_FOLDERS.has(folder) || !SAVED_FRAME_RE.test(file)) return null;
  return path.join(bundled ? bundledDir : rootDir, id, folder, file);
}

const ERROR_MESSAGES = {
  empty: '000.png から始まる3桁連番のPNGが見つかりません',
  missing_frame: '連番が欠けています',
  duplicate_frame: '同じ番号のファイルが重複しています',
  invalid_png: 'PNGとして読み込めないファイルがあります',
  size_mismatch: `キャンバスサイズが ${CANVAS_SIZE}×${CANVAS_SIZE}px ではありません`,
  not_rgba: 'RGBA（透過）PNGではありません',
  unreadable: 'フォルダを読み込めませんでした',
  invalid_fps: `fps は ${FPS_MIN}〜${FPS_MAX} の整数で入力してください`,
  invalid_name: `キャラクター名は1〜${DISPLAY_NAME_MAX}文字で入力してください`,
  missing_required_slot: '必須のモーションが設定されていません',
  unknown_slot: '不明なモーションです',
  invalid_voice: '声の設定が正しくありません',
  invalid_persona: 'キャラクター設定は1000文字以内で入力してください',
  not_found: 'キャラクターが見つかりません',
  write_failed: '取り込み先への保存に失敗しました',
};

/**
 * エラー（コード＋ファイル名など）を画面に出す文にする。
 * @param {{ code: string, file?: string, detail?: string, slot?: string }} error
 */
export function describeImportError(error) {
  if (isLinesError(error)) return describeLinesError(error);
  const base = ERROR_MESSAGES[error?.code] ?? '取り込みに失敗しました';
  const extras = [];
  if (error?.slot) extras.push(error.slot);
  if (error?.file) extras.push(error.file);
  if (error?.detail) extras.push(error.detail);
  return extras.length > 0 ? `${base}（${extras.join('・')}）` : base;
}

// ---------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------

class ImportError extends Error {
  constructor(error) {
    super(error.code);
    this.importError = error;
  }
}

const randomHex8 = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');

/**
 * 取り込んだキャラクターの保存・一覧・削除（userData/characters）。
 * @param {object} opts
 * @param {string} opts.rootDir userData/characters
 * @param {typeof import('node:fs/promises')} opts.fs
 * @param {() => string} [opts.randomId] ID の乱数部（8桁の16進）
 * @param {() => Date} [opts.now]
 * @param {{ info?: Function, warn?: Function }} [opts.log]
 */
export function createCharacterRepository({ rootDir, fs, randomId = randomHex8, now = () => new Date(), log = {} }) {
  const warn = (msg) => log.warn?.(msg);

  async function readHeader(filePath) {
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(PNG_HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, PNG_HEADER_BYTES, 0);
      return readPngHeader(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  }

  /**
   * ImageSequence フォルダを検証する（作成画面でフォルダを選んだ直後・取り込みの直前）。
   * @param {string} dir
   * @returns {Promise<{ ok: true, frameCount: number, frames: string[] } | { ok: false, error: object }>}
   */
  async function inspectFolder(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { ok: false, error: { code: 'unreadable' } };
    }
    const listed = frameFileNames(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (!listed.ok) return listed;
    const headers = [];
    for (const name of listed.frames) {
      try {
        headers.push(await readHeader(path.join(dir, name)));
      } catch {
        headers.push(null);
      }
    }
    const checked = checkFrameHeaders(listed.frames, headers);
    if (!checked.ok) return checked;
    return { ok: true, frameCount: checked.frameCount, frames: listed.frames };
  }

  async function exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async function newId() {
    for (let i = 0; i < 5; i++) {
      const id = `emotelab-${randomId()}`;
      if (isValidCharacterId(id) && !(await exists(path.join(rootDir, id)))) return id;
    }
    throw new ImportError({ code: 'write_failed' });
  }

  /** 一時ファイルへ書いてから rename する（書き込み途中の中断でファイルを壊さない） */
  async function writeJsonAtomic(filePath, value) {
    const tmp = `${filePath}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, filePath);
  }

  /** フォルダの連番を検証して、dest に 000.png… としてコピーする。検証に失敗したら ImportError */
  async function copySequence(srcDir, dest, slot) {
    const inspected = await inspectFolder(srcDir);
    if (!inspected.ok) throw new ImportError({ ...inspected.error, slot });
    await fs.mkdir(dest);
    for (let i = 0; i < inspected.frames.length; i++) {
      await fs.copyFile(path.join(srcDir, inspected.frames[i]), path.join(dest, frameFileName(i)));
    }
    return inspected.frameCount;
  }

  /** 声・キャラクター設定・セリフの入力を検証する */
  const validateProfile = validateCharacterProfile;

  async function readManifest(id) {
    try {
      const text = await fs.readFile(path.join(rootDir, id, MANIFEST_FILE), 'utf8');
      return parseManifest(JSON.parse(text), id);
    } catch {
      return null;
    }
  }

  return {
    inspectFolder,

    /**
     * キャラクターを取り込む。全スロットを再検証してから一時フォルダへコピーし、manifest を最後に書いて rename する。
     * @param {object} req
     * @param {string} req.displayName
     * @param {Record<string, { dir: string, fps?: number }>} req.slots 割り当てたスロットだけ
     * @param {object | null} [req.voice] 声（未設定は null）
     * @param {string} [req.persona] キャラクター設定
     * @param {object | null} [req.lines] セリフ（characterLines.validateLines の入力。未設定は null）
     * @returns {Promise<{ ok: true, manifest: object } | { ok: false, error: object }>}
     */
    async importCharacter({ displayName, slots, voice = null, persona = '', lines = null }) {
      const name = validateDisplayName(displayName);
      if (!name.ok) return name;
      const profile = validateProfile({ voice, persona, lines });
      if (!profile.ok) return profile;
      const slotNames = Object.keys(slots ?? {});
      const selection = validateSlotSelection(slotNames);
      if (!selection.ok) return selection;
      const fpsBySlot = {};
      for (const s of slotNames) {
        const fps = validateFps(slots[s].fps);
        if (!fps.ok) return { ok: false, error: { ...fps.error, slot: s } };
        fpsBySlot[s] = fps.value;
      }

      let tmp = null;
      try {
        const id = await newId();
        tmp = path.join(rootDir, `${IMPORTING_PREFIX}${id}`);
        await fs.mkdir(tmp, { recursive: true });
        const manifestSlots = {};
        for (const s of SLOT_NAMES) {
          if (!slots[s]) continue;
          const frameCount = await copySequence(slots[s].dir, path.join(tmp, slotFolderName(s)), s);
          manifestSlots[s] = { frameCount, fps: fpsBySlot[s] };
        }
        const manifest = buildManifest({
          id,
          displayName: name.value,
          importedAt: now().toISOString(),
          slots: manifestSlots,
          voice: profile.voice,
          persona: profile.persona,
          lines: profile.lines,
        });
        await fs.writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
        await fs.rename(tmp, path.join(rootDir, id));
        tmp = null;
        log.info?.(`[character] 取り込み: ${id}（${slotNames.join(', ')}）`);
        return { ok: true, manifest };
      } catch (e) {
        if (!(e instanceof ImportError)) warn(`[character] 取り込みに失敗: ${e?.message ?? e}`);
        return { ok: false, error: e instanceof ImportError ? e.importError : { code: 'write_failed' } };
      } finally {
        if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    },

    /**
     * 取り込み済みキャラクターを編集する（v5.9）。
     * slots の各値：{ keep: true, fps? } … 今の画像のまま（fps だけ変えられる）／{ dir, fps? } … フォルダを差し替える／
     *              null・未指定 … 任意スロットを解除する（rest・notify は解除できない）
     * @param {string} id
     * @param {object} req
     * @param {string} req.displayName
     * @param {Record<string, { keep: true, fps?: number } | { dir: string, fps?: number } | null>} req.slots
     * @param {object | null} [req.voice]
     * @param {string} [req.persona]
     * @param {object | null} [req.lines] セリフ（未設定は null）
     * @returns {Promise<{ ok: true, manifest: object } | { ok: false, error: object }>}
     */
    async updateCharacter(id, { displayName, slots, voice = null, persona = '', lines = null }) {
      const current = isValidCharacterId(id) ? await readManifest(id) : null;
      if (!current) return { ok: false, error: { code: 'not_found' } };
      const name = validateDisplayName(displayName);
      if (!name.ok) return name;
      const profile = validateProfile({ voice, persona, lines });
      if (!profile.ok) return profile;

      /** スロット → { mode: 'keep' | 'replace', dir?, fps } */
      const plan = {};
      for (const s of SLOT_NAMES) {
        const v = slots?.[s];
        if (!v) continue;
        if (v.keep === true) {
          if (!current.slots[s]) return { ok: false, error: { code: 'missing_required_slot', slot: s } };
          const fps = validateFps(v.fps ?? current.slots[s].fps);
          if (!fps.ok) return { ok: false, error: { ...fps.error, slot: s } };
          plan[s] = { mode: 'keep', fps: fps.value };
        } else if (typeof v.dir === 'string') {
          const fps = validateFps(v.fps);
          if (!fps.ok) return { ok: false, error: { ...fps.error, slot: s } };
          plan[s] = { mode: 'replace', dir: v.dir, fps: fps.value };
        } else {
          return { ok: false, error: { code: 'unknown_slot', slot: s } };
        }
      }
      const selection = validateSlotSelection(Object.keys(plan));
      if (!selection.ok) return selection;

      const charDir = path.join(rootDir, id);
      const manifestSlots = {};
      const base = {
        id,
        displayName: name.value,
        canvasSize: current.canvasSize,
        importedAt: current.importedAt,
        updatedAt: now().toISOString(),
        voice: profile.voice,
        persona: profile.persona,
        lines: profile.lines,
      };

      // フォルダを差し替えない：manifest の置き換えだけ（解除したスロットの画像は置き換えの後で消す）
      if (!Object.values(plan).some((p) => p.mode === 'replace')) {
        for (const [s, p] of Object.entries(plan)) manifestSlots[s] = { frameCount: current.slots[s].frameCount, fps: p.fps };
        const manifest = buildManifest({ ...base, slots: manifestSlots });
        try {
          await writeJsonAtomic(path.join(charDir, MANIFEST_FILE), manifest);
        } catch (e) {
          warn(`[character] 編集の保存に失敗: ${e?.message ?? e}`);
          return { ok: false, error: { code: 'write_failed' } };
        }
        for (const s of SLOT_NAMES) {
          if (current.slots[s] && !plan[s]) {
            await fs.rm(path.join(charDir, current.slots[s].folder), { recursive: true, force: true }).catch(() => {});
          }
        }
        log.info?.(`[character] 編集: ${id}`);
        return { ok: true, manifest };
      }

      // フォルダを差し替える：別フォルダで組み直してから入れ替える
      const tmp = path.join(rootDir, `${IMPORTING_PREFIX}${id}`);
      const removing = path.join(rootDir, `${REMOVING_PREFIX}${id}`);
      let moved = false;
      try {
        await fs.rm(tmp, { recursive: true, force: true });
        await fs.mkdir(tmp, { recursive: true });
        for (const [s, p] of Object.entries(plan)) {
          const dest = path.join(tmp, slotFolderName(s));
          let frameCount;
          if (p.mode === 'replace') {
            frameCount = await copySequence(p.dir, dest, s);
          } else {
            frameCount = current.slots[s].frameCount;
            await fs.mkdir(dest);
            for (let i = 0; i < frameCount; i++) {
              await fs.copyFile(path.join(charDir, current.slots[s].folder, frameFileName(i)), path.join(dest, frameFileName(i)));
            }
          }
          manifestSlots[s] = { frameCount, fps: p.fps };
        }
        const manifest = buildManifest({ ...base, slots: manifestSlots });
        await fs.writeFile(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
        await fs.rename(charDir, removing);
        moved = true;
        await fs.rename(tmp, charDir);
        moved = false;
        await fs.rm(removing, { recursive: true, force: true }).catch(() => {});
        log.info?.(`[character] 編集（画像を差し替え）: ${id}`);
        return { ok: true, manifest };
      } catch (e) {
        if (moved) await fs.rename(removing, charDir).catch(() => {}); // 退避した元のキャラクターを戻す
        if (!(e instanceof ImportError)) warn(`[character] 編集に失敗: ${e?.message ?? e}`);
        return { ok: false, error: e instanceof ImportError ? e.importError : { code: 'write_failed' } };
      } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    },

    /** 既定キャラクターの声・キャラクター設定・セリフ（default-profile.json）。無い・壊れていれば未設定 */
    async getDefaultProfile() {
      try {
        return parseDefaultProfile(JSON.parse(await fs.readFile(path.join(rootDir, DEFAULT_PROFILE_FILE), 'utf8')));
      } catch {
        return parseDefaultProfile(null);
      }
    },

    /**
     * 既定キャラクターの声・キャラクター設定・セリフを保存する（画像・名前は変えられない）。
     * @returns {Promise<{ ok: true, profile: { voice: object | null, persona: string, lines: object } } | { ok: false, error: object }>}
     */
    async saveDefaultProfile({ voice = null, persona = '', lines = null }) {
      const profile = validateProfile({ voice, persona, lines });
      if (!profile.ok) return profile;
      const value = { voice: profile.voice, persona: profile.persona, lines: profile.lines };
      try {
        await writeJsonAtomic(path.join(rootDir, DEFAULT_PROFILE_FILE), value);
      } catch (e) {
        warn(`[character] 既定キャラクターの設定の保存に失敗: ${e?.message ?? e}`);
        return { ok: false, error: { code: 'write_failed' } };
      }
      return { ok: true, profile: value };
    },

    /** 読める manifest を持つキャラクターの一覧（取り込み順）。壊れたものは除外してログに出す */
    async list() {
      let entries;
      try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
      const out = [];
      for (const e of entries) {
        if (!e.isDirectory() || !isValidCharacterId(e.name)) continue;
        const manifest = await readManifest(e.name);
        if (manifest) out.push(manifest);
        else warn(`[character] manifest.json を読み込めないため一覧から除外: ${e.name}`);
      }
      return out.sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.id.localeCompare(b.id));
    },

    /** @returns {Promise<object | null>} */
    async get(id) {
      if (!isValidCharacterId(id)) return null;
      return readManifest(id);
    },

    /** @returns {Promise<{ ok: boolean, error?: object }>} */
    async remove(id) {
      if (!isValidCharacterId(id) || !(await exists(path.join(rootDir, id)))) {
        return { ok: false, error: { code: 'not_found' } };
      }
      await fs.rm(path.join(rootDir, id), { recursive: true, force: true });
      log.info?.(`[character] 削除: ${id}`);
      return { ok: true };
    },

    /**
     * 中断した取り込み・編集の残骸を片付ける（起動時）。.importing-* は消す。
     * .removing-<id> は、入れ替えの途中で止まって <id> が無ければ元に戻し、<id> があれば消す。
     */
    async cleanupPartial() {
      let entries;
      try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(rootDir, e.name);
        if (e.name.startsWith(IMPORTING_PREFIX)) {
          await fs.rm(p, { recursive: true, force: true }).catch(() => {});
        } else if (e.name.startsWith(REMOVING_PREFIX)) {
          const id = e.name.slice(REMOVING_PREFIX.length);
          if (isValidCharacterId(id) && !(await exists(path.join(rootDir, id)))) await fs.rename(p, path.join(rootDir, id)).catch(() => {});
          else await fs.rm(p, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}
