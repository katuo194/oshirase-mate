import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { userDataDirName } from '../src/main/userDataDir.js';

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

  it('index.js の最初の import で固定する（store.js が import 時に userData を読むため）', () => {
    const src = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
    // Windows の git（core.autocrlf=true）でチェックアウトすると CRLF になる
    const firstImport = src.split(/\r?\n/).find((l) => l.startsWith('import '));
    expect(firstImport).toBe("import './pinUserDataDir.js';");
  });
});
