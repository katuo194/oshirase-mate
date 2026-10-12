// 暗号化保存ファイル（tokens.enc / gemini-key.enc / oauth-client.enc）を読めなかったときの退避（v5.12）。
//
// 以前は復号できない・中身が不正なファイルを黙って削除していたが、実機で原因の分からないままトークンとキーが消えたため、
// 削除せずに <ファイル名>.broken-<日時> へ名前を変えて残し、どのファイルがなぜ読めなかったかをログに出す。
// 退避後は元の名前のファイルが無いので、次回からは「未設定」として扱われる（設定し直せば新しいファイルが作られる）。
// ログには理由の種類と safeStorage のエラーだけを出し、復号した中身（秘密情報）は出さない。

import fs from 'node:fs/promises';
import path from 'node:path';

/** 読めなかった理由。decrypt … 復号に失敗／parse … 復号できたが JSON でない／invalid … 形式が不正 */
export class UnreadableContentError extends Error {
  /** @param {'decrypt' | 'parse' | 'invalid'} stage @param {string} [detail] */
  constructor(stage, detail) {
    super(detail ? `${stage}: ${detail}` : stage);
    this.stage = stage;
  }
}

/**
 * safeStorage.decryptString を呼び、失敗を UnreadableContentError('decrypt') にする（エラーメッセージに中身は含まれない）。
 * @param {{ decryptString(b: Buffer): string }} safeStorage
 * @param {Buffer} encrypted
 */
export function decryptOrThrow(safeStorage, encrypted) {
  try {
    return safeStorage.decryptString(encrypted);
  } catch (e) {
    throw new UnreadableContentError('decrypt', e?.message ?? String(e));
  }
}

/**
 * JSON として読む。失敗時のメッセージには中身の一部が含まれ得るので捨てて、種類だけにする。
 * @param {string} text
 */
export function parseJsonOrThrow(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new UnreadableContentError('parse');
  }
}

/** 退避先の名前に付ける日時（ローカル時刻 YYYYMMDD-HHMMSS） */
function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/**
 * 読めなかったファイルを <filePath>.broken-<日時> へ退避し、ログに警告を出す。名前を変えられなくても削除はしない。
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {unknown} opts.error 読めなかった理由（UnreadableContentError 以外は種類 unknown として扱う）
 * @param {{ warn: (msg: string) => void }} opts.log
 * @param {() => Date} [opts.now]
 */
export async function quarantineUnreadable({ filePath, error, log, now = () => new Date() }) {
  const name = path.basename(filePath);
  const reason = error instanceof UnreadableContentError ? error.message : 'unknown';
  const base = `${filePath}.broken-${stamp(now())}`;
  let dest = base;
  try {
    // 同じ秒に退避したものを上書きしない（Windows の rename は既存のファイルを置き換える）
    for (let n = 2; await exists(dest); n++) dest = `${base}-${n}`;
    await fs.rename(filePath, dest);
    log.warn(`[storage] ${name} を読めないため ${path.basename(dest)} に退避しました（${reason}）`);
  } catch (e) {
    log.warn(`[storage] ${name} を読めません（${reason}）。退避にも失敗したためそのまま残します: ${e?.code ?? e?.message ?? e}`);
  }
}
