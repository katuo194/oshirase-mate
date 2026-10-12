// ネットワーク復帰の検知（F-14）。バックオフ（最大15分）を待たずに、復帰したらすぐ scheduler に再試行させる。
//
//   OS の報告：isOsOnline() が false → true に変わったら再試行する。
//   疎通確認：オフライン表示中だけ、intervalMs ごとに probe()（Google への軽い HTTP リクエスト）で実際の疎通を確かめる。
//     Windows では仮想アダプタ（Hyper-V・WSL 等）があると net.isOnline() がネット断中も true のままで、
//     OS の報告だけでは復帰を検知できないため。
//     probe が成功したら再試行する。ただし続けて成功している間は繰り返さない（Google 側の障害などで
//     疎通はあるのに API が失敗し続けるときに、intervalMs ごとに API を叩き続けないため）。
//
// Electron に依存しない：OS の状態・オフライン判定・疎通確認・タイマーはすべて注入する。

/**
 * @param {object} deps
 * @param {() => boolean} deps.isOsOnline OS が報告するネットワーク状態（net.isOnline）
 * @param {() => boolean} deps.isOffline オフライン表示中か（scheduler.isOffline）
 * @param {() => Promise<boolean>} deps.probe 実際にインターネットへ届くか。reject しない
 * @param {() => void} deps.onRecover 復帰を検知したとき（scheduler.retryAllNow）
 * @param {number} deps.intervalMs
 * @param {typeof globalThis.setInterval} [deps.setInterval]
 * @param {typeof globalThis.clearInterval} [deps.clearInterval]
 * @param {{ info: Function }} [deps.log]
 */
export function createNetworkWatch({
  isOsOnline,
  isOffline,
  probe,
  onRecover,
  intervalMs,
  setInterval: setTimer = (...a) => globalThis.setInterval(...a),
  clearInterval: clearTimer = (...a) => globalThis.clearInterval(...a),
  log = console,
}) {
  let handle = null;
  let lastOsOnline = true;
  /** このオフライン期間中の直前の probe の結果（未実施は null）。オフラインを抜けたら null に戻す */
  let lastProbeOk = null;
  let probing = false;

  async function check() {
    const osOnline = isOsOnline();
    const osRecovered = osOnline && !lastOsOnline;
    lastOsOnline = osOnline;
    if (osRecovered) {
      log.info('[app] OS がネットワーク接続を報告したため再試行します');
      onRecover();
      return;
    }

    if (!isOffline()) {
      lastProbeOk = null;
      return;
    }
    if (!osOnline || probing) return; // OS が切断を報告している間は確かめるまでもない
    probing = true;
    let ok = false;
    try {
      ok = (await probe()) === true;
    } catch {
      ok = false;
    } finally {
      probing = false;
    }
    if (handle === null || !isOffline()) return; // 確認中に停止された・他の経路で復帰した
    if (ok && lastProbeOk !== true) {
      log.info('[app] インターネットへの疎通を確認したため再試行します');
      onRecover();
    }
    lastProbeOk = ok;
  }

  return {
    start() {
      if (handle !== null) return;
      lastOsOnline = isOsOnline();
      lastProbeOk = null;
      handle = setTimer(() => void check(), intervalMs);
    },

    stop() {
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}
