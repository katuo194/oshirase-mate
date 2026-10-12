const { contextBridge, ipcRenderer } = require('electron');

// キャラクター作成／編集画面（F-17・3.6・v5.9）。フォルダの選択はメインがOSのダイアログで行い、ここにはフォルダ名（末尾）と検証結果だけが返る
contextBridge.exposeInMainWorld('characterCreateApi', {
  // 画面を開いたとき（前回選んだフォルダを忘れる）。editId があれば編集モードで、その今の値が返る
  begin: (editId) => ipcRenderer.invoke('characterCreate:begin', editId ? String(editId) : ''),
  pickFolder: (slot) => ipcRenderer.invoke('characterCreate:pick-folder', String(slot)),
  clearSlot: (slot) => ipcRenderer.invoke('characterCreate:clear-slot', String(slot)),
  // { displayName, fps: { [slot]: number }, voice, persona, lines }。フォルダは pickFolder で選んだもの
  // lines（セリフ。F-22）は { notify: { [kind]: string }, idle: { [kind]: string } }（各欄の文字列。分割・検証はメイン）
  importCharacter: (req) => ipcRenderer.invoke('characterCreate:import', req),
  // 編集の保存。{ displayName, slots: { [slot]: 'keep' | 'picked' | 'none' }, fps, voice, persona, lines }
  save: (id, req) => ipcRenderer.invoke('characterCreate:save', String(id), req),
  // VOICEVOX の話者一覧（声の選択用）。{ available, speakers: [{ name, styles: [{ id, name }] }] }
  listSpeakers: () => ipcRenderer.invoke('characterCreate:list-speakers'),
  list: () => ipcRenderer.invoke('characterCreate:list'),
  remove: (id) => ipcRenderer.invoke('characterCreate:remove', String(id)),
  onChanged: (callback) => {
    const listener = (_event, view) => callback(view);
    ipcRenderer.on('characterCreate:changed', listener);
    return () => ipcRenderer.removeListener('characterCreate:changed', listener);
  },
});
