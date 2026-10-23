// キャラクター作成・編集画面のフォルダ選択ダイアログで最初に開く場所（3.6。Phase 16 の前の修正・v5.19）。Electron に依存しない（fs を注入する）。
//
// 次の順で決める：
//   1. 前に選んだフォルダの親（アプリの起動中だけ覚える）。EmoteLab はキャラクターごとのフォルダの下にモーションのフォルダを
//      書き出すので、待機を選んだ後は同じキャラクターの他のモーションをすぐ選べる
//   2. EmoteLab の書き出し先（ドキュメント\EmoteLab\Export）。ドキュメントの場所は Electron の app.getPath('documents') で受け取る
//      （OneDrive へ移していても正しい場所になる）
//   3. どちらも無ければ undefined（OS の既定の場所）

import path from 'node:path';

/** EmoteLab の書き出し先（ドキュメントからの相対） */
export const EMOTELAB_EXPORT_DIR = path.join('EmoteLab', 'Export');

/**
 * @param {{ stat: (p: string) => Promise<{ isDirectory(): boolean }> }} fs
 * @param {string} dir
 */
async function isDirectory(fs, dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string | null} opts.lastPicked 前に選んだフォルダ（無ければ null）
 * @param {string} opts.documentsDir ドキュメントのフォルダ
 * @param {{ stat: (p: string) => Promise<{ isDirectory(): boolean }> }} opts.fs
 * @returns {Promise<string | undefined>}
 */
export async function resolveFolderDialogStart({ lastPicked, documentsDir, fs }) {
  if (typeof lastPicked === 'string' && path.isAbsolute(lastPicked)) {
    const parent = path.dirname(lastPicked);
    if (await isDirectory(fs, parent)) return parent;
  }
  if (typeof documentsDir === 'string' && documentsDir !== '') {
    const exportDir = path.join(documentsDir, EMOTELAB_EXPORT_DIR);
    if (await isDirectory(fs, exportDir)) return exportDir;
  }
  return undefined;
}
