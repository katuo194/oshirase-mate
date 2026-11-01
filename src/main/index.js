// userData の保存先の固定は、store.js（import 時に userData を読む）より前に行うため最初に import する（v5.12）
import './pinUserDataDir.js';
import { app, dialog, net, powerMonitor, protocol, safeStorage, shell } from 'electron';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  closeChatWindow,
  createMascotWindow,
  getCharacterCreateWindow,
  getCharacterWindow,
  getChatWindow,
  getSettingsWindow,
  openCharacterWindow,
  openChatWindow,
  openManualWindow,
  openSettingsWindow,
} from './window.js';
import { createTray } from './tray.js';
import { getChatConfig, getEdition, getIdleTalkConfig, getPollingConfig, getSettings, getVoicevoxConfig, setCharacter, settingsEvents, updateSettings } from './store.js';
import {
  registerAuthIpc,
  registerCharacterIpc,
  registerChatIpc,
  registerGeminiIpc,
  registerLinksIpc,
  registerOAuthClientIpc,
  registerSettingsIpc,
  registerShortcutIpc,
  registerVoiceIpc,
} from './ipc.js';
import { DEFAULT_CHARACTER_ID, PROTOCOL_SCHEME, createCharacterRepository, isBundledCharacterId, resolveCharacterUrl } from './characterImport.js';
import { createBundledCharacters } from './bundledCharacters.js';
import { resolveFolderDialogStart } from './folderDialogStart.js';
import { createSpeakerNames } from './speakerNames.js';
import { DEFAULT_VIEW, buildCharacterView } from './characterMotions.js';
import { resolveVoiceConfig } from './characterProfile.js';
import { buildSystemPrompt } from './chatPersona.js';
import { applyLoginItem } from './autostart.js';
import { createShortcuts } from './shortcuts.js';
import { isExternalLinkUrl } from './externalLinks.js';
import { allowsIdleTalk } from './mascotVisibility.js';
import { createAuth } from './auth.js';
import { oauthSourceFor } from './edition.js';
import { createOAuthClientStorage } from './oauthClientStorage.js';
import { createOAuthClient } from './oauthClient.js';
import { createLinkExpiryWatch } from './linkExpiry.js';
import { createTokenStorage } from './tokenStorage.js';
import { startLoopbackServer } from './loopback.js';
import { createLogger } from './logger.js';
import { createNotifiedStore } from './notifiedStore.js';
import { SOURCES, createNotifyQueue } from './notifyQueue.js';
import { createMailSummary } from './mailSummary.js';
import { createNotificationPresenter } from './notificationPresenter.js';
import { formatBadgeText, idlePresentation, systemPresentation } from './notificationView.js';
import { createVoicevox } from './voicevox.js';
import { createVoiceReader } from './voiceReader.js';
import { createSfxResolver } from './sounds.js';
import { makeDevNotification } from './devNotifications.js';
import { createApiUsage } from './apiUsage.js';
import { createGoogleApi } from './googleApi.js';
import { createCalendarProvider } from './providers/calendar.js';
import { createTasksProvider } from './providers/tasks.js';
import { createGmailProvider } from './providers/gmail.js';
import { createPipeline } from './pipeline.js';
import { createNetworkWatch } from './networkWatch.js';
import { createNotificationLogger } from './notificationLogger.js';
import { createApiKeyStorage } from './apiKeyStorage.js';
import { createGeminiKey } from './geminiKey.js';
import { createGeminiClient } from './geminiClient.js';
import { createChatSession } from './gemini.js';
import { createChatController } from './chatController.js';
import { createLineGenerator } from './lineGenerator.js';
import { createIdleTalk } from './idleTalk.js';
import { createPhrasePicker } from './phrasePicker.js';

const isDev = process.argv.includes('--dev');

/** electron-builder の appId と同じ値（build/electron-builder.base.cjs）。ショートカットの AppUserModelID にも使う（F-19） */
const APP_USER_MODEL_ID = 'local.mascot-notifier';

// 取り込んだキャラクターの画像（userData/characters）をレンダラーへ渡す独自プロトコル（F-17・v5.9）。
// file:// の画像を canvas に描くと、ヒットテストで使う α値の読み出し（getImageData）がオリジン制約で失敗し得るため、
// CORS を許可した secure なスキームから fetch → ImageBitmap で読ませる。ready より前に登録する必要がある
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let isQuitting = false;
let tray = null;
let auth = null;
let pipeline = null;
let notificationLogger = null;
let presenter = null;
/** Google 連携が切れた・切れそうなときのお知らせと右クリックメニュー（linkExpiry.js。Phase 16） */
let linkExpiry = null;
/** マスコットウィンドウのコントローラー（window.js）。演出・バッジ・効果音設定の送り先 */
let mascot = null;
/** --dev のときだけ startPipeline が埋める開発用メニュー項目（トレイと右クリックメニューに出る） */
let devMenuItems = [];
/** VOICEVOX（F-13）。設定画面の接続状態表示と読み上げで共有する */
let voicevox = null;
/** ネットワーク復帰の監視（networkWatch.js。オフラインからの復帰を15分待たずに検知する） */
let onlineWatch = null;
/** Gemini APIキーの状態（F-16）。「話しかける」の有効・無効の判定とチャットの呼び出しで共有する */
let geminiKey = null;
/** チャットの段取り（chatController.js）。通知の経路とは独立 */
let chat = null;
/** アイドルトーク（F-15）。通知の presenter が作られた後（startPipeline）に生成する。それまでの操作は無視される */
let idleTalk = null;
/** 取り込んだキャラクター（F-17。userData/characters） */
let characters = null;
/** 同梱キャラクター（F-23。アプリの中の assets/characters。利用者が編集した値は userData/characters/<id>-profile.json） */
let bundledCharacters = null;
/** 選択中の同梱キャラクターの固定ボイス（fixedVoice.js）。同梱キャラクターでない・録音が無ければ null。applyCharacter が更新する */
let activeFixedVoice = null;
/** キャラクター作成・編集画面で前に選んだフォルダ（次のフォルダ選択をその親から開く。folderDialogStart.js） */
let lastPickedFolder = null;
/** 設定画面のボイス欄（クレジット表記）を出し直す（registerVoiceIpc の戻り値） */
let voiceIpc = null;
/**
 * 選択中のキャラクターの声・キャラクター設定（v5.9）・セリフ（F-22）。applyCharacter が更新する。
 * 声は通知・アイドルトーク・チャットのすべての読み上げに、キャラクター設定はチャットの人格に、
 * セリフは通知の読み上げ文とアイドルトークの文に使う（phrasePicker を作り直す）
 */
