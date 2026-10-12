import { ipcMain } from 'electron';
import path from 'node:path';
import { getSettings, settingsEvents, updateSettings } from './store.js';
import { DEFAULT_CHARACTER_ID, SLOT_NAMES, characterFrameUrl, describeImportError, isValidCharacterId } from './characterImport.js';
import { consoleUrlFor } from './googleConsoleLinks.js';

/** 既定キャラクターの表示名（選択画面・編集画面） */
const DEFAULT_CHARACTER_NAME = '黄色い丸（既定）';

// 今後追加するIPCはここに集約する（マスコット用の mascot:* は Phase 0 から window.js にあり、当面そのまま）。

// 設定ウィンドウからの呼び出しだけを許可する送信元検証（settings:* / auth:* 共通）
function senderCheck(getSettingsWindow) {
  return (e) => {
    const win = getSettingsWindow();
    return Boolean(win) && !win.isDestroyed() && e.sender === win.webContents;
  };
}

/**
 * 設定画面用IPC。
 * - settings:get / settings:update … 設定ウィンドウからのみ受け付ける
 * - settings:changed … 設定が変わるたび（トレイ操作含む）に設定ウィンドウへ通知
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 */
export function registerSettingsIpc({ getSettingsWindow }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);

  ipcMain.handle('settings:get', (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
    return getSettings();
  });

  ipcMain.handle('settings:update', (e, patch) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
    return updateSettings(patch);
  });

  settingsEvents.on('change', (settings) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send('settings:changed', settings);
  });
}

/**
 * Googleアカウント連携用IPC（設定ウィンドウからのみ）。レンダラーへ渡すのは状態（status / エラー種別）だけで、トークンは渡さない。
 * - auth:get-state … 現在の状態
 * - auth:link      … 同意フロー開始（ブラウザを開いた時点で戻る。完了は auth:changed で通知）
 * - auth:cancel / auth:unlink
 * - auth:changed   … 状態が変わるたびに設定ウィンドウへ通知
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 * @param {ReturnType<import('./auth.js').createAuth>} opts.auth
 */
export function registerAuthIpc({ getSettingsWindow, auth }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);
  const guard = (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
  };

  ipcMain.handle('auth:get-state', (e) => {
    guard(e);
    return auth.getState();
  });

  ipcMain.handle('auth:link', (e) => {
    guard(e);
    auth.link(); // 完了を待たない（link() は reject しない）
    return auth.getState();
  });

  ipcMain.handle('auth:cancel', (e) => {
    guard(e);
    auth.cancel();
    return auth.getState();
  });

  ipcMain.handle('auth:unlink', async (e) => {
    guard(e);
    await auth.unlink();
    return auth.getState();
  });

  auth.events.on('change', (state) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send('auth:changed', state);
  });
}

/**
 * VOICEVOX の接続状態用IPC（設定ウィンドウからのみ）。設定画面を開いたとき・「再確認」で起動確認を行う（定期ポーリングはしない）。
 * 個人版・共有版で違いはない（v5.11：有効・無効は接続状態だけで決まる）。
 * - voice:get-state … 起動確認をして状態を返す（{ status, version?, speakerName?, reason? }）
 * - voice:recheck   … 同上（ボタン用）
 * - voice:changed   … 状態が変わるたび（読み上げ時の失敗・復帰を含む）に設定ウィンドウへ通知
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 * @param {ReturnType<import('./voicevox.js').createVoicevox>} opts.voicevox
 * @param {() => { speakerId: number }} opts.getVoiceConfig
 */
export function registerVoiceIpc({ getSettingsWindow, voicevox, getVoiceConfig }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);

  const check = async (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
    return voicevox.checkStatus(getVoiceConfig());
  };
  ipcMain.handle('voice:get-state', check);
  ipcMain.handle('voice:recheck', check);

  voicevox.events.on('change', (state) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send('voice:changed', state);
  });
}

/**
 * Gemini APIキー用IPC（設定ウィンドウからのみ）。レンダラーへ渡すのは状態（設定済みか）とエラー種別だけで、キーは戻り値にもイベントにも載せない。
 * - gemini:get-state … { configured }
 * - gemini:set-key   … キーを検証して暗号化保存。{ ok, reason?, configured }
 * - gemini:clear-key … 削除
 * - gemini:changed   … 状態が変わるたびに設定ウィンドウへ通知
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 * @param {ReturnType<import('./geminiKey.js').createGeminiKey>} opts.geminiKey
 */
