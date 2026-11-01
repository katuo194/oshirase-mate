import { BrowserWindow, ipcMain, screen } from 'electron';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCharacterAnchor, loadSettingsWindowSize, saveCharacterAnchor, saveSettingsWindowSize } from './store.js';
import { SETTINGS_MIN_SIZE, isSettingsTab, resolveSettingsWindowSize } from './settingsWindowSize.js';
import { CHARACTER_SIZE, COLLAPSED_LAYOUT, boundsFromAnchor, computeLayout, layoutsEqual } from './windowLayout.js';
import { DEFAULT_VIEW } from './characterMotions.js';
import { classifyManualLink } from './manualLinks.js';
import { createMascotVisibility } from './mascotVisibility.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// 保存するのはアンカー（キャラクター中心のスクリーン座標）のみ。ウィンドウの bounds は、
// 現在の相対レイアウト（通常＝200×200、吹き出し表示中＝拡大）から anchor を基準に毎回逆算する（windowLayout.js）。
const SCREEN_MARGIN = 40;

function isAnchorOnAnyDisplay(anchor) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    anchor.x >= a.x && anchor.x < a.x + a.width && anchor.y >= a.y && anchor.y < a.y + a.height);
}

function defaultAnchor() {
  const a = screen.getPrimaryDisplay().workArea;
  return {
    x: a.x + a.width - SCREEN_MARGIN - CHARACTER_SIZE / 2,
    y: a.y + a.height - SCREEN_MARGIN - CHARACTER_SIZE / 2,
  };
}

function resolveInitialAnchor() {
  const saved = loadCharacterAnchor();
  return saved && isAnchorOnAnyDisplay(saved) ? saved : defaultAnchor();
}

/**
 * 透過マスコットウィンドウを生成する。
 *
 * 返すコントローラー（通知の表示は notificationPresenter.js が指揮し、ここは「窓と描画側への橋渡し」だけを担う）：
 *   events      … 'ready'（レンダラー準備完了）／'unready'（リロード・クラッシュ）／'done'（id：演出の完了）／
 *                 'drag-start'／'drag-end'
 *   present()   … ウィンドウを吹き出し用に拡大し（anchor 基準）、演出をレンダラーへ送る
 *   dismiss()   … ウィンドウを通常の大きさへ戻す
 *   setSummary() / applySettings() … バッジ・効果音／読み上げの設定のレンダラーへの反映
 *   sendVoice() … 表示中の通知の読み上げ音声（F-13）。setOffline() … オフライン表示（F-14）
 *   abort()     … 表示中のアイドルトークを絞って終わらせる（Phase 7：通知が来たとき）。events に 'menu'（右クリックメニュー表示）も追加
 *   setCharacter() … 表示するキャラクターの切り替え（Phase 8。下記「キャラクターの切り替え」）。events に 'character-applied' / 'character-failed'（view）を追加
 *   setDisplayMode() … 常時表示／通知時のみ表示（F-20。表示・非表示の判断は mascotVisibility.js）
 *
 * @param {object} opts
 * @param {boolean} opts.isDev --dev 起動か
 * @param {() => Electron.Menu} opts.buildMenu 右クリックメニューの生成関数
 * @param {() => boolean} opts.isQuitting 終了処理中か（それ以外のウィンドウ close は抑止する）
 * @param {'always' | 'notifyOnly'} [opts.displayMode] 起動時の表示モード（F-20）
 */
