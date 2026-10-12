// 通知パイプラインの配線（orchestration）。「どのイベントで何を呼ぶか」をここに集約する（Phase 4）。
// Electron・googleapis に依存しない：providers / auth / notifyQueue / mailSummary / タイマー / ログはすべて注入する。
// 実 googleapis クライアントの生成や実ファイルパスは index.js の担当。バックオフとオフライン判定は scheduler.js（Phase 6）。
//
//   カレンダー・TODO   poll → 予約通知の一覧 → reminderTimers.reconcile → 時刻に onFire → notifyQueue.push
//   メール（重要）     poll → 新規ID → notifyQueue.push（検知時点が通知時刻）
//   メール（その他）   poll → 未読件数 → mailSummary.update（'updated' で外へ）
//
// 未連携（auth の status が linked 以外）のときは API を呼ばずスキップする。エラー扱いにはしない。

import { createReminderTimers } from './reminderTimers.js';
import { createScheduler } from './scheduler.js';
import { localTimestamp } from './logger.js';

/** scheduler.js の系統名。 */
export const SOURCE_NAMES = Object.freeze({
  CALENDAR: 'calendar',
  TASKS: 'tasks',
  MAIL_IMPORTANT: 'gmail-important',
  MAIL_OTHER: 'gmail-other',
});

const SKIP_MESSAGES = Object.freeze({
  unlinked: '未連携のためスキップ',
  unconfigured: 'OAuth設定が未完了のためスキップ',
  checking: '認証確認中のためスキップ（確認完了後に即時実行）',
  linking: '連携処理中のためスキップ',
});

