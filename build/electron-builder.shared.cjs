// 共有版（知人グループへの配布用。2.4・2.5・9章#2）。
// - ビルド時の既定の版を shared にする（package.json の mascotEdition。edition.js の優先順位 2 番目）
// - 開発者の OAuth 資格情報（.env）は含めない。利用者が設定画面で自分の Client ID/Secret を入力する
// - セットアップ手順書（HTML）を実行ファイルと同じフォルダに置く（zip を展開して最初に目に入る。設定画面の「セットアップ手順を開く」でアプリ内のウィンドウに開く）
// - ライセンス（MIT）を LICENSE.txt として同じフォルダに置く（GitHub で配布する：Phase 11。Electron 自身のものは electron-builder が LICENSE.electron.txt として置く）
const base = require('./electron-builder.base.cjs');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  directories: { ...base.directories, output: 'dist/shared' },
  extraMetadata: { mascotEdition: 'shared' },
  extraFiles: [
    { from: 'docs/shared-edition-setup.html', to: 'セットアップ手順書.html' },
    { from: 'LICENSE', to: 'LICENSE.txt' },
  ],
  artifactName: 'oshirase-mate-shared-${version}-win-${arch}.${ext}',
};
