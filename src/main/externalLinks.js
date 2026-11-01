// 設定画面のボタンで既定のブラウザに開く外部のページ（Phase 12・v5.15）。Electron に依存しない純粋関数。
// 画面からはリンクの名前（下の表のキー）だけを送り、URL はここで決める（画面から任意の URL を開けないようにするため）。
// Console の URL は Google 側の変更で変わることがあるため、変わったらこの表と手順書（docs/setup-guide.html）を直す。

/**
 * リンクの名前 → URL。
 * 「Google 連携」タブの「自分でクライアントを作る」（共有版のみ表示。Phase 16 で手順 1 を 1-a・1-b に分けた）
 *   projectCreate … 手順1-a：プロジェクトを作る。はじめての人が apis から作ると、作成後に API の画面へ戻らず「ようこそ」の画面になる（実機で確認）ため分けた
 *   apis      … 手順1-b：Calendar・Tasks・Gmail の 3 つの API を一度に有効にする（「プロジェクトを確認」→「APIs を有効にする」の 2 段）
 *               （flows/enableapi の apiid にカンマ区切りで並べる形。Google の公式文書に定まった仕様は無いが、Google の Apigee のガイドで使われている）
 *   branding  … 手順2：Google Auth Platform を設定する（ブランディング。未設定なら「開始」→ アプリ情報・対象・連絡先情報・終了）
 *   audience  … 手順2：対象（テストユーザーに自分を追加する。ボタンは日本語の画面でも「Add users」）
 *   client    … 手順3：クライアントの作成（種類はデスクトップ アプリ。作成直後の画面で JSON をダウンロードする）
 * ボイス欄・チャット欄（両版で表示）
 *   voicevox  … VOICEVOX の公式サイト（ダウンロード）
 *   geminiKey … Google AI Studio の API キーのページ
 */
export const EXTERNAL_LINKS = Object.freeze({
  projectCreate: 'https://console.cloud.google.com/projectcreate',
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
