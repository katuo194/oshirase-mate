// 設定画面の「Google 連携の準備」（Phase 12・v5.15）の各手順のボタンで開く Google Cloud Console のページ。Electron に依存しない純粋関数。
// 画面からは手順の名前（下の表のキー）だけを送り、URL はここで決める（画面から任意の URL を開けないようにするため）。
// Console の URL は Google 側の変更で変わることがあるため、変わったらこの表と手順書（docs/setup-guide.html）を直す。

/**
 * 手順の名前 → URL。
 *   apis     … 手順1：プロジェクトを作り（選び）、Calendar・Tasks・Gmail の 3 つの API を一度に有効にする
 *              （flows/enableapi の apiid にカンマ区切りで並べる形。Google の公式文書に定まった仕様は無いが、Google の Apigee のガイドで使われている）
 *   branding … 手順2：同意画面（Google Auth Platform のブランディング。未設定なら「開始」のウィザードになる）
 *   audience … 手順2：対象（公開ステータスを「本番環境」にする）
 *   client   … 手順3：クライアントの作成（種類はデスクトップ アプリ。作成直後の画面で JSON をダウンロードする）
 */
export const CONSOLE_LINKS = Object.freeze({
  apis: 'https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,tasks.googleapis.com,gmail.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  client: 'https://console.cloud.google.com/auth/clients/create',
});

/**
 * @param {unknown} step 画面から送られた手順の名前
 * @returns {string | null} 開く URL。知らない名前なら null
 */
export function consoleUrlFor(step) {
  if (typeof step !== 'string' || !Object.hasOwn(CONSOLE_LINKS, step)) return null;
  return CONSOLE_LINKS[step];
}
