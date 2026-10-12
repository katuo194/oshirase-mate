// デスクトップ・スタートメニューのショートカット（F-19・v5.12）。Electron を import しない（shell・fs は注入）ので Vitest から直接テストできる。
//
// インストーラーを使わない（zip 配布：9章#2）ため、アプリ自身が設定画面のボタンで .lnk を作る。
// zip を展開し直した・フォルダを移動したなどで、リンク先が今の実行ファイルと違う .lnk は 'stale'（作り直しを促す）とする。
// ソースから起動しているとき（npm start・npx electron .）も作れる（v5.15）。そのときの execPath は Electron 本体（node_modules の中）なので、
// 引数にアプリのフォルダ（と、起動時に明示された --user-data-dir）を付け、配布版のものと混ざらないよう別の名前（おしらせメイト（開発）.lnk）にする。
import path from 'node:path';

export const SHORTCUT_LOCATIONS = Object.freeze(['desktop', 'startMenu']);
export const SHORTCUT_FILE_NAME = 'おしらせメイト.lnk';
export const DEV_SHORTCUT_FILE_NAME = 'おしらせメイト（開発）.lnk';

/** Windows のパスとして同じ場所か（大文字小文字・区切り文字の違いを無視） */
const samePath = (a, b) => typeof a === 'string' && path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

/**
 * Electron の shell.readShortcutLink が返す args の長さの上限（MAX_PATH − 1）。.lnk には全文が保存されている（WScript.Shell で確認）が、
 * 読み戻すと先頭の 259 文字に切れるため、それ以上の長さの引数は先頭が一致すれば同じとみなす（ソースからの起動で保存先を指定すると超えることがある）
 */
export const READ_ARGS_LIMIT = 259;

/** 読み戻した引数が、作るときの引数と同じか */
const sameArgs = (read, args) => read === args || (read.length >= READ_ARGS_LIMIT && args.startsWith(read));

/** コマンドラインの値を引用符で囲む（パスに空白・日本語を含むため。Windows のパスに " は使えないので取り除くだけでよい） */
const quote = (s) => `"${String(s).replaceAll('"', '')}"`;

/**
 * ソースから起動しているときのショートカットの引数（Electron 本体に渡す）。
 * @param {{ appPath: string, userDataDir?: string | null }} dev
 *   appPath … アプリのフォルダ（app.getAppPath()）
 *   userDataDir … 起動時に --user-data-dir が明示されていればその場所（共有版の動作確認で、同じ保存先で起動し直すため）。無ければ null
 * @returns {string}
 */
export function devLaunchArgs({ appPath, userDataDir = null }) {
  return [quote(appPath), ...(userDataDir ? [`--user-data-dir=${quote(userDataDir)}`] : [])].join(' ');
}

/**
 * @param {object} opts
 * @param {string} opts.platform process.platform
 * @param {string} opts.execPath 今の実行ファイル（配布版では おしらせメイト.exe、ソースからの起動では electron.exe）
 * @param {{ appPath: string, userDataDir?: string | null } | null} [opts.dev] ソースから起動しているとき（app.isPackaged が false）。配布版は null
 * @param {{ desktop: string, startMenu: string }} opts.dirs 置き場所のフォルダ
 * @param {{ writeShortcutLink: Function, readShortcutLink: Function }} opts.shell Electron の shell
 * @param {{ existsSync: Function, unlinkSync: Function }} opts.fs
 * @param {string} opts.appUserModelId
 * @param {{ warn: Function }} [opts.log]
 */
export function createShortcuts({ platform, execPath, dev = null, dirs, shell, fs, appUserModelId, log = { warn: () => {} } }) {
  const supported = platform === 'win32';
  const fileName = dev ? DEV_SHORTCUT_FILE_NAME : SHORTCUT_FILE_NAME;
  const args = dev ? devLaunchArgs(dev) : '';
  const linkPath = (location) => path.win32.join(dirs[location], fileName);
  const isLocation = (location) => SHORTCUT_LOCATIONS.includes(location);

  /** @returns {'none' | 'ok' | 'stale'} */
  function stateOf(location) {
    const p = linkPath(location);
    if (!fs.existsSync(p)) return 'none';
    try {
      const link = shell.readShortcutLink(p);
      // 引数が違う（ソースのフォルダを移した・保存先が違う）ものも作り直しを促す
      return samePath(link.target, execPath) && sameArgs(link.args ?? '', args) ? 'ok' : 'stale';
    } catch {
      return 'stale'; // 壊れた .lnk も作り直しで直る
    }
  }

  /** @returns {{ supported: boolean, desktop: 'none'|'ok'|'stale', startMenu: 'none'|'ok'|'stale' }} */
  function status() {
    if (!supported) return { supported: false, desktop: 'none', startMenu: 'none' };
    return { supported: true, desktop: stateOf('desktop'), startMenu: stateOf('startMenu') };
  }

  const fail = (reason) => ({ ok: false, reason, ...status() });

  return {
    status,

    /** 作成（既にあれば作り直す） */
    create(location) {
      if (!supported) return fail('unsupported');
      if (!isLocation(location)) return fail('invalid_location');
      const p = linkPath(location);
      let ok = false;
      try {
        ok = shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', {
          target: execPath,
          ...(dev ? { args } : {}),
          cwd: dev ? dev.appPath : path.win32.dirname(execPath),
          description: dev ? 'おしらせメイト（開発）' : 'おしらせメイト',
          icon: execPath, // 実行ファイルに埋め込んだアイコン（ソースからの起動では Electron のアイコン）
          iconIndex: 0,
          appUserModelId,
        });
      } catch (e) {
        log.warn(`[shortcut] 作成に失敗: ${e?.message ?? e}`);
      }
      return ok ? { ok: true, ...status() } : fail('write_failed');
    },

    /** 削除（アプリが作る名前の .lnk だけ。無ければ何もしない） */
    remove(location) {
      if (!supported) return fail('unsupported');
      if (!isLocation(location)) return fail('invalid_location');
      const p = linkPath(location);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) {
        log.warn(`[shortcut] 削除に失敗: ${e?.message ?? e}`);
        return fail('remove_failed');
      }
      return { ok: true, ...status() };
    },
  };
}
