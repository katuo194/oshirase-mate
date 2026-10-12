const { contextBridge, ipcRenderer } = require('electron');

// メイン → レンダラーは「コールバック登録」だけを公開する（ipcRenderer や event オブジェクトは渡さない）
const subscribe = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('mascot', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('mascot:set-ignore-mouse', ignore),
  dragStart: () => ipcRenderer.send('mascot:drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('mascot:drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('mascot:drag-end'),
  showContextMenu: () => ipcRenderer.send('mascot:context-menu'),

  // Phase 5：通知の演出
  ready: () => ipcRenderer.send('mascot:ready'), // リスナー登録後に1回呼ぶ（メインが以降の演出・バッジを送り始める）
  showDone: (id) => ipcRenderer.send('mascot:show-done', String(id)), // 演出（出現→待機→退場）が終わった
  // ウィンドウ拡大・縮小の切り替え（ちらつき対策。手順は main/window.js）：
  onLayoutPrepare: subscribe('mascot:layout-prepare'), // { seq, layout }：キャラクターを隠して新しい配置へ再配置する
  layoutReady: (seq) => ipcRenderer.send('mascot:layout-ready', seq), // 隠した状態を描画した（メインがウィンドウを切り替えてよい）
  onLayoutCommit: subscribe('mascot:layout-commit'), // { seq }：ウィンドウを切り替えた。リサイズの反映後にキャラクターを再表示する
  onShow: subscribe('mascot:show'), // { presentation, sfx }
  onSummary: subscribe('mascot:summary'), // { text: string | null }：サマリバッジ
  onSettings: subscribe('mascot:settings'), // { muted, sfxVolume, voiceVolume }

  // Phase 6
  onVoice: subscribe('mascot:voice'), // { id, url, volume, durationMs }：表示中の通知の読み上げ音声（url: null は合成できなかった）
  onOffline: subscribe('mascot:offline'), // { offline }：オフライン表示（F-14）

  // Phase 7
  onAbort: subscribe('mascot:abort'), // { id }：表示中のアイドルトークを絞って終わらせる（通知が優先）

  // Phase 8：キャラクターの切り替え（手順は main/window.js）
  onCharacterLoad: subscribe('mascot:character-load'), // { seq, view }：全スロットを先読みし、通知の表示中でなければ差し替える
  onCharacterCancel: subscribe('mascot:character-cancel'), // 読み込み中の切り替えを取りやめる（表示中のキャラクターへ戻した）
  characterLoaded: (seq, ok) => ipcRenderer.send('mascot:character-loaded', seq, ok === true), // 差し替えた（失敗なら false）

  // Phase 10：出入りのフェード（F-20）
  onVisibility: subscribe('mascot:visibility'), // { visible }：不透明／透明へ遷移する（通知時のみ表示・起動時）

  // F-21：直前のお知らせをもう一度（キャラクターのダブルクリック）
  replay: () => ipcRenderer.send('mascot:replay'),
});
