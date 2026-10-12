// マスコットウィンドウの表示・非表示（F-20「通知時のみ表示」・v5.12）。Electron を import しない（ウィンドウ操作・タイマーは注入）。
//
// displayMode が 'always' なら常に表示する。'notifyOnly' なら普段は非表示で、通知の演出が始まったら表示し、
// 吹き出しが閉じてウィンドウが通常の大きさへ戻ったら（collapsed）消す。連続する通知の間はウィンドウが縮小しないので消えない。
// ドラッグ中・右クリックメニュー表示中（busy）も消さない。
//
// 出入りはフェード：表示はウィンドウを出してからレンダラーを不透明へ遷移させ、非表示はレンダラーを透明へ遷移させてから
// ウィンドウを隠す（透明になったフレームを残して隠すので、次に表示したときに前の絵が一瞬出ない）。
// レンダラーは透明な状態から始まるので、起動時（always）もフェードインする。

export const DISPLAY_MODES = Object.freeze(['always', 'notifyOnly']);

/** レンダラーのフェード（style.css の body の transition）より少し長く待ってから隠す */
export const HIDE_DELAY_MS = 250;

/** アイドルトーク（F-15）を出してよいか。通知時のみ表示では出さない（v5.12） */
export const allowsIdleTalk = (displayMode) => displayMode !== 'notifyOnly';

/**
 * @param {object} opts
 * @param {() => void} opts.showWindow ウィンドウを（フォーカスを奪わずに）表示する
 * @param {() => void} opts.hideWindow ウィンドウを隠す
 * @param {(opaque: boolean) => void} opts.fade レンダラーを不透明／透明へ遷移させる
 * @param {'always' | 'notifyOnly'} [opts.mode]
 * @param {typeof setTimeout} [opts.setTimeout]
 * @param {typeof clearTimeout} [opts.clearTimeout]
 */
export function createMascotVisibility({
  showWindow,
  hideWindow,
  fade,
  mode: initialMode = 'always',
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
}) {
  let mode = DISPLAY_MODES.includes(initialMode) ? initialMode : 'always';
  /** ウィンドウの初回描画が終わったか（ready-to-show。それまでは表示しない） */
  let windowReady = false;
  /** 通知の演出中（表示開始〜縮小の完了） */
  let presenting = false;
  const busy = new Set();
  /** ウィンドウを表示しているか（フェードアウト中も true） */
  let shown = false;
  /** レンダラーを不透明にしているか */
  let opaque = false;
  let hideTimer = null;

  function sync() {
    if (!windowReady) return;
    const want = mode === 'always' || presenting || busy.size > 0;
    if (want) {
      if (hideTimer !== null) {
        clearTimer(hideTimer); // フェードアウト中に次の通知が来た
        hideTimer = null;
      }
      if (!shown) {
        shown = true;
        showWindow();
      }
      if (!opaque) {
        opaque = true;
        fade(true);
      }
      return;
    }
    if (!shown || hideTimer !== null) return;
    opaque = false;
    fade(false);
    hideTimer = setTimer(() => {
      hideTimer = null;
      shown = false;
      hideWindow();
    }, HIDE_DELAY_MS);
  }

  return {
    /** ウィンドウの初回描画が終わった（ready-to-show） */
    windowReady() {
      windowReady = true;
      sync();
    },

    /** @param {'always' | 'notifyOnly'} next 不正な値は always */
    setMode(next) {
      mode = DISPLAY_MODES.includes(next) ? next : 'always';
      sync();
    },

    /** 通知の演出を始める（ウィンドウを吹き出し用に拡大する前に呼ぶ） */
    notifyPresenting() {
      presenting = true;
      sync();
    },

    /** 吹き出しが閉じ、ウィンドウが通常の大きさへ戻った（またはレンダラーが読み込み直された） */
    notifyCollapsed() {
      presenting = false;
      sync();
    },

    /** @param {'drag' | 'menu'} key @param {boolean} on */
    setBusy(key, on) {
      if (on) busy.add(key);
      else busy.delete(key);
      sync();
    },

    /** レンダラーを不透明にしているか（読み込み直したレンダラーへ今の状態を送り直すため） */
    isOpaque: () => opaque,
  };
}
