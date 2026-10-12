// ログ出力（4章「ログ」）。コンソールと userData/logs/app-YYYY-MM-DD.log（ローカル日付ごとのファイル）の両方へ出す。
// 自動起動時などコンソールが見えない状況でも、後から通知の検知履歴を確認できるようにするため。
// Electron に依存しない：出力先ディレクトリ・時刻・コンソールは注入する。
//
// 保持期間（9章#4）：今日を含め RETENTION_DAYS 日分を残し、それより古い app-YYYY-MM-DD.log を削除する。
// notifiedStore.js と同じく「起動時（createLogger）と書き込み時（日付が変わって最初の書き込み）」の両方で行う。
// 判定は mtime ではなくファイル名の日付。パターンに合わないファイルは決して消さない。
// トークン・Client Secret・メール本文は絶対に渡さないこと（呼び出し側の責務）。

import fs from 'node:fs';
import path from 'node:path';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export const DEFAULT_RETENTION_DAYS = 14;
const LOG_FILE = /^app-(\d{4}-\d{2}-\d{2})\.log$/;

/** ローカル時刻の日付 "YYYY-MM-DD"。 */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ローカル時刻 "YYYY-MM-DD HH:mm:ss.SSS"。 */
export function localTimestamp(ms) {
  const d = new Date(ms);
  return `${localDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 保持期間を過ぎたログファイル名を返す（純粋関数）。今日を含め retentionDays 日分（ローカル日付）を残す。
 * @param {string[]} names ディレクトリ内のファイル名
 * @param {number} nowMs
 * @param {number} retentionDays
 * @returns {string[]}
 */
export function expiredLogFiles(names, nowMs, retentionDays = DEFAULT_RETENTION_DAYS) {
  const d = new Date(nowMs);
  // 暦日で数える（ミリ秒の引き算だと夏時間の23/25時間日にずれる）
  const oldestKept = localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (Math.max(1, retentionDays) - 1)).getTime());
  return names.filter((name) => {
    const m = LOG_FILE.exec(name);
    return m !== null && m[1] < oldestKept; // YYYY-MM-DD は文字列比較で日付順になる
  });
}

/**
 * @param {object} opts
 * @param {string} opts.dir ログの出力先（userData/logs）
 * @param {() => number} [opts.now]
 * @param {Pick<Console, 'log' | 'warn' | 'error'>} [opts.console]
 * @param {number} [opts.retentionDays] 既定14日（9章#4）
 */
export function createLogger({ dir, now = Date.now, console: out = console, retentionDays = DEFAULT_RETENTION_DAYS }) {
  let dirReady = false;
  let fileFailed = false;
  /** 最後にパージした日付（ローカル）。日付が変わった最初の書き込みで再びパージする */
  let purgedDate = null;

  function purge(t) {
    purgedDate = localDate(t);
    let removed = 0;
    try {
      for (const name of expiredLogFiles(fs.readdirSync(dir), t, retentionDays)) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
          removed++;
        } catch (e) {
          out.warn(`[logger] 古いログを削除できません: ${name}: ${e?.message ?? e}`);
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') out.warn(`[logger] ログの保持期間の確認に失敗: ${e?.message ?? e}`);
    }
    if (removed > 0) write('info', [`[logger] 保持期間(${retentionDays}日)を過ぎたログを削除: ${removed}件`]);
  }

  function write(level, args) {
    const message = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    const t = now();
    if (purgedDate !== localDate(t)) purge(t); // purge 内の write では purgedDate が今日なので再帰しない
    const line = `${localTimestamp(t)} ${level.toUpperCase().padEnd(5)} ${message}`;

    (level === 'error' ? out.error : level === 'warn' ? out.warn : out.log)(line);

    // ファイルに書けなくてもアプリは止めない（一度だけコンソールに知らせる）。同期書き込みなので順序は保たれ、強制終了でも失われにくい
    try {
      if (!dirReady) {
        fs.mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      fs.appendFileSync(path.join(dir, `app-${localDate(t)}.log`), `${line}\n`);
    } catch (e) {
      if (!fileFailed) {
        fileFailed = true;
        out.error(`[logger] cannot write log file: ${e?.message ?? e}`);
      }
    }
  }

  purge(now());

  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}
