// electron-builder の共通設定（9章#2：実行ファイル一式の zip ＋セットアップ手順書。v5.11）。
// 版ごとの違い（ビルド時の既定の版・同梱物・出力先・ファイル名）は electron-builder.shared.cjs / electron-builder.personal.cjs で上書きする。
//
// NSIS インストーラーは採らない：electron-builder はアンインストーラーを作るためにビルド中に未署名のインストーラーを一度実行するが、
// スマート アプリ コントロールが有効な Windows ではその実行がアプリケーション制御ポリシーで止められ、ビルドできない
// （配布先でも未署名のインストーラーは「実行」を選べずに止められる）。コード署名は9章#8。
//
// 同梱するファイルはホワイトリストで指定する（.env・docs・test・mocks・scripts・build は入らない）。
// 秘密情報を含む .env は、個人版の設定でだけ extraResources として resources/.env に置く（共有版には含めない）。

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'local.mascot-notifier',
  // 旧名「通知マスコット」（v5.12で変更）。userData の保存先は productName ではなく package.json の name で決まり、旧名に固定している（src/main/userDataDir.js）。
  // appId は内部の識別子で、ショートカットの AppUserModelID にも使うため変えない
  productName: 'おしらせメイト',
  directories: {
    // ビルド用素材の置き場。icon.png（256×256 以上）を置くと electron-builder が実行ファイルのアイコンにする（F-19・v5.12）。
    // 無ければ Electron の既定アイコン。トレイのアイコンは assets/icons/icon.png（src/main/tray.js）
    buildResources: 'build/resources',
  },
  files: ['package.json', 'src/**/*', 'assets/**/*', '!**/*.map'],
  asar: true,
  npmRebuild: false,
  win: {
    target: [{ target: 'zip', arch: ['x64'] }],
  },
};
