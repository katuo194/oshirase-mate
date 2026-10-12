// 通知の表示シーケンサ（F-03 / F-08 表示側 / 3.7 ドラッグ）。Electron に依存しない：描画の実体（show / finish）は注入する。
//
// 役割：notifyQueue から通知を「1件ずつ」取り出して表示に回し、表示完了の通知（done）を受けてから次を取り出す。
//       take() は表示が終わるたびに1回だけ呼ぶ。だから複数の通知が短時間に集中してもアニメーションは重ならず、キュー順に並ぶ。
//
//   取り出す条件：開始済み・表示中でない・レンダラー準備完了・ドラッグ中でない
//   ドラッグ中 ：setDragging(true) で notifyQueue.pause()。ドラッグ中に来た通知はキューに溜まり、
//                setDragging(false)（resume）の後に到着順で表示される。すでに始まっている表示はそのまま続く
//   ウォッチドッグ：出現＋保持＋退場＋余裕 の間に done が来なければ、警告ログを出して強制完了する
//                （レンダラーの停止・リロードで、キューが永久に止まらないようにする）。読み上げで表示が延びるときは extend() で延長する
//   システム通知：showSystem() で渡したアプリからのお知らせ（オフライン等。F-14）は、キューの次の通知より先に表示する。
//                表示中の演出は中断しない（1件ずつの原則は同じ）。notifyQueue・通知済みIDには載せない
//   再表示：replayLast() は、最後に表示した通知（予定・TODO・重要メール）を今の時刻で作り直してもう一度表示する（F-21）。
//          システム通知と同じ優先枠に入れる。notifyQueue・通知済みIDには載せない。通知・システム通知の表示中や待ちがあるときは受理しない
//
// show(presentation, notification)  … 表示を始める（ウィンドウ拡大→レンダラーへ送信）。例外は握りつぶして次の通知へ進む
// finish(presentation, reason)      … 表示を終える（ウィンドウを元の大きさへ）。reason: 'done' | 'timeout' | 'renderer-gone' | 'stopped'
// abort(presentation)               … 【Phase 7】表示中のアイドルトークを絞って終わらせるようレンダラーへ伝える（完了は通常どおり done で返る）
//
//   アイドルトーク：showIdle() で渡したアイドルトーク（F-15）は、通知が常に優先する。何も表示しておらずキューも空のときだけ受理し、
//                表示中に通知（enqueued）やシステム通知が来たら abort() で絞って終わらせ、その done の後に通知を始める

import { toPresentation, totalMs } from './notificationView.js';

/** 想定の演出時間に足す余裕。これを過ぎても done が来なければ強制完了する。 */
export const WATCHDOG_MARGIN_MS = 3000;

