// 効果音の解決（F-12 / 3.7）。「鳴らすか・どのファイルか・音量は」を表示開始時に main 側で決め、
// レンダラーには { url, volume } か null（＝鳴らさない）だけを渡す。Electron に依存しない：ファイル有無・URL変換・ログは注入する。
//
//   ミュート中  … null（警告なし。効果音を停止・アニメーションと吹き出しは継続：3.7）
//   音量 0      … null（警告なし）
//   ファイル無し … null。無音で続行し、警告ログは種別（キー）ごとに1回だけ出す（2.7：素材は後から用意する前提）
//
// 探索順：notify_<sfxKey>.{mp3,wav,ogg} → notify.{mp3,wav,ogg}（共通フォールバック）

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SFX_EXTENSIONS = Object.freeze(['.mp3', '.wav', '.ogg']);

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * @param {object} opts
 * @param {string} opts.baseDir 効果音ディレクトリ（assets/sounds の絶対パス）
 * @param {(filePath: string) => boolean} opts.exists
 * @param {{ warn: Function }} [opts.log]
 * @param {(filePath: string) => string} [opts.toUrl] ファイルパス → レンダラーが読める URL
 * @returns {{ resolve: (args: { sfxKey: string, muted: boolean, volume: number }) => { url: string, volume: number } | null }}
 */
export function createSfxResolver({ baseDir, exists, log = console, toUrl = (p) => pathToFileURL(p).href }) {
  const warned = new Set();

  function findFile(sfxKey) {
    const names = sfxKey && sfxKey !== 'default' ? [`notify_${sfxKey}`, 'notify'] : ['notify'];
    for (const name of names) {
      for (const ext of SFX_EXTENSIONS) {
        const filePath = path.join(baseDir, name + ext);
        if (exists(filePath)) return filePath;
      }
    }
    return { missing: names };
  }

  return {
    resolve({ sfxKey, muted, volume }) {
      if (muted === true) return null;
      const v = Number.isFinite(volume) ? clamp01(volume) : 0;
      if (v <= 0) return null;

      const found = findFile(sfxKey);
      if (typeof found === 'string') return { url: toUrl(found), volume: v };

      const key = sfxKey || 'default';
      if (!warned.has(key)) {
        warned.add(key);
        log.warn(`[sfx] 効果音ファイルが見つからないため無音で続行します（${found.missing.join(' / ')}.{mp3,wav,ogg} を ${baseDir} に置いてください）`);
      }
      return null;
    },
  };
}
