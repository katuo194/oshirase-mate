import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokenStorage } from '../src/main/tokenStorage.js';

// 平文が見えない・元に戻せる、という性質だけを持つ偽の safeStorage
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC1:${Buffer.from(s).reverse().toString('base64')}`),
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith('ENC1:')) throw new Error('bad ciphertext');
      return Buffer.from(Buffer.from(t.slice(5), 'base64').reverse()).toString();
    },
  };
}

let dir;
let filePath;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenstore-'));
  filePath = path.join(dir, 'tokens.enc');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const creds = { refresh_token: 'RT-secret-value', scope: 'a b c', token_type: 'Bearer' };

describe('tokenStorage', () => {
  it('保存 → 読み出しで往復できる', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(creds);
    expect(await s.load()).toEqual(creds);
  });

  it('ファイルにリフレッシュトークンが平文で含まれない', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(creds);
    const raw = (await fs.readFile(filePath)).toString('latin1');
    expect(raw).not.toContain('RT-secret-value');
    expect(raw).not.toContain('refresh_token');
  });

  it('保存形式は googleapis の setCredentials にそのまま渡せる snake_case のフィールド名（アクセストークンは保存しない）', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save({ ...creds, access_token: 'AT-must-not-persist', expiry_date: 123 });
    const loaded = await s.load();
    expect(Object.keys(loaded).sort()).toEqual(['refresh_token', 'scope', 'token_type']);
  });

  it('同意した時刻（linked_at。Phase 16）も保存して読み戻せる。数でなければ保存しない', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save({ ...creds, linked_at: 1_700_000_000_000 });
    expect(await s.load()).toEqual({ ...creds, linked_at: 1_700_000_000_000 });
    await s.save({ ...creds, linked_at: 'yesterday' });
    expect(await s.load()).toEqual(creds);
  });

  it('無い場合は null', async () => {
    expect(await createTokenStorage({ filePath, safeStorage: fakeSafeStorage() }).load()).toBeNull();
  });

  it('暗号化できない環境では平文フォールバックせず、保存を拒否する', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
    await expect(s.save(creds)).rejects.toThrow();
    await expect(fs.access(filePath)).rejects.toThrow(); // ファイルが作られていない
  });

  it('refresh_token が無い認証情報は保存しない', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await expect(s.save({ scope: 'x' })).rejects.toThrow();
  });

  it('壊れたファイルは null を返し、削除せずに .broken-<日時> へ退避してログに出す（v5.12）', async () => {
    await fs.writeFile(filePath, 'not encrypted garbage');
    const warns = [];
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage(), log: { warn: (m) => warns.push(m) } });
    expect(await s.load()).toBeNull();
    await expect(fs.access(filePath)).rejects.toThrow();
    const kept = (await fs.readdir(dir)).filter((n) => n.startsWith('tokens.enc.broken-'));
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(dir, kept[0]), 'utf8')).toBe('not encrypted garbage');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('tokens.enc');
    expect(warns[0]).toContain('decrypt: bad ciphertext');
    expect(await s.load()).toBeNull(); // 次からは未連携扱い
  });

  it('復号できても中身が不正なら退避し、ログに中身を出さない', async () => {
    const warns = [];
    const safeStorage = fakeSafeStorage();
    await fs.writeFile(filePath, safeStorage.encryptString('{"refresh_token":""} RT-secret-value'));
    const s = createTokenStorage({ filePath, safeStorage, log: { warn: (m) => warns.push(m) } });
    expect(await s.load()).toBeNull();
    expect(warns[0]).toContain('（parse）');
    expect(warns.join(' ')).not.toContain('RT-secret-value');
  });

  it('暗号化基盤が一時的に使えないときはファイルを消さない', async () => {
    await createTokenStorage({ filePath, safeStorage: fakeSafeStorage() }).save(creds);
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
    expect(await s.load()).toBeNull();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('remove はファイルが無くても成功する', async () => {
    const s = createTokenStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(creds);
    await s.remove();
    await s.remove();
    expect(await s.load()).toBeNull();
  });
});
