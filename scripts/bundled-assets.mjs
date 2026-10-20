// 同梱キャラクター（F-23・Phase 15）の素材の確認。scripts/bundle-character.mjs（check）と scripts/check-dist.mjs（共有版のビルド後）から使う。
// assets/characters/<id>/ に、manifest.json・必須のモーションの画像（取り込みと同じ ImageSequence の決まり）・件名なしの固定ボイスの文・
// 固定ボイス（voice/voices.json と WAV。録音しておく文がすべてそろっていること）があるかを確かめる。

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseBundledManifest } from '../src/main/bundledCharacters.js';
import { REQUIRED_SLOTS, SLOT_NAMES, createCharacterRepository, describeImportError, slotFolderName } from '../src/main/characterImport.js';
import { LINE_KIND_LABELS, NOTIFY_KINDS } from '../src/main/characterLines.js';
import { VOICE_DIR, VOICE_INDEX_FILE, parseVoiceIndex, recordingTexts, sameVoice } from '../src/main/fixedVoice.js';

/** リポジトリの中の同梱キャラクターの置き場所 */
export const assetsDirOf = (root) => path.join(root, 'assets', 'characters');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同梱キャラクター1体の素材を確かめる。
 * problems の code：manifest（manifest.json が無い・形が違う）／images（画像が無い・決まりに合わない）／
 *   voice（声・クレジット表記が無い）／fallback（件名なしの固定ボイスの文が無い）／voices（固定ボイスが無い・足りない・声が違う）
 * @param {string} assetsDir assets/characters
 * @param {string} id
 * @returns {Promise<{ id: string, problems: { code: string, message: string }[], frames: Record<string, number>, recorded: number, texts: number }>}
 */
export async function checkBundledCharacter(assetsDir, id) {
  const problems = [];
  const problem = (code, message) => problems.push({ code, message });
  const result = { id, problems, frames: {}, recorded: 0, texts: 0 };
  const dir = path.join(assetsDir, id);

  let raw;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    problem('manifest', `manifest.json を読めません（${e?.code ?? e?.message ?? e}）`);
    return result;
  }

  // 画像：取り込みと同じ決まり（400×400・RGBA・000 から欠番のない3桁連番）
  const inspector = createCharacterRepository({ rootDir: assetsDir, fs });
  for (const slot of SLOT_NAMES) {
    if (raw?.slots?.[slot] === null || raw?.slots?.[slot] === undefined) continue;
    const folder = path.join(dir, slotFolderName(slot));
    if (!(await exists(folder))) {
      if (REQUIRED_SLOTS.includes(slot)) problem('images', `${slotFolderName(slot)}/ がありません（必須）`);
      continue;
    }
    const inspected = await inspector.inspectFolder(folder);
    if (inspected.ok) result.frames[slot] = inspected.frameCount;
    else problem('images', `${slotFolderName(slot)}/：${describeImportError(inspected.error)}`);
  }

  // 画像がそろっていなくても、manifest の中身は確かめる（必須のモーションに仮の枚数を入れて読む）
  const counts = Object.fromEntries(SLOT_NAMES.map((s) => [s, result.frames[s] ?? (REQUIRED_SLOTS.includes(s) ? 1 : null)]));
  const manifest = parseBundledManifest(raw, id, counts);
  if (!manifest) {
    problem('manifest', 'manifest.json の形が正しくありません（version・id・displayName・slots の fps を確かめてください）');
    return result;
  }
  if (!manifest.voice) problem('voice', 'voice（話者・話速・音高）がありません');
  if (!manifest.voiceCredit) problem('voice', 'voiceCredit（「VOICEVOX:話者名」）がありません');
  for (const kind of NOTIFY_KINDS) {
    if (manifest.fallbackLines[kind].length === 0) problem('fallback', `件名なしの固定ボイスの文（${LINE_KIND_LABELS.notify[kind]}）がありません`);
  }

  // 固定ボイス：録音しておく文がすべて、今の声で録音されていること
  const texts = recordingTexts(manifest);
  result.texts = texts.length;
  let index = null;
  try {
    index = parseVoiceIndex(JSON.parse(await fs.readFile(path.join(dir, VOICE_DIR, VOICE_INDEX_FILE), 'utf8')));
  } catch {
    problem('voices', `${VOICE_DIR}/${VOICE_INDEX_FILE} がありません（npm run bundle:voices -- ${id}）`);
    return result;
  }
  if (!index) {
    problem('voices', `${VOICE_DIR}/${VOICE_INDEX_FILE} の形が正しくありません`);
    return result;
  }
  if (!sameVoice(index.voice, manifest.voice)) problem('voices', `録音の声が manifest.json の voice と違います（npm run bundle:voices -- ${id}）`);
  const missing = [];
  for (const text of texts) {
    const clip = index.clips.get(text);
    if (clip && (await exists(path.join(dir, VOICE_DIR, clip.file)))) result.recorded++;
    else missing.push(text);
  }
  if (missing.length > 0) problem('voices', `録音が無い文が ${missing.length} 件あります（npm run bundle:voices -- ${id}）。例：${missing[0]}`);
  return result;
}