export function createMascotWindow({ isDev, buildMenu, isQuitting, displayMode = 'always' }) {
  let anchor = resolveInitialAnchor();
  let dragOrigin = null;
  /** 現在の相対レイアウト。吹き出し表示中だけ拡大される。bounds は常に anchor と組み合わせて逆算する */
  let layout = COLLAPSED_LAYOUT;
  const events = new EventEmitter();

  const win = new BrowserWindow({
    ...boundsFromAnchor(anchor, layout),
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Windows では resizable な transparent ウィンドウは透過が壊れる
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(dirname, '../preload/mascot.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 効果音（F-12）はユーザー操作なしで再生するため、自動再生ポリシーを緩める（このウィンドウは自アプリのローカルHTMLのみ）
      autoplayPolicy: 'no-user-gesture-required',
      // 演出中の rAF が遮蔽判定などで止まらないようにする（止まってもメイン側のウォッチドッグが次へ進める）
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  // キャラクター上にカーソルが来るまでクリックを透過。forward:true で mousemove はレンダラーに届く
  win.setIgnoreMouseEvents(true, { forward: true });

  // ---- 表示・非表示（F-20）。通知時のみ表示では通知の間だけ出す。出入りはレンダラーのフェード（mascotVisibility.js）----
  const visibility = createMascotVisibility({
    mode: displayMode,
    showWindow: () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver'); // 隠した後に出し直しても最前面の水準を保つ
    },
    hideWindow: () => {
      if (!win.isDestroyed()) win.hide();
    },
    fade: (opaque) => send('mascot:visibility', { visible: opaque }),
  });

  win.once('ready-to-show', () => visibility.windowReady());

  // Alt+F4 等でウィンドウだけが閉じてマスコットが消えるのを防ぐ（終了はメニューの「終了」のみ）
  win.on('close', (e) => {
    if (!isQuitting()) e.preventDefault();
  });

  win.loadFile(path.join(dirname, '../renderer/mascot/index.html'), {
    query: isDev ? { dev: '1' } : {},
  });
  if (isDev) {
    // 透過ウィンドウでは attach 型の DevTools が透過を壊すため detach で開く
    win.webContents.once('did-finish-load', () => win.webContents.openDevTools({ mode: 'detach' }));
  }

  const applyAnchor = () => win.setBounds(boundsFromAnchor(anchor, layout));

  // ---- レンダラーとの橋渡し（Phase 5） ----
  const send = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ---- レイアウトの切り替え（ちらつき対策） ----
  // キャラクターの画面上の位置は「ウィンドウ左上＋ウィンドウ内での描画位置」で決まる。拡大・縮小ではウィンドウ左上が動くので、
  // 描画位置も逆向きに同時に動かす必要があるが、setBounds（メイン）と再配置（レンダラー）は別プロセスで、同じ1フレームには載せられない。
  // どちらを先にしても「間違った位置のキャラクター」が1〜数フレーム見えてしまうため、切り替えの間だけキャラクターを隠す：
  //   1. prepare … レンダラーがキャラクターを隠し、新しいレイアウトへ再配置する（ウィンドウはまだ旧サイズ）
  //   2. ready   … 隠した状態が描画された後、レンダラーが ACK を返す
  //   3. setBounds → commit … メインがウィンドウを切り替え、レンダラーへ知らせる。レンダラーはリサイズの反映後にキャラクターを再表示する
  // 連続する通知で配置が同じなら、この切り替え自体を行わない（通知ごとの明滅を避ける）。
  const TRANSITION_TIMEOUT_MS = 1000; // ACK が来ない場合（レンダラー停止など）でも先へ進む
  const DISMISS_DELAY_MS = 150; // 縮小を少し遅らせ、直後に次の通知が来たら拡大したまま続ける

  let transitionSeq = 0;
  /** 進行中の切り替え。{ seq, layout, show, timer } */
  let transition = null;
  let dismissTimer = null;

  function commitTransition(t) {
    if (transition !== t) return;
    transition = null;
    clearTimeout(t.timer);
    if (win.isDestroyed()) return;
    layout = t.layout;
    applyAnchor(); // 常に anchor から逆算（characterAnchor 基準）
    send('mascot:layout-commit', { seq: t.seq });
    if (t.show) send('mascot:show', t.show);
    else if (t.layout === COLLAPSED_LAYOUT) visibility.notifyCollapsed(); // 吹き出しが閉じた（通知時のみ表示なら消す）
  }

  function startTransition(next, show) {
    if (win.isDestroyed()) return; // 終了処理中
    if (transition) clearTimeout(transition.timer); // 古い切り替えは破棄（その ACK は seq 不一致で無視される）
    const t = { seq: ++transitionSeq, layout: next, show, timer: null };
    t.timer = setTimeout(() => commitTransition(t), TRANSITION_TIMEOUT_MS);
    transition = t;
    send('mascot:layout-prepare', { seq: t.seq, layout: next });
  }

  ipcMain.on('mascot:layout-ready', (e, seq) => {
    if (e.sender !== win.webContents || !transition || transition.seq !== seq) return;
    commitTransition(transition);
  });

  let rendererReady = false;
  const markUnready = () => {
    if (!rendererReady) return;
    rendererReady = false;
    // リロード・クラッシュ時は通常の大きさに戻し、ドラッグ中だったなら終了扱いにする（pause したままにしない）
    if (transition) clearTimeout(transition.timer);
    transition = null;
    clearTimeout(dismissTimer);
    dismissTimer = null;
    layout = COLLAPSED_LAYOUT;
    if (!win.isDestroyed()) applyAnchor();
    if (dragOrigin) {
      dragOrigin = null;
      saveCharacterAnchor(anchor);
      visibility.setBusy('drag', false);
      events.emit('drag-end');
    }
    visibility.notifyCollapsed(); // 表示中の通知は打ち切られた（準備が戻れば presenter が表示し直す）
    events.emit('unready');
  };
  win.webContents.on('did-start-loading', markUnready);
  win.webContents.on('render-process-gone', markUnready);

  ipcMain.on('mascot:ready', (e) => {
    if (e.sender !== win.webContents) return;
    rendererReady = true;
    send('mascot:visibility', { visible: visibility.isOpaque() }); // 読み込み直したレンダラーは透明から始まる
    appliedView = DEFAULT_VIEW; // 読み込み直したレンダラーは既定キャラクターから始まる
    requestCharacterLoad();
    events.emit('ready');
  });

  // ---- キャラクターの切り替え（Phase 8）----
  // キャラクター枠は全キャラクター共通の 200 DIP なので、ウィンドウの大きさは変わらない。
  // view をレンダラーへ送ると、レンダラーが全スロットを先読みし、通知の表示中でなければ（表示中なら終わってから）差し替えて
  // mascot:character-loaded で結果を返す。リロード後は既定キャラクターから始まるので、準備完了のたびに送り直す。
  /** 表示したいキャラクター（setCharacter の値）と、レンダラーが実際に描いているキャラクター */
  let targetView = DEFAULT_VIEW;
  let appliedView = DEFAULT_VIEW;
  let characterSeq = 0;
  // 同じキャラクターでも編集されたら（revision が変われば）読み直す
  const viewKey = (v) => `${v.type}:${v.id}:${v.revision ?? ''}`;

  function requestCharacterLoad() {
    if (!rendererReady || win.isDestroyed()) return;
    if (viewKey(targetView) === viewKey(appliedView)) {
      ++characterSeq; // 読み込み中の古い要求は捨てる（すでに表示中のキャラクターへ戻した）
      send('mascot:character-cancel', {});
      return;
    }
    send('mascot:character-load', { seq: ++characterSeq, view: targetView });
  }

  ipcMain.on('mascot:character-loaded', (e, seq, ok) => {
    if (e.sender !== win.webContents || seq !== characterSeq) return;
    if (ok !== true) {
      events.emit('character-failed', targetView);
      return;
    }
    appliedView = targetView;
    events.emit('character-applied', appliedView);
  });

  ipcMain.on('mascot:show-done', (e, id) => {
    if (e.sender !== win.webContents || typeof id !== 'string') return;
    events.emit('done', id);
  });

  // モニタ構成が変わってキャラクターが画面外に取り残された場合は初期位置へ戻す
  const ensureVisible = () => {
    if (!isAnchorOnAnyDisplay(anchor)) {
      anchor = defaultAnchor();
      applyAnchor();
      saveCharacterAnchor(anchor);
    }
  };
  screen.on('display-removed', ensureVisible);
  screen.on('display-metrics-changed', ensureVisible);

  ipcMain.on('mascot:set-ignore-mouse', (e, ignore) => {
    if (e.sender !== win.webContents) return;
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  ipcMain.on('mascot:drag-start', (e) => {
    if (e.sender !== win.webContents) return;
    dragOrigin = { ...anchor };
    visibility.setBusy('drag', true);
    events.emit('drag-start');
  });

  ipcMain.on('mascot:drag-move', (e, dx, dy) => {
    if (e.sender !== win.webContents || !dragOrigin) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    anchor = { x: dragOrigin.x + dx, y: dragOrigin.y + dy };
    applyAnchor();
  });

  ipcMain.on('mascot:drag-end', (e) => {
    if (e.sender !== win.webContents || !dragOrigin) return;
    dragOrigin = null;
    saveCharacterAnchor(anchor);
    visibility.setBusy('drag', false);
    events.emit('drag-end');
  });

  // ダブルクリック：直前のお知らせをもう一度（F-21。判定と表示は presenter）
  ipcMain.on('mascot:replay', (e) => {
    if (e.sender !== win.webContents) return;
    events.emit('replay');
  });

  ipcMain.on('mascot:context-menu', (e) => {
    if (e.sender !== win.webContents) return;
    events.emit('menu'); // 操作あり（アイドルトークの再武装用）
    // メニューを開いている間は消さない（通知時のみ表示で、吹き出しが閉じた直後に右クリックした場合）
    visibility.setBusy('menu', true);
    buildMenu().popup({ window: win, callback: () => visibility.setBusy('menu', false) });
  });

  return {
    win,
    events,
    isReady: () => rendererReady,

    /**
     * 通知の演出を始める。ウィンドウを吹き出し用に拡大し（anchor 基準で見た目位置を保つ。切り替えの手順は上記）、
     * 完了後に演出を送る。すでに同じ配置で拡大済み（連続する通知）なら切り替えずにそのまま送る。
     * @param {object} presentation notificationView.toPresentation() の値
     * @param {{ url: string, volume: number } | null} sfx 鳴らす効果音（ミュート・ファイル無しなら null）
     * @param {{ width: number, height: number }} [bubbleSize]
     */
    present(presentation, sfx, bubbleSize) {
      visibility.notifyPresenting(); // 通知時のみ表示なら、拡大の前にウィンドウを出す（切り替えの ACK は描画中のウィンドウでしか返らない）
      clearTimeout(dismissTimer);
      dismissTimer = null;
      const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
      const next = computeLayout({ anchor, workArea: display.workArea, ...(bubbleSize ? { bubbleSize } : {}) });
      const show = { presentation, sfx };
      if (!transition && layoutsEqual(next, layout)) send('mascot:show', show);
      else startTransition(next, show);
    },

    /** ウィンドウを通常の大きさへ戻す（直後に次の通知が来なければ）。 */
    dismiss() {
      if (!transition && layoutsEqual(layout, COLLAPSED_LAYOUT)) {
        visibility.notifyCollapsed(); // すでに通常の大きさ（縮小の完了を待たずに消してよい）
        return;
      }
      clearTimeout(dismissTimer);
      dismissTimer = setTimeout(() => {
        dismissTimer = null;
        startTransition(COLLAPSED_LAYOUT, null);
      }, DISMISS_DELAY_MS);
    },

    /**
     * 表示中のアイドルトーク（F-15）を絞って終わらせる（通知が来たため）。レンダラーは絞りの後に通常どおり showDone を返す。
     * @param {string} id 表示中の presentation.id
     */
    abort(id) {
      send('mascot:abort', { id });
    },

    /** サマリバッジ。text が null なら非表示。 */
    setSummary(text) {
      send('mascot:summary', { text });
    },

    /** 音まわりの設定（ミュート・効果音／ボイス音量）。表示中の音を止める／音量を変えるために送る。 */
    applySettings({ muted, sfxVolume, voiceVolume }) {
      send('mascot:settings', { muted, sfxVolume, voiceVolume });
    },

    /**
     * 表示中の通知の読み上げ音声。レンダラーは表示中の id と一致し、まだ絞りに入っていなければ再生する（遅れて届いたものは捨てる）。
     * url: null は「合成できなかった」：voicePending の表示の保持を解く（v5.10）。
     * @param {{ id: string, url: string | null, volume?: number, durationMs?: number | null }} voice
     */
    sendVoice(voice) {
      send('mascot:voice', voice);
    },

    /** オフライン表示（困り顔＋左下のバッジ）。通知の演出とは独立に重ねて表示する。 */
    setOffline(offline) {
      send('mascot:offline', { offline: offline === true });
    },

    /**
     * 表示するキャラクターを切り替える（Phase 8）。先読みが終わり、通知の表示が終わってから切り替わる。
     * @param {object} view characterMotions.buildCharacterView() の値
     */
    setCharacter(view) {
      targetView = view ?? DEFAULT_VIEW;
      requestCharacterLoad();
    },

    /**
     * 表示モード（F-20）。always にするとすぐ表示し、notifyOnly にすると待機中ならすぐ、通知の表示中ならその後に消える。
     * @param {'always' | 'notifyOnly'} mode
     */
    setDisplayMode(mode) {
      visibility.setMode(mode);
    },
  };
}

let settingsWindow = null;

/** 設定ウィンドウ。IPC の送信元検証用（ipc.js から使う）。未オープンなら null。 */
export function getSettingsWindow() {
  return settingsWindow;
}

/**
 * 設定ウィンドウを開く。既に開いていれば前面に出すだけ（シングルトン）。
 * 設定・Google 連携（Phase 16）・キャラクター選択（3.6）は同じウィンドウのタブ（v5.19）。tab を渡すとそのタブを表示し、省略すると
 * 開いていれば今のタブのまま、新しく開くときは設定のタブにする。
 * @param {{ tab?: 'settings' | 'google' | 'character' }} [opts]
 */
export function openSettingsWindow({ tab } = {}) {
  const showTab = isSettingsTab(tab) ? tab : null;
  if (settingsWindow) {
    if (showTab) {
      const wc = settingsWindow.webContents;
      // 読み込み中に送ると画面のスクリプトが受け取れないので、読み込みが終わってから送る
      if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('settings:show-tab', showTab));
      else wc.send('settings:show-tab', showTab);
    }
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  // 大きさは変えられる（v5.19）。前に閉じたときの大きさで開く（無ければ 720×760。作業領域より大きくはしない）。
  // 狭くすると画面側で 1 列に並べ替え、低い画面では列の中（1 列のときは全体）だけスクロールする
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const size = resolveSettingsWindowSize(loadSettingsWindowSize(), workArea);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: Math.min(SETTINGS_MIN_SIZE.width, workArea.width),
    minHeight: Math.min(SETTINGS_MIN_SIZE.height, workArea.height - 40),
    useContentSize: true,
    show: false,
    title: showTab === 'character' ? 'キャラクター選択' : showTab === 'google' ? 'Google 連携' : '設定',
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(dirname, '../preload/settings.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.setMenu(null);

  // ローカルHTML以外を開かせない（外部リンクや新規ウィンドウを遮断）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());
  // 閉じたときの大きさを覚える（最大化・最小化中は元の大きさが取れないので、前に覚えた大きさのまま）
  win.on('close', () => {
    if (win.isMaximized() || win.isMinimized()) return;
    const [width, height] = win.getContentSize();
    saveSettingsWindowSize({ width, height });
  });
  win.on('closed', () => {
    settingsWindow = null;
  });

  win.loadFile(path.join(dirname, '../renderer/settings/index.html'), { query: { tab: showTab ?? 'settings' } });

  settingsWindow = win;
  return win;
}

let manualWindow = null;

/**
 * セットアップ手順書（共有版。F-18・v5.11）をアプリ内のウィンドウで開く。既に開いていれば前面に出すだけ（シングルトン）。
 * shell.openPath は .html の既定アプリ（VS Code 等のエディターのこともある）で開くため使わない。
 * 手順書は静的な HTML なので preload は持たせない。見出しへの移動はウィンドウ内、https のリンクは既定のブラウザで開き、それ以外は遮断する。
 * @param {object} opts
 * @param {string} opts.filePath 手順書の HTML
 * @param {(url: string) => Promise<void>} opts.openExternal 既定のブラウザで開く（https のみ渡される）
 */
export function openManualWindow({ filePath, openExternal }) {
  if (manualWindow) {
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.show();
    manualWindow.focus();
    return manualWindow;
  }

  const manualUrl = pathToFileURL(filePath).href;
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    show: false,
    title: 'セットアップ手順書',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // 専用のメモリ上のセッション（他のウィンドウの権限設定と干渉させない。ディスクにも残さない）
      partition: 'manual',
    },
  });
  win.setMenu(null);

  const openLink = (url) => {
    if (classifyManualLink(url, manualUrl) === 'external') void openExternal(url).catch(() => {});
  };
  // target="_blank" のリンク：新しいウィンドウは作らず、https なら既定のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  // 同じページ内の見出しへの移動だけを許す
  win.webContents.on('will-navigate', (e, url) => {
    if (classifyManualLink(url, manualUrl) === 'in-page') return;
    e.preventDefault();
    openLink(url);
  });
  // 権限はスコープの「コピー」ボタン用のクリップボード書き込みだけ
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    manualWindow = null;
  });

  win.loadURL(manualUrl);

  manualWindow = win;
  return win;
}

