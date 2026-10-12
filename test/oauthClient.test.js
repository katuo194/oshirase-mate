import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/main/auth.js';
import { createOAuthClient } from '../src/main/oauthClient.js';
import { createOAuthClientStorage } from '../src/main/oauthClientStorage.js';
import { FIXTURE, createFakeGoogleOAuth } from '../mocks/google/oauth.js';

// 平文が見えない・元に戻せる、という性質だけを持つ偽の safeStorage（tokenStorage.test.js・apiKeyStorage.test.js と同じ）
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-client-'));
  filePath = path.join(dir, 'oauth-client.enc');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const CLIENT = { clientId: FIXTURE.clientId, clientSecret: FIXTURE.clientSecret };

describe('oauthClientStorage（oauth-client.enc の暗号化保存）', () => {
  it('暗号化して保存し、読み戻せる。ファイルに平文（ID・Secret）が残らない', async () => {
    const storage = createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage() });
    await storage.save({ clientId: ` ${CLIENT.clientId} `, clientSecret: CLIENT.clientSecret });
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw).not.toContain(CLIENT.clientSecret);
    expect(raw).not.toContain(CLIENT.clientId);
    expect(await storage.load()).toEqual(CLIENT);
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow(); // 一時ファイルは残らない
  });

  it('暗号化できない環境では平文にフォールバックせず throw し、ファイルも作らない', async () => {
    const storage = createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) });
    await expect(storage.save(CLIENT)).rejects.toThrow('encryption unavailable');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('不正な値は保存しない', async () => {
    const storage = createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage() });
    await expect(storage.save({ clientId: '', clientSecret: CLIENT.clientSecret })).rejects.toThrow('missing_client_id');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('無ければ null。壊れた・中身が不正なファイルは null にし、削除せずに退避してログに出す（v5.12）', async () => {
    const warns = [];
    const storage = createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage(), log: { warn: (m) => warns.push(m) } });
    expect(await storage.load()).toBeNull();
    const cases = [
      [Buffer.from('garbage'), 'decrypt'],
      [fakeSafeStorage().encryptString('{"clientId":"x","clientSecret":"y"}'), '（invalid）'],
      [fakeSafeStorage().encryptString('not json'), '（parse）'],
    ];
    for (const [bad, reason] of cases) {
      warns.length = 0;
      await fs.writeFile(filePath, bad);
      expect(await storage.load()).toBeNull();
      await expect(fs.access(filePath)).rejects.toThrow();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(reason);
    }
    // 同じ秒に退避しても上書きせず、3つとも残る
    expect((await fs.readdir(dir)).filter((n) => n.startsWith('oauth-client.enc.broken-'))).toHaveLength(3);
  });

  it('暗号化基盤が一時的に使えないときはファイルを消さずに null', async () => {
    await createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage() }).save(CLIENT);
    expect(await createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage({ available: false }) }).load()).toBeNull();
    expect(await createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage() }).load()).toEqual(CLIENT);
  });

  it('remove で削除できる（無くてもエラーにしない）', async () => {
    const storage = createOAuthClientStorage({ filePath, safeStorage: fakeSafeStorage() });
    await storage.remove();
    await storage.save(CLIENT);
    await storage.remove();
    expect(await storage.load()).toBeNull();
  });
});

