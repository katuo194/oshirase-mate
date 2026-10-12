import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, expiredLogFiles, localDate, localTimestamp } from '../src/main/logger.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-log-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 123).getTime();
const fakeConsole = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('logger', () => {
  it('コンソールとログファイル（app-YYYY-MM-DD.log）の両方に出す', () => {
    const c = fakeConsole();
    const log = createLogger({ dir: path.join(dir, 'logs'), now: () => at(2026, 9, 20, 16, 5, 9), console: c });
    log.info('[test] hello');
    log.warn('[test] careful');

    const file = path.join(dir, 'logs', 'app-2026-09-20.log');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '2026-09-20 16:05:09.123 INFO  [test] hello\n2026-09-20 16:05:09.123 WARN  [test] careful\n',
    );
    expect(c.log).toHaveBeenCalledWith('2026-09-20 16:05:09.123 INFO  [test] hello');
    expect(c.warn).toHaveBeenCalledTimes(1);
  });

  it('日付が変わると別のファイルに書く', () => {
    const clock = { t: at(2026, 9, 20, 23, 59, 59) };
    const log = createLogger({ dir, now: () => clock.t, console: fakeConsole() });
    log.info('a');
    clock.t = at(2026, 9, 21, 0, 0, 1);
    log.info('b');
    expect(fs.readdirSync(dir).sort()).toEqual(['app-2026-09-20.log', 'app-2026-09-21.log']);
  });

  it('保存先ディレクトリが無ければ作る', () => {
    const nested = path.join(dir, 'a', 'b');
    createLogger({ dir: nested, console: fakeConsole() }).info('x');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('文字列以外（Error・オブジェクト）も整形して出す', () => {
    const c = fakeConsole();
    const log = createLogger({ dir, console: c });
    log.info('e:', new Error('bad'), { a: 1 });
    expect(c.log.mock.calls[0][0]).toContain('e: bad {"a":1}');
  });

  it('ファイルに書けなくてもアプリは止めない（コンソールには出す。エラー通知は一度だけ）', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, ''); // ここをディレクトリにはできない
    const c = fakeConsole();
    const log = createLogger({ dir: path.join(blocker, 'logs'), console: c });
    expect(() => {
      log.info('one');
      log.info('two');
    }).not.toThrow();
    expect(c.log).toHaveBeenCalledTimes(2);
    expect(c.error).toHaveBeenCalledTimes(1);
  });

  it('日付・時刻はローカル時刻で整形する', () => {
    expect(localDate(at(2026, 1, 2))).toBe('2026-01-02');
    expect(localTimestamp(at(2026, 1, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05.123');
  });
});

describe('logger / 保持期間（9章#4：14日）', () => {
  const touch = (...names) => {
    for (const n of names) fs.writeFileSync(path.join(dir, n), 'x\n');
  };

  it('expiredLogFiles：今日を含め14日分を残し、15日目より古いものを返す', () => {
    const now = at(2026, 9, 21, 10);
    const names = ['app-2026-09-21.log', 'app-2026-09-08.log', 'app-2026-09-07.log', 'app-2026-08-01.log'];
    expect(expiredLogFiles(names, now, 14)).toEqual(['app-2026-09-07.log', 'app-2026-08-01.log']);
  });

  it('expiredLogFiles：パターンに合わないファイルは決して返さない', () => {
    const names = ['memo.txt', 'app-2020-01-01.log.bak', 'app-2020-1-1.log', 'other-2020-01-01.log', 'app-2020-01-01.log'];
    expect(expiredLogFiles(names, at(2026, 9, 21), 14)).toEqual(['app-2020-01-01.log']);
  });

  it('expiredLogFiles：月・年をまたいでも暦日で数える', () => {
    const now = at(2027, 1, 5, 0, 0, 1);
    expect(expiredLogFiles(['app-2026-12-23.log', 'app-2026-12-22.log'], now, 14)).toEqual(['app-2026-12-22.log']);
  });

  it('起動時（createLogger）に古いファイルを削除し、件数をログに残す', () => {
    touch('app-2026-08-01.log', 'app-2026-09-08.log', 'memo.txt');
    const c = fakeConsole();
    createLogger({ dir, now: () => at(2026, 9, 21, 9), console: c });
    expect(fs.readdirSync(dir).sort()).toEqual(['app-2026-09-08.log', 'app-2026-09-21.log', 'memo.txt']);
    expect(fs.readFileSync(path.join(dir, 'app-2026-09-21.log'), 'utf8')).toContain('[logger] 保持期間(14日)を過ぎたログを削除: 1件');
  });

  it('削除するものが無ければ何も書かない', () => {
    touch('app-2026-09-20.log');
    const c = fakeConsole();
    createLogger({ dir, now: () => at(2026, 9, 21, 9), console: c });
    expect(fs.readdirSync(dir)).toEqual(['app-2026-09-20.log']);
    expect(c.log).not.toHaveBeenCalled();
  });

  it('起動したまま日付が変わると、最初の書き込みでパージする', () => {
    const clock = { t: at(2026, 9, 21, 23, 59) };
    const log = createLogger({ dir, now: () => clock.t, console: fakeConsole() });
    touch('app-2026-09-08.log'); // 9/21 時点では14日目で残る
    log.info('a');
    expect(fs.existsSync(path.join(dir, 'app-2026-09-08.log'))).toBe(true);
    clock.t = at(2026, 9, 22, 0, 0, 5);
    log.info('b');
    expect(fs.existsSync(path.join(dir, 'app-2026-09-08.log'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'app-2026-09-22.log'), 'utf8')).toMatch(/削除: 1件[\s\S]*INFO  b/);
  });

  it('ディレクトリがまだ無くても落ちない', () => {
    const c = fakeConsole();
    expect(() => createLogger({ dir: path.join(dir, 'none'), console: c })).not.toThrow();
    expect(c.warn).not.toHaveBeenCalled();
  });
});
