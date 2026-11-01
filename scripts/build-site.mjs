// ホームページとプライバシーポリシー（GitHub Pages。Phase 16・要件定義書 付録 A-37）で公開するファイルを 1 つのフォルダに集める。
// .github/workflows/pages.yml から呼ぶ。手元で見た目を確かめるときにも使える（出力をブラウザで開く）。
//
//   node scripts/build-site.mjs [出力先]   … 既定は _site/（.gitignore 済み）。中身は毎回作り直す
//
// 集めるもの：
//   site/ の中身                                       → そのまま
//   site/*.html が参照する images/<名前>              → docs/images/<名前>（README と同じ画像。参照していない画像は出さない）
//   docs/setup-guide.html と docs/setup-guide-images/ → setup-guide.html と setup-guide-images/（zip に入れる手順書と同じもの）

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, process.argv[2] ?? '_site');

/** HTML が参照する images/ の画像の名前（重複なし） */
export const siteImagesOf = (html) => [...new Set([...html.matchAll(/["(]images\/([\w.-]+)/g)].map((m) => m[1]))];

async function main() {
  if (!out.startsWith(root + path.sep) || out === path.join(root, 'site')) throw new Error(`出力先がおかしい: ${out}`);
  await fs.rm(out, { recursive: true, force: true });
  await fs.cp(path.join(root, 'site'), out, { recursive: true });

  const images = new Set();
  for (const name of await fs.readdir(path.join(root, 'site'))) {
    if (name.endsWith('.html')) for (const image of siteImagesOf(await fs.readFile(path.join(root, 'site', name), 'utf8'))) images.add(image);
  }
  await fs.mkdir(path.join(out, 'images'), { recursive: true });
  for (const image of images) await fs.copyFile(path.join(root, 'docs', 'images', image), path.join(out, 'images', image));

  await fs.copyFile(path.join(root, 'docs', 'setup-guide.html'), path.join(out, 'setup-guide.html'));
  await fs.cp(path.join(root, 'docs', 'setup-guide-images'), path.join(out, 'setup-guide-images'), { recursive: true });

  console.log(`${path.relative(root, out)}/ に書き出しました（画像 ${images.size} 枚）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
