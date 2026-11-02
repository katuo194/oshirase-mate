import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteImagesOf } from '../scripts/build-site.mjs';
import { EXTERNAL_LINKS } from '../src/main/externalLinks.js';

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

  it('手順書が参照する画面の写真（Phase 16）はすべて docs/setup-guide-images/ にあり、使っていない写真も無い', () => {
    const guide = read('docs/setup-guide.html');
    const used = [...new Set(guide.match(/setup-guide-images\/[\w.-]+/g) ?? [])].map((p) => p.replace('setup-guide-images/', '')).sort();
    expect(used.length).toBeGreaterThan(0);
    const files = fs.readdirSync(new URL('../docs/setup-guide-images/', import.meta.url)).sort();
    expect(files).toEqual(used);
  });

  it('手順書の中のリンク（#見出し）の行き先がすべてある', () => {
    const guide = read('docs/setup-guide.html');
    const ids = new Set([...guide.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of guide.matchAll(/href="#([^"]+)"/g)) expect(ids.has(target), target).toBe(true);
  });

  describe('ホームページとプライバシーポリシー（site/。Phase 16・付録 A-37）', () => {
    const pages = ['site/index.html', 'site/privacy.html'];

    it('本文に「共有版」「個人版」が出てこない', () => {
      for (const page of pages) for (const word of ['共有版', '個人版']) expect(withoutComments(read(page)), page).not.toContain(word);
    });

    it('ホームページはアプリの名前を見出しにして、プライバシーポリシーへリンクしている（Google の「ブランディング」の要件）', () => {
      const home = withoutComments(read('site/index.html'));
      expect(home).toContain('<h1>おしらせメイト</h1>');
      expect(home).toContain('href="privacy.html"');
    });

    it('プライバシーポリシーに、読み取るスコープと「限定使用」の一文がある', () => {
      const policy = withoutComments(read('site/privacy.html'));
      for (const scope of ['calendar.readonly', 'tasks.readonly', 'gmail.readonly']) expect(policy).toContain(scope);
      expect(policy).toContain('限定使用の要件を含む');
      expect(policy).toContain('including the Limited Use requirements');
      expect(policy).toContain('https://developers.google.com/terms/api-services-user-data-policy');
    });

    it('参照している画像は docs/images/ にあり、サイト内のリンクの行き先は書き出すファイルにある', () => {
      const published = new Set([...fs.readdirSync(new URL('../site/', import.meta.url)), 'setup-guide.html']);
      for (const page of pages) {
        const html = read(page);
        for (const image of siteImagesOf(html)) expect(fs.existsSync(new URL(`../docs/images/${image}`, import.meta.url)), image).toBe(true);
        for (const [, target] of html.matchAll(/href="(?!https:|#)([^"#]*)/g)) {
          if (target !== './') expect(published.has(target), `${page} → ${target}`).toBe(true);
        }
      }
    });
  });

  it('「Google 連携」タブのボタンで開くページは、すべて externalLinks の表にある（Phase 16）', () => {
    const html = read('src/renderer/settings/index.html');
    const names = [...html.matchAll(/data-link="([^"]+)"/g)].map((m) => m[1]);
    for (const name of ['projectCreate', 'apis', 'branding', 'audience', 'client']) expect(names).toContain(name);
    for (const name of names) expect(Object.hasOwn(EXTERNAL_LINKS, name), name).toBe(true);
  });
});