let activeCharacter = { id: 'default', builtin: true, displayName: '', voice: null, persona: '', lines: null };
/** 選択中のキャラクターのセリフから文を選ぶ（シャッフル袋）。キャラクターを反映するたびに作り直す */
let phrasePicker = createPhrasePicker();

/** 実際に使う VOICEVOX の声：選択中のキャラクターの声、未設定なら config.json の voicevox（6.1） */
const effectiveVoiceConfig = () => resolveVoiceConfig(activeCharacter.voice, getVoicevoxConfig());
/**
 * 設定画面のボイス欄に出す固定ボイスの状態。credit は今の声で録音を使えるときのクレジット表記、
 * changed は録音があるのに利用者が声を変えたため使えないとき true（そのことを案内する。v5.18）
 */
const fixedVoiceState = () => {
  if (!activeFixedVoice) return { credit: null, changed: false };
  const usable = activeFixedVoice.usable(effectiveVoiceConfig());
  return { credit: usable ? activeFixedVoice.credit : null, changed: !usable };
};

/** ネットワーク状態を見る間隔。net.isOnline() はローカルの状態を読むだけ。疎通確認（通信あり）はオフライン表示中だけ */
const ONLINE_WATCH_MS = 30 * 1000;
/** オフライン中の疎通確認先。認証不要・本文なしの 204 を返し、API の呼び出し回数にも数えられない */
const PROBE_URL = 'https://www.google.com/generate_204';
const PROBE_TIMEOUT_MS = 5 * 1000;

/**
 * Google（OAuth・API・Gemini）への通信に使う fetch。Chromium のネットワークスタック（net.fetch）を通すことで、
 * OS のプロキシ設定（WPAD の自動検出・PAC を含む）に従う。Node の fetch はプロキシを使わないため、
 * プロキシ必須のネットワーク（学内LAN等）では常に接続失敗になり、オフライン表示から戻らなかった。
 * VOICEVOX（localhost）はプロキシと無関係なので Node の fetch のまま。
 */
const googleFetch = (url, init) => net.fetch(url, init);

/** インターネットに実際に届くか（応答が返れば HTTP ステータスは問わない）。reject しない */
async function probeInternet() {
  try {
    await googleFetch(PROBE_URL, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}
/** オフラインへ遷移したときに1回だけ出すお知らせ（F-14：接続を促す表示） */
const OFFLINE_MESSAGE = { title: 'インターネットにつながらないみたい', sub: '接続を確認してね。つながったら自動で再開するよ' };
/** ダブルクリックしたが、まだ通知を表示していない（F-21） */
const NO_REPLAY_MESSAGE = { title: 'まだお知らせはないよ', sub: 'お知らせしたあとにダブルクリックすると、もう一度言うよ' };
/** Google 連携の期限が近い（自分で作ったクライアントはテストモードのため 7 日で切れる）・切れた（Phase 16。linkExpiry.js） */
const LINK_EXPIRY_MESSAGES = {
  expiring: { title: 'Google との連携がもうすぐ切れるよ', sub: '右クリックの「Google と連携し直す」から、連携し直してね' },
  expired: { title: 'Google との連携が切れちゃった', sub: '右クリックの「Google と連携し直す」から、もう一度連携してね' },
};

/** 音まわりの設定をマスコットへ（ミュート・効果音／ボイス音量） */
function applyMascotSettings(settings = getSettings()) {
  mascot?.applySettings({ muted: settings.muted, sfxVolume: settings.volume.sfx, voiceVolume: settings.volume.voice });
}

// トレイ常駐アプリのため、ウィンドウが閉じてもアプリは終了しない（終了はメニューの「終了」のみ）
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  isQuitting = true;
});
app.on('will-quit', () => {
  onlineWatch?.stop();
  onlineWatch = null;
  pipeline?.stop();
  idleTalk?.stop();
  presenter?.stop();
  linkExpiry?.dispose();
  notificationLogger?.stop();
  auth?.dispose();
  tray?.destroy();
  tray = null;
});

