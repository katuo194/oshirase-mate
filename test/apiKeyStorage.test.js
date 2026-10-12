import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_MAX_LENGTH, API_KEY_MIN_LENGTH, createApiKeyStorage, validateApiKey } from '../src/main/apiKeyStorage.js';
import { createGeminiKey } from '../src/main/geminiKey.js';

// 平文が見えない・元に戻せる、という性質だけを持つ偽の safeStorage（tokenStorage.test.js と同じ）
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-key-'));
  filePath = path.join(dir, 'gemini-key.enc');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const KEY = 'AIzaSy-SECRET-VALUE-0123456789abcdef';

describe('apiKeyStorage / 入力の検証', () => {
  it('前後の空白は除き、正しい形式なら ok', () => {
    expect(validateApiKey(`  ${KEY}\n`)).toEqual({ ok: true, key: KEY });
  });

  it('空・短すぎる・長すぎる・使えない文字（空白・全角・改行）は拒否', () => {
    expect(validateApiKey('')).toEqual({ ok: false, reason: 'empty' });
    expect(validateApiKey('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateApiKey(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(validateApiKey('a'.repeat(API_KEY_MIN_LENGTH - 1))).toEqual({ ok: false, reason: 'too_short' });
    expect(validateApiKey('a'.repeat(API_KEY_MAX_LENGTH + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateApiKey('AIza with space 0123456789012345')).toEqual({ ok: false, reason: 'invalid_chars' });
    expect(validateApiKey('AIzaあいうえお0123456789012345678')).toEqual({ ok: false, reason: 'invalid_chars' });
    expect(validateApiKey('AIza\nSy0123456789012345678901')).toEqual({ ok: false, reason: 'invalid_chars' });
  });
});

describe('apiKeyStorage / 暗号化保存（tokenStorage と同形）', () => {
  it('保存 → 読み出しで往復できる', async () => {
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(KEY);
    expect(await s.load()).toBe(KEY);
  });

  it('ファイルにキーが平文で含まれない', async () => {
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(KEY);
    const raw = (await fs.readFile(filePath)).toString('latin1');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('SECRET-VALUE');
  });

  it('暗号化できない環境では平文にフォールバックせず throw（ファイルも作らない）', async () => {
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
    await expect(s.save(KEY)).rejects.toThrow('encryption unavailable');
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
  });

  it('不正な形式のキーは保存しない', async () => {
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() });
    await expect(s.save('short')).rejects.toThrow();
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('無ければ null。壊れたファイルは null を返し、削除せずに退避してログに出す（v5.12）', async () => {
    const warns = [];
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage(), log: { warn: (m) => warns.push(m) } });
    expect(await s.load()).toBeNull();
    expect(warns).toEqual([]);
    await fs.writeFile(filePath, 'not-encrypted');
    expect(await s.load()).toBeNull();
    await expect(fs.access(filePath)).rejects.toThrow();
    expect((await fs.readdir(dir)).filter((n) => /^gemini-key\.enc\.broken-\d{8}-\d{6}$/.test(n))).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('gemini-key.enc');
  });

  it('暗号化基盤が使えない間はファイルに触らない（復号できないだけで壊れているとは限らない）', async () => {
    await createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() }).save(KEY);
    const unavailable = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
    expect(await unavailable.load()).toBeNull();
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('remove で削除できる（無くても失敗しない）', async () => {
    const s = createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() });
    await s.save(KEY);
    await s.remove();
    expect(await s.load()).toBeNull();
    await expect(s.remove()).resolves.toBeUndefined();
  });
});

describe('geminiKey / 設定済みの状態とイベント（設定画面・「話しかける」の有効化）', () => {
  const make = (safeStorage = fakeSafeStorage()) => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const key = createGeminiKey({ storage: createApiKeyStorage({ filePath, safeStorage }), log });
    return { key, log };
  };

  it('起動時（init）に保存済みキーの有無を確認する。キー本体は状態に含まれない', async () => {
    await createApiKeyStorage({ filePath, safeStorage: fakeSafeStorage() }).save(KEY);
    const { key } = make();
    expect(key.isConfigured()).toBe(false);
    await key.init();
    expect(key.isConfigured()).toBe(true);
    expect(key.getState()).toEqual({ configured: true });
    expect(JSON.stringify(key.getState())).not.toContain(KEY);
  });

  it('保存すると設定済みになり change を発火、getKey で main だけが取り出せる', async () => {
    const { key } = make();
    const onChange = vi.fn();
    key.events.on('change', onChange);
    expect(await key.set(`  ${KEY} `)).toEqual({ ok: true });
    expect(onChange).toHaveBeenCalledWith({ configured: true });
    expect(await key.getKey()).toBe(KEY);
  });

  it('不正な入力は拒否理由を返し、状態を変えない', async () => {
    const { key } = make();
    expect(await key.set('')).toEqual({ ok: false, reason: 'empty' });
    expect(await key.set('x y z 0123456789012345678')).toEqual({ ok: false, reason: 'invalid_chars' });
    expect(key.isConfigured()).toBe(false);
  });

  it('暗号化できない環境では save_failed（未設定のまま）', async () => {
    const { key, log } = make(fakeSafeStorage({ available: false }));
    expect(await key.set(KEY)).toEqual({ ok: false, reason: 'save_failed' });
    expect(key.isConfigured()).toBe(false);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(KEY);
  });

  it('削除すると未設定に戻り change を発火する。ログにキーは出ない', async () => {
    const { key, log } = make();
    await key.set(KEY);
    const onChange = vi.fn();
    key.events.on('change', onChange);
    expect(await key.clear()).toEqual({ ok: true });
    expect(onChange).toHaveBeenCalledWith({ configured: false });
    expect(await key.getKey()).toBeNull();
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])).not.toContain(KEY);
  });

  it('同じ状態への更新では change を発火しない', async () => {
    const { key } = make();
    const onChange = vi.fn();
    key.events.on('change', onChange);
    await key.clear();
    expect(onChange).not.toHaveBeenCalled();
  });
});
