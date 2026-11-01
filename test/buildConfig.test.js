import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// electron-builder の設定（9章#2・#3。v5.11）。共有版に開発者の .env が入らないことを設定の段階で固定する
// （ビルド後の実物の確認は scripts/check-dist.mjs）。
const require = createRequire(import.meta.url);
const base = require('../build/electron-builder.base.cjs');
const shared = require('../build/electron-builder.shared.cjs');
const personal = require('../build/electron-builder.personal.cjs');

const envLike = (s) => /(^|\/)\.env(\.|$|\*)/.test(s.replace(/^!/, '')) && !s.includes('.env.example');
const extraFrom = (cfg) => (cfg.extraResources ?? []).map((r) => (typeof r === 'string' ? r : r.from));

describe('electron-builder 共通設定', () => {
  it('同梱ファイルはホワイトリスト（src・assets・package.json のみ。.env・docs・test・mocks・scripts・build を含まない）', () => {
    const includes = base.files.filter((f) => !f.startsWith('!'));
    expect(includes.sort()).toEqual(['assets/**/*', 'package.json', 'src/**/*'].sort());
    for (const f of includes) {
      expect(envLike(f)).toBe(false);
      expect(f).not.toMatch(/^(docs|test|mocks|scripts|build|node_modules)\b|^\*\*|^\*$/);
    }
    expect(base.asar).toBe(true);
  });

  it('配布物は実行ファイル一式の zip（9章#2。未署名の NSIS はスマート アプリ コントロールで止められるため使わない）', () => {
    expect(base.win.target).toEqual([{ target: 'zip', arch: ['x64'] }]);
    expect(base).not.toHaveProperty('nsis');
  });
});

describe('共有版の設定', () => {
  it('ビルド時の版を shared にする（edition.js の既定値）', () => {
    expect(shared.extraMetadata).toEqual({ mascotEdition: 'shared' });
  });

  it('.env を同梱しない（files・extraResources・extraFiles のいずれにも無い）', () => {
    for (const f of [...shared.files, ...extraFrom(shared), ...(shared.extraFiles ?? []).map((r) => (typeof r === 'string' ? r : r.from))]) {
      expect(envLike(f)).toBe(false);
    }
    expect(shared.files).toEqual(base.files);
  });

  it('セットアップ手順書（HTML）とライセンスを実行ファイルと同じフォルダに同梱する（zip を展開して目に入る・設定画面の「セットアップ手順を開く」）', () => {
    expect(shared.extraFiles).toEqual([
      { from: 'docs/setup-guide.html', to: 'セットアップ手順書.html' },
      { from: 'docs/setup-guide-images', to: 'setup-guide-images' },
      { from: 'LICENSE', to: 'LICENSE.txt' },
    ]);
    expect(shared.extraResources ?? []).toEqual([]);
  });

  it('出力先・ファイル名は個人版と分ける（取り違えて個人版を配らない）', () => {
    expect(shared.directories.output).toBe('dist/shared');
    expect(personal.directories.output).toBe('dist/personal');
    expect(shared.artifactName).toMatch(/^oshirase-mate-shared-/);
    expect(personal.artifactName).toMatch(/^oshirase-mate-personal-/);
  });
});

describe('個人版の設定', () => {
  it('ビルド時の版を personal にし、.env を resources/.env に置く（app.asar には入れない）', () => {
    expect(personal.extraMetadata).toEqual({ mascotEdition: 'personal' });
    expect(personal.extraResources).toEqual([{ from: '.env', to: '.env' }]);
    expect(personal.files).toEqual(base.files);
  });
});

describe('package.json のビルドスクリプト', () => {
  const pkg = require('../package.json');
  it('共有版はビルド後に check-dist で .env が無いことを確かめる。個人版はビルド前に .env を確かめる', () => {
    expect(pkg.scripts['dist:shared']).toMatch(/electron-builder .*electron-builder\.shared\.cjs && node scripts\/check-dist\.mjs post shared$/);
    expect(pkg.scripts['dist:personal']).toMatch(/^node scripts\/check-dist\.mjs pre personal && .*electron-builder\.personal\.cjs && node scripts\/check-dist\.mjs post personal$/);
  });

  it('ライセンスと公開リポジトリを示し、npm には公開しない（Phase 11）', () => {
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository?.url).toMatch(/github\.com\/katuo194\/oshirase-mate\.git$/);
    expect(pkg.private).toBe(true);
  });

  it('開発時の package.json には mascotEdition を書かない（開発時は personal、または config.json の値）', () => {
    expect(pkg).not.toHaveProperty('mascotEdition');
  });
});