if (!app.requestSingleInstanceLock()) {
  // 二重起動：先に起動している方に任せて即終了
  app.quit();
} else {
  // ショートカット等からもう一度起動されたら、起動中であることが分かるよう設定画面を開く（F-19。開いていれば前面に出すだけ）
  app.on('second-instance', () => {
    if (app.isReady()) openSettingsWindow();
  });

  app.whenReady().then(() => {
    const log = createLogger({ dir: path.join(app.getPath('userData'), 'logs') });
    // 個人版／共有版（2.5・6.1）。両版の違いは OAuth 資格情報の提供元と配布形態だけ（v5.11）
    const edition = getEdition();
    const oauthSource = oauthSourceFor(edition);
    log.info(`[app] 起動（${edition === 'shared' ? '共有版' : '個人版'}）`);

    // 個人版の OAuth Client ID/Secret は .env（9章#3）。自動起動時は cwd が異なるため、パスはアプリ基準で明示する。
    // 配布パッケージ（個人版）では extraResources で resources/.env に同梱する。共有版は .env を読まない（同梱もしない）。値はログに出さない
    if (oauthSource === 'env') {
      const envPath = app.isPackaged ? path.join(process.resourcesPath, '.env') : path.join(app.getAppPath(), '.env');
      dotenv.config({ path: envPath, quiet: true });
    }

    auth = createAuth({
      env: process.env,
      // 共有版は、保存済みの Client ID/Secret を oauthClient.init() が読み込んで auth.configure で反映するまで未設定
      ...(oauthSource === 'user' ? { clientConfig: { ok: false, reason: 'missing_client_id' } } : {}),
      tokenStorage: createTokenStorage({ filePath: path.join(app.getPath('userData'), 'tokens.enc'), safeStorage, log }),
      fetch: googleFetch,
      openExternal: async (url) => {
        // 開くのは Google の認可URLだけ
        if (!url.startsWith('https://accounts.google.com/')) throw new Error('unexpected url');
        await shell.openExternal(url);
      },
      startLoopback: startLoopbackServer,
      log,
    });

    registerSettingsIpc({ getSettingsWindow });

    // デスクトップ・スタートメニューのショートカット（F-19。配布版のみ）
    app.setAppUserModelId(APP_USER_MODEL_ID);
    registerShortcutIpc({
      getSettingsWindow,
      shortcuts: createShortcuts({
        platform: process.platform,
        execPath: process.execPath,
        // ソースから起動しているときは、Electron 本体にアプリのフォルダ（と明示された --user-data-dir）を渡す開発用のショートカットにする（v5.15）
        dev: app.isPackaged
          ? null
          : { appPath: app.getAppPath(), userDataDir: app.commandLine.hasSwitch('user-data-dir') ? app.getPath('userData') : null },
        dirs: {
          desktop: app.getPath('desktop'),
          startMenu: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        },
        shell,
        fs,
        appUserModelId: APP_USER_MODEL_ID,
        log,
      }),
    });
    registerAuthIpc({ getSettingsWindow, auth });

    // 共有版の OAuth Client ID/Secret（2.4・F-18）。safeStorage で暗号化して userData/oauth-client.enc に保存し、Secret はレンダラーへ渡さない
    const oauthClient = createOAuthClient({
      edition,
      storage: createOAuthClientStorage({ filePath: path.join(app.getPath('userData'), 'oauth-client.enc'), safeStorage, log }),
      auth,
      log,
    });
    registerOAuthClientIpc({
      getSettingsWindow,
      oauthClient,
      // セットアップ手順書（HTML）をアプリ内のウィンドウで開く（shell.openPath は .html の既定アプリ＝エディターのこともあるため使わない）。
      // 配布パッケージ（共有版の zip）は実行ファイルと同じフォルダ、開発時は docs/。本文の https のリンクだけ既定のブラウザで開く
      openManual: async () => {
        const manual = app.isPackaged
          ? path.join(path.dirname(process.execPath), 'セットアップ手順書.html')
          : path.join(app.getAppPath(), 'docs', 'setup-guide.html');
        if (!fs.existsSync(manual)) {
          log.warn('[oauth] セットアップ手順書が見つかりません');
          return false;
        }
        openManualWindow({
          filePath: manual,
          openExternal: (url) => (url.startsWith('https://') ? shell.openExternal(url) : Promise.resolve()),
        });
        return true;
      },
      // 「Google 連携」タブの「ファイルを選ぶ」：Console からダウンロードした（または受け取った）JSON を選ぶ（Phase 12・16）
      pickClientFile: async (win) => {
        const r = await dialog.showOpenDialog(win, {
          title: 'ダウンロードした OAuth クライアントの JSON を選択',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
      },
    });

    // 設定画面のボタンで開く外部のページ（「Google 連携の準備」の Console・VOICEVOX・Gemini API キー。v5.15）。
    // 開くのは externalLinks.js の表にある URL だけ（ipc.js がリンクの名前から URL を決め、ここでももう一度確かめる）
    registerLinksIpc({
      getSettingsWindow,
      openExternal: async (url) => {
        if (!isExternalLinkUrl(url)) throw new Error('unexpected url');
        await shell.openExternal(url);
      },
    });

    // VOICEVOX（F-13）。個人版・共有版とも、有効・無効は接続状態（疎通確認）だけで決まる（v5.11）。
    // 接続状態は起動時・設定画面を開いたとき・再確認・読み上げのたびに確かめる（定期ポーリングはしない）
    voicevox = createVoicevox({ fetch: globalThis.fetch, log });
    voiceIpc = registerVoiceIpc({ getSettingsWindow, voicevox, getVoiceConfig: effectiveVoiceConfig, getFixedVoiceState: fixedVoiceState });
    // 起動時の接続確認と話者の先読みは、選択中のキャラクターの声が決まってから applyCharacter で行う

    // Gemini APIキー（F-16）。safeStorage で暗号化して userData/gemini-key.enc に保存し、設定画面へは状態（設定済みか）だけを渡す
    geminiKey = createGeminiKey({
      storage: createApiKeyStorage({ filePath: path.join(app.getPath('userData'), 'gemini-key.enc'), safeStorage, log }),
      log,
    });
    registerGeminiIpc({ getSettingsWindow, geminiKey });
    // セリフの生成（Phase 14）。作成・編集画面のボタンを押したときだけ呼ぶ。モデルの切り替えの記憶はチャットと別に持つ
    const lineGenerator = createLineGenerator({
      client: createGeminiClient({ fetch: googleFetch, getApiKey: () => geminiKey.getKey(), logTag: 'lines', log }),
      log,
    });

    // キャラクター（F-17）。取り込み・一覧・削除は characterImport.js、状態→モーションの解決は characterMotions.js
    const charactersDir = path.join(app.getPath('userData'), 'characters');
    characters = createCharacterRepository({ rootDir: charactersDir, fs: fsp, log });
    void characters.cleanupPartial();
    // 同梱キャラクター（F-23）。画像・セリフ・固定ボイスはアプリの中（配布版では app.asar の中。Electron の fs で読める）
    const bundledDir = path.join(app.getAppPath(), 'assets', 'characters');
    bundledCharacters = createBundledCharacters({ assetsDir: bundledDir, profileDir: charactersDir, fs: fsp, log });
    protocol.handle(PROTOCOL_SCHEME, async (request) => {
      const filePath = resolveCharacterUrl(request.url, charactersDir, bundledDir);
      if (!filePath) return new Response(null, { status: 404 });
      try {
        const data = await fsp.readFile(filePath);
        // 編集で画像が差し替わるので、キャッシュさせない（URL にも ?v=更新日時 を付けている）
        return new Response(data, { headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    registerCharacterIpc({
      getCharacterWindow,
      getCharacterCreateWindow,
      repository: characters,
      bundled: bundledCharacters,
      select: async (id) => {
        const ids = [DEFAULT_CHARACTER_ID, ...[...(await bundledCharacters.list()), ...(await characters.list())].map((m) => m.id)];
        return setCharacter(id, ids).ok;
      },
      listSpeakers: () => voicevox.listSpeakers(),
      // 選択画面の声の説明（v5.18）。VOICEVOX から取れた話者名を userData に覚えておき、止まっていても名前を出す
      speakerNames: createSpeakerNames({
        filePath: path.join(app.getPath('userData'), 'voicevox-speakers.json'),
        fs: fsp,
        listSpeakers: () => voicevox.listSpeakers(),
        log,
      }),
      getDefaultVoice: getVoicevoxConfig,
      // 選択中のキャラクターが編集されたら、表示・声・チャットの人格を反映し直す
      onCharacterUpdated: (id) => {
        if (id === activeCharacter.id) void applyCharacter(log);
      },
      // 最初に開く場所は「前に選んだフォルダの親 → ドキュメント\EmoteLab\Export → OS の既定」（folderDialogStart.js）
      pickFolder: async (win) => {
        const defaultPath = await resolveFolderDialogStart({ lastPicked: lastPickedFolder, documentsDir: app.getPath('documents'), fs: fsp });
        const r = await dialog.showOpenDialog(win, {
          title: 'EmoteLab の ImageSequence フォルダを選択',
          properties: ['openDirectory'],
          ...(defaultPath ? { defaultPath } : {}),
        });
        if (r.canceled || r.filePaths.length === 0) return null;
        lastPickedFolder = r.filePaths[0];
        return lastPickedFolder;
      },
      confirmRemove: async (win, displayName) => {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['削除', 'キャンセル'],
          defaultId: 1,
          cancelId: 1,
          title: 'キャラクターの削除',
          message: `「${displayName}」を削除しますか？`,
          detail: '取り込んだ画像も削除されます（EmoteLab の書き出しフォルダは削除しません）。',
        });
        return r.response === 0;
      },
      confirmReset: async (win, displayName) => {
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['戻す', 'キャンセル'],
          defaultId: 1,
          cancelId: 1,
          title: '同梱の状態に戻す',
          message: `「${displayName}」の声・キャラクター設定・セリフを同梱の状態に戻しますか？`,
          detail: '編集して保存した内容は消えます。',
        });
        return r.response === 0;
      },
      isGeminiConfigured: () => geminiKey.isConfigured(),
      generateLines: (req) => lineGenerator.generate(req),
      confirmReplaceLines: async (win) => {
        const r = await dialog.showMessageBox(win, {
          type: 'question',
          buttons: ['置き換える', 'キャンセル'],
          defaultId: 0,
          cancelId: 1,
          title: 'セリフを作る',
          message: '書いてあるセリフを、Gemini で作った案に置き換えますか？',
          detail: 'キャラクター名とキャラクター設定を Gemini に送ります。置き換えた後も、保存するまでは反映されません（保存せずに閉じれば元のままです）。',
        });
        return r.response === 0;
      },
    });
    geminiKey.events.on('change', () => tray?.refreshMenu()); // 「話しかける」の有効・無効をトレイメニューへ反映
    void geminiKey.init().then(() => tray?.refreshMenu());

    // チャット（F-16）。読み上げは voiceReader.js のチャット専用インスタンス（通知の読み上げとスロットを共有しない）。
    // 音声ファイルは tts/chat/ に置く（通知側の起動時掃除と干渉しないよう別ディレクトリ）
    const chatVoiceReader = createVoiceReader({
      voicevox,
      getSettings,
      getVoiceConfig: effectiveVoiceConfig,
      dir: path.join(app.getPath('userData'), 'tts', 'chat'),
      fs: fsp,
      toUrl: (p) => pathToFileURL(p).href,
      randomId: randomUUID,
      log,
    });
    void chatVoiceReader.cleanupDir();
    chat = createChatController({
      session: createChatSession({
        // 会話の開始時（チャットウィンドウを開いたとき）に選択中のキャラクターの人格で確定する（3.5・v5.9）
        getSystemPrompt: () => buildSystemPrompt(activeCharacter),
        // 終了メッセージも同じく会話の開始時に、選択中のキャラクターのセリフ（無ければ定型文）から選ぶ（Phase 14）
        getClosingMessage: () => phrasePicker.pickChat('closing'),
        client: createGeminiClient({ fetch: googleFetch, getApiKey: () => geminiKey.getKey(), log }),
        getMaxTurns: () => getChatConfig().maxTurns,
      }),
      voiceReader: chatVoiceReader,
      getConfig: getChatConfig,
      sendToWindow: (channel, payload) => {
        const win = getChatWindow();
        if (!win || win.isDestroyed()) return false;
        win.webContents.send(channel, payload);
        return true;
      },
      closeWindow: closeChatWindow,
      onActivity: () => idleTalk?.touch(),
      log,
    });
    registerChatIpc({ getChatWindow, controller: chat });

    /** 「話しかける」：チャットウィンドウを開く（キー未設定なら何もしない。メニュー側でもグレーアウト）。開くたびに新規の会話 */
    const openChat = () => {
      if (!geminiKey.isConfigured()) return;
      openChatWindow({ onOpened: () => chat.begin(), onClosed: () => chat.dispose() });
      idleTalk?.touch();
    };

    tray = createTray({
      onQuit: () => app.quit(),
      onOpenSettings: () => {
        idleTalk?.touch(); // 設定を開くのはユーザー操作
        openSettingsWindow();
      },
      onChangeCharacter: () => {
        idleTalk?.touch();
        openCharacterWindow();
      },
      onTalk: openChat,
      isTalkEnabled: () => geminiKey.isConfigured(),
      // 連携が切れた・切れそうなとき（Phase 16）。連携する・連携し直すボタンと期限の表示がある設定タブを開く
      isRelinkNeeded: () => linkExpiry?.needsRelink() ?? false,
      onRelink: () => {
        idleTalk?.touch();
        openSettingsWindow({ tab: 'settings' });
      },
      getMuted: () => getSettings().muted,
      onToggleMute: () => updateSettings({ muted: !getSettings().muted }),
      getNotifyOnly: () => getSettings().displayMode === 'notifyOnly',
      onToggleNotifyOnly: () => updateSettings({ displayMode: getSettings().displayMode === 'notifyOnly' ? 'always' : 'notifyOnly' }),
      iconPath: path.join(app.getAppPath(), 'assets', 'icons', 'icon.png'),
      getDevItems: () => devMenuItems,
    });

    // 設定の変更（トレイ・設定画面どちらから来ても）をここで一括して反映する
    let lastLaunchAtLogin = getSettings().launchAtLogin;
    let lastCharacter = getSettings().character;
    let lastTaskNotifyTime = `${getSettings().taskNotifyHour}:${getSettings().taskNotifyMinute}`;
    settingsEvents.on('change', (settings) => {
      if (settings.character !== lastCharacter) {
        lastCharacter = settings.character;
        void applyCharacter(log);
      }
      // TODO の通知時刻を変えたら、TODO を取り直して予約（タイマー）を新しい時刻で組み直す（Phase 16）
      const taskNotifyTime = `${settings.taskNotifyHour}:${settings.taskNotifyMinute}`;
      if (taskNotifyTime !== lastTaskNotifyTime) {
        lastTaskNotifyTime = taskNotifyTime;
        log.info(`[app] TODO の通知時刻を ${settings.taskNotifyHour}:${String(settings.taskNotifyMinute).padStart(2, '0')} に変更しました`);
        void pipeline?.scheduler.runNow('tasks');
      }
      tray.refreshMenu();
      mascot?.setDisplayMode(settings.displayMode); // 常時表示／通知時のみ表示（F-20）
      // 表示中の効果音・読み上げを、ミュートなら止め（破棄）・音量変更なら追随させる（3.7：アニメーションと吹き出しは継続）
      applyMascotSettings(settings);
      chat?.applySettings({ muted: settings.muted, voiceVolume: settings.volume.voice });
      if (settings.launchAtLogin !== lastLaunchAtLogin) {
        lastLaunchAtLogin = settings.launchAtLogin;
        applyLoginItem(app, settings.launchAtLogin);
      }
    });

    // 起動時に保存値を OS 側へ再適用する（store を正とし、OS 側とのずれを防ぐ）
    applyLoginItem(app, lastLaunchAtLogin);

    mascot = createMascotWindow({ isDev, buildMenu: tray.buildMenu, isQuitting: () => isQuitting, displayMode: getSettings().displayMode });
    // 選択中のキャラクターを表示する（先読みが終わるまでは既定キャラクター）。読み込めなければ既定キャラクターへ戻す
    mascot.events.on('character-applied', (view) => log.info(`[character] 表示: ${view.id}`));
    mascot.events.on('character-failed', (view) => {
      log.warn(`[character] 画像を読み込めないため既定キャラクターで表示します: ${view.id}`);
      if (view.type !== DEFAULT_VIEW.type) mascot.setCharacter(DEFAULT_VIEW);
    });
    void applyCharacter(log);

    // マスコット表示をブロックしないよう await しない。保存済みトークンのサイレント更新はバックグラウンドで行い、結果はログのみ
    // 共有版は、保存済みの Client ID/Secret を反映してからサイレント更新する（どちらも reject しない）
    void oauthClient.init().then(() => auth.init());

    // 通知パイプライン（Phase 4）。Google API クライアントの読み込みを待たないよう、マスコット表示の後にバックグラウンドで行う
    void startPipeline({ auth, oauthClient, log, refreshTrayMenu: () => tray?.refreshMenu() }).catch((e) =>
      log.warn(`[app] 通知パイプラインの開始に失敗: ${e?.message ?? e}`),
    );
  });
}

let characterRequest = 0;
/** 起動後に一度でも話者の先読み（voicevox.warmUp）を行ったか */
let voiceWarmedUp = false;

/**
 * 設定（6.1 character）のキャラクターを反映する：マスコットの表示・読み上げの声・チャットの人格（v5.9）。
 * 存在しない・manifest が壊れている ID は既定キャラクター。同梱キャラクター（F-23）は固定ボイスも読み込む。
 */
async function applyCharacter(log) {
  const request = ++characterRequest;
  const id = getSettings().character;
  let manifest = null;
  if (isBundledCharacterId(id)) manifest = await bundledCharacters.get(id).catch(() => null);
  else if (id !== DEFAULT_CHARACTER_ID) manifest = await characters.get(id).catch(() => null);
  const defaultProfile = manifest ? null : await characters.getDefaultProfile();
  const fixedVoice = manifest && isBundledCharacterId(manifest.id) ? await bundledCharacters.loadFixedVoice(manifest).catch(() => null) : null;
  if (request !== characterRequest) return; // より新しい選択が来た
  if (id !== DEFAULT_CHARACTER_ID && !manifest) log.warn(`[character] キャラクターが見つからないため既定キャラクターで表示します: ${id}`);

  const before = effectiveVoiceConfig();
  activeCharacter = manifest
    ? { id: manifest.id, builtin: false, displayName: manifest.displayName, voice: manifest.voice, persona: manifest.persona, lines: manifest.lines }
    : { id: DEFAULT_CHARACTER_ID, builtin: true, displayName: '', ...defaultProfile };
  activeFixedVoice = fixedVoice;
  // セリフ（F-22）：設定の無い種類は今の固定文。袋は作り直す（前のキャラクターの文を引き継がない）
  phrasePicker = createPhrasePicker({ lines: activeCharacter.lines });
  mascot?.setCharacter(buildCharacterView(manifest));
  voiceIpc?.refresh(); // 設定画面のクレジット表記（固定ボイスの話者）を出し直す

  // 起動時と声が変わったときは、接続状態（設定画面のクレジット表記「VOICEVOX:話者名」）を確かめ直し、
  // 話者を先に読み込ませる（VOICEVOX を起動した直後は、その話者の初回の合成が遅いため。v5.10）
  const after = effectiveVoiceConfig();
  if (!voiceWarmedUp || after.speakerId !== before.speakerId) {
    voiceWarmedUp = true;
    void voicevox?.warmUp(after).catch(() => {});
  }
}

/**
 * 実 Google API・実ファイルパスといった「Electron・実APIに依存する配線」だけをここに置く。
 * どのイベントで何を呼ぶか（orchestration）は pipeline.js（依存注入・ユニットテスト済み）にある。
 * 認証は auth.getAccessToken() の有効なアクセストークンのみを都度渡す（googleapis の OAuth2Client は使わない。googleApi.js 参照）。
 */
async function startPipeline({ auth, oauthClient, log, refreshTrayMenu }) {
  // googleapis 全体は全API（300超）の定義を読み込み、メインのメモリが約100MB増える（9章#7）。使う3つだけを個別パッケージで読む
  const loadStart = Date.now();
  const [{ calendar }, { tasks }, { gmail }] = await Promise.all([
    import('@googleapis/calendar'),
    import('@googleapis/tasks'),
    import('@googleapis/gmail'),
  ]);
  log.info(`[app] Google API クライアントの読み込み ${Date.now() - loadStart}ms`);

  const usage = createApiUsage();
  const api = createGoogleApi({
    auth,
    calendar: calendar({ version: 'v3' }),
    tasks: tasks({ version: 'v1' }),
    gmail: gmail({ version: 'v1' }),
    fetch: googleFetch,
    usage,
  });

  const notifyQueue = createNotifyQueue({
    store: createNotifiedStore({ filePath: path.join(app.getPath('userData'), 'notified.json') }),
    log,
  });
  const mailSummary = createMailSummary();

  // 通知の表示（Phase 5）。notifyQueue から1件ずつ取り出してマスコットに演出させ、完了を受けて次へ進む。
  // ログ出力（[notify] / [summary]）はデバッグ用に残す。
  notificationLogger = createNotificationLogger({ mailSummary, log });
  notificationLogger.start();

  const sfx = createSfxResolver({
    baseDir: path.join(app.getAppPath(), 'assets', 'sounds'),
    exists: (p) => fs.existsSync(p),
    log,
  });

  // 読み上げ（F-13）。音声ファイルは userData/tts/ に一意名で置き、表示が終わったら削除する（前回の残骸は起動時に掃除）。
  // 同梱キャラクターは、録音してある文を VOICEVOX を使わずに流す（F-23。チャットの読み上げは返事が毎回違うので使わない）
  const voiceReader = createVoiceReader({
    voicevox,
    getSettings,
    getVoiceConfig: effectiveVoiceConfig,
    getFixedVoice: () => activeFixedVoice,
    dir: path.join(app.getPath('userData'), 'tts'),
    fs: fsp,
    toUrl: (p) => pathToFileURL(p).href,
    randomId: randomUUID,
    log,
  });
  void voiceReader.cleanupDir();

  /**
   * 表示を始めた通知の読み上げを並行して準備し、できたら送る（表示の開始は音声を待たない：4章 応答性）。
   * 合成を待つ間は吹き出しを閉じない（上限 maxVoiceHoldMs。v5.10）ので、ウォッチドッグも上限まで延ばす。
   * 合成できなかったときは url: null を送って保持を解く。
   * @param {object} presentation voicePending（willSpeak の結果）つき
   */
  function speak(presentation) {
    if (!presentation.voicePending) return;
    presenter.extend(presentation.id, presentation.timing.maxVoiceHoldMs + presentation.timing.outMs);
    void voiceReader.prepare(presentation.id, presentation.speech, { speechKind: presentation.speechKind }).then((voice) => {
      if (!voice) {
        if (presenter.currentId() === presentation.id) mascot.sendVoice({ id: presentation.id, url: null });
        return;
      }
      if (presenter.currentId() !== presentation.id) {
        voiceReader.cancel(presentation.id); // 合成中に表示が終わった
        return;
      }
      // 音声の長さに合わせて保持時間が延びるので、ウォッチドッグも上限まで延ばす（バックログで縮んだ保持時間より音声を優先）
      presenter.extend(presentation.id, presentation.timing.maxVoiceHoldMs + presentation.timing.outMs);
      mascot.sendVoice({ id: presentation.id, url: voice.url, volume: voice.volume, durationMs: voice.durationMs });
      log.info(`[voice] 読み上げ: ${presentation.id}（${voice.durationMs ?? '?'}ms）`);
    });
  }

  presenter = createNotificationPresenter({
    notifyQueue,
    show: (presentation, notification) => {
      if (notification) notificationLogger.logShown(notification); // アプリからのお知らせ（オフライン等）は通知ではない
      const s = getSettings();
      // ミュート・音量・ファイル有無の判定は表示開始時にここで行う（ミュート中も演出と吹き出しは出す：3.7）
      const sound = presentation.sfxKey ? sfx.resolve({ sfxKey: presentation.sfxKey, muted: s.muted, volume: s.volume.sfx }) : null;
      // 通知の読み上げが優先：チャットの音声（再生中・準備中）は止める（アイドルトークはチャットを開いている間は出ない）
      if (presentation.kind !== 'idle' && presentation.speech) chat?.pauseVoice();
      // 読み上げるなら、音声が届く（または合成できないと分かる）まで吹き出しを保持するようレンダラーに伝える
      const shown = { ...presentation, voicePending: Boolean(presentation.speech) && voiceReader.willSpeak(presentation.speech) };
      mascot.present(shown, sound);
      speak(shown);
    },
    finish: (presentation) => {
      voiceReader.cancel(presentation.id); // 合成中なら中断し、音声ファイルを削除する
      mascot.dismiss();
      if (presentation.kind !== 'idle') idleTalk?.touch(); // 「最後の通知」から数える（アイドルトーク自身は発話時に再武装済み）
    },
    // アイドルトーク表示中に通知が来たら、絞って終わらせる（通知が常に優先：v5.8）
    abort: (presentation) => mascot.abort(presentation.id),
    // 読み上げ文は選択中のキャラクターのセリフから選ぶ（F-22。通常の表示と F-21 の再表示の両方）
    getSpeechOptions: () => ({ pickLine: (kind, accept) => phrasePicker.pickNotify(kind, accept) }),
    log,
  });

  // アイドルトーク（F-15）。トリガー判定は idleTalk.js（依存注入・ユニットテスト済み）。表示は presenter.showIdle（通知が優先）
  // 文は選択中のキャラクターのセリフ（F-22。phrasePicker は applyCharacter が作り直す）
  let idleSeq = 0;
  idleTalk = createIdleTalk({
    getConfig: getIdleTalkConfig,
    pickPhrase: (category) => phrasePicker.pick(category),
    show: ({ text }) => {
      if (getChatWindow()) return false; // チャット中は話しかけない（1分後に再判定）
      if (!allowsIdleTalk(getSettings().displayMode)) return false; // 通知時のみ表示では出さない（F-20）
      return presenter.showIdle(idlePresentation({ id: `idle:${Date.now()}:${++idleSeq}`, text }));
    },
    log,
  });
  // アプリ内の操作：マスコットのドラッグ・右クリックメニュー（設定・チャットを開く／チャット送信は各所で touch する）
  for (const name of ['drag-start', 'drag-end', 'menu', 'replay']) mascot.events.on(name, () => idleTalk.touch());

  // ダブルクリック：直前のお知らせをもう一度（F-21）。表示中・待ちがあるときは何もしない
  mascot.events.on('replay', () => {
    const result = presenter.replayLast();
    if (result === 'none') presenter.showSystem(systemPresentation({ id: `system:no-replay:${Date.now()}`, ...NO_REPLAY_MESSAGE }));
    log.info(`[notify] 再表示の要求: ${result}`);
  });

  // オフライン表示（F-14）。開発メニューの「見た目確認用」の切り替えと、実際の判定（scheduler）のどちらかが立っていれば表示する
  let devOffline = false;
  const isOffline = () => devOffline || (pipeline?.scheduler.isOffline() ?? false);
  const showOfflineMessage = () => presenter.showSystem(systemPresentation({ id: `system:offline:${Date.now()}`, ...OFFLINE_MESSAGE }));

  // Google 連携が切れた・切れそうなとき（Phase 16）。マスコットで知らせ、右クリックメニューに「Google と連携し直す…」を出す
  const showLinkExpiry = (kind) => presenter.showSystem(systemPresentation({ id: `system:link-${kind}:${Date.now()}`, ...LINK_EXPIRY_MESSAGES[kind] }));
  linkExpiry = createLinkExpiryWatch({
    auth,
    getOrigin: () => oauthClient.getOrigin(),
    notify: showLinkExpiry,
    onChange: refreshTrayMenu,
    log,
  });
  oauthClient.events.on('change', () => linkExpiry.refresh());

  const pushSummary = () => mascot.setSummary(formatBadgeText(mailSummary.get()));
  mailSummary.events.on('updated', pushSummary);
  mailSummary.events.on('reset', pushSummary);

  // レンダラーの準備（起動時・リロード後）。準備前は取り出さず、準備完了で溜まっていた通知の表示とバッジ・設定の反映を始める
  mascot.events.on('ready', () => {
    applyMascotSettings();
    mascot.setOffline(isOffline());
    pushSummary();
    presenter.setRendererReady(true);
  });
  mascot.events.on('unready', () => presenter.setRendererReady(false));
  mascot.events.on('done', (id) => presenter.done(id));
  // ドラッグ中は取り出しを一時停止し、終了で再開する（ドラッグ中に来た通知は順番どおりキューに溜まる）
  mascot.events.on('drag-start', () => presenter.setDragging(true));
  mascot.events.on('drag-end', () => presenter.setDragging(false));

  presenter.start();
  idleTalk.start();
  if (mascot.isReady()) {
    applyMascotSettings();
    pushSummary();
    presenter.setRendererReady(true);
  }

  if (isDev) {
    // 開発用：実イベントを待たずに表示・キュー順・ドラッグ・ミュート・バッジを確認できる
    let seq = 0;
    const push = (source) => notifyQueue.push(makeDevNotification(source, ++seq));
    const setSummaryCount = (count) => mailSummary.update(Math.max(0, count), { capped: count >= 2500 });
    devMenuItems = [
      { label: 'カレンダー', click: () => push(SOURCES.CALENDAR) },
      { label: 'TODO', click: () => push(SOURCES.TASKS) },
      { label: '重要メール', click: () => push(SOURCES.GMAIL) },
      { label: '3種を連続（カレンダー→TODO→メール）', click: () => [SOURCES.CALENDAR, SOURCES.TASKS, SOURCES.GMAIL].forEach(push) },
      { label: '重要メール5連続', click: () => Array.from({ length: 5 }, () => SOURCES.GMAIL).forEach(push) },
      { type: 'separator' },
      // サマリは次のポーリング（最大1分後）で実際の未読件数に戻る
      { label: 'サマリ +1', click: () => setSummaryCount(mailSummary.get().count + 1) },
      { label: 'サマリ 100件（99+ 表示）', click: () => setSummaryCount(100) },
      { label: 'サマリ 0件（非表示）', click: () => setSummaryCount(0) },
      { type: 'separator' },
      // 見た目の確認用（実際のオフライン判定・バックオフには関与しない）
      {
        label: 'オフライン表示 ON/OFF（見た目確認用）',
        click: () => {
          devOffline = !devOffline;
          mascot.setOffline(isOffline());
          if (devOffline) showOfflineMessage();
        },
      },
      { label: 'VOICEVOX 接続状態を再確認', click: () => void voicevox.checkStatus(effectiveVoiceConfig()).catch(() => {}) },
      // 見た目の確認用（連携の状態・右クリックメニューは変わらない）
      { label: 'Google 連携の期限の予告', click: () => showLinkExpiry('expiring') },
      { label: 'Google 連携切れ', click: () => showLinkExpiry('expired') },
      { type: 'separator' },
      // 間隔・静粛時間帯を無視して今すぐ表示（通知表示中などで受理されなければ何も起きない）
      { label: 'アイドルトーク（通常）', click: () => idleTalk.fireNow('normal') },
      { label: 'アイドルトーク（朝）', click: () => idleTalk.fireNow('morning') },
      { label: 'アイドルトーク（就寝前）', click: () => idleTalk.fireNow('bedtime') },
    ];
    refreshTrayMenu();
  }

  pipeline = createPipeline({
    auth,
    providers: {
      calendar: createCalendarProvider({ listEvents: api.listEvents }),
      tasks: createTasksProvider({
        listTaskLists: api.listTaskLists,
        listTasks: api.listTasks,
        notifyHour: () => getPollingConfig().taskNotifyHour,
        notifyMinute: () => getPollingConfig().taskNotifyMinute,
      }),
      gmail: createGmailProvider({ listMessages: api.listMessages, getMessage: api.getMessage, log }),
    },
    notifyQueue,
    mailSummary,
    getPollingConfig,
    usage,
    log,
  });
  // オフライン判定（scheduler）→ マスコットの表示。遷移時に1回だけ「接続を確認してね」を出す（復帰時は表示を消すだけ）
  pipeline.scheduler.events.on('offline-change', ({ offline }) => {
    mascot.setOffline(isOffline());
    if (offline && !devOffline) showOfflineMessage();
  });

  // ネットワークの復帰（OS の報告・オフライン中の疎通確認）・スリープからの復帰で、バックオフ待ちの系統をすぐ再試行する
  onlineWatch = createNetworkWatch({
    isOsOnline: () => net.isOnline(),
    isOffline: () => pipeline?.scheduler.isOffline() ?? false,
    probe: probeInternet,
    onRecover: () => pipeline?.scheduler.retryAllNow(),
    intervalMs: ONLINE_WATCH_MS,
    log,
  });
  onlineWatch.start();
  powerMonitor.on('resume', () => {
    log.info('[app] スリープから復帰したため再試行します');
    idleTalk?.touch(); // 復帰直後にアイドルトークを出さない
    pipeline?.scheduler.retryAllNow();
  });

  await pipeline.start();
}
