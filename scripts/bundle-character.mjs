// 同梱キャラクター（F-23・Phase 15）の素材を作る・確かめる開発用のスクリプト。手順は docs/development.md。
//
//   node scripts/bundle-character.mjs check [id…]
//     … 画像・manifest.json・件名なしの固定ボイスの文・固定ボイスがそろっているかを確かめる（id を省くと全員）
//   node scripts/bundle-character.mjs export <id> [--user-data-dir <dir>]
//     … アプリの編集画面で保存した声・キャラクター設定・セリフ（userData/characters/<id>-profile.json）を manifest.json に書き戻す。
//       userData は既定で %APPDATA%\my-mascot-app（開発時・個人版の保存先。src/main/userDataDir.js）
//   node scripts/bundle-character.mjs voices <id…> [--force]
//     … VOICEVOX（localhost:50021）を起動した状態で、録音しておく文（fixedVoice.recordingTexts）をすべて合成して voice/ に書き出す。
//       同じ文・同じ声の録音があれば作り直さない（--force で全部作り直す）。使わなくなった WAV は消す。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetsDirOf, checkBundledCharacter } from './bundled-assets.mjs';
import { BUNDLED_MANIFEST_VERSION, parseFallbackLines, profileFileName } from '../src/main/bundledCharacters.js';
import { BUNDLED_CHARACTER_IDS } from '../src/main/characterImport.js';
import { parseLines } from '../src/main/characterLines.js';
import { parseDefaultProfile, parseVoice } from '../src/main/characterProfile.js';
import { VOICE_DIR, VOICE_INDEX_FILE, VOICE_INDEX_VERSION, clipFileName, parseVoiceIndex, recordingTexts, sameVoice } from '../src/main/fixedVoice.js';
import { USER_DATA_DIR_NAMES } from '../src/main/userDataDir.js';
import { createVoicevox, wavDurationMs } from '../src/main/voicevox.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = assetsDirOf(root);
const [command, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(`[bundle] NG: ${message}`);
  process.exit(1);
}

/** 引数から --name value を取り出し、残りを id として返す */
function parseArgs(args) {
  const opts = {};
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') opts.force = true;
    else if (args[i] === '--user-data-dir') opts.userDataDir = args[++i];
    else ids.push(args[i]);
  }
  for (const id of ids) if (!BUNDLED_CHARACTER_IDS.includes(id)) fail(`同梱キャラクターの id ではありません: ${id}（${BUNDLED_CHARACTER_IDS.join(' / ')}）`);
  return { opts, ids };
}

const manifestPath = (id) => path.join(assetsDir, id, 'manifest.json');
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const writeJson = (p, value) => fs.writeFile(p, `${JSON.stringify(value, null, 2)}\n`);

async function check(ids) {
  let ng = false;
  for (const id of ids.length > 0 ? ids : BUNDLED_CHARACTER_IDS) {
    const r = await checkBundledCharacter(assetsDir, id);
    const frames = Object.entries(r.frames).map(([s, n]) => `${s} ${n}枚`).join('・') || '画像なし';
    console.log(`[bundle] ${id}：${frames}／録音 ${r.recorded}/${r.texts}`);
    for (const p of r.problems) console.log(`  - [${p.code}] ${p.message}`);
    if (r.problems.length > 0) ng = true;
  }
  if (ng) fail('そろっていない素材があります');
  console.log('[bundle] OK: 同梱キャラクターの素材がそろっています');
}