export function registerGeminiIpc({ getSettingsWindow, geminiKey }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);
  const guard = (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
  };

  ipcMain.handle('gemini:get-state', (e) => {
    guard(e);
    return geminiKey.getState();
  });

  ipcMain.handle('gemini:set-key', async (e, key) => {
    guard(e);
    const result = await geminiKey.set(key);
    return { ...result, ...geminiKey.getState() };
  });

  ipcMain.handle('gemini:clear-key', async (e) => {
    guard(e);
    const result = await geminiKey.clear();
    return { ...result, ...geminiKey.getState() };
  });

  geminiKey.events.on('change', (state) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send('gemini:changed', state);
  });
}

/**
 * 共有版の OAuth Client ID/Secret 用IPC（設定ウィンドウからのみ。2.4・3.6・F-18）。
 * レンダラーへ渡すのは状態（{ edition, userInput, configured, clientId, editable }）とエラー種別だけで、Secret は戻り値にもイベントにも載せない。
 * - oauth:get-state   … 状態
 * - oauth:set         … { clientId, clientSecret } を検証して暗号化保存。{ ok, reason?, ...状態 }（個人版・連携中は拒否）
 * - oauth:clear       … 削除（個人版・連携中は拒否）
 * - oauth:open-manual … セットアップ手順書を開く
 * - oauth:import-file … （Phase 12）ファイル選択ダイアログで Console の JSON を選ばせ、メインで読み込んで保存する。{ ok, reason?, canceled?, ...状態 }
 * - oauth:import-path … （Phase 12）設定画面にドロップされた JSON をメインで読み込んで保存する（受け取るのはファイルの場所だけ。中身は画面を通らない）
 * - oauth:open-console … （Phase 12）「Google 連携の準備」の手順の名前を受け取り、決まった Console のページを既定のブラウザで開く（googleConsoleLinks.js）
 * - oauth:changed     … 状態が変わるたびに設定ウィンドウへ通知
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 * @param {ReturnType<import('./oauthClient.js').createOAuthClient>} opts.oauthClient
 * @param {() => Promise<boolean>} opts.openManual
 * @param {(win: Electron.BrowserWindow) => Promise<string | null>} opts.pickClientFile OSのファイル選択ダイアログ（JSON）
 * @param {(url: string) => Promise<void>} opts.openExternal 既定のブラウザで開く
 */
