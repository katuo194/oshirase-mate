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

// キャラクター選択（F-17・3.6）。設定ウィンドウの「キャラクター」タブ（v5.19。以前は別のウィンドウ）。一覧（ID・表示名・サムネイルURL）と選択だけを扱う
contextBridge.exposeInMainWorld('characterApi', {
  list: () => ipcRenderer.invoke('character:list'),
  select: (id) => ipcRenderer.invoke('character:select', String(id)),
  // 取り込み・削除・選択の変更（他の画面・トレイから）を受け取る。戻り値は購読解除関数
  onChanged: (callback) => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('character:changed', listener);
    return () => ipcRenderer.removeListener('character:changed', listener);
  },
});

// タブの切り替え（v5.19）。トレイの「設定」「キャラクター変更」で、開いているウィンドウのタブを切り替える
contextBridge.exposeInMainWorld('tabsApi', {
  onShowTab: (callback) => {
    const listener = (_event, tab) => callback(String(tab));
    ipcRenderer.on('settings:show-tab', listener);
    return () => ipcRenderer.removeListener('settings:show-tab', listener);
  },
});

// キャラクター作成／編集（F-17・3.6・v5.9）。v5.19 で別のウィンドウからキャラクタータブの中へ移した。
// フォルダの選択はメインがOSのダイアログで行い、ここにはフォルダ名（末尾）と検証結果だけが返る
contextBridge.exposeInMainWorld('characterCreateApi', {
  // 画面を開いたとき（前回選んだフォルダを忘れる）。editId があれば編集モードで、その今の値が返る
  begin: (editId) => ipcRenderer.invoke('characterCreate:begin', editId ? String(editId) : ''),
  pickFolder: (slot) => ipcRenderer.invoke('characterCreate:pick-folder', String(slot)),
  clearSlot: (slot) => ipcRenderer.invoke('characterCreate:clear-slot', String(slot)),
  // { displayName, fps: { [slot]: number }, voice, persona, lines }。フォルダは pickFolder で選んだもの
  // lines（セリフ。F-22）は { notify: { [kind]: string }, idle: { [kind]: string }, chat: { closing: string } }（各欄の文字列。分割・検証はメイン）
  importCharacter: (req) => ipcRenderer.invoke('characterCreate:import', req),
  // 編集の保存。{ displayName, slots: { [slot]: 'keep' | 'picked' | 'none' }, fps, voice, persona, lines }
  save: (id, req) => ipcRenderer.invoke('characterCreate:save', String(id), req),
  // 同梱キャラクター（F-23）を同梱の状態に戻す（メインが確認のダイアログを出す）。{ ok, character? , canceled?, message? }
  resetBundled: (id) => ipcRenderer.invoke('characterCreate:reset', String(id)),
  // VOICEVOX の話者一覧（声の選択用）。{ available, speakers: [{ name, styles: [{ id, name }] }] }
  listSpeakers: () => ipcRenderer.invoke('characterCreate:list-speakers'),
  // セリフの案を Gemini で作る（Phase 14）。{ displayName, persona, replace }。保存はしない
  // 戻り値：{ ok: true, lines, missing } | { ok: false, canceled: true } | { ok: false, reason, message }
  generateLines: (req) => ipcRenderer.invoke('characterCreate:generate-lines', req),
  // 取り込んだキャラクターの削除（メインが確認のダイアログを出す）。v5.19 で編集画面の「削除」ボタンから呼ぶ
  remove: (id) => ipcRenderer.invoke('characterCreate:remove', String(id)),
});
