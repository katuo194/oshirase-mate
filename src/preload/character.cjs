const { contextBridge, ipcRenderer } = require('electron');

// キャラクター選択画面（F-17・3.6）。一覧（ID・表示名・サムネイルURL）と選択だけを扱う
contextBridge.exposeInMainWorld('characterApi', {
  list: () => ipcRenderer.invoke('character:list'),
  select: (id) => ipcRenderer.invoke('character:select', String(id)),
  openCreate: () => ipcRenderer.invoke('character:open-create'),
  openEdit: (id) => ipcRenderer.invoke('character:open-edit', String(id)), // 取り込んだキャラクターは全項目、既定キャラクターは声と設定のみ
  // 取り込み・削除・選択の変更（他の画面・トレイから）を受け取る。戻り値は購読解除関数
  onChanged: (callback) => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('character:changed', listener);
    return () => ipcRenderer.removeListener('character:changed', listener);
  },
});
