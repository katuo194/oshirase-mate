import { describe, expect, it } from 'vitest';
import { applyLoginItem, loginItemOptions } from '../src/main/autostart.js';

describe('loginItemOptions', () => {
  it('パッケージ後は openAtLogin のみ', () => {
    expect(loginItemOptions({ openAtLogin: true, isPackaged: true, execPath: 'C:\\app\\app.exe', appPath: 'C:\\app' })).toEqual({
      openAtLogin: true,
    });
  });

  it('開発時（未パッケージ）は electron.exe にアプリのパスを引数で渡す', () => {
    const opts = loginItemOptions({
      openAtLogin: true,
      isPackaged: false,
      execPath: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      appPath: 'C:\\proj',
    });
    expect(opts).toEqual({
      openAtLogin: true,
      path: 'C:\\proj\\node_modules\\electron\\dist\\electron.exe',
      args: ['C:\\proj'],
    });
  });

  it('OFF のときも同じ path/args を渡す（登録時と同じエントリを確実に削除するため）', () => {
    const opts = loginItemOptions({ openAtLogin: false, isPackaged: false, execPath: 'E', appPath: 'A' });
    expect(opts).toEqual({ openAtLogin: false, path: 'E', args: ['A'] });
  });
});

describe('applyLoginItem', () => {
  it('app.setLoginItemSettings にオプションを渡す', () => {
    const calls = [];
    const fakeApp = {
      isPackaged: true,
      getAppPath: () => 'C:\\app',
      setLoginItemSettings: (o) => calls.push(o),
    };
    applyLoginItem(fakeApp, true);
    expect(calls).toEqual([{ openAtLogin: true }]);
  });
});
