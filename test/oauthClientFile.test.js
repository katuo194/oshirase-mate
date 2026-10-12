import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CLIENT_FILE_BYTES, parseOAuthClientFile, readOAuthClientFile } from '../src/main/oauthClientFile.js';

// Console からダウンロードした OAuth クライアントの JSON の読み込み（Phase 12・v5.15）。見本は mocks/google/client_secret_*.json（値はダミー）
const mock = (name) => fs.readFile(new URL(`../mocks/google/${name}`, import.meta.url));
const DESKTOP = {
  clientId: '000000000000-dummydesktop.apps.googleusercontent.com',
  clientSecret: 'dummy-desktop-client-secret',
};

describe('parseOAuthClientFile', () => {
  it('デスクトップ アプリの JSON（installed）から Client ID/Secret を取り出す', async () => {
    expect(parseOAuthClientFile(await mock('client_secret_desktop.json'))).toEqual({ ok: true, ...DESKTOP });
  });

  it('文字列でも Buffer でも読める', async () => {
    const text = (await mock('client_secret_desktop.json')).toString('utf8');
    expect(parseOAuthClientFile(text)).toEqual({ ok: true, ...DESKTOP });
  });

  it('先頭の BOM を許す', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await mock('client_secret_desktop.json')]);
    expect(parseOAuthClientFile(withBom)).toEqual({ ok: true, ...DESKTOP });
    expect(parseOAuthClientFile(`﻿${withBom.subarray(3).toString('utf8')}`)).toEqual({ ok: true, ...DESKTOP });
  });

  it('ファイルの前後・値の前後の余計な空白は取り除く', () => {
    const json = `\r\n  ${JSON.stringify({ installed: { client_id: `  ${DESKTOP.clientId}\n`, client_secret: `\t${DESKTOP.clientSecret} ` } })}\r\n\r\n`;
    expect(parseOAuthClientFile(json)).toEqual({ ok: true, ...DESKTOP });
  });

  it('種類が「ウェブ アプリケーション」（web）なら web_client', async () => {
    expect(parseOAuthClientFile(await mock('client_secret_web.json'))).toEqual({ ok: false, reason: 'web_client' });
  });

  it('Secret の入っていない JSON（作成後に詳細画面からダウンロードしたもの）は missing_values', async () => {
    expect(parseOAuthClientFile(await mock('client_secret_no_secret.json'))).toEqual({ ok: false, reason: 'missing_values' });
    for (const installed of [{ client_secret: DESKTOP.clientSecret }, { client_id: DESKTOP.clientId, client_secret: '  ' }, { client_id: 1, client_secret: 2 }]) {
      expect(parseOAuthClientFile(JSON.stringify({ installed }))).toEqual({ ok: false, reason: 'missing_values' });
    }
  });

  it('値の形式が正しくなければ invalid_values', () => {
    for (const installed of [
      { client_id: 'not-a-client-id', client_secret: DESKTOP.clientSecret },
      { client_id: DESKTOP.clientId, client_secret: 'short' },
      { client_id: DESKTOP.clientId, client_secret: 'has space inside' },
      { client_id: DESKTOP.clientSecret, client_secret: DESKTOP.clientId },
    ]) {
      expect(parseOAuthClientFile(JSON.stringify({ installed }))).toEqual({ ok: false, reason: 'invalid_values' });
    }
  });

  it('JSON として読めなければ not_json', () => {
    for (const bad of ['', 'client_id=abc', '{"installed": {', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])]) {
      expect(parseOAuthClientFile(bad)).toEqual({ ok: false, reason: 'not_json' });
    }
  });

  it('JSON だが OAuth クライアントのファイルでなければ not_client_file', () => {
    for (const other of ['null', '[]', '"text"', '42', '{}', '{"installed": "x"}', '{"installed": []}', '{"type": "service_account", "client_id": "1"}']) {
      expect(parseOAuthClientFile(other)).toEqual({ ok: false, reason: 'not_client_file' });
    }
  });

  it('64KB を超えるものは解析せずに too_large', () => {
    const big = JSON.stringify({ installed: { ...{ client_id: DESKTOP.clientId, client_secret: DESKTOP.clientSecret }, pad: 'x'.repeat(MAX_CLIENT_FILE_BYTES) } });
    expect(parseOAuthClientFile(big)).toEqual({ ok: false, reason: 'too_large' });
    expect(parseOAuthClientFile(Buffer.from(big))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('失敗の結果に値（Secret）を含めない', async () => {
    const results = [
      parseOAuthClientFile(await mock('client_secret_web.json')),
      parseOAuthClientFile(JSON.stringify({ installed: { client_id: 'bad', client_secret: DESKTOP.clientSecret } })),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain('dummy-web-client-secret');
    expect(text).not.toContain(DESKTOP.clientSecret);
  });
});

describe('readOAuthClientFile', () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth-client-file-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ファイルを読み込んで解析する（日本語・空白を含むパス、拡張子の大文字も可）', async () => {
    const file = path.join(dir, 'ダウンロード 1', 'client_secret_000.apps.googleusercontent.COM.JSON');
    await fs.mkdir(path.dirname(file));
    await fs.copyFile(new URL('../mocks/google/client_secret_desktop.json', import.meta.url), file);
    expect(await readOAuthClientFile(file, fs)).toEqual({ ok: true, ...DESKTOP });
  });

  it('大きすぎるファイルは中身を読まずに too_large', async () => {
    const file = path.join(dir, 'big.json');
    await fs.writeFile(file, Buffer.alloc(MAX_CLIENT_FILE_BYTES + 1, 0x20));
    let read = false;
    const spy = { stat: fs.stat, readFile: async (p) => ((read = true), fs.readFile(p)) };
    expect(await readOAuthClientFile(file, spy)).toEqual({ ok: false, reason: 'too_large' });
    expect(read).toBe(false);
  });

  it('拡張子が .json でなければ読まずに not_json', async () => {
    const file = path.join(dir, 'client_secret.txt');
    await fs.copyFile(new URL('../mocks/google/client_secret_desktop.json', import.meta.url), file);
    expect(await readOAuthClientFile(file, fs)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('無いファイル・フォルダ・相対パス・空・文字列でない値は read_failed', async () => {
    const folder = path.join(dir, 'folder.json');
    await fs.mkdir(folder);
    for (const p of [path.join(dir, 'missing.json'), folder, 'client_secret.json', '', undefined, 42]) {
      expect(await readOAuthClientFile(p, fs)).toEqual({ ok: false, reason: 'read_failed' });
    }
  });
});