let chatWindow = null;

/** チャットウィンドウ。IPC の送信元検証用（ipc.js から使う）。未オープンなら null。 */
export function getChatWindow() {
  return chatWindow;
}

/**
 * チャットウィンドウを開く（F-16）。既に開いていれば前面に出すだけ（シングルトン）。
 * セキュリティは設定ウィンドウと同水準（webviewTag 無効・外部遷移／新規ウィンドウの拒否）に、権限要求の全拒否を加える
 * （専用の in-memory セッションを使うので、他のウィンドウには影響しない）。CSP は renderer/chat/index.html の meta。
 * @param {object} [opts]
 * @param {() => void} [opts.onOpened] 新しくウィンドウを作ったとき（新規の会話の開始）
 * @param {() => void} [opts.onClosed] ウィンドウが閉じたとき（履歴・音声の破棄）
 */
export function openChatWindow({ onOpened = () => {}, onClosed = () => {} } = {}) {
  if (chatWindow) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const win = new BrowserWindow({
    width: 380,
    height: 560,
    show: false,
    title: 'チャット',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(dirname, '../preload/chat.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: 'chat',
      // 読み上げ（F-13 と同じ VOICEVOX の音声）を、ユーザー操作の直後でなくても再生できるように
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenu(null);

  // 権限要求（カメラ・マイク・通知など）はすべて拒否する。このウィンドウは音声を再生するだけ
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  // ローカルHTML以外を開かせない（外部リンクや新規ウィンドウを遮断）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    chatWindow = null;
    onClosed();
  });

  chatWindow = win;
  onOpened();
  win.loadFile(path.join(dirname, '../renderer/chat/index.html'));
  return win;
}

/** チャットウィンドウを閉じる（10往復での自動終了）。 */
export function closeChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
}

// ---- キャラクター選択・作成／編集画面（Phase 8）----
// v5.19：どちらも設定ウィンドウの「キャラクター」タブの中の画面になった（作成／編集画面はタブの中で一覧と切り替える）。
// IPC の送信元の確認（ipc.js）には、どちらも設定ウィンドウを返す。

/** キャラクター選択画面のウィンドウ。IPC の送信元検証用。未オープンなら null。 */
export function getCharacterWindow() {
  return settingsWindow;
}

/** キャラクター作成／編集画面のウィンドウ。IPC の送信元検証用。未オープンなら null。 */
export function getCharacterCreateWindow() {
  return settingsWindow;
}

/** キャラクター選択画面（3.6）を開く。設定ウィンドウを「キャラクター」のタブで開く（v5.19）。 */
export function openCharacterWindow() {
  return openSettingsWindow({ tab: 'character' });
}