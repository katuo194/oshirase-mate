const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  // 生のIPCイベントは渡さず、設定オブジェクトだけを渡す。戻り値は購読解除関数
  onChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});

// Googleアカウント連携。状態（status / エラー種別）のみを扱い、トークンは一切渡らない
contextBridge.exposeInMainWorld('authApi', {
  getState: () => ipcRenderer.invoke('auth:get-state'),
  link: () => ipcRenderer.invoke('auth:link'),
  cancel: () => ipcRenderer.invoke('auth:cancel'),
  unlink: () => ipcRenderer.invoke('auth:unlink'),
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('auth:changed', listener);
    return () => ipcRenderer.removeListener('auth:changed', listener);
  },
});

// VOICEVOX の接続状態（F-13。個人版・共有版とも表示：v5.11）。状態だけを扱う
contextBridge.exposeInMainWorld('voiceApi', {
  getState: () => ipcRenderer.invoke('voice:get-state'),
  recheck: () => ipcRenderer.invoke('voice:recheck'),
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('voice:changed', listener);
    return () => ipcRenderer.removeListener('voice:changed', listener);
  },
});

// Gemini APIキー（F-16）。キーはメインへ送るだけで、戻り値・イベントには状態（configured）とエラー種別しか含まれない
contextBridge.exposeInMainWorld('geminiApi', {
  getState: () => ipcRenderer.invoke('gemini:get-state'),
  setKey: (key) => ipcRenderer.invoke('gemini:set-key', String(key)),
  clearKey: () => ipcRenderer.invoke('gemini:clear-key'),
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('gemini:changed', listener);
    return () => ipcRenderer.removeListener('gemini:changed', listener);
  },
});

// デスクトップ・スタートメニューのショートカット（F-19。配布版のみ）。location は 'desktop' | 'startMenu'
contextBridge.exposeInMainWorld('shortcutApi', {
  status: () => ipcRenderer.invoke('shortcut:status'),
  create: (location) => ipcRenderer.invoke('shortcut:create', String(location)),
  remove: (location) => ipcRenderer.invoke('shortcut:remove', String(location)),
});

// 共有版の OAuth Client ID/Secret（2.4・F-18）。値はメインへ送るだけで、戻り値・イベントに Secret は含まれない（Client ID と状態のみ）
contextBridge.exposeInMainWorld('oauthApi', {
  getState: () => ipcRenderer.invoke('oauth:get-state'),
  set: (clientId, clientSecret) => ipcRenderer.invoke('oauth:set', { clientId: String(clientId), clientSecret: String(clientSecret) }),
  clear: () => ipcRenderer.invoke('oauth:clear'),
  openManual: () => ipcRenderer.invoke('oauth:open-manual'),
  // 「Google 連携の準備」（Phase 12）。JSON の読み込みはメインで行い、中身は画面を通らない
  importFile: () => ipcRenderer.invoke('oauth:import-file'),
  // ドロップされたファイルは場所だけをメインへ送る（webUtils.getPathForFile。File.path は Electron 32 で廃止）
  importDropped: (file) => {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      // File でないものが渡された
    }
    return ipcRenderer.invoke('oauth:import-path', filePath);
  },
  onChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('oauth:changed', listener);
    return () => ipcRenderer.removeListener('oauth:changed', listener);
  },
});

// 外部のページ（「Google 連携の準備」の Console・VOICEVOX・Gemini API キー。v5.15）を既定のブラウザで開く。
// リンクの名前（apis / branding / audience / client / voicevox / geminiKey）だけを送り、URL はメインが決める
contextBridge.exposeInMainWorld('linksApi', {
  open: (name) => ipcRenderer.invoke('links:open', String(name)),
});
