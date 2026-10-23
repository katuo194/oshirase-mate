// 設定ウィンドウ（設定・キャラクターのタブ。3.6）の大きさ（v5.19）。Electron に依存しない純粋関数。
// 大きさは利用者が変えられ、閉じたときの大きさを config.json の settingsWindowSize に覚えて次に開くときに使う（位置は覚えない）。
// 幅が狭いときは、画面側（settings/style.css）が 2 列を 1 列に並べ替える。

/** 初めて開くときの内容の大きさ（DIP）。1 画面ですべて見えるよう横長にして 2 列で並べる（v5.15） */
export const SETTINGS_DEFAULT_SIZE = Object.freeze({ width: 1000, height: 660 });
/** これより小さくはできない（1 列に並べたときに入力欄が潰れない幅・タブと数項目が見える高さ） */
export const SETTINGS_MIN_SIZE = Object.freeze({ width: 520, height: 420 });

/**
 * 開くときの大きさ。覚えた大きさが無い・壊れていれば既定の大きさ。どちらも最小以上・作業領域以下にそろえる
 * （作業領域の高さからはタイトルバーの分として 40 を引く。作業領域が最小より小さいときは作業領域に合わせる）。
 * @param {unknown} saved config.json の settingsWindowSize
 * @param {{ width: number, height: number }} workArea 開くディスプレイの作業領域
 * @returns {{ width: number, height: number }}
 */
export function resolveSettingsWindowSize(saved, workArea) {
  const valid = (v) => Number.isFinite(v) && v > 0;
  const base =
    saved && typeof saved === 'object' && valid(saved.width) && valid(saved.height)
      ? { width: Math.round(saved.width), height: Math.round(saved.height) }
      : SETTINGS_DEFAULT_SIZE;
  const maxWidth = workArea.width;
  const maxHeight = workArea.height - 40;
  return {
    width: Math.min(Math.max(base.width, SETTINGS_MIN_SIZE.width), maxWidth),
    height: Math.min(Math.max(base.height, SETTINGS_MIN_SIZE.height), maxHeight),
  };
}

/** 設定ウィンドウのタブ。'settings' … 設定、'character' … キャラクター選択 */
export const SETTINGS_TABS = Object.freeze(['settings', 'character']);

/** @returns {value is 'settings' | 'character'} */
export const isSettingsTab = (value) => SETTINGS_TABS.includes(value);
