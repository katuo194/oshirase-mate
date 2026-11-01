// 個人版／共有版（2.5・6.1）の解決。Electron に依存しない純粋関数（Vitest で直接テストする）。
//
// 版は次の順で決める（v5.11。4 は v5.19）：
//   1. config.json に実際に保存された edition（'personal' / 'shared'。開発・検証時に直接編集したときだけ存在する）
//   2. ビルド時の既定値（配布パッケージの package.json の mascotEdition。electron-builder の extraMetadata で埋め込む）
//   3. ソースから起動していて、プロジェクト直下の .env に Client ID と Secret が両方入っていれば 'personal'
//   4. それ以外（GitHub から取得したソースを .env なしで起動したとき）は 'shared'。設定画面の「Google 連携」タブで
//      クライアントを読み込めば連携できる（配布版の zip と同じ）
// 「保存されている」かは、スキーマや electron-store の既定値で埋まった値ではなく、本当に書かれた値で判定する。
// そのため settingsSchema.js・store.js の既定値に edition を加えてはいけない（加えるとビルド時の値が常に上書きされる）。
// アプリから edition を書き込む経路も持たない。
//
// 両版の違いは OAuth 資格情報の提供元と配布形態だけ（VOICEVOX は版によらず疎通確認で判定する：v5.11）。

import { ENV_CLIENT_ID, ENV_CLIENT_SECRET } from './authCore.js';

export const EDITIONS = Object.freeze(['personal', 'shared']);

/** @returns {value is 'personal' | 'shared'} */
export const isEdition = (value) => EDITIONS.includes(value);

/**
 * @param {{ stored?: unknown, buildDefault?: unknown, envHasCredentials?: boolean }} sources
 *   envHasCredentials … ソースからの起動で .env に Client ID と Secret が入っているか（buildInfo.js。省略時は入っているとみなす）
 * @returns {'personal' | 'shared'}
 */
export function resolveEdition({ stored, buildDefault, envHasCredentials = true } = {}) {
  if (isEdition(stored)) return stored;
  if (isEdition(buildDefault)) return buildDefault;
  return envHasCredentials === false ? 'shared' : 'personal';
}

/**
 * .env（dotenv.parse の結果）に Client ID と Secret が両方入っているか。形式は見ない
 * （値が入っていて形式が誤っている .env は個人版のまま起動し、設定画面にエラーを出す。気づかないうちに共有版に切り替わらないため）。
 * @param {Record<string, string | undefined> | null} env
 */
export function hasEnvCredentials(env) {
  return Boolean(env?.[ENV_CLIENT_ID]?.trim() && env?.[ENV_CLIENT_SECRET]?.trim());
}

/**
 * OAuth Client ID/Secret の提供元。個人版は .env（開発者のもの）、共有版は利用者が設定画面で入力したもの（2.4）。
 * @param {'personal' | 'shared'} edition
 * @returns {'env' | 'user'}
 */
export function oauthSourceFor(edition) {
  return edition === 'shared' ? 'user' : 'env';
}
