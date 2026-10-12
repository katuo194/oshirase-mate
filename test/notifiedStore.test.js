import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORMAT_VERSION, createNotifiedStore, purgeExpired } from '../src/main/notifiedStore.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let dir;
let filePath;
let clock;
const now = () => clock;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notified-'));
  filePath = path.join(dir, 'notified.json');
  clock = NOW;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const create = () => createNotifiedStore({ filePath, now });
const readRaw = async () => JSON.parse(await fs.readFile(filePath, 'utf8'));

describe('purgeExpired', () => {
  it('保持期間を過ぎた記録だけを落とす', () => {
    const notified = {
      'mail:fresh': NOW - 1 * DAY,
      'mail:edge': NOW - 7 * DAY + 1000,
      'mail:expired': NOW - 7 * DAY,
      'mail:ancient': NOW - 30 * DAY,
    };
    expect(purgeExpired(notified, NOW, 7 * DAY)).toEqual({
      'mail:fresh': NOW - 1 * DAY,
      'mail:edge': NOW - 7 * DAY + 1000,
    });
  });

  it('記録時刻が数値でないものは壊れた記録として捨てる', () => {
    expect(purgeExpired({ a: 'yesterday', b: null, c: NaN, d: NOW }, NOW, 7 * DAY)).toEqual({ d: NOW });
  });
});

describe('notifiedStore', () => {
  it('ファイルが無ければ空を返す', async () => {
    expect(await create().load()).toEqual({});
  });

  it('保存 → 読み出しで往復できる', async () => {
    const s = create();
    await s.save({ 'mail:1': NOW, 'cal:2:123': NOW - 1000 });
    expect(await s.load()).toEqual({ 'mail:1': NOW, 'cal:2:123': NOW - 1000 });
  });

  it('バージョン付きの形式で書き出す', async () => {
    await create().save({ 'mail:1': NOW });
    expect(await readRaw()).toEqual({ version: FORMAT_VERSION, notified: { 'mail:1': NOW } });
  });

  it('書き込み時に7日超をパージする（長時間起動でも肥大しない）', async () => {
    const s = create();
    const purged = await s.save({ 'mail:old': NOW - 8 * DAY, 'mail:new': NOW });
    expect(purged).toEqual({ 'mail:new': NOW });
    expect((await readRaw()).notified).toEqual({ 'mail:new': NOW });
  });

  it('読み出し時にも7日超をパージする（起動しっぱなしの後に再起動した場合）', async () => {
    await create().save({ 'mail:1': NOW });
    clock = NOW + 8 * DAY; // 8日後に起動
    expect(await create().load()).toEqual({});
  });

  it('壊れたJSONは空として扱い、ファイルを捨てる', async () => {
    await fs.writeFile(filePath, '{ this is not json');
    expect(await create().load()).toEqual({});
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('形式が違うJSONも空として扱う', async () => {
    await fs.writeFile(filePath, JSON.stringify({ version: 1, notified: 'なにか' }));
    expect(await create().load()).toEqual({});
  });

  it('一時ファイルを経由して置き換えるので、書き込み後に .tmp が残らない', async () => {
    await create().save({ 'mail:1': NOW });
    expect(await fs.readdir(dir)).toEqual(['notified.json']);
  });

  it('保存先ディレクトリが無くても作って書き込む', async () => {
    const nested = path.join(dir, 'a', 'b', 'notified.json');
    const s = createNotifiedStore({ filePath: nested, now });
    await s.save({ 'mail:1': NOW });
    expect(await s.load()).toEqual({ 'mail:1': NOW });
  });

  it('remove() で履歴を消せる', async () => {
    const s = create();
    await s.save({ 'mail:1': NOW });
    await s.remove();
    expect(await s.load()).toEqual({});
  });
});
