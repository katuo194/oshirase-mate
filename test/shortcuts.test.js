import { describe, expect, it } from 'vitest';
import { SHORTCUT_FILE_NAME, createShortcuts } from '../src/main/shortcuts.js';

const EXE = 'C:\\Users\\u\\Documents\\おしらせメイト\\おしらせメイト.exe';
const DIRS = { desktop: 'C:\\Users\\u\\Desktop', startMenu: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs' };
const DESKTOP_LNK = `${DIRS.desktop}\\${SHORTCUT_FILE_NAME}`;
const START_LNK = `${DIRS.startMenu}\\${SHORTCUT_FILE_NAME}`;

/** .lnk をメモリ上に持つ偽の shell / fs */
function setup({ isPackaged = true, platform = 'win32', links = {}, writeResult = true } = {}) {
  const files = new Map(Object.entries(links));
  const writes = [];
  const shell = {
    writeShortcutLink(p, op, details) {
      writes.push({ p, op, details });
      if (writeResult) files.set(p, { target: details.target });
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
  const shortcuts = createShortcuts({ isPackaged, platform, execPath: EXE, dirs: DIRS, shell, fs, appUserModelId: 'local.mascot-notifier' });
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

  it('開発時（未パッケージ）と Windows 以外は非対応', () => {
    expect(setup({ isPackaged: false }).shortcuts.status()).toEqual({ supported: false, desktop: 'none', startMenu: 'none' });
    expect(setup({ platform: 'darwin' }).shortcuts.status().supported).toBe(false);
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
    const dev = setup({ isPackaged: false });
    expect(dev.shortcuts.create('desktop')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(dev.writes).toEqual([]);
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
    const { shortcuts, files } = setup({ isPackaged: false, links: { [DESKTOP_LNK]: { target: EXE } } });
    expect(shortcuts.remove('desktop')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(files.has(DESKTOP_LNK)).toBe(true);
    expect(setup().shortcuts.remove('..')).toMatchObject({ ok: false, reason: 'invalid_location' });
  });
});
