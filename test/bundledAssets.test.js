// リポジトリの同梱キャラクターの素材（assets/characters。F-23）を確かめる。
// 画像・固定ボイスは素材を置くまで無いので、ここでは「置いてあるものが正しいか」を見る（全部そろっているかは npm run bundle:check と、
// 共有版のビルド後の check-dist が確かめる）。セリフを変えたのに固定ボイスを作り直し忘れた、もここで分かる。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetsDirOf, checkBundledCharacter } from '../scripts/bundled-assets.mjs';
import { BUNDLED_CHARACTER_IDS } from '../src/main/characterImport.js';

const root = path.resolve(import.meta.dirname, '..');
const assetsDir = assetsDirOf(root);

describe.each(BUNDLED_CHARACTER_IDS)('同梱キャラクターの素材：%s', (id) => {
  it('manifest.json が読め、声とクレジット表記がある', async () => {
    const r = await checkBundledCharacter(assetsDir, id);
    expect(r.problems.filter((p) => p.code === 'manifest' || p.code === 'voice')).toEqual([]);
  });

  it('画像を置いてあれば、取り込みと同じ決まり（400×400・RGBA・欠番のない連番）に合っている', async () => {
    const r = await checkBundledCharacter(assetsDir, id);
    // 置き場所だけ作った空のフォルダは「まだ置いていない」
    const hasPng = (folder) => fs.existsSync(folder) && fs.readdirSync(folder).some((n) => /\.png$/i.test(n));
    const placed = ['rest', 'notify'].some((f) => hasPng(path.join(assetsDir, id, f)));
    if (placed) expect(r.problems.filter((p) => p.code === 'images')).toEqual([]);
  });

  it('固定ボイスを作ってあれば、録音しておく文がすべて今の声で録音されている', async () => {
    const r = await checkBundledCharacter(assetsDir, id);
    if (fs.existsSync(path.join(assetsDir, id, 'voice', 'voices.json'))) expect(r.problems.filter((p) => p.code === 'voices')).toEqual([]);
  });
});
