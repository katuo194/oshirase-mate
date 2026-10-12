// userData の保存先フォルダ名（v5.12）。Electron を import しない（Vitest でテストするため）。
//
// Electron の userData は既定で %APPDATA%\<アプリ名> で、アプリ名は package.json の productName（無ければ name）で決まる。
// electron-builder の productName は実行ファイル名などに使われるだけで、同梱の package.json には入らないため、
// これまでは開発時・個人版・共有版とも name（my-mascot-app）のフォルダを使っていた。
//
// - 個人版・開発時：アプリ名の変更（name は oshirase-mate）で保存先が変わると、設定・トークン・取り込んだキャラクターが
//   引き継がれないため、旧名のフォルダに固定する。
// - 共有版：個人版と同じ PC で動かしても開発者のデータ（トークン・キャラクター等）が混ざらないよう、専用のフォルダにする。
//   判定はビルド時の版（package.json の mascotEdition）だけで行う。config.json の edition は保存先が決まるまで読めないため。
export const USER_DATA_DIR_NAMES = Object.freeze({
  personal: 'my-mascot-app',
  shared: 'おしらせメイト',
});

/**
 * @param {string | null} buildEdition package.json の mascotEdition（buildInfo.js。開発時は null）
 * @returns {string}
 */
export function userDataDirName(buildEdition) {
  return buildEdition === 'shared' ? USER_DATA_DIR_NAMES.shared : USER_DATA_DIR_NAMES.personal;
}
