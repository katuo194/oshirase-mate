// 個別通知の正規化・重複排除・キュー管理（6章）。F-05 と F-08 の本体。
// Electron に依存しない：永続化層（notifiedStore）と時刻は注入する。
//
// F-08：push された順に並び、take() で先入れ先出しに1件ずつ取り出せる。
//       取り出し＝表示ではない。表示時にアニメーションを重ねないことは Phase 5 の担当。
// F-05：通知IDを notified.json に永続化し、再起動後も同じIDを二度と受け付けない。
//
// 通知IDはソース種別をプレフィックスにして、別ソース同士が衝突しないようにする：
//   カレンダー  cal:<eventId>:<リマインダー時刻のエポックms>   … 1予定に複数リマインダーがあり得る。予定が動けば再通知する
//   TODO        task:<taskListId>:<taskId>:<期限日>            … タスクIDはリスト内一意。期限変更で再通知する
//   重要メール  mail:<messageId>                              … メッセージIDだけで一意
// Google の ID は英数字・`_`・`-` のみでコロンを含まないため、`:` 区切りで曖昧さは生じない。
// サマリ通知（重要でないメール）はIDを持たず、ここも notified.json も通らない（mailSummary.js の管轄）。

import { EventEmitter } from 'node:events';

export const SOURCES = Object.freeze({
  CALENDAR: 'calendar',
  TASKS: 'tasks',
  GMAIL: 'gmail',
});

const ID_PREFIX = Object.freeze({
  [SOURCES.CALENDAR]: 'cal',
  [SOURCES.TASKS]: 'task',
  [SOURCES.GMAIL]: 'mail',
});

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 通知IDを組み立てる。ID生成をこの1関数に集約して、プレフィックスの付け忘れを防ぐ。
 * @param {string} source SOURCES のいずれか
 * @param {...(string|number)} parts
 */
export function makeNotificationId(source, ...parts) {
  const prefix = ID_PREFIX[source];
  if (!prefix) throw new Error(`unknown notification source: ${source}`);
  if (parts.length === 0 || parts.some((p) => p === undefined || p === null || p === '')) {
    throw new Error(`empty id part for source: ${source}`);
  }
  return [prefix, ...parts].join(':');
}

/**
 * providers が作った通知を検証・補完する（純粋関数）。不正なら null。
 * @returns {{ id: string, source: string, title: string, body: string, notifyAt: number, data: object } | null}
 */
export function normalizeNotification(raw, { now = Date.now() } = {}) {
  if (!isPlainObject(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!Object.values(SOURCES).includes(raw.source)) return null;
  return {
    id: raw.id,
    source: raw.source,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    notifyAt: Number.isFinite(raw.notifyAt) ? raw.notifyAt : now,
    data: isPlainObject(raw.data) ? { ...raw.data } : {},
  };
}

/**
 * @param {object} opts
 * @param {ReturnType<import('./notifiedStore.js').createNotifiedStore>} opts.store
 * @param {() => number} [opts.now]
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createNotifyQueue({ store, now = Date.now, log = console }) {
  const events = new EventEmitter();

  /** 通知済みID → 記録時刻。init() で notified.json から復元する */
  let notified = {};
  /** 取り出し待ちの通知（先頭が最も古い） */
  const pending = [];
  /** キュー内のIDの索引。notified に入るのは take() の時点なので、待機中の重複はこちらで弾く */
  const pendingIds = new Set();

  let paused = false;
  let initialized = false;

  // 永続化は単一フライトでコアレスする（auth.js の refreshAccessToken と同じ方式）
  let persisting = null;
  let dirty = false;

  function persist() {
    dirty = true;
    if (persisting) return persisting;
    persisting = (async () => {
      while (dirty) {
        dirty = false;
        // 書き込み中に take() が新しいIDを足し得るので、渡すのはコピー。
        // 戻り値はパージ後の内容で、消えたIDだけをメモリからも落とす（書き込み中に増えた分は残す）。
        const snapshot = { ...notified };
        try {
          const purged = await store.save(snapshot);
          for (const id of Object.keys(snapshot)) {
            if (!(id in purged)) delete notified[id];
          }
        } catch (e) {
          log.warn(`[notifyQueue] failed to persist notified ids: ${e?.message ?? e}`);
        }
      }
    })().finally(() => {
      persisting = null;
    });
    return persisting;
  }

  return {
    events,

    /** 起動時に一度呼ぶ。notified.json を読み込む（7日超は notifiedStore がパージ済み）。 */
    async init() {
      notified = await store.load();
      initialized = true;
      return Object.keys(notified).length;
    },

    /**
     * 通知をキューに積む。重複（通知済み・キュー待機中）は積まずに捨てる。
     * @returns {{ accepted: boolean, reason?: 'duplicate' | 'invalid', notification?: object }}
     */
    push(raw) {
      if (!initialized) log.warn('[notifyQueue] push() before init(); 通知済み履歴が未読込のまま処理している');
      const n = normalizeNotification(raw, { now: now() });
      if (!n) return { accepted: false, reason: 'invalid' };
      if (n.id in notified || pendingIds.has(n.id)) return { accepted: false, reason: 'duplicate' };

      const notification = { ...n, queuedAt: now() };
      pending.push(notification);
      pendingIds.add(n.id);
      events.emit('enqueued', { ...notification });
      return { accepted: true, notification: { ...notification } };
    },

    /**
     * 先頭の通知を1件取り出す。キューが空、または一時停止中なら null。
     * 取り出した時点で通知済みとして記録する（永続化は非同期。テストは whenPersisted() を待つ）。
     */
    take() {
      if (paused || pending.length === 0) return null;
      const notification = pending.shift();
      pendingIds.delete(notification.id);
      notified[notification.id] = now();
      persist();
      return notification;
    },

    /** 取り出さずに先頭を覗く（一時停止中でも見える）。 */
    peek: () => (pending.length > 0 ? { ...pending[0] } : null),

    /** 取り出し待ちの件数。 */
    size: () => pending.length,

    /** 指定IDが通知済みか（テスト・Phase 4 の再取得判定用）。 */
    isNotified: (id) => id in notified,

    /**
     * 取り出しを一時停止する。Phase 5 でドラッグ中に呼ぶ想定（Phase 0 で確認した位置計算の競合対策）。
     * 停止中も push は受け付け、キューに溜まる。順序は崩れない。
     */
    pause() {
      paused = true;
    },

    /** 取り出しを再開する。溜まっていた分は到着順のまま取り出せる。 */
    resume() {
      if (!paused) return;
      paused = false;
      events.emit('resumed', { pending: pending.length });
    },

    isPaused: () => paused,

    /** 進行中の永続化の完了を待つ（テストと終了処理用）。 */
    whenPersisted: () => persisting ?? Promise.resolve(),
  };
}
