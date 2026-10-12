// 個人版（開発者本人用。2.3・9章#3）。開発者の OAuth 資格情報（.env）を resources/.env に同梱する。
// 配布しないこと（.env を含むため）。ビルド前に scripts/check-dist.mjs が .env の有無・形式を確かめる。
const base = require('./electron-builder.base.cjs');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  directories: { ...base.directories, output: 'dist/personal' },
  extraMetadata: { mascotEdition: 'personal' },
  extraResources: [{ from: '.env', to: '.env' }],
  artifactName: 'oshirase-mate-personal-${version}-win-${arch}.${ext}',
};
