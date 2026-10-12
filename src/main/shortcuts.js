// デスクトップ・スタートメニューのショートカット（F-19・v5.12）。Electron を import しない（shell・fs は注入）ので Vitest から直接テストできる。
//
// インストーラーを使わない（zip 配布：9章#2）ため、アプリ自身が設定画面のボタンで .lnk を作る。
// 作るのは配布版だけ（開発時の execPath は electron.exe で、アプリのパスを引数で渡す必要があり、配布物の利用者には関係がない）。
// zip を展開し直した・フォルダを移動したなどで、リンク先が今の実行ファイルと違う .lnk は 'stale'（作り直しを促す）とする。
import path from 'node:path';

export const SHORTCUT_LOCATIONS = Object.freeze(['desktop', 'startMenu']);
export const SHORTCUT_FILE_NAME = 'おしらせメイト.lnk';

/** Windows のパスとして同じ場所か（大文字小文字・区切り文字の違いを無視） */
const samePath = (a, b) => typeof a === 'string' && path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

/**
 * @param {object} opts
 * @param {boolean} opts.isPackaged
 * @param {string} opts.platform process.platform
 * @param {string} opts.execPath 今の実行ファイル（配布版では おしらせメイト.exe）
 * @param {{ desktop: string, startMenu: string }} opts.dirs 置き場所のフォルダ
 * @param {{ writeShortcutLink: Function, readShortcutLink: Function }} opts.shell Electron の shell
 * @param {{ existsSync: Function, unlinkSync: Function }} opts.fs
 * @param {string} opts.appUserModelId
 * @param {{ warn: Function }} [opts.log]
 */
export function createShortcuts({ isPackaged, platform, execPath, dirs, shell, fs, appUserModelId, log = { warn: () => {} } }) {
  const supported = isPackaged === true && platform === 'win32';
  const linkPath = (location) => path.win32.join(dirs[location], SHORTCUT_FILE_NAME);
  const isLocation = (location) => SHORTCUT_LOCATIONS.includes(location);

  /** @returns {'none' | 'ok' | 'stale'} */
  function stateOf(location) {
    const p = linkPath(location);
    if (!fs.existsSync(p)) return 'none';
    try {
      return samePath(shell.readShortcutLink(p).target, execPath) ? 'ok' : 'stale';
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
          cwd: path.win32.dirname(execPath),
          description: 'おしらせメイト',
          icon: execPath, // 実行ファイルに埋め込んだアイコン
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
