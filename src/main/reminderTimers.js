// 予約通知（カレンダーのリマインダー・TODOの16:00）の setTimeout 管理（7.1）。
// 「ポーリングごとに登録済みタイマーを再構築し、予定の変更・削除に追随する」を、二重発火なしで行う。
//
// 二重発火を防ぐための決めごと：
//   1. 登録済みハンドルの所有者は timers（Map）ただ一つ。clearTimeout を呼ぶ経路も cancel() 一つに限定する。
//      個別に clearTimeout を書く場所をコード中に作らない。
//   2. reconcile() は差分適用。id と発火時刻が同じものは既存タイマーをそのまま残す
//      （毎回張り直すと、発火直前のタイマーがポーリングのたびにリセットされ続ける）。
//   3. 発火コールバックは真っ先に自分を Map から削除してから onFire を呼ぶ。
//      「発火済みのタイマーが Map に残り、次の reconcile で cancel 対象になる」状態を作らない。
//
// なお、仮に二重発火してもキュー側のID重複排除（F-05）が握り潰す。ここはその一段目。

/** setTimeout の遅延の上限（32bit）。超えると即時発火に化けるので登録しない。 */
const MAX_DELAY_MS = 2147483647;

/**
 * @param {object} deps
 * @param {(entry: object) => void} deps.onFire 発火時に呼ぶ（通常は notifyQueue.push）
 * @param {() => number} [deps.now]
 * @param {typeof globalThis.setTimeout} [deps.setTimeout] テストでは fake timers が入る
 * @param {typeof globalThis.clearTimeout} [deps.clearTimeout]
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createReminderTimers({
  onFire,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  log = console,
}) {
  /** @type {Map<string, { handle: any, notifyAt: number }>} 登録済みハンドルの唯一の所有者 */
  const timers = new Map();

  /** タイマーを破棄する唯一の経路。clear と delete を必ずセットで行う。 */
  function cancel(id) {
    const rec = timers.get(id);
    if (!rec) return false;
    timers.delete(id);
    clearTimer(rec.handle);
    return true;
  }

  function schedule(entry) {
    const delay = Math.max(0, entry.notifyAt - now());
    if (delay > MAX_DELAY_MS) return false; // 遠すぎる予定。次回以降のポーリングで登録する
    const handle = setTimer(() => {
      // 先に自分を取り下げる。以降このIDは「登録されていない」状態
      timers.delete(entry.id);
      try {
        onFire(entry);
      } catch (e) {
        log.warn(`[reminderTimers] onFire failed for ${entry.id}: ${e?.message ?? e}`);
      }
    }, delay);
    timers.set(entry.id, { handle, notifyAt: entry.notifyAt });
    return true;
  }

  return {
    /**
     * 「登録されているべきタイマーの全体」を渡すと、その状態に合わせる。
     * 消えた予定のタイマーは破棄し、時刻が変わったものは張り直し、変わらないものは触らない。
     *
     * @param {Array<{ id: string, notifyAt: number }>} entries
     * @returns {{ added: number, removed: number, kept: number, skipped: number }}
     */
    reconcile(entries) {
      /** @type {Map<string, object>} */
      const desired = new Map();
      for (const e of entries ?? []) {
        if (typeof e?.id === 'string' && Number.isFinite(e?.notifyAt)) desired.set(e.id, e);
      }

      let removed = 0;
      for (const [id, rec] of [...timers]) {
        const next = desired.get(id);
        // 一覧から消えた、または発火時刻が変わった → 破棄する（時刻変更は下で張り直される）
        if (!next || next.notifyAt !== rec.notifyAt) {
          cancel(id);
          removed++;
        }
      }

      let added = 0;
      let kept = 0;
      let skipped = 0;
      for (const entry of desired.values()) {
        if (timers.has(entry.id)) {
          kept++;
          continue;
        }
        if (schedule(entry)) added++;
        else skipped++;
      }

      return { added, removed, kept, skipped };
    },

    cancel,

    /** 登録済みのタイマーをすべて破棄する（終了時・連携解除時）。 */
    disposeAll() {
      for (const id of [...timers.keys()]) cancel(id);
    },

    size: () => timers.size,
    has: (id) => timers.has(id),
    scheduledIds: () => [...timers.keys()],
  };
}
