// notified.json（通知済みIDの履歴。6章）の読み書き。F-05「再起動後も再提示されない」の永続化層。
// store.js（electron-store）から分離してある：ここは機械が書く履歴でスキーマ検証も既定値補完も要らず、
// ファイルパスを注入できる方が一時ディレクトリでユニットテストできる（tokenStorage.js と同じ構え）。
// Electron に依存しない。
//
// ファイル形式：
//   { "version": 1, "notified": { "<通知ID>": <記録した時刻のエポックms> } }

import fs from 'node:fs/promises';
import path from 'node:path';

export const FORMAT_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * 保持期間を過ぎた記録を落とした新しいオブジェクトを返す（純粋関数）。
 * 記録時刻が数値でないものも、壊れた記録として同時に捨てる。
 */
export function purgeExpired(notified, nowMs, retentionMs) {
  const out = {};
  for (const [id, at] of Object.entries(notified ?? {})) {
    if (typeof at === 'number' && Number.isFinite(at) && nowMs - at < retentionMs) out[id] = at;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath notified.json のパス（userData 配下）
 * @param {() => number} [opts.now]
 * @param {number} [opts.retentionDays] 既定7日（6章）
 */
export function createNotifiedStore({ filePath, now = Date.now, retentionDays = DEFAULT_RETENTION_DAYS }) {
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  const remove = async () => {
    await fs.rm(filePath, { force: true });
  };

  /** 書き込み途中の中断で履歴を壊さないよう、一時ファイル経由で置き換える。 */
  async function writeFile(contents) {
    const tmp = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmp, contents);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // 保存先ディレクトリが無い場合だけ作って1度だけやり直す
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tmp, contents);
    }
    await fs.rename(tmp, filePath);
  }

  return {
    /**
     * 保持期間内の記録だけを返す。ファイルが無い・壊れている場合は空（壊れたファイルは削除する）。
     * 履歴を失っても最悪「一度出した通知がもう一度出る」だけで、起動が止まる方が害が大きい。
     * @returns {Promise<Record<string, number>>} 通知ID → 記録時刻
     */
    async load() {
      let text;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.notified !== 'object' || parsed.notified === null) {
          throw new Error('invalid content');
        }
        return purgeExpired(parsed.notified, now(), retentionMs);
      } catch {
        await remove();
        return {};
      }
    },

    /**
     * 履歴を丸ごと書き直す。書き込みのたびにもパージするので、長時間起動でも肥大しない。
     * @param {Record<string, number>} notified
     */
    async save(notified) {
      const purged = purgeExpired(notified, now(), retentionMs);
      await writeFile(JSON.stringify({ version: FORMAT_VERSION, notified: purged }));
      return purged;
    },

    remove,
  };
}
