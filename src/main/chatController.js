// チャットウィンドウの段取り（F-16 / 3.5 / 3.7）。Electron に依存しない：セッション・読み上げ・ウィンドウ操作・タイマーは注入する。
//
// 役割：チャットセッション（gemini.js）に発言を渡し、応答の読み上げ（チャット専用の voiceReader インスタンス）と、
//       maxTurns 往復目の自動終了（応答と終了メッセージを送り、再生が終わる頃にウィンドウを閉じる）を指揮する。
//
// 読み上げ（v5.8）：
//   - voiceReader.js のチャット専用インスタンスを使う（通知の読み上げとスロットを共有せず、互いを中断しない）。再生はチャットウィンドウ側。
//   - 待ち行列を持たない。次の送信・ウィンドウ終了・ミュート・通知の読み上げ開始（pauseVoice）で前の音声を止めて破棄する。
//     ミュート中に発生した読み上げは合成せず（voiceReader が判定）、解除後に再生される経路は無い（3.7）。
//   - 最終往復は「応答＋終了メッセージ」を1回で合成し、再生の終わりからしばらく置いて閉じる。音声が無ければ読み終える時間だけ待つ。
//   - フォールバック応答（失敗時）は読み上げない。

/** 読み上げる文の最大長（音声が長くなりすぎないように）。 */
export const CHAT_SPEECH_MAX = 200;
/** 自動終了：音声の終わりからウィンドウを閉じるまでの間、下限・上限。音声が無い場合は下限だけ待つ（終了メッセージを読める時間）。 */
export const CLOSE_TAIL_MS = 1000;
export const CLOSE_MIN_MS = 4000;
export const CLOSE_MAX_MS = 20000;

/**
 * @param {object} deps
 * @param {ReturnType<import('./gemini.js').createChatSession>} deps.session
 * @param {{ prepare: Function, cancel: Function }} deps.voiceReader createVoiceReader() のチャット専用インスタンス
 * @param {() => { showRemainingCount: boolean }} deps.getConfig
 * @param {(channel: string, payload: unknown) => boolean} deps.sendToWindow チャットウィンドウへ送る（無ければ false）
 * @param {() => void} deps.closeWindow チャットウィンドウを閉じる
 * @param {() => void} [deps.onActivity] ユーザー操作があった（アイドルトークの再武装用）
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [deps.timers]
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createChatController({ session, voiceReader, getConfig, sendToWindow, closeWindow, onActivity = () => {}, timers = {}, log = console }) {
  const setTimer = timers.setTimeout ?? ((...a) => globalThis.setTimeout(...a));
  const clearTimer = timers.clearTimeout ?? ((...a) => globalThis.clearTimeout(...a));

  let seq = 0;
  /** 読み上げ中（準備中・再生待ち）の id */
  let voiceId = null;
  let closeTimer = null;
  let disposed = false;

  const view = () => ({ ...session.state(), showRemainingCount: getConfig().showRemainingCount });

  function stopVoice() {
    const id = voiceId;
    voiceId = null;
    if (id === null) return;
    voiceReader.cancel(id);
    sendToWindow('chat:stop-voice', { id });
  }

  /** 読み上げを準備して送る。音声の長さ（なければ null）を返す（最終往復のクローズ時刻の計算用）。 */
  async function speak(text) {
    const id = `chat:${++seq}`;
    voiceId = id;
    const voice = await voiceReader.prepare(id, text.length > CHAT_SPEECH_MAX ? text.slice(0, CHAT_SPEECH_MAX) : text);
    if (!voice) {
      if (voiceId === id) voiceId = null;
      return null;
    }
    // 準備中に次の送信・終了・通知の読み上げが始まった（stopVoice 済み）なら、届けずに捨てる
    if (disposed || voiceId !== id || !sendToWindow('chat:voice', { id, url: voice.url, volume: voice.volume, durationMs: voice.durationMs })) {
      voiceReader.cancel(id);
      return null;
    }
    log.info(`[chat] 読み上げ: ${id}（${voice.durationMs ?? '?'}ms）`);
    return voice.durationMs ?? null;
  }

  function scheduleClose(voiceMs) {
    clearTimer(closeTimer);
    const wait = voiceMs === null ? CLOSE_MIN_MS : Math.min(CLOSE_MAX_MS, Math.max(CLOSE_MIN_MS, voiceMs + CLOSE_TAIL_MS));
    closeTimer = setTimer(() => {
      closeTimer = null;
      if (!disposed) closeWindow();
    }, wait);
  }

  return {
    /** ウィンドウを開いたときの表示用の状態。 */
    getState: () => view(),

    /**
     * ユーザーの発言を送る。応答はここで返し（読み上げは並行して準備し、できたら chat:voice で送る）、最終往復なら自動終了を予約する。
     * @param {string} text
     */
    async send(text) {
      if (disposed) return { ok: false, reason: 'aborted' };
      onActivity();
      stopVoice(); // ユーザーが次へ進んだので、前の音声は止めて破棄（待ち行列は持たない）
      const result = await session.send(text);
      if (disposed || !result.ok) return result;
      onActivity();

      const shown = { ...result, showRemainingCount: getConfig().showRemainingCount };
      if (result.fallback) return shown;

      const speech = result.closing ? `${result.reply}${result.closing}` : result.reply;
      // 読み上げは応答を待たせず並行して準備する（4章の応答性と同じ構え）
      const spoken = speak(speech).catch((e) => {
        log.warn(`[chat] 読み上げの準備に失敗: ${e?.message ?? e}`);
        return null;
      });
      if (result.final) {
        // 応答を返した後に、音声の準備・再生を待ってからウィンドウを閉じる
        void spoken.then((ms) => {
          if (!disposed) scheduleClose(ms);
        });
      }
      return shown;
    },

    /** 通知の読み上げが始まった：チャットの音声は譲る（通知が優先）。 */
    pauseVoice: () => stopVoice(),

    /** チャットウィンドウが音声の再生を終えた／失敗した。音声ファイルを削除する。 */
    onVoiceDone(id) {
      if (typeof id !== 'string') return;
      voiceReader.cancel(id);
      if (voiceId === id) voiceId = null;
    },

    /** 設定（ミュート・ボイス音量）の変更をチャットウィンドウへ。ミュートなら再生中の音声も止めて捨てる。 */
    applySettings({ muted, voiceVolume }) {
      if (muted) stopVoice();
      sendToWindow('chat:settings', { muted, voiceVolume });
    },

    /** ウィンドウが閉じた：履歴・往復数・読み上げ・自動終了の予約をすべて破棄する（次回は新規の会話）。 */
    dispose() {
      disposed = true;
      clearTimer(closeTimer);
      closeTimer = null;
      const id = voiceId;
      voiceId = null;
      if (id !== null) voiceReader.cancel(id);
      session.reset();
      onActivity();
    },

    /** 新しいウィンドウを開く前の初期化（前回の dispose を解除する）。 */
    begin() {
      disposed = false;
      session.reset();
      clearTimer(closeTimer);
      closeTimer = null;
      onActivity();
    },
  };
}