const USAGE_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {{ getState: () => { status: string }, events: import('node:events').EventEmitter }} deps.auth
 * @param {{ calendar: { poll: Function }, tasks: { poll: Function }, gmail: { pollImportant: Function, pollUnreadOtherCount: Function, reset: Function } }} deps.providers
 * @param {ReturnType<import('./notifyQueue.js').createNotifyQueue>} deps.notifyQueue
 * @param {ReturnType<import('./mailSummary.js').createMailSummary>} deps.mailSummary
 * @param {() => { polling: { mailIntervalSec: number, calendarIntervalSec: number, taskIntervalSec: number } }} deps.getPollingConfig
 * @param {{ format: () => string }} [deps.usage] API呼び出し回数の実測（1時間ごと・終了時にログへ出す）
 * @param {{ setTimeout?: Function, clearTimeout?: Function, setInterval?: Function, clearInterval?: Function }} [deps.timers] テストでは fake timers が入る
 * @param {() => number} [deps.now]
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createPipeline({
  auth,
  providers,
  notifyQueue,
  mailSummary,
  getPollingConfig,
  usage,
  timers = {},
  now = Date.now,
  log = console,
}) {
  const t = {
    setTimeout: timers.setTimeout ?? globalThis.setTimeout,
    clearTimeout: timers.clearTimeout ?? globalThis.clearTimeout,
    setInterval: timers.setInterval ?? globalThis.setInterval,
    clearInterval: timers.clearInterval ?? globalThis.clearInterval,
  };

  /** 予約通知（カレンダー・TODO）の発火。キュー側の重複排除（F-05）に任せ、捨てられた場合だけ記録する。 */
  const reminderTimers = createReminderTimers({
    onFire: (entry) => {
      const res = notifyQueue.push(entry);
      if (!res.accepted) log.info(`[pipeline] 通知済みのため破棄 (${res.reason}): ${entry.id}`);
    },
    now,
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
    log,
  });

  // reminderTimers.reconcile は「登録されているべき全体」を受け取る仕様で、渡さなかったタイマーは破棄される。
  // カレンダーとTODOが同じインスタンスを共有するため、系統ごとの最新の取得結果を保持して、常に和集合を渡す。
  const latest = { calendar: [], tasks: [] };

  /**
   * 通知済みの予約通知はタイマーに載せ直さない。リマインダー時刻が過ぎた予定は、開始までのポーリングのたびに
   * 「時刻が過去 → 即時発火」で再登録されてしまい、キューに弾かれるだけの発火とログが繰り返されるため。
   * 再起動後に履歴へ読み込まれた通知済みIDも、ここで登録前に除外される（F-05）。
   */
  const dropNotified = (entries) => entries.filter((e) => !notifyQueue.isNotified(e.id));

  const isLinked = () => auth.getState().status === 'linked';

  /** 系統ごとに、最後に出したスキップ理由。同じ理由のスキップを毎回ログに出さないため。 */
  const lastSkip = new Map();

  function logSkip(name, status) {
    if (lastSkip.get(name) === status) return;
    lastSkip.set(name, status);
    log.info(`[pipeline] ${name}: ${SKIP_MESSAGES[status] ?? `${status}のためスキップ`}`);
  }

  /**
   * 未連携ならスキップ、連携済みなら fetch → apply。
   * fetch の await 中に連携解除された場合は結果を捨てる（解除後にタイマーが復活しないように）。
   * 例外はそのまま投げる（scheduler の 'failed' に GoogleApiError として載る）。
   */
  async function run(name, fetch, apply) {
    const status = auth.getState().status;
    if (status !== 'linked') {
      logSkip(name, status);
      return { skipped: true, reason: status };
    }
    let data;
    try {
      data = await fetch();
    } catch (e) {
      // 連携解除との競合で、トークン取得に失敗しただけの場合はエラーにしない
      if (!isLinked()) {
        logSkip(name, auth.getState().status);
        return { skipped: true, reason: auth.getState().status };
      }
      throw e;
    }
    if (!isLinked()) {
      logSkip(name, auth.getState().status);
      return { skipped: true, reason: auth.getState().status };
    }
    lastSkip.delete(name);
    return { skipped: false, result: apply(data) };
  }

  /** 予約通知の和集合でタイマーを再構築し、新しく登録されたものを時刻つきでログに残す。 */
  function reconcileTimers(name) {
    const before = new Set(reminderTimers.scheduledIds());
    // 他系統の最新結果に残っている通知済みの分（さっき発火したばかりのもの）もここで除外する
    const all = dropNotified([...latest.calendar, ...latest.tasks]);
    const r = reminderTimers.reconcile(all);
    log.info(`[pipeline] ${name}: 予約通知 追加${r.added} / 削除${r.removed} / 維持${r.kept} / 範囲外${r.skipped}`);
    for (const e of all) {
      if (!before.has(e.id) && reminderTimers.has(e.id)) {
        log.info(`[pipeline]   登録: [${e.source}] ${e.title} → ${localTimestamp(e.notifyAt)}`);
      }
    }
    return r;
  }

  const pollers = {
    [SOURCE_NAMES.CALENDAR]: () =>
      run(
        SOURCE_NAMES.CALENDAR,
        () => providers.calendar.poll(),
        (entries) => {
          latest.calendar = entries;
          return reconcileTimers(SOURCE_NAMES.CALENDAR);
        },
      ),

    [SOURCE_NAMES.TASKS]: () =>
      run(
        SOURCE_NAMES.TASKS,
        () => providers.tasks.poll(),
        (entries) => {
          latest.tasks = entries;
          return reconcileTimers(SOURCE_NAMES.TASKS);
        },
      ),

    [SOURCE_NAMES.MAIL_IMPORTANT]: () =>
      run(
        SOURCE_NAMES.MAIL_IMPORTANT,
        () => providers.gmail.pollImportant(),
        ({ notifications, seeded }) => {
          if (seeded) log.info('[pipeline] gmail-important: 初回取得（既存の未読は通知済み扱い）');
          let accepted = 0;
          for (const n of notifications) {
            // メールは検知した時点が通知時刻なのでタイマーを介さず直接キューへ
            const res = notifyQueue.push(n);
            if (res.accepted) accepted++;
            else log.info(`[pipeline] 通知済みのため破棄 (${res.reason}): ${n.id}`);
          }
          return { seeded, accepted };
        },
      ),

    [SOURCE_NAMES.MAIL_OTHER]: () =>
      run(
        SOURCE_NAMES.MAIL_OTHER,
        () => providers.gmail.pollUnreadOtherCount(),
        ({ count, capped }) => mailSummary.update(count, { capped }),
      ),
  };

  const config = getPollingConfig();
  const scheduler = createScheduler({
    sources: [
      { name: SOURCE_NAMES.CALENDAR, intervalSec: config.polling.calendarIntervalSec, poll: pollers[SOURCE_NAMES.CALENDAR] },
      { name: SOURCE_NAMES.TASKS, intervalSec: config.polling.taskIntervalSec, poll: pollers[SOURCE_NAMES.TASKS] },
      { name: SOURCE_NAMES.MAIL_IMPORTANT, intervalSec: config.polling.mailIntervalSec, poll: pollers[SOURCE_NAMES.MAIL_IMPORTANT] },
      { name: SOURCE_NAMES.MAIL_OTHER, intervalSec: config.polling.mailIntervalSec, poll: pollers[SOURCE_NAMES.MAIL_OTHER] },
    ],
    runImmediately: true,
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
    now,
    log,
  });

  /** 連携が外れた（解除・invalid_grant）ときの後始末。再連携後に 7.1 の「初回は既存未読を通知済み扱い」が正しく効くようにする。 */
  function resetState() {
    reminderTimers.disposeAll();
    latest.calendar = [];
    latest.tasks = [];
    providers.gmail.reset();
    mailSummary.reset();
    scheduler.resetOffline(); // 未連携はオフラインとは別の状態（invalid_grant をオフラインに数えない：2.3）
    log.info('[pipeline] 連携が外れたため予約通知と取得状態をリセット');
  }

  let running = false;
  /** scheduler.start() 済みか。履歴の読み込み前に runNow して未初期化の notifyQueue に push しないため、running とは分ける */
  let ready = false;
  let previousStatus = auth.getState().status;
  auth.events.on('change', ({ status }) => {
    if (status === previousStatus) return;
    previousStatus = status;
    if (status === 'linked') {
      // 起動時の認証確認中にスキップされた分・設定画面での連携直後を、次の間隔まで待たずに実行する
      if (ready) for (const name of Object.keys(pollers)) void scheduler.runNow(name);
    } else if (status === 'unlinked' || status === 'unconfigured') {
      resetState();
    }
  });

  let usageTimer = null;

  return {
    scheduler,
    reminderTimers,

    /** 通知済み履歴を読み込んでからポーリングを開始する（history 未読込のまま push しないため）。 */
    async start() {
      if (running) return;
      running = true;
      try {
        const n = await notifyQueue.init();
        log.info(`[pipeline] 通知済み履歴を読み込み（${n}件）`);
      } catch (e) {
        log.warn(`[pipeline] 通知済み履歴の読み込みに失敗（空で開始）: ${e?.message ?? e}`);
      }
      if (!running) return; // 読み込み中に stop された
      scheduler.start();
      ready = true;
      if (usage) usageTimer = t.setInterval(() => log.info(usage.format()), USAGE_LOG_INTERVAL_MS);
      log.info('[pipeline] ポーリング開始');
    },

    stop() {
      if (!running) return;
      running = false;
      ready = false;
      scheduler.stop();
      reminderTimers.disposeAll();
      if (usageTimer !== null) t.clearInterval(usageTimer);
      usageTimer = null;
      if (usage) log.info(usage.format());
    },
  };
}
