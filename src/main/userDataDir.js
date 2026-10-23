// userData の保存先フォルダ名（v5.12）。Electron を import しない（Vitest でテストするため）。
//
// Electron の userData は既定で %APPDATA%\<アプリ名> で、アプリ名は package.json の productName（無ければ name）で決まる。
// electron-builder の productName は実行ファイル名などに使われるだけで、同梱の package.json には入らないため、
// これまでは開発時・個人版・共有版とも name（my-mascot-app）のフォルダを使っていた。
//
// - 個人版・開発時：アプリ名の変更（name は oshirase-mate）で保存先が変わると、設定・トークン・取り込んだキャラクターが
//   引き継がれないため、旧名のフォルダに固定する。
// - 共有版：個人版と同じ PC で動かしても開発者のデータ（トークン・キャラクター等）が混ざらないよう、専用のフォルダにする。
//   判定は config.json を読まずに決まる版（ビルド時の版。ソースからの起動では .env の有無：edition.js・v5.19）だけで行う。
//   config.json の edition は保存先が決まるまで読めないため。
//   ソースを .env なしで起動したとき（GitHub から取得したソース）は共有版なので、配布版の zip と同じフォルダを使う。
export const USER_DATA_DIR_NAMES = Object.freeze({
  personal: 'my-mascot-app',
  shared: 'おしらせメイト',
});

/**
 * @param {'personal' | 'shared'} defaultEdition config.json を読まずに決まる版（resolveEdition の stored なし）
 * @returns {string}
 */
export function userDataDirName(defaultEdition) {
  return defaultEdition === 'shared' ? USER_DATA_DIR_NAMES.shared : USER_DATA_DIR_NAMES.personal;
}

/**
 * 固定する保存先フォルダ名。起動時に --user-data-dir が明示されていれば固定しない（null）：
 * 開発中に共有版の動きを確かめるとき、個人版のデータと混ざらない専用のフォルダで起動するため（docs/development.md。v5.15）。
 * 明示が無い普段の起動・配布版は userDataDirName のとおり。
 * @param {object} opts
 * @param {'personal' | 'shared'} opts.defaultEdition config.json を読まずに決まる版
 * @param {boolean} opts.hasUserDataDirSwitch 起動引数に --user-data-dir があるか
 * @returns {string | null}
 */
export function userDataDirToPin({ defaultEdition, hasUserDataDirSwitch }) {
  return hasUserDataDirSwitch ? null : userDataDirName(defaultEdition);
}
