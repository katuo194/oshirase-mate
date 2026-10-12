// セットアップ手順書ウィンドウ（共有版。F-18・v5.11）のリンクの扱い。Electron に依存しない純粋関数（Vitest で直接テストする）。
// 手順書はアプリ内のウィンドウで開く（.html の既定アプリが VS Code 等のエディターの PC があり、shell.openPath ではブラウザで開くとは限らないため）。
//   in-page  … 手順書の中の見出しへの移動（同じファイルの #アンカー）。そのままウィンドウ内で移動する
//   external … https のリンク（Google Cloud Console・VOICEVOX 等）。既定のブラウザで開き、ウィンドウは移動しない
//   block    … それ以外（別のローカルファイル・http・javascript: 等）。何もしない

/**
 * @param {string} url 移動先
 * @param {string} manualUrl 手順書自身の file:// URL
 * @returns {'in-page' | 'external' | 'block'}
 */
export function classifyManualLink(url, manualUrl) {
  let target;
  let self;
  try {
    target = new URL(url);
    self = new URL(manualUrl);
  } catch {
    return 'block';
  }
  if (target.protocol === 'https:') return 'external';
  if (target.protocol === 'file:' && self.protocol === 'file:' && target.pathname === self.pathname && target.search === self.search) {
    return 'in-page';
  }
  return 'block';
}
