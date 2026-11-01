// 共有版で利用者が入力した OAuth Client ID/Secret（2.4・v5.11）の暗号化保存。apiKeyStorage.js と同じ設計：
// safeStorage とファイルパスは注入（Vitest から直接テストできる）。暗号化できない環境では平文にフォールバックせず throw する。
// 保存先は userData/oauth-client.enc（.gitignore の *.enc で除外済み）。Secret はレンダラーへ一切渡さない。
// Phase 16：クライアントをどの道で入れたか（origin）も一緒に置く。'received' … 開発者から受け取った（本番環境のプロジェクト）、
// 'self' … 自分で作った（テストモード。連携が 7 日で切れる）。それより前に保存したファイルには無い（null 扱い）。

import fs from 'node:fs/promises';
import { validateOAuthClient } from './authCore.js';
import { UnreadableContentError, decryptOrThrow, parseJsonOrThrow, quarantineUnreadable } from './unreadableFile.js';

/** クライアントをどの道で入れたか（Phase 16）。'received' … 受け取った、'self' … 自分で作った */
export const CLIENT_ORIGINS = Object.freeze(['received', 'self']);

/** @returns {value is 'received' | 'self'} */
export const isClientOrigin = (value) => CLIENT_ORIGINS.includes(value);

/**
 * @param {object} opts
 * @param {string} opts.filePath oauth-client.enc のパス（userData 配下）
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} opts.safeStorage
 * @param {{ warn: (msg: string) => void }} [opts.log] 読めないファイルを退避したときの警告（unreadableFile.js）
 */
export function createOAuthClientStorage({ filePath, safeStorage, log = { warn: () => {} } }) {
  const remove = async () => {
    await fs.rm(filePath, { force: true });
  };

  return {
    /**
     * 検証してから暗号化して保存する。暗号化できない環境では throw（平文保存しない）。
     * @param {{ clientId: string, clientSecret: string, origin?: 'received' | 'self' | null }} client origin は正しい値のときだけ保存する
     */
    async save(client) {
      const v = validateOAuthClient(client);
      if (!v.ok) throw new Error(`invalid oauth client: ${v.reason}`);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const origin = isClientOrigin(client?.origin) ? { origin: client.origin } : {};
      const encrypted = safeStorage.encryptString(JSON.stringify({ clientId: v.clientId, clientSecret: v.clientSecret, ...origin }));
      // 書き込み途中の中断で壊さないよう、一時ファイル経由で置き換える
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, encrypted);
      await fs.rename(tmp, filePath);
    },

    /**
     * @returns {Promise<{ clientId: string, clientSecret: string, origin?: 'received' | 'self' } | null>}
     *   無い・読めない・壊れている場合は null（壊れたファイルは削除せず .broken-<日時> へ退避する）。origin は保存してあるときだけ付く
     */
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
        const parsed = parseJsonOrThrow(decryptOrThrow(safeStorage, encrypted));
        const v = validateOAuthClient(parsed);
        if (!v.ok) throw new UnreadableContentError('invalid');
        return { clientId: v.clientId, clientSecret: v.clientSecret, ...(isClientOrigin(parsed?.origin) ? { origin: parsed.origin } : {}) };
      } catch (error) {
        await quarantineUnreadable({ filePath, error, log });
        return null;
      }
    },

    remove,
  };
}
