// 通知1件の読み上げの段取り（F-13 / 3.7）。Electron に依存しない：voicevox・設定・ファイル操作・URL変換はすべて注入する。
//
//   prepare(id, text) … 読み上げるべきか判定 → 合成 → userData/tts/<一意名>.wav に保存 → { url, durationMs, volume } を返す。
//                       読み上げない・できないときは null（サイレントにスキップ。表示は音声を待たずに進んでいる）
//   cancel(id)        … 表示が終わった（完了・タイムアウト・中断）。合成中なら中断し、保存済みのファイルは削除する
//   cleanupDir()      … 起動時に tts/ の残骸（前回の強制終了などで消えなかったもの）を削除する
//   willSpeak(text)   … prepare が合成に進むか（ミュート・音量0・文なしでなければ true）
//
// ミュート（3.7：ミュート中に発生した読み上げは破棄し、解除後にまとめて再生しない）：
//   - 開始時にミュート → 合成しない
//   - 合成中にミュートされた → 完了時に再判定して破棄（ファイルも作らない）
//   - 再生中のミュートはレンダラーが止める（mascot:settings）
// 読み上げの待ち行列は持たない。扱うのは「いま表示中の1件」だけなので、ミュート解除後に再生される経路が存在しない。
// ボイス音量0でも合成しない。版（個人版／共有版）では判定しない：VOICEVOX が起動していれば両版とも読み上げる（v5.11）。
// 起動していないときは voicevox.synthesize の起動確認で分かり、サイレントにスキップする。

import path from 'node:path';
import { VoicevoxError, wavDurationMs } from './voicevox.js';

/**
 * @param {object} deps
 * @param {{ synthesize: Function }} deps.voicevox voicevox.js の createVoicevox()
 * @param {() => { muted: boolean, volume: { voice: number } }} deps.getSettings
 * @param {() => { speakerId: number, speedScale: number, pitchScale: number }} deps.getVoiceConfig
 * @param {string} deps.dir userData/tts
 * @param {{ writeFile: Function, rm: Function, mkdir: Function, readdir: Function }} deps.fs node:fs/promises 互換
 * @param {(filePath: string) => string} deps.toUrl
 * @param {() => string} deps.randomId
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createVoiceReader({ voicevox, getSettings, getVoiceConfig, dir, fs, toUrl, randomId, log = console }) {
  /** 表示中の1件の読み上げ。{ id, controller, filePath } */
  let current = null;

  async function removeFile(filePath) {
    if (!filePath) return;
    try {
      await fs.rm(filePath, { force: true });
    } catch (e) {
      log.warn(`[voice] 音声ファイルを削除できません: ${e?.message ?? e}`);
    }
  }

  /** 読み上げない理由（読み上げるなら null）。 */
  function skipReason(text) {
    if (typeof text !== 'string' || text.trim() === '') return 'no-text';
    const s = getSettings();
    if (s.muted) return 'muted';
    if (!(s.volume.voice > 0)) return 'volume-zero';
    return null;
  }

  return {
    /**
     * @param {string} id 表示中の presentation.id
     * @param {string | null} text 読み上げる文（notificationView.toSpeechText）
     * @returns {Promise<{ url: string, filePath: string, durationMs: number | null, volume: number } | null>}
     */
    async prepare(id, text) {
      const reason = skipReason(text);
      if (reason !== null) {
        if (reason === 'muted') log.info(`[voice] ミュート中のため読み上げを破棄: ${id}`);
        return null;
      }

      if (current) this.cancel(current.id); // 通常は起きない（表示は1件ずつ）
      const entry = { id, controller: new AbortController(), filePath: null };
      current = entry;
      const isCurrent = () => current === entry;

      let wav;
      try {
        wav = await voicevox.synthesize(text, { ...getVoiceConfig(), volumeScale: 1.0 }, { signal: entry.controller.signal });
      } catch (e) {
        if (isCurrent()) current = null;
        // 未起動・失敗はサイレントにスキップ（状態の変化とログは voicevox.js が出す）。中断は表示が先に終わっただけ
        if (!(e instanceof VoicevoxError)) log.warn(`[voice] 読み上げの準備に失敗: ${e?.message ?? e}`);
        return null;
      }

      if (!isCurrent()) return null; // 合成中に表示が終わった
      if (getSettings().muted) {
        current = null;
        log.info(`[voice] 合成中にミュートされたため読み上げを破棄: ${id}`);
        return null;
      }

      const filePath = path.join(dir, `${randomId()}.wav`);
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, wav);
      } catch (e) {
        if (isCurrent()) current = null;
        log.warn(`[voice] 音声ファイルを保存できません: ${e?.message ?? e}`);
        await removeFile(filePath);
        return null;
      }
      if (!isCurrent()) {
        await removeFile(filePath); // 保存中に表示が終わった
        return null;
      }
      entry.filePath = filePath;
      return { url: toUrl(filePath), filePath, durationMs: wavDurationMs(wav), volume: getSettings().volume.voice };
    },

    /** 表示の終了。合成中なら中断し、保存済みのファイルを削除する。id が違えば何もしない。 */
    cancel(id) {
      if (!current || current.id !== id) return;
      const { controller, filePath } = current;
      current = null;
      controller.abort();
      void removeFile(filePath);
    },

    /** 起動時の掃除：tts/ に残った .wav を消す。 */
    async cleanupDir() {
      let names;
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        if (e?.code !== 'ENOENT') log.warn(`[voice] tts ディレクトリを確認できません: ${e?.message ?? e}`);
        return 0;
      }
      const wavs = names.filter((n) => n.endsWith('.wav'));
      await Promise.all(wavs.map((n) => removeFile(path.join(dir, n))));
      if (wavs.length > 0) log.info(`[voice] 前回の音声ファイルを削除: ${wavs.length}件`);
      return wavs.length;
    },

    /**
     * この文を今読み上げる（合成に進む）か。表示の開始時に「音声が届くまで吹き出しを保持するか」を決めるのに使う。
     * @param {string | null} text
     */
    willSpeak: (text) => skipReason(text) === null,

    /** 読み上げ準備中・再生待ちの id（なければ null）。 */
    currentId: () => current?.id ?? null,
  };
}
