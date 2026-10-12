// 共有版で利用者が入力した OAuth Client ID/Secret（2.4・v5.11）の暗号化保存。apiKeyStorage.js と同じ設計：
// safeStorage とファイルパスは注入（Vitest から直接テストできる）。暗号化できない環境では平文にフォールバックせず throw する。
// 保存先は userData/oauth-client.enc（.gitignore の *.enc で除外済み）。Secret はレンダラーへ一切渡さない。

import fs from 'node:fs/promises';
import { validateOAuthClient } from './authCore.js';
import { UnreadableContentError, decryptOrThrow, parseJsonOrThrow, quarantineUnreadable } from './unreadableFile.js';

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
     * @param {{ clientId: string, clientSecret: string }} client
     */
    async save(client) {
      const v = validateOAuthClient(client);
      if (!v.ok) throw new Error(`invalid oauth client: ${v.reason}`);
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const encrypted = safeStorage.encryptString(JSON.stringify({ clientId: v.clientId, clientSecret: v.clientSecret }));
      // 書き込み途中の中断で壊さないよう、一時ファイル経由で置き換える
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, encrypted);
      await fs.rename(tmp, filePath);
    },

    /** @returns {Promise<{ clientId: string, clientSecret: string } | null>} 無い・読めない・壊れている場合は null（壊れたファイルは削除せず .broken-<日時> へ退避する） */
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
        const v = validateOAuthClient(parseJsonOrThrow(decryptOrThrow(safeStorage, encrypted)));
        if (!v.ok) throw new UnreadableContentError('invalid');
        return { clientId: v.clientId, clientSecret: v.clientSecret };
      } catch (error) {
        await quarantineUnreadable({ filePath, error, log });
        return null;
      }
    },

    remove,
  };
}