/** 実物の auth（偽の Google・メモリ上のトークン保存）と oauthClient を組み合わせる */
function setup({ edition = 'shared', safeStorage = fakeSafeStorage(), google = createFakeGoogleOAuth() } = {}) {
  const tokens = { data: null };
  const servers = [];
  const opened = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const auth = createAuth({
    // 個人版の .env（共有版では使われないことを確かめるため、わざと別の値を入れておく）
    env: { GOOGLE_OAUTH_CLIENT_ID: 'developer.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'developer-secret' },
    ...(edition === 'shared' ? { clientConfig: { ok: false, reason: 'missing_client_id' } } : {}),
    tokenStorage: {
      save: async (c) => void (tokens.data = c),
      load: async () => tokens.data,
      remove: async () => void (tokens.data = null),
    },
    fetch: google.fetch,
    openExternal: async (url) => void opened.push(url),
    startLoopback: async () => {
      let deliver;
      let reject;
      const result = new Promise((res, rej) => {
        deliver = res;
        reject = rej;
      });
      const close = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      const server = { redirectUri: 'http://127.0.0.1:5555/callback', result, close, deliver };
      servers.push(server);
      return server;
    },
    log,
  });
  const storage = createOAuthClientStorage({ filePath, safeStorage });
  const oauthClient = createOAuthClient({ edition, storage, auth, log });
  const states = [];
  oauthClient.events.on('change', (s) => states.push(s));
  return { auth, oauthClient, storage, google, servers, opened, log, states };
}

async function link(ctx) {
  const done = ctx.auth.link();
  await vi.waitFor(() => expect(ctx.servers).toHaveLength(1));
  ctx.servers[0].deliver({ code: FIXTURE.code });
  await done;
}

describe('oauthClient（共有版の Client ID/Secret。2.4・3.6・F-18）', () => {
  it('起動時：未保存なら未設定のまま（連携は開始できない）', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    expect(ctx.oauthClient.getState()).toEqual({ edition: 'shared', userInput: true, configured: false, clientId: null, editable: true });
    expect(ctx.auth.getState()).toMatchObject({ status: 'unconfigured' });
    await ctx.auth.link();
    expect(ctx.servers).toHaveLength(0); // 空の資格情報で連携を試みない
  });

  it('保存すると再起動なしで未連携になり、そのまま入力したクライアントで連携できる', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    expect(await ctx.oauthClient.set({ clientId: `  ${CLIENT.clientId}`, clientSecret: `${CLIENT.clientSecret}\n` })).toEqual({ ok: true });
    expect(ctx.oauthClient.getState()).toMatchObject({ configured: true, clientId: CLIENT.clientId, editable: true });
    expect(ctx.auth.getState()).toEqual({ status: 'unlinked', lastError: null });
    await link(ctx);
    expect(ctx.auth.getState().status).toBe('linked');
    expect(new URL(ctx.opened[0]).searchParams.get('client_id')).toBe(CLIENT.clientId); // .env の値ではない
  });

  it('保存済みの値は次回起動時に読み込まれ、auth に反映される', async () => {
    await setup().storage.save(CLIENT);
    const ctx = setup();
    await ctx.oauthClient.init();
    expect(ctx.oauthClient.getState()).toMatchObject({ configured: true, clientId: CLIENT.clientId });
    expect(ctx.auth.getState().status).toBe('unlinked');
  });

  it('検証に通らない値は保存せず、理由を返す（auth も変えない）', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    const cases = [
      [{ clientId: '', clientSecret: '' }, 'missing_client_id'],
      [{ clientId: CLIENT.clientId, clientSecret: ' ' }, 'missing_client_secret'],
      [{ clientId: 'bad', clientSecret: CLIENT.clientSecret }, 'invalid_client_id'],
      [{ clientId: CLIENT.clientSecret, clientSecret: CLIENT.clientId }, 'swapped'],
      [{ clientId: CLIENT.clientId, clientSecret: 'short' }, 'invalid_client_secret'],
    ];
    for (const [input, reason] of cases) {
      expect(await ctx.oauthClient.set(input)).toEqual({ ok: false, reason });
    }
    expect(await ctx.storage.load()).toBeNull();
    expect(ctx.auth.getState().status).toBe('unconfigured');
  });

  it('連携中は変更も削除もできない（linked）。連携解除すればできる', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    await ctx.oauthClient.set(CLIENT);
    await link(ctx);
    expect(ctx.oauthClient.getState().editable).toBe(false);
    expect(await ctx.oauthClient.set({ clientId: 'other.apps.googleusercontent.com', clientSecret: 'other-secret-1' })).toEqual({ ok: false, reason: 'linked' });
    expect(await ctx.oauthClient.clear()).toEqual({ ok: false, reason: 'linked' });
    expect(await ctx.storage.load()).toEqual(CLIENT);
    expect(ctx.auth.getState().status).toBe('linked');

    await ctx.auth.unlink();
    expect(ctx.oauthClient.getState().editable).toBe(true);
    expect(await ctx.oauthClient.clear()).toEqual({ ok: true });
    expect(ctx.oauthClient.getState()).toMatchObject({ configured: false, clientId: null });
    expect(ctx.auth.getState()).toMatchObject({ status: 'unconfigured' });
    expect(await ctx.storage.load()).toBeNull();
  });

  it('連携状態が変わると change を出す（設定画面の入力欄のロック）', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    await ctx.oauthClient.set(CLIENT);
    ctx.states.length = 0;
    await link(ctx);
    expect(ctx.states.at(-1)).toMatchObject({ editable: false });
  });

  it('状態・イベント・ログに Secret を含めない', async () => {
    const ctx = setup();
    await ctx.oauthClient.init();
    await ctx.oauthClient.set(CLIENT);
    await ctx.oauthClient.set({ clientId: CLIENT.clientId, clientSecret: 'x y' });
    const everything = JSON.stringify([ctx.oauthClient.getState(), ctx.states, ctx.log.info.mock.calls, ctx.log.warn.mock.calls]);
    expect(everything).not.toContain(CLIENT.clientSecret);
  });

  it('暗号化できない環境では save_failed（平文保存しない・auth も変えない）', async () => {
    const ctx = setup({ safeStorage: fakeSafeStorage({ available: false }) });
    await ctx.oauthClient.init();
    expect(await ctx.oauthClient.set(CLIENT)).toEqual({ ok: false, reason: 'save_failed' });
    expect(ctx.auth.getState().status).toBe('unconfigured');
    expect(ctx.oauthClient.getState().configured).toBe(false);
  });
});

describe('oauthClient / 個人版（.env を使う）', () => {
  it('入力欄を出さず、保存・削除を受け付けない。init は保存ファイルを読まず、.env の設定を変えない', async () => {
    await setup().storage.save(CLIENT); // 共有版で保存したファイルがあっても
    const ctx = setup({ edition: 'personal' });
    await ctx.oauthClient.init();
    expect(ctx.oauthClient.getState()).toEqual({ edition: 'personal', userInput: false, configured: false, clientId: null, editable: false });
    expect(ctx.auth.getState().status).toBe('unlinked'); // .env の値で設定済み
    expect(await ctx.oauthClient.set(CLIENT)).toEqual({ ok: false, reason: 'not_shared' });
    expect(await ctx.oauthClient.clear()).toEqual({ ok: false, reason: 'not_shared' });
    expect(await ctx.storage.load()).toEqual(CLIENT); // 触らない
    const done = ctx.auth.link();
    await vi.waitFor(() => expect(ctx.opened).toHaveLength(1));
    expect(new URL(ctx.opened[0]).searchParams.get('client_id')).toBe('developer.apps.googleusercontent.com');
    ctx.auth.cancel();
    await done;
  });
});
