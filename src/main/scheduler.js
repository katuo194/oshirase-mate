// ポーリング統括（2.1 / 5.2 / 6章）。4系統をそれぞれの間隔で回し、失敗時のバックオフ（4章）とオフライン判定（F-14）を担う。
//
//   カレンダー        5分（config.json の polling.calendarIntervalSec）
//   TODO              5分（polling.taskIntervalSec）
//   メール（重要）    1分（polling.mailIntervalSec）
//   メール（それ以外）1分（polling.mailIntervalSec）
//
// バックオフ（系統ごと）：失敗が n 回続いたら、次の再試行は min(1分 × 2^(n-1), 15分) 後（1分→2分→4分→8分→15分→15分…）。
//   基準は通常間隔によらず全系統で1分。429 の Retry-After があればそちらが長い方を採る。成功したら通常間隔に戻る。
//   retryable フラグは見ない（直らない失敗でも API を叩き続けないよう、失敗はすべてバックオフする。retryable はログ・将来のUI用の情報）。
//
// オフライン判定（全体で1つ）：系統ごとに「接続失敗（error.offlineCandidate）の連続回数」を数え、
//   いずれか1系統が OFFLINE_THRESHOLD 回に達したらオフライン、全系統が閾値未満に戻ったら解除する。
//   offlineCandidate でない失敗（401・クォータ・429・403 など）はサーバーに届いている証拠なので、連続回数を 0 に戻す。
//   オフライン中に失敗していた系統が成功したら、バックオフ待ちの他系統を即時に再試行する（復帰の検知を15分待たせない）。
//
// Electron に依存しない：タイマー・時刻・各系統の poll 関数はすべて注入する。

import { EventEmitter } from 'node:events';
import { localTimestamp } from './logger.js';

export const BACKOFF_BASE_MS = 60 * 1000;
export const BACKOFF_MAX_MS = 15 * 60 * 1000;
/** F-14：接続失敗がこの回数続いたらオフライン。 */
export const OFFLINE_THRESHOLD = 3;

/** 失敗が n 回（n ≥ 1）続いたときの、次の再試行までの待ち時間。 */
export function backoffDelayMs(n) {
  const k = Math.max(1, Math.floor(n));
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(k - 1, 30), BACKOFF_MAX_MS);
}

