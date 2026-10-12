// Gemini APIキー（3.5 / 4章 セキュリティ）の暗号化保存。tokenStorage.js と同じ設計：
// safeStorage とファイルパスは注入（Vitest から直接テストできる）。暗号化できない環境では平文にフォールバックせず throw する。
// 保存先は userData/gemini-key.enc（.gitignore の *.enc で除外済み）。キーはレンダラーへ一切渡さない（状態＝設定済みかどうかのみ）。

import fs from 'node:fs/promises';
import { UnreadableContentError, decryptOrThrow, quarantineUnreadable } from './unreadableFile.js';

/** 想定される長さの範囲（Gemini の API キーは39文字前後）。明らかな誤入力だけを弾く。 */
export const API_KEY_MIN_LENGTH = 20;
export const API_KEY_MAX_LENGTH = 256;

/**
 * 入力されたキーの検証（純粋関数）。前後の空白は取り除く。空白・改行・非ASCIIを含むものは弾く。
 * @param {unknown} input
 * @returns {{ ok: true, key: string } | { ok: false, reason: 'empty' | 'too_short' | 'too_long' | 'invalid_chars' }}
 */
export function validateApiKey(input) {
  const key = typeof input === 'string' ? input.trim() : '';
  if (key === '') return { ok: false, reason: 'empty' };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: 'invalid_chars' };
  if (key.length < API_KEY_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (key.length > API_KEY_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, key };
}

/**
 * @param {object} opts
 * @param {string} opts.filePath gemini-key.enc のパス（userData 配下）
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} opts.safeStorage
 * @param {{ warn: (msg: string) => void }} [opts.log] 読めないファイルを退避したときの警告（unreadableFile.js）
 */
export function createApiKeyStorage({ filePath, safeStorage, log = { warn: () => {} } }) {
  const remove = async () => {
    await fs.rm(filePath, { force: true });
  };

  return {
    /** 暗号化して保存する。暗号化できない環境では throw（平文保存しない）。 */
    async save(key) {
      const v = validateApiKey(key);
      if (!v.ok) throw new Error(`invalid api key: ${v.reason}`);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const encrypted = safeStorage.encryptString(v.key);
      // 書き込み途中の中断でキーを壊さないよう、一時ファイル経由で置き換える
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, encrypted);
      await fs.rename(tmp, filePath);
    },

    /** @returns {Promise<string | null>} 無い・読めない・壊れている場合は null（壊れたファイルは削除せず .broken-<日時> へ退避する） */
    async load() {
      let encrypted;
      try {
        encrypted = await fs.readFile(filePath);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      // 暗号化基盤が使えない間はファイルに触らない（復号できないだけで、壊れているとは限らない）
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        const v = validateApiKey(decryptOrThrow(safeStorage, encrypted));
        if (!v.ok) throw new UnreadableContentError('invalid');
        return v.key;
      } catch (error) {
        await quarantineUnreadable({ filePath, error, log });
        return null;
      }
    },

    remove,
  };
}