export function registerOAuthClientIpc({ getSettingsWindow, oauthClient, openManual, pickClientFile, openExternal }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);
  const guard = (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
  };

  ipcMain.handle('oauth:get-state', (e) => {
    guard(e);
    return oauthClient.getState();
  });

  ipcMain.handle('oauth:set', async (e, input) => {
    guard(e);
    const req = input !== null && typeof input === 'object' ? input : {};
    const result = await oauthClient.set({ clientId: req.clientId, clientSecret: req.clientSecret });
    return { ...result, ...oauthClient.getState() };
  });

  ipcMain.handle('oauth:clear', async (e) => {
    guard(e);
    const result = await oauthClient.clear();
    return { ...result, ...oauthClient.getState() };
  });

  ipcMain.handle('oauth:open-manual', async (e) => {
    guard(e);
    return { ok: await openManual() };
  });

  ipcMain.handle('oauth:import-file', async (e) => {
    guard(e);
    // 共有版でない・連携中ならダイアログを出さずに理由を返す
    const { userInput, editable } = oauthClient.getState();
    if (!userInput) return { ok: false, reason: 'not_shared', ...oauthClient.getState() };
    if (!editable) return { ok: false, reason: 'linked', ...oauthClient.getState() };
    const filePath = await pickClientFile(getSettingsWindow());
    if (!filePath) return { ok: false, canceled: true, ...oauthClient.getState() };
    const result = await oauthClient.importFile(filePath);
    return { ...result, ...oauthClient.getState() };
  });

  ipcMain.handle('oauth:import-path', async (e, filePath) => {
    guard(e);
    const result = await oauthClient.importFile(typeof filePath === 'string' ? filePath : '');
    return { ...result, ...oauthClient.getState() };
  });

  ipcMain.handle('oauth:open-console', async (e, step) => {
    guard(e);
    const url = consoleUrlFor(step);
    if (!url) return { ok: false };
    try {
      await openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  oauthClient.events.on('change', (state) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send('oauth:changed', state);
  });
}

/**
 * ショートカット用IPC（F-19。設定ウィンドウからのみ）。場所は 'desktop' / 'startMenu' のみ（shortcuts.js が検証する）。
 * - shortcut:status … { supported, desktop, startMenu }（各場所は 'none' | 'ok' | 'stale'）
 * - shortcut:create … 作成（既にあれば作り直す）。{ ok, reason?, ...状態 }
 * - shortcut:remove … 削除。{ ok, reason?, ...状態 }
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getSettingsWindow
 * @param {ReturnType<import('./shortcuts.js').createShortcuts>} opts.shortcuts
 */
export function registerShortcutIpc({ getSettingsWindow, shortcuts }) {
  const isFromSettingsWindow = senderCheck(getSettingsWindow);
  const guard = (e) => {
    if (!isFromSettingsWindow(e)) throw new Error('forbidden');
  };

  ipcMain.handle('shortcut:status', (e) => {
    guard(e);
    return shortcuts.status();
  });

  ipcMain.handle('shortcut:create', (e, location) => {
    guard(e);
    return shortcuts.create(location);
  });

  ipcMain.handle('shortcut:remove', (e, location) => {
    guard(e);
    return shortcuts.remove(location);
  });
}

/**
 * チャットウィンドウ用IPC（チャットウィンドウからのみ）。通知の経路（mascot:* ・ presenter）には触れない。
 * - chat:get-state  … { turn, max, remaining, finished, busy, showRemainingCount }
 * - chat:send       … 発言を送る。応答（または拒否理由）を返す
 * - chat:voice-done … 読み上げの再生が終わった（音声ファイルの削除）
 * メイン → チャット：chat:voice / chat:stop-voice / chat:settings（chatController の sendToWindow 経由）
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getChatWindow
 * @param {ReturnType<import('./chatController.js').createChatController>} opts.controller
 */
export function registerChatIpc({ getChatWindow, controller }) {
  const isFromChatWindow = senderCheck(getChatWindow);

  ipcMain.handle('chat:get-state', (e) => {
    if (!isFromChatWindow(e)) throw new Error('forbidden');
    return controller.getState();
  });

  ipcMain.handle('chat:send', (e, text) => {
    if (!isFromChatWindow(e)) throw new Error('forbidden');
    if (typeof text !== 'string') return { ok: false, reason: 'empty' };
    return controller.send(text);
  });

  ipcMain.on('chat:voice-done', (e, id) => {
    if (!isFromChatWindow(e)) return;
    controller.onVoiceDone(id);
  });
}

/** 選択画面・作成／編集画面に出す一覧の1行（既定キャラクター＋取り込み済み）。フォルダのパスは含めない */
function characterListView(manifests, selectedId) {
  const ids = new Set(manifests.map((m) => m.id));
  return {
    // 保存された ID が無くなっていれば既定キャラクターを表示している（6.1）
    selected: ids.has(selectedId) ? selectedId : DEFAULT_CHARACTER_ID,
    characters: [
      { id: DEFAULT_CHARACTER_ID, displayName: DEFAULT_CHARACTER_NAME, builtin: true, thumbnail: null, slots: [] },
      ...manifests.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        builtin: false,
        // 編集で画像が差し替わっても古いサムネイルを出さないよう、更新日時（revision）を付ける
        thumbnail: characterFrameUrl(m.id, m.slots.rest.folder, 0, m.updatedAt),
        slots: SLOT_NAMES.filter((s) => m.slots[s]),
      })),
    ],
  };
}

/** 作成／編集画面が扱う fps の入力（スロット → 数値）。不正な形は空として扱う（検証は repository） */
const fpsInput = (req) => (req && typeof req.fps === 'object' && req.fps !== null ? req.fps : {});

