// 設定の既定値・正規化・更新パッチ検証。Electron に依存しない純粋ロジック（Vitest でテスト可能にするため store.js から分離）。
// Phase 1 で扱うキー：character / muted / volume.sfx / volume.voice / launchAtLogin（6.1）。Phase 10 で displayMode（F-20）を追加。
// それ以外のキー（characterAnchor や将来 Phase のキー）はここでは一切扱わない。

export const DEFAULTS = Object.freeze({
  character: 'default',
  muted: false,
  volume: Object.freeze({ sfx: 0.8, voice: 1.0 }),
  launchAtLogin: false,
  displayMode: 'always',
});

/** 表示モード（F-20）：常時表示／通知時のみ表示 */
const DISPLAY_MODES = ['always', 'notifyOnly'];

const clamp01 = (n) => Math.min(1, Math.max(0, n));
// 0.01 刻みに丸める（スライダー由来の浮動小数誤差を保存しない）
const roundVolume = (n) => Math.round(clamp01(n) * 100) / 100;

const isBool = (v) => typeof v === 'boolean';
const isVolume = (v) => typeof v === 'number' && Number.isFinite(v);
const isDisplayMode = (v) => DISPLAY_MODES.includes(v);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 保存済みの生データ（欠損・型不正あり得る）を、Phase 1 対象キーのみの正規化済み設定にする。 */
export function normalizeSettings(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const v = isPlainObject(r.volume) ? r.volume : {};
  return {
    character: typeof r.character === 'string' && r.character !== '' ? r.character : DEFAULTS.character,
    muted: isBool(r.muted) ? r.muted : DEFAULTS.muted,
    volume: {
      sfx: isVolume(v.sfx) ? roundVolume(v.sfx) : DEFAULTS.volume.sfx,
      voice: isVolume(v.voice) ? roundVolume(v.voice) : DEFAULTS.volume.voice,
    },
    launchAtLogin: isBool(r.launchAtLogin) ? r.launchAtLogin : DEFAULTS.launchAtLogin,
    displayMode: isDisplayMode(r.displayMode) ? r.displayMode : DEFAULTS.displayMode,
  };
}

/**
 * レンダラー等からの更新パッチを検証する。許可するのは muted / volume.sfx / volume.voice / launchAtLogin / displayMode のみ。
 * character は設定画面からは変更不可（Phase 8：キャラクター選択画面から store.setCharacter の専用経路で変える）。未知キー・不正な型は黙って捨てる。
 * @returns {{ muted?: boolean, volume?: { sfx?: number, voice?: number }, launchAtLogin?: boolean, displayMode?: 'always' | 'notifyOnly' }}
 */
export function sanitizePatch(patch) {
  const out = {};
  if (!isPlainObject(patch)) return out;
  if (isBool(patch.muted)) out.muted = patch.muted;
  if (isBool(patch.launchAtLogin)) out.launchAtLogin = patch.launchAtLogin;
  if (isDisplayMode(patch.displayMode)) out.displayMode = patch.displayMode;
  if (isPlainObject(patch.volume)) {
    const volume = {};
    if (isVolume(patch.volume.sfx)) volume.sfx = roundVolume(patch.volume.sfx);
    if (isVolume(patch.volume.voice)) volume.voice = roundVolume(patch.volume.voice);
    if (Object.keys(volume).length > 0) out.volume = volume;
  }
  return out;
}

/**
 * 検証済みパッチと現在の設定を比較し、値が変わるキーだけを [ドット記法キー, 値] で返す。
 * store 側はこの1件ずつを store.set(key, value) で書く（設定全体を書き戻さないので、他のキーを壊さない）。
 */
export function diffPatch(current, patch) {
  const entries = [];
  if (patch.muted !== undefined && patch.muted !== current.muted) {
    entries.push(['muted', patch.muted]);
  }
  if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== current.launchAtLogin) {
    entries.push(['launchAtLogin', patch.launchAtLogin]);
  }
  if (patch.displayMode !== undefined && patch.displayMode !== current.displayMode) {
    entries.push(['displayMode', patch.displayMode]);
  }
  for (const k of ['sfx', 'voice']) {
    const next = patch.volume?.[k];
    if (next !== undefined && next !== current.volume[k]) {
      entries.push([`volume.${k}`, next]);
    }
  }
  return entries;
}
