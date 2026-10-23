import Store from 'electron-store';
import { EventEmitter } from 'node:events';
import { diffPatch, normalizeSettings, sanitizePatch } from './settingsSchema.js';
import { normalizePollingConfig } from './pollingConfig.js';
import { normalizeVoicevoxConfig } from './voicevox.js';
import { normalizeIdleTalkConfig } from './idleTalk.js';
import { normalizeChatConfig } from './gemini.js';
import { resolveEdition } from './edition.js';
import { BUILD_EDITION, ENV_HAS_CREDENTIALS } from './buildInfo.js';

// config.json（6.1）。Phase 1 で扱うのは character / muted / volume / launchAtLogin と、Phase 0 の characterAnchor のみ。
// defaults は空のまま。既定値の補完は normalizeSettings が読み出し時に行う（保存値は変更されたキーだけが書かれる）。
const store = new Store({
  name: 'config',
  defaults: {},
});

// 設定が変わったときに ('change', settings) を発火する。
// 書き込み経路は updateSettings に一本化してあり、トレイ・設定画面・自動起動はこのイベントを購読して同期する。
export const settingsEvents = new EventEmitter();

export function loadCharacterAnchor() {
  const a = store.get('characterAnchor');
  if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
    return { x: a.x, y: a.y };
  }
  return null;
}

export function saveCharacterAnchor(anchor) {
  store.set('characterAnchor', { x: Math.round(anchor.x), y: Math.round(anchor.y) });
}

/** 設定ウィンドウの内容の大きさ（v5.19）。検証は settingsWindowSize.js の resolveSettingsWindowSize */
export function loadSettingsWindowSize() {
  return store.get('settingsWindowSize') ?? null;
}

export function saveSettingsWindowSize(size) {
  store.set('settingsWindowSize', { width: Math.round(size.width), height: Math.round(size.height) });
}

/** 正規化済みの設定（Phase 1 対象キーのみ）を返す。 */
export function getSettings() {
  return normalizeSettings({
    character: store.get('character'),
    muted: store.get('muted'),
    volume: store.get('volume'),
    launchAtLogin: store.get('launchAtLogin'),
    displayMode: store.get('displayMode'),
  });
}

/** ポーリング間隔と TODO 通知時刻（読み取り専用。Phase 4 では設定画面から変更しない）。 */
export function getPollingConfig() {
  return normalizePollingConfig({
    polling: store.get('polling'),
    taskNotifyHour: store.get('taskNotifyHour'),
  });
}

/** VOICEVOX の話者・速度・高さ（6.1。読み取り専用：話者選択UIは持たず、config.json を直接編集する）。 */
export function getVoicevoxConfig() {
  return normalizeVoicevoxConfig(store.get('voicevox'));
}

/** アイドルトークの有効・間隔・静粛時間帯（6.1 idleTalk。読み取り専用：config.json を直接編集する）。 */
export function getIdleTalkConfig() {
  return normalizeIdleTalkConfig(store.get('idleTalk'));
}

/** チャットの最大往復数・残り回数表示（6.1 chat。読み取り専用）。 */
export function getChatConfig() {
  return normalizeChatConfig(store.get('chat'));
}

/**
 * 個人版／共有版（2.5・6.1）。config.json に実際に保存された edition → ビルド時の既定値 → .env に資格情報があれば 'personal'、無ければ 'shared'（edition.js）。
 * store の defaults は空なので、store.get('edition') が値を返すのは config.json に本当に書かれているときだけ。
 * edition はアプリから書き込まない（ここにも settingsSchema.js にも既定値を足さないこと）。
 */
export function getEdition() {
  return resolveEdition({ stored: store.get('edition'), buildDefault: BUILD_EDITION, envHasCredentials: ENV_HAS_CREDENTIALS });
}

/**
 * 選択中のキャラクター（6.1 character）を変える。書くのは character キーだけ（characterAnchor 等の他のキーは書き換えない）。
 * 設定画面の updateSettings（sanitizePatch）は character を受け付けないため、キャラクター選択画面からはこの経路だけを使う。
 * @param {string} id 'default' または取り込み済みキャラクターの ID
 * @param {string[]} availableIds 選べる ID（'default' を含む）。含まれない ID は書かない
 * @returns {{ ok: boolean, settings: ReturnType<typeof getSettings> }}
 */
export function setCharacter(id, availableIds) {
  const current = getSettings();
  if (typeof id !== 'string' || !availableIds.includes(id)) return { ok: false, settings: current };
  if (current.character === id) return { ok: true, settings: current };
  store.set('character', id);
  const next = getSettings();
  settingsEvents.emit('change', next);
  return { ok: true, settings: next };
}

/**
 * 設定を部分更新する。パッチは検証され、値が変わるキーだけを個別に store.set する
 * （characterAnchor や将来のキーを上書きしない）。変更があれば 'change' を発火する。
 * @returns {ReturnType<typeof getSettings>} 更新後の設定
 */
export function updateSettings(patch) {
  const current = getSettings();
  const entries = diffPatch(current, sanitizePatch(patch));
  if (entries.length === 0) return current;

  for (const [key, value] of entries) store.set(key, value);

  const next = getSettings();
  settingsEvents.emit('change', next);
  return next;
}