/**
 * キャラクター選択画面・作成／編集画面用IPC（F-17・3.6・v5.9）。それぞれ自分のウィンドウからの呼び出しだけを受け付ける。
 * 選択画面：character:list / character:select / character:open-create / character:open-edit、一覧が変わるたびに character:changed
 * 作成／編集画面：characterCreate:begin / pick-folder / clear-slot / import / save / list / remove / list-speakers、
 *                一覧が変わるたびに characterCreate:changed
 * 選んだフォルダのフルパスはメインだけが持ち（スロット名に紐付け）、レンダラーにはフォルダ名（末尾）と検証結果だけを返す。
 * @param {object} opts
 * @param {() => Electron.BrowserWindow | null} opts.getCharacterWindow
 * @param {() => Electron.BrowserWindow | null} opts.getCharacterCreateWindow
 * @param {ReturnType<import('./characterImport.js').createCharacterRepository>} opts.repository
 * @param {(id: string) => Promise<boolean>} opts.select 選択を保存する（存在確認込み）
 * @param {(opts?: { editId?: string }) => void} opts.openCreateWindow
 * @param {(win: Electron.BrowserWindow) => Promise<string | null>} opts.pickFolder OSのフォルダ選択ダイアログ
 * @param {(win: Electron.BrowserWindow, displayName: string) => Promise<boolean>} opts.confirmRemove 削除の確認
 * @param {() => Promise<{ name: string, styles: { id: number, name: string }[] }[]>} opts.listSpeakers VOICEVOX の話者一覧
 * @param {(id: string) => void} opts.onCharacterUpdated キャラクターの画像・声・設定が変わった（選択中なら反映し直す）
 */
