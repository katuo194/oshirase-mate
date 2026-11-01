// 設定ウィンドウ（設定・キャラクターのタブ。3.6）の大きさ（v5.19）。Electron に依存しない純粋関数。
// 大きさは利用者が変えられ、閉じたときの大きさを config.json の settingsWindowSize に覚えて次に開くときに使う（位置は覚えない）。
// 幅が狭いときは、画面側（settings/style.css）が 2 列を 1 列に並べ替える。

/**
 * 初めて開くときの内容の大きさ（DIP）。縦長にして 1 列で並べる（幅 760 以下。Phase 16）。
 * 以前（v5.15）は 1 画面ですべて見えるよう横長（1000×660）にして 2 列にしていたが、Google 連携の準備を別のタブに分けて
 * 設定タブの項目が減ったため、無理に横長にしなくてよいとユーザーが判断した。広げれば今までどおり 2 列になる
 */
export const SETTINGS_DEFAULT_SIZE = Object.freeze({ width: 720, height: 760 });
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

/** 設定ウィンドウのタブ。'settings' … 設定、'google' … Google 連携（準備の手順。Phase 16）、'character' … キャラクター選択 */
export const SETTINGS_TABS = Object.freeze(['settings', 'google', 'character']);

/** @returns {value is 'settings' | 'google' | 'character'} */
export const isSettingsTab = (value) => SETTINGS_TABS.includes(value);