/** ログ用の「1分」「30秒」「1分30秒」。 */
export function formatDelay(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}秒`;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

/**
 * @param {object} deps
 * @param {Array<{ name: string, intervalSec: number, poll: () => Promise<any> }>} deps.sources
 * @param {boolean} [deps.runImmediately] start() 直後に1回実行する（起動直後に通知を取りこぼさないため）
 * @param {typeof globalThis.setTimeout} [deps.setTimeout] テストでは fake timers が入る
 * @param {typeof globalThis.clearTimeout} [deps.clearTimeout]
 * @param {() => number} [deps.now]
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createScheduler({
  sources,
  runImmediately = true,
  setTimeout: setTimer = (...a) => globalThis.setTimeout(...a),
  clearTimeout: clearTimer = (...a) => globalThis.clearTimeout(...a),
  now = Date.now,
  log = console,
}) {
  // 失敗の通知に 'error' という名前は使わない。EventEmitter は 'error' にリスナーが1つも無いと
  // emit した時点で throw する仕様のため、購読者がいないだけでポーリングが落ちてしまう。
  const events = new EventEmitter();

  const entries = (sources ?? []).map((s) => ({
    name: s.name,
    intervalMs: s.intervalSec * 1000,
    poll: s.poll,
    handle: null,
    inFlight: false,
    consecutiveFailures: 0,
    /** 接続失敗（offlineCandidate）の連続回数。オフライン判定用 */
    offlineStreak: 0,
    /** バックオフ中の次回実行予定時刻（通常時は null） */
    backoffUntil: null,
    /** 現在のバックオフ待ち時間（通常時は null）。タイマー発火時の張り直しに使う */
    backoffMs: null,
    runs: 0,
    skips: 0,
  }));

  let running = false;
  let offline = false;

  /** 次の実行を delayMs 後に張り直す（保留中のタイマーは取り消す）。 */
  function arm(entry, delayMs) {
    if (entry.handle !== null) clearTimer(entry.handle);
    entry.handle = null;
    if (!running) return;
    entry.handle = setTimer(() => {
      entry.handle = null;
      // 発火した時点で次を張っておく（poll が戻らなくても次の機会が来るように。通常時は setInterval と同じ間隔になる）
      arm(entry, entry.backoffMs ?? entry.intervalMs);
      if (entry.backoffMs !== null) entry.backoffUntil = now() + entry.backoffMs;
      void tick(entry);
    }, delayMs);
  }

  function updateOffline(cause) {
    const next = entries.some((e) => e.offlineStreak >= OFFLINE_THRESHOLD);
    if (next === offline) return;
    offline = next;
    if (offline) {
      log.warn(`[scheduler] オフライン状態へ遷移（${cause.name} が${OFFLINE_THRESHOLD}回連続で接続失敗: ${cause.kind ?? 'unknown'}）`);
    } else {
      log.info('[scheduler] オンラインに復帰');
    }
    events.emit('offline-change', { offline, cause });
  }

  /** バックオフ待ちの系統を今すぐ実行する（復帰の兆候があったとき）。 */
  function retryBackedOff(except) {
    const targets = entries.filter((e) => e !== except && e.backoffMs !== null && !e.inFlight);
    if (targets.length === 0) return;
    log.info(`[scheduler] バックオフ待ちの系統を即時再試行: ${targets.map((e) => e.name).join(', ')}`);
    for (const e of targets) void tick(e);
  }

  function onSuccess(entry, result) {
    const recovered = entry.consecutiveFailures;
    entry.consecutiveFailures = 0;
    entry.offlineStreak = 0;
    if (recovered > 0) {
      entry.backoffMs = null;
      entry.backoffUntil = null;
      log.info(`[scheduler] ${entry.name} 復帰（${recovered}回の失敗の後）→ 通常間隔 ${formatDelay(entry.intervalMs)}`);
      arm(entry, entry.intervalMs);
    }
    events.emit('polled', { name: entry.name, result });
    const wasOffline = offline;
    updateOffline({ name: entry.name, kind: null });
    // 復帰の兆候（失敗していた系統が成功した）のときだけ。ずっと成功している系統の成功では何もしない
    if (wasOffline && recovered > 0) retryBackedOff(entry);
  }

  function onFailure(entry, error) {
    entry.consecutiveFailures++;
    const n = entry.consecutiveFailures;
    entry.offlineStreak = error?.offlineCandidate === true ? entry.offlineStreak + 1 : 0;

    const retryAfter = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
    const delay = Math.max(backoffDelayMs(n), retryAfter);
    entry.backoffMs = delay;
    entry.backoffUntil = now() + delay;
    arm(entry, delay);

    const next = running ? ` → 次の再試行 ${formatDelay(delay)}後 (${localTimestamp(entry.backoffUntil).slice(11, 19)})` : '';
    log.warn(`[scheduler] ${entry.name} poll failed (${n}連続): ${error?.message ?? error}${next}`);
    events.emit('failed', { name: entry.name, error, consecutiveFailures: n });
    updateOffline({ name: entry.name, kind: error?.kind ?? null });
  }

  /**
   * 1系統を1回実行する。
   * - 前回が完了していなければ今回は見送る（遅いAPI応答でポーリングが積み上がらないように）
   * - 例外は握り潰して他系統に波及させない（オフライン時にアプリを落とさない。4章）
   */
  async function tick(entry) {
    if (entry.inFlight) {
      entry.skips++;
      events.emit('skipped', { name: entry.name });
      return;
    }
    entry.inFlight = true;
    let ok = false;
    let result;
    let error;
    try {
      result = await entry.poll();
      ok = true;
    } catch (e) {
      error = e;
    } finally {
      entry.inFlight = false;
      entry.runs++;
    }
    if (ok) onSuccess(entry, result);
    else onFailure(entry, error);
  }

  return {
    events,

    /** ポーリングを開始する。多重 start は無視する。 */
    start() {
      if (running) return;
      running = true;
      for (const entry of entries) {
        arm(entry, entry.intervalMs);
        if (runImmediately) void tick(entry);
      }
    },

    /** すべてのタイマーを止める。実行中の poll の完了は待たない（結果は捨てられる）。 */
    stop() {
      if (!running) return;
      running = false;
      for (const entry of entries) {
        if (entry.handle !== null) clearTimer(entry.handle);
        entry.handle = null;
      }
    },

    /** 指定した系統を即座に1回実行する（設定変更後・再連携直後などに使う）。 */
    runNow(name) {
      const entry = entries.find((e) => e.name === name);
      if (!entry) return Promise.resolve();
      return tick(entry);
    },

    /** バックオフ待ちの全系統を即座に再試行する（OS のネットワーク復帰・スリープ復帰を検知したとき）。 */
    retryAllNow() {
      retryBackedOff(null);
    },

    /** オフライン判定を解除する（連携が外れたとき。未連携はオフラインとは別の状態）。 */
    resetOffline() {
      for (const e of entries) e.offlineStreak = 0;
      updateOffline({ name: null, kind: null });
    },

    isRunning: () => running,
    isOffline: () => offline,

    /** 系統ごとの実行状況（テスト・ログ用）。 */
    getStats: () =>
      entries.map((e) => ({
        name: e.name,
        runs: e.runs,
        skips: e.skips,
        consecutiveFailures: e.consecutiveFailures,
        offlineStreak: e.offlineStreak,
        backoffUntil: e.backoffUntil,
        inFlight: e.inFlight,
      })),
  };
}
