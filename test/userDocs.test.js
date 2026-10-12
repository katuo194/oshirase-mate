import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// 利用者向けの文書・画面の文言（Phase 12・v5.15）。利用者に配るのは共有版だけなので、版の名前や開発の話を見せない。
// 開発者向けの内容は docs/development.md に置く。
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** HTML のコメントを除いた部分（コメントは開発者向け） */
const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

describe('利用者向けの文書・画面', () => {
  it('README に「個人版」「共有版」「ビルド」「npm」が出てこない', () => {
    const readme = read('README.md');
    for (const word of ['個人版', '共有版', 'ビルド', 'npm']) expect(readme).not.toContain(word);
  });

  it('README から開発者向けの説明（docs/development.md）と手順書（docs/setup-guide.html）へリンクしている', () => {
    const readme = read('README.md');
    expect(readme).toContain('(docs/development.md)');
    expect(readme).toContain('(docs/setup-guide.html)');
    expect(fs.existsSync(new URL('../docs/development.md', import.meta.url))).toBe(true);
  });

  it('セットアップ手順書（docs/setup-guide.html）の本文に「共有版」が出てこない', () => {
    expect(withoutComments(read('docs/setup-guide.html'))).not.toContain('共有版');
  });

  it('設定画面に「共有版」「配布版」が出てこない（見出しは「Google 連携の準備」）', () => {
    const html = withoutComments(read('src/renderer/settings/index.html'));
    expect(html).toContain('<h2>Google 連携の準備</h2>');
    // app.js の文字列（コメントを除く）にも出さない
    const js = read('src/renderer/settings/app.js')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    for (const word of ['共有版', '配布版']) {
      expect(html).not.toContain(word);
      expect(js).not.toContain(word);
    }
  });
});
