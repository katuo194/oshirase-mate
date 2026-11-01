// tokens.enc の読み書き（2.3 / 4章）。Electron の safeStorage とファイルパスは注入するので、Vitest から直接テストできる。
//
// 保存するフィールド名は google-auth-library の Credentials（snake_case）と同一にしてある。
// Phase 3/4 では load() の結果をそのまま googleapis の OAuth2Client.setCredentials() に渡せる：
//   oauth2Client.setCredentials(await tokenStorage.load());
// アクセストークンは短命なので保存しない（refresh_token だけあれば OAuth2Client が自動で取得する）。

import fs from 'node:fs/promises';
import { UnreadableContentError, decryptOrThrow, parseJsonOrThrow, quarantineUnreadable } from './unreadableFile.js';

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';

/**
 * linked_at（Phase 16）は同意した時刻（ミリ秒）。自分で作ったクライアント（テストモード）の連携が 7 日で切れるのを予告するために使う。
 * それより前に保存したファイルには無い（load の結果にも付かない）。
 * @typedef {{ refresh_token: string, scope: string, token_type: string, linked_at?: number }} StoredCredentials
 * @param {object} opts
 * @param {string} opts.filePath tokens.enc のパス（userData 配下）
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} opts.safeStorage
 * @param {{ warn: (msg: string) => void }} [opts.log] 読めないファイルを退避したときの警告（unreadableFile.js）
 */
export function createTokenStorage({ filePath, safeStorage, log = { warn: () => {} } }) {
  const remove = async () => {
    await fs.rm(filePath, { force: true });
  };

  return {
    /**
     * 暗号化して保存する。暗号化できない環境では平文にフォールバックせず throw する。
     * @param {Partial<StoredCredentials> & { refresh_token: string }} credentials
     */
    async save(credentials) {
      if (!isNonEmptyString(credentials?.refresh_token)) throw new Error('refresh_token is required');
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      /** @type {StoredCredentials} */
      const stored = {
        refresh_token: credentials.refresh_token,
        scope: typeof credentials.scope === 'string' ? credentials.scope : '',
        token_type: isNonEmptyString(credentials.token_type) ? credentials.token_type : 'Bearer',
        ...(Number.isFinite(credentials.linked_at) ? { linked_at: credentials.linked_at } : {}),
      };
      const encrypted = safeStorage.encryptString(JSON.stringify(stored));
      // 書き込み途中の中断でトークンを壊さないよう、一時ファイル経由で置き換える
      const tmp = `${filePath}.tmp`;
      await fs.writeFile(tmp, encrypted);
      await fs.rename(tmp, filePath);
    },

    /**
     * @returns {Promise<StoredCredentials | null>} 無い・読めない・壊れている場合は null（壊れたファイルは削除せず .broken-<日時> へ退避する）
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
        if (!isNonEmptyString(parsed?.refresh_token)) throw new UnreadableContentError('invalid');
        return {
          refresh_token: parsed.refresh_token,
          scope: typeof parsed.scope === 'string' ? parsed.scope : '',
          token_type: isNonEmptyString(parsed.token_type) ? parsed.token_type : 'Bearer',
          ...(Number.isFinite(parsed.linked_at) ? { linked_at: parsed.linked_at } : {}),
        };
      } catch (error) {
        await quarantineUnreadable({ filePath, error, log });
        return null;
      }
    },

    remove,
  };
}
