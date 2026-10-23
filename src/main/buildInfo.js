// ビルド時に埋め込まれた情報（package.json）。配布パッケージでは electron-builder の extraMetadata が
// package.json に mascotEdition（'shared' / 'personal'）を書き込む（build/electron-builder.*.cjs）。開発時は未設定。
// ソースから起動したとき（mascotEdition なし）は、プロジェクト直下の .env に Client ID/Secret があるかで版を決める（edition.js。v5.19）。
// store.js・pinUserDataDir.js から読む。テストではこのモジュールを vi.mock で差し替える。

import dotenv from 'dotenv';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasEnvCredentials } from './edition.js';

/**
 * @param {string} [packageJsonPath]
 * @returns {string | null} package.json の mascotEdition（無い・読めなければ null。値の検証は edition.js）
 */
export function readBuildEdition(packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg?.mascotEdition === 'string' ? pkg.mascotEdition : null;
  } catch {
    return null;
  }
}

/**
 * .env に Client ID と Secret が両方入っているか（値は返さない・ログにも出さない）。無い・読めなければ false。
 * @param {string} [envPath] 既定はプロジェクト直下（package.json と同じフォルダ。index.js が開発時に読む .env と同じ）
 */
export function readEnvHasCredentials(envPath = fileURLToPath(new URL('../../.env', import.meta.url))) {
  try {
    return hasEnvCredentials(dotenv.parse(fs.readFileSync(envPath)));
  } catch {
    return false;
  }
}

export const BUILD_EDITION = readBuildEdition();

/** ソースからの起動で .env に資格情報があるか。配布パッケージ（ビルド時の版あり）では読まない（使わないため true にしておく） */
export const ENV_HAS_CREDENTIALS = BUILD_EDITION === null ? readEnvHasCredentials() : true;
