import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnreadableContentError, decryptOrThrow, parseJsonOrThrow, quarantineUnreadable } from '../src/main/unreadableFile.js';

let dir;
let filePath;
let warns;
const log = { warn: (m) => warns.push(m) };
const NOW = () => new Date(2026, 8, 22, 23, 40, 5); // ローカル時刻 2026-09-22 23:40:05

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unreadable-'));
  filePath = path.join(dir, 'tokens.enc');
  warns = [];
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('quarantineUnreadable（読めないファイルは削除せず退避する：v5.12）', () => {
  it('<名前>.broken-<日時> へ名前を変えて中身を残し、理由をログに出す', async () => {
    await fs.writeFile(filePath, 'data');
    await quarantineUnreadable({ filePath, error: new UnreadableContentError('decrypt', 'bad'), log, now: NOW });
    expect(await fs.readdir(dir)).toEqual(['tokens.enc.broken-20260922-234005']);
    expect(await fs.readFile(path.join(dir, 'tokens.enc.broken-20260922-234005'), 'utf8')).toBe('data');
    expect(warns).toEqual(['[storage] tokens.enc を読めないため tokens.enc.broken-20260922-234005 に退避しました（decrypt: bad）']);
  });

  it('同じ日時の退避先があれば上書きせず番号を付ける', async () => {
    await fs.writeFile(filePath, 'first');
    await quarantineUnreadable({ filePath, error: new UnreadableContentError('parse'), log, now: NOW });
    await fs.writeFile(filePath, 'second');
    await quarantineUnreadable({ filePath, error: new UnreadableContentError('parse'), log, now: NOW });
    expect((await fs.readdir(dir)).sort()).toEqual(['tokens.enc.broken-20260922-234005', 'tokens.enc.broken-20260922-234005-2']);
    expect(await fs.readFile(path.join(dir, 'tokens.enc.broken-20260922-234005'), 'utf8')).toBe('first');
  });

  it('想定外のエラーは種類 unknown として扱い、メッセージ（中身を含み得る）は出さない', async () => {
    await fs.writeFile(filePath, 'data');
    await quarantineUnreadable({ filePath, error: new Error('secret-ish'), log, now: NOW });
    expect(warns[0]).toContain('（unknown）');
    expect(warns[0]).not.toContain('secret-ish');
  });

  it('退避できなくても削除はせず、ログに出す', async () => {
    await quarantineUnreadable({ filePath: path.join(dir, 'missing.enc'), error: new UnreadableContentError('decrypt'), log, now: NOW });
    expect(warns[0]).toContain('退避にも失敗したためそのまま残します');
  });
});

describe('decryptOrThrow / parseJsonOrThrow', () => {
  it('復号の失敗は decrypt（safeStorage のメッセージつき）', () => {
    const safeStorage = {
      decryptString: () => {
        throw new Error('Error while decrypting');
      },
    };
    expect(() => decryptOrThrow(safeStorage, Buffer.from('x'))).toThrow(new UnreadableContentError('decrypt', 'Error while decrypting'));
    expect(decryptOrThrow({ decryptString: () => 'ok' }, Buffer.from('x'))).toBe('ok');
  });

  it('JSON の失敗は parse だけ（JSON.parse のメッセージは中身の一部を含み得るため捨てる）', () => {
    let error;
    try {
      parseJsonOrThrow('RT-secret-value');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnreadableContentError);
    expect(error.stage).toBe('parse');
    expect(error.message).toBe('parse');
    expect(parseJsonOrThrow('{"a":1}')).toEqual({ a: 1 });
  });
});
