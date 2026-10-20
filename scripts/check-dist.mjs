// 配布ビルドの前後の確認（9章#2・#3。v5.11）。
//   node scripts/check-dist.mjs pre personal  … ビルド前：.env があり、Client ID/Secret の形式が正しいこと（個人版は .env を同梱する）
//   node scripts/check-dist.mjs post shared   … ビルド後：共有版に .env が含まれていないこと、ビルド時の版が shared であること、手順書と LICENSE.txt があること、
//                                               同梱キャラクター（F-23）の素材がそろっていて app.asar に入っていること
//   node scripts/check-dist.mjs post personal … ビルド後：個人版に resources/.env があり、ビルド時の版が personal であること
// 値そのものは表示しない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { validateOAuthEnv } from '../src/main/authCore.js';
import { BUNDLED_CHARACTER_IDS } from '../src/main/characterImport.js';
import { assetsDirOf, checkBundledCharacter } from './bundled-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [phase, edition] = process.argv.slice(2);

function fail(message) {
  console.error(`[check-dist] NG: ${message}`);
  process.exit(1);
}
const ok = (message) => console.log(`[check-dist] OK: ${message}`);

if (!['pre', 'post'].includes(phase) || !['shared', 'personal'].includes(edition)) {
  fail('使い方: node scripts/check-dist.mjs <pre|post> <shared|personal>');
}

if (phase === 'pre') {
  if (edition === 'personal') {
    const envPath = path.join(root, '.env');
    if (!fs.existsSync(envPath)) fail('.env がありません（個人版は .env を同梱します。.env.example を参照）');
    const v = validateOAuthEnv(dotenv.parse(fs.readFileSync(envPath)));
    if (!v.ok) fail(`.env の値に問題があります: ${v.reason}`);
    ok('.env の Client ID/Secret の形式');
  }
  process.exit(0);
}

// post：win-unpacked の中身を確かめる
const resources = path.join(root, 'dist', edition, 'win-unpacked', 'resources');
if (!fs.existsSync(resources)) fail(`${path.relative(root, resources)} がありません（先にビルドしてください）`);

let asar;
try {
  asar = await import('@electron/asar'); // electron-builder の依存として入っている
} catch {
  fail('@electron/asar を読み込めません（npm install を確認してください）');
}
const archive = path.join(resources, 'app.asar');
const files = asar.listPackage(archive, {}).map((f) => f.replaceAll('\\', '/'));
const envInAsar = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'));
if (envInAsar.length > 0) fail(`app.asar に .env が含まれています: ${envInAsar.join(', ')}`);
const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
if (pkg.mascotEdition !== edition) fail(`ビルド時の版が ${edition} ではありません（mascotEdition=${pkg.mascotEdition}）`);
ok(`ビルド時の版 = ${edition}、app.asar に .env なし`);

const envInResources = fs.existsSync(path.join(resources, '.env'));
if (edition === 'shared') {
  if (envInResources) fail('共有版の resources/.env が存在します（開発者の資格情報を配布してしまいます）');
  // 実行ファイルのフォルダ全体（= zip の中身）にも .env が無いこと
  const appDir = path.dirname(resources);
  const stray = fs.readdirSync(appDir, { recursive: true }).map(String).filter((f) => /(^|[\\/])\.env(\.|$)/.test(f));
  if (stray.length > 0) fail(`共有版に .env が含まれています: ${stray.join(', ')}`);
  if (!fs.existsSync(path.join(appDir, 'セットアップ手順書.html'))) fail('実行ファイルと同じフォルダに セットアップ手順書.html がありません');
  if (!fs.existsSync(path.join(appDir, 'LICENSE.txt'))) fail('実行ファイルと同じフォルダに LICENSE.txt がありません');
  const zips = fs.readdirSync(path.join(root, 'dist', edition)).filter((f) => f.endsWith('.zip'));
  if (zips.length === 0) fail('配布用の zip がありません');
  ok(`.env なし、セットアップ手順書・LICENSE.txt あり、配布物: ${zips.join(', ')}`);

  // 同梱キャラクター（F-23）：素材がそろっていて（画像・セリフ・固定ボイス）、そのすべてが app.asar に入っていること。
  // GitHub から zip を入れた利用者が、VOICEVOX が無くても同梱キャラクターを使えるようにする
  const assetsDir = assetsDirOf(root);
  for (const id of BUNDLED_CHARACTER_IDS) {
    const r = await checkBundledCharacter(assetsDir, id);
    if (r.problems.length > 0) fail(`同梱キャラクター ${id} の素材がそろっていません（npm run bundle:check）: ${r.problems.map((p) => p.message).join(' / ')}`);
    const sources = fs.readdirSync(path.join(assetsDir, id), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    const packed = new Set(files);
    const absent = sources
      .map((e) => `/${path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/')}`)
      .filter((f) => !packed.has(f));
    if (absent.length > 0) fail(`app.asar に同梱キャラクターのファイルが入っていません: ${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ' ほか' : ''}`);
    ok(`同梱キャラクター ${id}（${Object.entries(r.frames).map(([s, n]) => `${s} ${n}枚`).join('・')}、録音 ${r.recorded}文）`);
  }
} else {
  if (!envInResources) fail('個人版の resources/.env がありません');
  ok('resources/.env あり（個人版。配布しないこと）');
}
