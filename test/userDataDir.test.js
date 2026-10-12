import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { userDataDirName, userDataDirToPin } from '../src/main/userDataDir.js';

describe('userData の保存先（v5.12）', () => {
  it('個人版は旧 package.json の name（my-mascot-app）に固定する（アプリ名の変更後もデータを引き継ぐ）', () => {
    expect(userDataDirName('personal')).toBe('my-mascot-app');
  });

  it('開発時（ビルド時の版なし）も個人版と同じ', () => {
    expect(userDataDirName(null)).toBe('my-mascot-app');
  });

  it('共有版は専用のフォルダ（同じ PC の個人版のデータと混ざらない）', () => {
    expect(userDataDirName('shared')).toBe('おしらせメイト');
    expect(userDataDirName('shared')).not.toBe(userDataDirName('personal'));
  });

  it('--user-data-dir が明示されていなければ、版ごとのフォルダに固定する', () => {
    expect(userDataDirToPin({ buildEdition: null, hasUserDataDirSwitch: false })).toBe('my-mascot-app');
    expect(userDataDirToPin({ buildEdition: 'personal', hasUserDataDirSwitch: false })).toBe('my-mascot-app');
    expect(userDataDirToPin({ buildEdition: 'shared', hasUserDataDirSwitch: false })).toBe('おしらせメイト');
  });

  it('--user-data-dir が明示されていれば固定しない（開発中の共有版の動作確認で、指定したフォルダの config.json を読むため。v5.15）', () => {
    for (const buildEdition of [null, 'personal', 'shared']) {
      expect(userDataDirToPin({ buildEdition, hasUserDataDirSwitch: true })).toBeNull();
    }
  });

  it('pinUserDataDir.js は起動引数の --user-data-dir を見てから固定する', () => {
    const src = readFileSync(new URL('../src/main/pinUserDataDir.js', import.meta.url), 'utf8');
    expect(src).toContain("app.commandLine.hasSwitch('user-data-dir')");
    expect(src).toMatch(/if \(dirName\) app\.setPath\('userData'/);
  });

  it('index.js の最初の import で固定する（store.js が import 時に userData を読むため）', () => {
    const src = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
    // Windows の git（core.autocrlf=true）でチェックアウトすると CRLF になる
    const firstImport = src.split(/\r?\n/).find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './pinUserDataDir.js';");
  });
});
