// 選択中のキャラクターの manifest から、状態（rest / notify.*）→ 再生するモーションを解決する（F-17・2.6）。純粋関数。
//
// スロットのフォールバック：notify.calendar / notify.tasks / notify.gmail が未設定なら notify を使う。
// 状態 → スロット：通知の種別（presentation.kind）で notify.<kind>、アプリからのお知らせ（system）・未知の種別は notify、
// アイドルトーク（idle）は rest のまま（v5.8：通知の動きを使わない軽い表現）。
//
// レンダラーへ送る描画情報（buildCharacterView）は、フォールバックを解決済みの形にして送る：
//   sources    … 実際にデコードするスロット（設定済みのものだけ。同じ画像を二重にデコードしない）
//   stateSlots … 状態 → sources のキー（レンダラーは引くだけ。判断はここに集約する）

import { SLOT_NAMES, characterFrameUrl } from './characterImport.js';
import { CHARACTER_SIZE } from './windowLayout.js';

/** 組み込みの既定キャラクター（黄色い丸。Canvas の手続き描画） */
export const DEFAULT_VIEW = Object.freeze({ type: 'procedural', id: 'default', canvasSize: CHARACTER_SIZE });

/** 種別ごとのスロットを持つ通知（notificationView.js の kind） */
const NOTIFY_KINDS = Object.freeze(['calendar', 'tasks', 'gmail']);

/**
 * 表示の状態 → 使いたいスロット名（フォールバック前）。
 * @param {{ phase: 'rest' | 'notify', kind?: string }} state
 */
export function slotForState({ phase, kind }) {
  if (phase !== 'notify' || kind === 'idle') return 'rest';
  return NOTIFY_KINDS.includes(kind) ? `notify.${kind}` : 'notify';
}

/**
 * スロット名 → 実際に再生するモーション（未設定の notify.* は notify へ）。
 * @param {object} manifest parseManifest 済み
 * @param {string} slot
 * @returns {{ slot: string, folder: string, frameCount: number, fps: number } | null}
 */
export function resolveMotion(manifest, slot) {
  const v = manifest?.slots?.[slot];
  if (v) return { slot, folder: v.folder, frameCount: v.frameCount, fps: v.fps };
  if (slot.startsWith('notify.')) return resolveMotion(manifest, 'notify');
  return null;
}

/**
 * レンダラー（renderer/mascot/character.js）へ送る描画情報。manifest が無ければ既定キャラクター。
 * @param {object | null} manifest
 * @param {(id: string, folder: string, index: number, revision?: string) => string} [toUrl]
 */
export function buildCharacterView(manifest, toUrl = characterFrameUrl) {
  if (!manifest) return DEFAULT_VIEW;
  const sources = {};
  for (const slot of SLOT_NAMES) {
    const v = manifest.slots[slot];
    if (!v) continue;
    sources[slot] = {
      frameCount: v.frameCount,
      fps: v.fps,
      urls: Array.from({ length: v.frameCount }, (_, i) => toUrl(manifest.id, v.folder, i, manifest.updatedAt)),
    };
  }
  const stateSlots = {
    rest: resolveMotion(manifest, slotForState({ phase: 'rest' })).slot,
    idle: resolveMotion(manifest, slotForState({ phase: 'notify', kind: 'idle' })).slot,
    notify: resolveMotion(manifest, slotForState({ phase: 'notify', kind: 'system' })).slot,
  };
  for (const kind of NOTIFY_KINDS) stateSlots[kind] = resolveMotion(manifest, slotForState({ phase: 'notify', kind })).slot;
  return {
    type: 'frames',
    id: manifest.id,
    // 編集されたら変わる（同じ ID でも画像を読み直す：window.js）
    revision: manifest.updatedAt,
    displayName: manifest.displayName,
    canvasSize: manifest.canvasSize,
    sources,
    stateSlots,
  };
}
