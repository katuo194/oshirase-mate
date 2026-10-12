const { contextBridge, ipcRenderer } = require('electron');

// メイン → レンダラーは「コールバック登録」だけを公開する（ipcRenderer や event オブジェクトは渡さない）
const subscribe = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

// チャットウィンドウ用（F-16）。Gemini のキー・リクエストはメインだけが扱い、ここへは発言と応答のテキストしか渡らない
contextBridge.exposeInMainWorld('chatApi', {
  getState: () => ipcRenderer.invoke('chat:get-state'), // { turn, max, remaining, finished, busy, showRemainingCount }
  send: (text) => ipcRenderer.invoke('chat:send', String(text)), // 応答 { ok, reply, closing, turn, max, remaining, final, fallback, showRemainingCount } または { ok:false, reason }
  voiceDone: (id) => ipcRenderer.send('chat:voice-done', String(id)), // 読み上げの再生が終わった（音声ファイルをメインが削除する）
  onVoice: subscribe('chat:voice'), // { id, url, volume, durationMs }：応答の読み上げ音声
  onStopVoice: subscribe('chat:stop-voice'), // { id }：再生中の音声を止める（通知の読み上げが優先・次の送信・ミュート）
  onSettings: subscribe('chat:settings'), // { muted, voiceVolume }
});
