import { describe, expect, it } from 'vitest';
import { DEV_SHORTCUT_FILE_NAME, READ_ARGS_LIMIT, SHORTCUT_FILE_NAME, createShortcuts, devLaunchArgs } from '../src/main/shortcuts.js';

const EXE = 'C:\\Users\\u\\Documents\\おしらせメイト\\おしらせメイト.exe';
const DIRS = { desktop: 'C:\\Users\\u\\Desktop', startMenu: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs' };
const DESKTOP_LNK = `${DIRS.desktop}\\${SHORTCUT_FILE_NAME}`;
const START_LNK = `${DIRS.startMenu}\\${SHORTCUT_FILE_NAME}`;

/** .lnk をメモリ上に持つ偽の shell / fs */
function setup({ dev = null, platform = 'win32', execPath = EXE, links = {}, writeResult = true } = {}) {
  const files = new Map(Object.entries(links));
  const writes = [];
  const shell = {
    writeShortcutLink(p, op, details) {
      writes.push({ p, op, details });
      if (writeResult) files.set(p, { target: details.target, args: details.args ?? '' });
      return writeResult;
    },
    readShortcutLink(p) {
      const d = files.get(p);
      if (!d || d === 'broken') throw new Error('Failed to read shortcut link');
      return d;
    },
  };
  const fs = {
    existsSync: (p) => files.has(p),
    unlinkSync: (p) => files.delete(p),
  };
  const shortcuts = createShortcuts({ platform, execPath, dev, dirs: DIRS, shell, fs, appUserModelId: 'local.mascot-notifier' });
  return { shortcuts, files, writes };
}

describe('shortcuts.status', () => {
  it('無ければ none', () => {
    expect(setup().shortcuts.status()).toEqual({ supported: true, desktop: 'none', startMenu: 'none' });
  });

  it('リンク先が今の実行ファイルなら ok（大文字小文字・区切りの違いは無視）', () => {
    const { shortcuts } = setup({ links: { [DESKTOP_LNK]: { target: EXE.toUpperCase().replaceAll('\\', '/') } } });
    expect(shortcuts.status().desktop).toBe('ok');
  });

  it('リンク先が違う（フォルダを移動した）・読めない .lnk は stale', () => {
    const { shortcuts } = setup({ links: { [DESKTOP_LNK]: { target: 'D:\\old\\おしらせメイト.exe' }, [START_LNK]: 'broken' } });
    expect(shortcuts.status()).toEqual({ supported: true, desktop: 'stale', startMenu: 'stale' });
  });

  it('Windows 以外は非対応', () => {
    expect(setup({ platform: 'darwin' }).shortcuts.status()).toEqual({ supported: false, desktop: 'none', startMenu: 'none' });
  });
});

describe('shortcuts.create', () => {
  it('実行ファイルを指す .lnk を作る（アイコンは実行ファイルのもの・AppUserModelID は appId）', () => {
    const { shortcuts, writes } = setup();
    expect(shortcuts.create('desktop')).toEqual({ ok: true, supported: true, desktop: 'ok', startMenu: 'none' });
    expect(writes).toEqual([
      {
        p: DESKTOP_LNK,
        op: 'create',
        details: {
          target: EXE,
          cwd: 'C:\\Users\\u\\Documents\\おしらせメイト',
          description: 'おしらせメイト',
          icon: EXE,
          iconIndex: 0,
          appUserModelId: 'local.mascot-notifier',
        },
      },
    ]);
  });

  it('既にあれば replace で作り直す（stale → ok）', () => {
    const { shortcuts, writes } = setup({ links: { [START_LNK]: { target: 'D:\\old\\x.exe' } } });
    expect(shortcuts.create('startMenu').startMenu).toBe('ok');
    expect(writes[0].op).toBe('replace');
    expect(writes[0].p).toBe(START_LNK);
  });

  it('書き込めなければ write_failed', () => {
    expect(setup({ writeResult: false }).shortcuts.create('desktop')).toMatchObject({ ok: false, reason: 'write_failed', desktop: 'none' });
  });

  it('非対応・不正な場所は作らない', () => {
    const mac = setup({ platform: 'darwin' });
    expect(mac.shortcuts.create('desktop')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(mac.writes).toEqual([]);
    const bad = setup();
    expect(bad.shortcuts.create('C:\\Windows')).toMatchObject({ ok: false, reason: 'invalid_location' });
    expect(bad.shortcuts.create('constructor')).toMatchObject({ ok: false, reason: 'invalid_location' });
    expect(bad.writes).toEqual([]);
  });
});

describe('shortcuts.remove', () => {
  it('.lnk を削除する（無くても ok）', () => {
    const { shortcuts, files } = setup({ links: { [DESKTOP_LNK]: { target: EXE } } });
    expect(shortcuts.remove('desktop')).toEqual({ ok: true, supported: true, desktop: 'none', startMenu: 'none' });
    expect(files.has(DESKTOP_LNK)).toBe(false);
    expect(shortcuts.remove('desktop').ok).toBe(true);
  });

  it('非対応・不正な場所は消さない', () => {
    const { shortcuts, files } = setup({ platform: 'darwin', links: { [DESKTOP_LNK]: { target: EXE } } });
    expect(shortcuts.remove('desktop')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(files.has(DESKTOP_LNK)).toBe(true);
    expect(setup().shortcuts.remove('..')).toMatchObject({ ok: false, reason: 'invalid_location' });
  });
});

describe('ソースから起動しているとき（npm start・npx electron .。v5.15）', () => {
  const ELECTRON = 'C:\\dev\\oshirase-mate\\node_modules\\electron\\dist\\electron.exe';
  const APP = 'C:\\dev\\oshirase-mate';
  const USER_DATA = 'C:\\Users\\u\\AppData\\Local\\Temp\\mascot shared';
  const DEV_LNK = `${DIRS.desktop}\\${DEV_SHORTCUT_FILE_NAME}`;

  it('devLaunchArgs：アプリのフォルダと、明示された --user-data-dir を引用符で囲んで渡す', () => {
    expect(devLaunchArgs({ appPath: APP })).toBe(`"${APP}"`);
    expect(devLaunchArgs({ appPath: APP, userDataDir: USER_DATA })).toBe(`"${APP}" --user-data-dir="${USER_DATA}"`);
  });

  it('作れる。Electron 本体に引数を付けた .lnk を、配布版とは別の名前で作る', () => {
    const { shortcuts, writes, files } = setup({ execPath: ELECTRON, dev: { appPath: APP, userDataDir: USER_DATA } });
    expect(shortcuts.status()).toEqual({ supported: true, desktop: 'none', startMenu: 'none' });
    expect(shortcuts.create('desktop')).toEqual({ ok: true, supported: true, desktop: 'ok', startMenu: 'none' });
    expect(writes[0]).toEqual({
      p: DEV_LNK,
      op: 'create',
      details: {
        target: ELECTRON,
        args: `"${APP}" --user-data-dir="${USER_DATA}"`,
        cwd: APP,
        description: 'おしらせメイト（開発）',
        icon: ELECTRON,
        iconIndex: 0,
        appUserModelId: 'local.mascot-notifier',
      },
    });
    expect(files.has(DESKTOP_LNK)).toBe(false); // 配布版のショートカットには触らない
  });

  it('引数が違う（保存先・フォルダが違う）.lnk は stale。作り直すと ok', () => {
    const links = { [DEV_LNK]: { target: ELECTRON, args: `"${APP}" --user-data-dir="D:\\other"` } };
    const { shortcuts } = setup({ execPath: ELECTRON, dev: { appPath: APP, userDataDir: null }, links });
    expect(shortcuts.status().desktop).toBe('stale');
    expect(shortcuts.create('desktop').desktop).toBe('ok');
  });

  it('長い引数は、読み戻しが 259 文字に切れても先頭が一致すれば ok（Electron の readShortcutLink の上限）', () => {
    const longDir = `C:\\Users\\u\\AppData\\Local\\Temp\\${'x'.repeat(260)}`;
    const dev = { appPath: APP, userDataDir: longDir };
    const full = devLaunchArgs(dev);
    expect(full.length).toBeGreaterThan(READ_ARGS_LIMIT);
    const truncated = full.slice(0, READ_ARGS_LIMIT);
    expect(setup({ execPath: ELECTRON, dev, links: { [DEV_LNK]: { target: ELECTRON, args: truncated } } }).shortcuts.status().desktop).toBe('ok');
    // 先頭が違えば stale、短い（上限に届かない）途中までの一致も stale
    const other = `"D:\\other"${truncated.slice(10)}`;
    expect(setup({ execPath: ELECTRON, dev, links: { [DEV_LNK]: { target: ELECTRON, args: other } } }).shortcuts.status().desktop).toBe('stale');
    expect(setup({ execPath: ELECTRON, dev, links: { [DEV_LNK]: { target: ELECTRON, args: full.slice(0, 100) } } }).shortcuts.status().desktop).toBe('stale');
  });

  it('配布版の .lnk（おしらせメイト.lnk）は見ない・消さない', () => {
    const { shortcuts, files } = setup({ execPath: ELECTRON, dev: { appPath: APP }, links: { [DESKTOP_LNK]: { target: EXE } } });
    expect(shortcuts.status().desktop).toBe('none');
    expect(shortcuts.remove('desktop').ok).toBe(true);
    expect(files.has(DESKTOP_LNK)).toBe(true);
  });
});