async function exportProfile(ids, { userDataDir }) {
  if (ids.length !== 1) fail('使い方: npm run bundle:export -- <id> [--user-data-dir <dir>]');
  const [id] = ids;
  const dataDir = userDataDir ?? path.join(process.env.APPDATA ?? '', USER_DATA_DIR_NAMES.personal);
  const profilePath = path.join(dataDir, 'characters', profileFileName(id));
  let profile;
  try {
    profile = parseDefaultProfile(await readJson(profilePath));
  } catch {
    fail(`${profilePath} がありません（アプリの編集画面で「保存」してから実行してください）`);
  }
  const manifest = await readJson(manifestPath(id));
  if (manifest?.version !== BUNDLED_MANIFEST_VERSION) fail(`${manifestPath(id)} の形が正しくありません`);
  manifest.voice = profile.voice;
  manifest.persona = profile.persona;
  manifest.lines = profile.lines;
  manifest.updatedAt = new Date().toISOString();
  await writeJson(manifestPath(id), manifest);
  const count = (group) => Object.values(profile.lines[group]).reduce((n, a) => n + a.length, 0);
  console.log(`[bundle] ${id}：声・キャラクター設定・セリフ（通知 ${count('notify')}文・アイドルトーク ${count('idle')}文・チャット ${count('chat')}文）を manifest.json に書き戻しました`);
  if (!profile.voice) console.log('  - 声が「指定しない」です。固定ボイスを作るには話者を選んで保存し直してください');
  console.log(`  次は VOICEVOX を起動して npm run bundle:voices -- ${id}`);
}

async function voices(ids, { force }) {
  if (ids.length === 0) fail('使い方: npm run bundle:voices -- <id…> [--force]');
  const voicevox = createVoicevox({ fetch: globalThis.fetch, log: { info: () => {}, warn: (m) => console.warn(m) } });
  for (const id of ids) {
    const raw = await readJson(manifestPath(id));
    const voice = parseVoice(raw.voice);
    if (!voice) fail(`${id}：manifest.json に voice（話者）がありません`);
    const texts = recordingTexts({ lines: parseLines(raw.lines), fallbackLines: parseFallbackLines(raw.fallbackLines) });
    const dir = path.join(assetsDir, id, VOICE_DIR);
    await fs.mkdir(dir, { recursive: true });
    let old = null;
    try {
      old = parseVoiceIndex(await readJson(path.join(dir, VOICE_INDEX_FILE)));
    } catch {
      // 初めて作る
    }
    const reusable = old && sameVoice(old.voice, voice) && !force ? old.clips : new Map();

    const clips = {};
    let made = 0;
    for (const [i, text] of texts.entries()) {
      const file = clipFileName(text, voice);
      const prev = reusable.get(text);
      if (prev?.file === file) {
        try {
          await fs.access(path.join(dir, file));
          clips[text] = { file, durationMs: prev.durationMs };
          continue;
        } catch {
          // ファイルが無い：作り直す
        }
      }
      process.stdout.write(`[bundle] ${id}：合成 ${i + 1}/${texts.length} ${text}\n`);
      let wav;
      try {
        wav = await voicevox.synthesize(text, { ...voice, volumeScale: 1.0 });
      } catch (e) {
        fail(`${id}：合成できませんでした（VOICEVOX は起動していますか？）: ${e?.message ?? e}`);
      }
      await fs.writeFile(path.join(dir, file), wav);
      clips[text] = { file, durationMs: wavDurationMs(wav) };
      made++;
    }
    await writeJson(path.join(dir, VOICE_INDEX_FILE), { version: VOICE_INDEX_VERSION, voice, clips });

    // 使わなくなった録音を消す
    const used = new Set(Object.values(clips).map((c) => c.file));
    let removed = 0;
    for (const name of await fs.readdir(dir)) {
      if (name.endsWith('.wav') && !used.has(name)) {
        await fs.rm(path.join(dir, name));
        removed++;
      }
    }
    console.log(`[bundle] ${id}：${texts.length}文（新しく合成 ${made}・削除 ${removed}）`);
  }
}

const { opts, ids } = parseArgs(rest);
switch (command) {
  case 'check':
    await check(ids);
    break;
  case 'export':
    await exportProfile(ids, opts);
    break;
  case 'voices':
    await voices(ids, opts);
    break;
  default:
    fail('使い方: node scripts/bundle-character.mjs <check|export|voices> …');
}
