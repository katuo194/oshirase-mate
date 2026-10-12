// 自動起動の適用。Electron を import しない（app は呼び出し側から渡す）ので、Vitest から直接テストできる。

/**
 * setLoginItemSettings に渡すオプションを組み立てる（純粋関数）。
 * 未パッケージ（`electron .` での開発実行）では execPath が electron.exe になるため、
 * アプリのパスを args に渡さないと、ログイン時に素の Electron が起動してしまう。
 */
export function loginItemOptions({ openAtLogin, isPackaged, execPath, appPath }) {
  if (isPackaged) return { openAtLogin };
  return { openAtLogin, path: execPath, args: [appPath] };
}

/** @param {Electron.App} app */
export function applyLoginItem(app, openAtLogin) {
  app.setLoginItemSettings(
    loginItemOptions({
      openAtLogin,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    }),
  );
}
