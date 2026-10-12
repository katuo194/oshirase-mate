// 設定画面のボタンで既定のブラウザに開く外部のページ（Phase 12・v5.15）。Electron に依存しない純粋関数。
// 画面からはリンクの名前（下の表のキー）だけを送り、URL はここで決める（画面から任意の URL を開けないようにするため）。
// Console の URL は Google 側の変更で変わることがあるため、変わったらこの表と手順書（docs/setup-guide.html）を直す。

/**
 * リンクの名前 → URL。
 * 「Google 連携の準備」（共有版のみ表示）
 *   apis      … 手順1：プロジェクトを作り（選び）、Calendar・Tasks・Gmail の 3 つの API を一度に有効にする
 *               （flows/enableapi の apiid にカンマ区切りで並べる形。Google の公式文書に定まった仕様は無いが、Google の Apigee のガイドで使われている）
 *   branding  … 手順2：同意画面（Google Auth Platform のブランディング。未設定なら「開始」のウィザードになる）
 *   audience  … 手順2：対象（公開ステータスを「本番環境」にする）
 *   client    … 手順3：クライアントの作成（種類はデスクトップ アプリ。作成直後の画面で JSON をダウンロードする）
 * ボイス欄・チャット欄（両版で表示）
 *   voicevox  … VOICEVOX の公式サイト（ダウンロード）
 *   geminiKey … Google AI Studio の API キーのページ
 */
export const EXTERNAL_LINKS = Object.freeze({
  apis: 'https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com,tasks.googleapis.com,gmail.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  client: 'https://console.cloud.google.com/auth/clients/create',
  voicevox: 'https://voicevox.hiroshiba.jp/',
  geminiKey: 'https://aistudio.google.com/apikey',
});

/**
 * @param {unknown} name 画面から送られたリンクの名前
 * @returns {string | null} 開く URL。知らない名前なら null
 */
export function externalUrlFor(name) {
  if (typeof name !== 'string' || !Object.hasOwn(EXTERNAL_LINKS, name)) return null;
  return EXTERNAL_LINKS[name];
}

/**
 * 開いてよい URL か（表にある URL そのものか）。main で shell.openExternal の直前にもう一度確かめる。
 * @param {unknown} url
 */
export function isExternalLinkUrl(url) {
  return typeof url === 'string' && Object.values(EXTERNAL_LINKS).includes(url);
}