/**
 * @param {object} opts
 * @param {ReturnType<import('./notifyQueue.js').createNotifyQueue>} opts.notifyQueue
 * @param {(presentation: object, notification: object) => void} opts.show
 * @param {(presentation: object, reason: string) => void} [opts.finish]
 * @param {() => number} [opts.now]
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [opts.timers] テストでは fake timers が入る
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createNotificationPresenter({ notifyQueue, show, finish = () => {}, abort = () => {}, now = Date.now, timers = {}, log = console }) {
  const setTimer = timers.setTimeout ?? ((...a) => globalThis.setTimeout(...a));
  const clearTimer = timers.clearTimeout ?? ((...a) => globalThis.clearTimeout(...a));

  let started = false;
  let rendererReady = false;
  let dragging = false;
  /** 表示中の演出（なければ null）。{ presentation, timer, startedAt } */
  let current = null;
  /** 表示待ちのシステム通知・再表示（presentation）。キューより優先 */
  const systemQueue = [];
  /** 最後に表示した通知（再表示用。F-21）。システム通知・アイドルトーク・再表示そのものは含めない */
  let lastNotification = null;
  let replaySeq = 0;

  function complete(reason) {
    if (!current) return;
    const { presentation, timer } = current;
    current = null;
    clearTimer(timer);
    try {
      finish(presentation, reason);
    } catch (e) {
      log.warn(`[present] 表示の後始末に失敗: ${e?.message ?? e}`);
    }
  }

  /** 条件が揃っていれば、次の通知を1件取り出して表示する。何度呼んでも安全（表示中は何もしない）。 */
  function armWatchdog(presentation, delayMs) {
    return setTimer(() => {
      log.warn(`[present] 表示完了の応答がないため強制的に次へ進みます: ${presentation.id}`);
      complete('timeout');
      pump();
    }, delayMs);
  }

  /** 次に表示するもの。システム通知を優先し、次にキュー（ドラッグ中は notifyQueue 自体が止まっている）。 */
  function next() {
    if (systemQueue.length > 0) return { presentation: systemQueue.shift(), notification: null };
    const notification = notifyQueue.take();
    if (notification === null) return null;
    return { presentation: toPresentation(notification, { now: now(), backlog: notifyQueue.size() }), notification };
  }

  /** 表示を始める。例外は握りつぶし（この1件は諦める）、始められたかを返す。 */
  function begin(presentation, notification) {
    const timer = armWatchdog(presentation, totalMs(presentation.timing) + WATCHDOG_MARGIN_MS);
    current = { presentation, timer, startedAt: now(), aborting: false };
    try {
      show(presentation, notification);
      if (notification) lastNotification = notification;
      return true;
    } catch (e) {
      // 1件の表示失敗でキューを止めない。この通知は諦めて次へ
      log.warn(`[present] 表示の開始に失敗: ${presentation.id}: ${e?.message ?? e}`);
      complete('stopped');
      return false;
    }
  }

  function pump() {
    while (started && rendererReady && !dragging && current === null) {
      const item = next();
      if (item === null) return;
      if (begin(item.presentation, item.notification)) return;
    }
  }

  /**
   * アイドルトーク（F-15）の表示中に通知・システム通知が来たら、アイドルトークを中断する（通知が常に優先：v5.8）。
   * 中断は即時に消すのではなく、レンダラーが絞り（outMs）に入って done を返す形にし、通知はその完了後に始まる（1件ずつの原則を保つ）。
   */
  function preemptIdle() {
    if (current === null || current.aborting || current.presentation.kind !== 'idle') return;
    current.aborting = true;
    clearTimer(current.timer);
    // 絞りの時間＋余裕の間に done が来なければ強制完了（レンダラー停止でキューが止まらないように）
    current.timer = armWatchdog(current.presentation, current.presentation.timing.outMs + WATCHDOG_MARGIN_MS);
    log.info(`[present] 通知が来たためアイドルトークを中断: ${current.presentation.id}`);
    try {
      abort(current.presentation);
    } catch (e) {
      log.warn(`[present] アイドルトークの中断に失敗: ${e?.message ?? e}`);
    }
  }

  const onQueueEvent = () => {
    if (started) preemptIdle();
    pump();
  };

  return {
    start() {
      if (started) return;
      started = true;
      notifyQueue.events.on('enqueued', onQueueEvent);
      notifyQueue.events.on('resumed', onQueueEvent);
      pump();
    },

    stop() {
      if (!started) return;
      started = false;
      notifyQueue.events.off('enqueued', onQueueEvent);
      notifyQueue.events.off('resumed', onQueueEvent);
      complete('stopped');
    },

    /** レンダラーの準備状態。false（クラッシュ・リロード）なら表示中の演出を中断し、true になったら再開する。 */
    setRendererReady(ready) {
      rendererReady = ready === true;
      if (!rendererReady) complete('renderer-gone');
      else pump();
    },

    /** ドラッグの開始・終了。ドラッグ中は取り出しを止め、終了で再開する。 */
    setDragging(value) {
      const next = value === true;
      if (next === dragging) return;
      dragging = next;
      if (dragging) {
        notifyQueue.pause();
      } else {
        notifyQueue.resume();
        pump();
      }
    },

    /**
     * レンダラーからの表示完了。現在の演出と id が一致するときだけ受理し、古い応答は無視する。
     * @returns {boolean} 受理したか
     */
    done(id) {
      if (current === null || current.presentation.id !== id) return false;
      complete('done');
      pump();
      return true;
    },

    /**
     * アプリからのお知らせを表示する（キューの次の通知より先。表示中の演出があれば、その完了後）。
     * @param {object} presentation notificationView.systemPresentation() の値
     */
    showSystem(presentation) {
      systemQueue.push(presentation);
      preemptIdle(); // アイドルトーク表示中なら中断して、システム通知を先に出す
      pump();
    },

    /**
     * 最後に表示した通知をもう一度表示する（F-21。マスコットのダブルクリック）。表示の内容は今の時刻で作り直す（予定の「n分後」など）。
     * 何も表示していないか、アイドルトークの表示中（中断して先に出す）で、通知・システム通知の待ちが無いときだけ受理する。
     * @returns {'shown' | 'busy' | 'none'} shown：表示した（または中断の後に表示する）／busy：表示中・待ちがある／none：まだ通知を表示していない
     */
    replayLast() {
      if (!started || !rendererReady || dragging) return 'busy';
      if (current !== null && current.presentation.kind !== 'idle') return 'busy';
      if (systemQueue.length > 0 || notifyQueue.size() > 0) return 'busy';
      if (lastNotification === null) return 'none';
      // id は元の通知と別にする（遅れて届いた元の done・読み上げと取り違えない）
      systemQueue.push({ ...toPresentation(lastNotification, { now: now() }), id: `replay:${lastNotification.id}:${++replaySeq}` });
      preemptIdle();
      pump();
      return 'shown';
    },

    /**
     * アイドルトーク（F-15）を表示する。通知が優先なので、何も表示中でなく、システム通知待ち・通知キューが空で、
     * レンダラーが準備済みかつドラッグ中でないときだけ受理する（それ以外は false。呼び出し側が後で再試行する）。
     * 通知済みIDにもキューにも載せない。表示中に通知が来たら中断される（abort）。
     * @param {object} presentation notificationView.idlePresentation() の値
     * @returns {boolean} 受理したか
     */
    showIdle(presentation) {
      if (!started || !rendererReady || dragging || current !== null) return false;
      if (systemQueue.length > 0 || notifyQueue.size() > 0) return false;
      return begin(presentation, null);
    },

    /**
     * 表示中の演出の想定時間を延ばす（読み上げで保持時間が延びるとき）。ウォッチドッグを「表示開始から totalMs ＋余裕」に張り直す。
     * @returns {boolean} 受理したか（id が表示中のものでなければ false）
     */
    extend(id, totalMsFromStart) {
      if (current === null || current.presentation.id !== id || current.aborting) return false;
      clearTimer(current.timer);
      const remaining = Math.max(0, current.startedAt + totalMsFromStart + WATCHDOG_MARGIN_MS - now());
      current.timer = armWatchdog(current.presentation, remaining);
      return true;
    },

    /** 表示中の通知 id（なければ null）。 */
    currentId: () => current?.presentation.id ?? null,

    isDragging: () => dragging,
  };
}
