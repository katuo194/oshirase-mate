// ビルド時に埋め込まれた情報（package.json）。配布パッケージでは electron-builder の extraMetadata が
// package.json に mascotEdition（'shared' / 'personal'）を書き込む（build/electron-builder.*.cjs）。開発時は未設定。
// store.js から読む。テストではこのモジュールを vi.mock で差し替える。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

export const BUILD_EDITION = readBuildEdition();