export function registerCharacterIpc({
  getCharacterWindow,
  getCharacterCreateWindow,
  repository,
  select,
  openCreateWindow,
  pickFolder,
  confirmRemove,
  listSpeakers,
  onCharacterUpdated,
}) {
  const fromSelect = senderCheck(getCharacterWindow);
  const fromCreate = senderCheck(getCharacterCreateWindow);
  const guard = (check) => (e) => {
    if (!check(e)) throw new Error('forbidden');
  };
  const guardSelect = guard(fromSelect);
  const guardCreate = guard(fromCreate);

  const list = async () => characterListView(await repository.list(), getSettings().character);

  /** 作成／編集画面で選んだフォルダ。スロット名 → { dir, frameCount } */
  let picked = {};

  async function broadcast() {
    const view = await list();
    for (const [getWin, channel] of [[getCharacterWindow, 'character:changed'], [getCharacterCreateWindow, 'characterCreate:changed']]) {
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send(channel, view);
    }
  }
  // 選択の変更（どの経路でも）を両画面の表示へ反映する
  let lastCharacter = getSettings().character;
  settingsEvents.on('change', (settings) => {
    if (settings.character === lastCharacter) return;
    lastCharacter = settings.character;
    void broadcast();
  });

  ipcMain.handle('character:list', (e) => {
    guardSelect(e);
    return list();
  });

  ipcMain.handle('character:select', async (e, id) => {
    guardSelect(e);
    const ok = await select(typeof id === 'string' ? id : '');
    return { ok, ...(await list()) };
  });

  ipcMain.handle('character:open-create', (e) => {
    guardSelect(e);
    openCreateWindow();
  });

  ipcMain.handle('character:open-edit', (e, id) => {
    guardSelect(e);
    if (typeof id === 'string' && (id === DEFAULT_CHARACTER_ID || isValidCharacterId(id))) openCreateWindow({ editId: id });
  });

  /**
   * 画面を開いたとき。前回選んだフォルダを忘れ、モード（作成／編集）と編集対象の今の値を返す。
   * 声の欄は版によらず常に出す（v5.11。話者を選べるかは characterCreate:list-speakers の available で決まる）。
   * @returns {{ mode: 'create' } |
   *   { mode: 'edit', character: { id, displayName, builtin, slots, voice, persona } } |
   *   { mode: 'missing' }}
   */
  ipcMain.handle('characterCreate:begin', async (e, editId) => {
    guardCreate(e);
    picked = {};
    if (typeof editId !== 'string' || editId === '') return { mode: 'create' };
    if (editId === DEFAULT_CHARACTER_ID) {
      const profile = await repository.getDefaultProfile();
      return {
        mode: 'edit',
        character: { id: DEFAULT_CHARACTER_ID, displayName: DEFAULT_CHARACTER_NAME, builtin: true, slots: {}, ...profile },
      };
    }
    const m = await repository.get(editId);
    if (!m) return { mode: 'missing' };
    return {
      mode: 'edit',
      character: { id: m.id, displayName: m.displayName, builtin: false, slots: m.slots, voice: m.voice, persona: m.persona },
    };
  });

  ipcMain.handle('characterCreate:pick-folder', async (e, slot) => {
    guardCreate(e);
    if (!SLOT_NAMES.includes(slot)) throw new Error('unknown slot');
    const dir = await pickFolder(getCharacterCreateWindow());
    if (!dir) return { slot, canceled: true };
    const inspected = await repository.inspectFolder(dir);
    if (!inspected.ok) {
      delete picked[slot];
      return { slot, ok: false, folderName: path.basename(dir), message: describeImportError(inspected.error) };
    }
    picked[slot] = { dir, frameCount: inspected.frameCount };
    return { slot, ok: true, folderName: path.basename(dir), frameCount: inspected.frameCount };
  });

  ipcMain.handle('characterCreate:clear-slot', (e, slot) => {
    guardCreate(e);
    delete picked[slot];
  });

  /** VOICEVOX の話者一覧（声の選択用）。未起動なら一覧なし（版によらない：v5.11） */
  ipcMain.handle('characterCreate:list-speakers', async (e) => {
    guardCreate(e);
    try {
      return { available: true, speakers: await listSpeakers() };
    } catch {
      return { available: false, speakers: [] };
    }
  });

  /**
   * 画面から来た声。undefined（送られていない）は「今の値のまま」、null は「未設定（config.json の voicevox）」。
   * VOICEVOX が未起動で話者を選べないときも、画面は保存済みの値をそのまま送り返す（v5.9：保存済みの値は残す）
   */
  const voiceInput = (req) => (req && 'voice' in req ? (req.voice ?? null) : undefined);

  ipcMain.handle('characterCreate:import', async (e, req) => {
    guardCreate(e);
    const fps = fpsInput(req);
    const slots = {};
    for (const s of Object.keys(picked)) slots[s] = { dir: picked[s].dir, fps: fps[s] };
    const result = await repository.importCharacter({
      displayName: req?.displayName,
      slots,
      voice: voiceInput(req) ?? null,
      persona: req?.persona,
    });
    if (!result.ok) return { ok: false, message: describeImportError(result.error) };
    picked = {};
    await broadcast();
    return { ok: true, id: result.manifest.id, displayName: result.manifest.displayName };
  });

  /**
   * 編集の保存。req.slots の各値：'keep'（今の画像のまま）／'picked'（選び直したフォルダ）／'none'（任意スロットの解除）。
   * 既定キャラクターは声とキャラクター設定だけを保存する。
   */
  ipcMain.handle('characterCreate:save', async (e, id, req) => {
    guardCreate(e);
    if (id === DEFAULT_CHARACTER_ID) {
      const current = await repository.getDefaultProfile();
      const voice = voiceInput(req);
      const result = await repository.saveDefaultProfile({ voice: voice === undefined ? current.voice : voice, persona: req?.persona });
      if (!result.ok) return { ok: false, message: describeImportError(result.error) };
      onCharacterUpdated(DEFAULT_CHARACTER_ID);
      return { ok: true, displayName: DEFAULT_CHARACTER_NAME };
    }
    const current = await repository.get(id);
    if (!current) return { ok: false, message: describeImportError({ code: 'not_found' }) };
    const fps = fpsInput(req);
    const states = req && typeof req.slots === 'object' && req.slots !== null ? req.slots : {};
    const slots = {};
    for (const s of SLOT_NAMES) {
      if (states[s] === 'keep') slots[s] = { keep: true, fps: fps[s] };
      else if (states[s] === 'picked' && picked[s]) slots[s] = { dir: picked[s].dir, fps: fps[s] };
    }
    const voice = voiceInput(req);
    const result = await repository.updateCharacter(id, {
      displayName: req?.displayName,
      slots,
      voice: voice === undefined ? current.voice : voice,
      persona: req?.persona,
    });
    if (!result.ok) return { ok: false, message: describeImportError(result.error) };
    picked = {};
    await broadcast();
    onCharacterUpdated(id);
    return { ok: true, displayName: result.manifest.displayName, slots: result.manifest.slots };
  });

  ipcMain.handle('characterCreate:list', (e) => {
    guardCreate(e);
    return list();
  });

  ipcMain.handle('characterCreate:remove', async (e, id) => {
    guardCreate(e);
    const manifest = await repository.get(id);
    if (!manifest) return { ok: false, message: describeImportError({ code: 'not_found' }) };
    if (!(await confirmRemove(getCharacterCreateWindow(), manifest.displayName))) return { ok: false, canceled: true };
    // 選択中なら先に既定キャラクターへ戻す（6.1）
    if (getSettings().character === id) await select(DEFAULT_CHARACTER_ID);
    const result = await repository.remove(id);
    await broadcast();
    return result.ok ? { ok: true } : { ok: false, message: describeImportError(result.error) };
  });
}
