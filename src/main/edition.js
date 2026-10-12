// 個人版／共有版（2.5・6.1）の解決。Electron に依存しない純粋関数（Vitest で直接テストする）。
//
// 版は次の順で決める（v5.11）：
//   1. config.json に実際に保存された edition（'personal' / 'shared'。開発・検証時に直接編集したときだけ存在する）
//   2. ビルド時の既定値（配布パッケージの package.json の mascotEdition。electron-builder の extraMetadata で埋め込む）
//   3. 'personal'
// 「保存されている」かは、スキーマや electron-store の既定値で埋まった値ではなく、本当に書かれた値で判定する。
// そのため settingsSchema.js・store.js の既定値に edition を加えてはいけない（加えるとビルド時の値が常に上書きされる）。
// アプリから edition を書き込む経路も持たない。
//
// 両版の違いは OAuth 資格情報の提供元と配布形態だけ（VOICEVOX は版によらず疎通確認で判定する：v5.11）。

export const EDITIONS = Object.freeze(['personal', 'shared']);

/** @returns {value is 'personal' | 'shared'} */
export const isEdition = (value) => EDITIONS.includes(value);

/**
 * @param {{ stored?: unknown, buildDefault?: unknown }} sources
 * @returns {'personal' | 'shared'}
 */
export function resolveEdition({ stored, buildDefault } = {}) {
  if (isEdition(stored)) return stored;
  if (isEdition(buildDefault)) return buildDefault;
  return 'personal';
}

/**
 * OAuth Client ID/Secret の提供元。個人版は .env（開発者のもの）、共有版は利用者が設定画面で入力したもの（2.4）。
 * @param {'personal' | 'shared'} edition
 * @returns {'env' | 'user'}
 */
export function oauthSourceFor(edition) {
  return edition === 'shared' ? 'user' : 'env';
}
