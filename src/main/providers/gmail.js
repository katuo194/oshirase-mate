// メール通知（2.1 / 7.1）。重要メールは個別通知、それ以外は未読件数のサマリ通知（件数の差分管理は mailSummary.js）。
//
// Phase 3 では実通信を行わない。Phase 4 では取得関数を googleapis のラッパに差し替える：
//   listMessages: ({ q, maxResults, pageToken }) => gmail.users.messages.list({ userId: 'me', q, maxResults, pageToken }).then((r) => r.data)
//   getMessage: (id) => gmail.users.messages.get({
//     userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'],
//   }).then((r) => r.data)
//
// 重要判定はGmail標準の重要度マーカー（IMPORTANTラベル）に委ねる＝クエリで振り分ける（7.1）。

import { SOURCES, makeNotificationId } from '../notifyQueue.js';

export const QUERY_IMPORTANT = 'is:important is:unread';
export const QUERY_OTHER = 'is:unread -is:important';

/**
 * 重要でない未読の件数は、resultSizeEstimate ではなく ID を数えて求める。
 * resultSizeEstimate は、結果が1ページに収まらないと実件数ではなく 201 の固定値になり、大量の未読があると更新が止まって見えるため（実機で確認）。
 * 1ページ500件 × 最大5ページ（2,500件）まで数え、それ以上は「2500+」として扱う。
 */
export const UNREAD_COUNT_PAGE_SIZE = 500;
export const UNREAD_COUNT_MAX_PAGES = 5;

/** messages.list は0件のとき messages キー自体を返さない。 */
export function messageIdsOf(response) {
  return (response?.messages ?? []).map((m) => m.id).filter((id) => typeof id === 'string');
}

/** messages.get（format=metadata）のヘッダを取り出す。ヘッダ名は大文字小文字を区別しない。 */
export function headerOf(message, name) {
  const target = name.toLowerCase();
  const h = (message?.payload?.headers ?? []).find((x) => String(x?.name).toLowerCase() === target);
  return h?.value ?? '';
}

/** `山田太郎 <yamada@example.com>` → `山田太郎`。表示名が無ければアドレスをそのまま返す。 */
export function displayNameOf(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from ?? '');
  const name = m?.[1]?.trim();
  return name || (from ?? '').trim();
}

/**
 * messages.get のレスポンスを通知オブジェクトにする（純粋関数）。
 * @param {object} message
 * @param {{ now: number }} ctx
 */
export function normalizeImportantMessage(message, { now }) {
  const subject = headerOf(message, 'Subject');
  const from = headerOf(message, 'From');
  return {
    id: makeNotificationId(SOURCES.GMAIL, message.id),
    source: SOURCES.GMAIL,
    title: subject || '(件名なし)',
    body: displayNameOf(from),
    // メールは到着を検知した時点が通知時刻（予約通知ではない）
    notifyAt: now,
    data: {
      messageId: message.id,
      threadId: message.threadId ?? '',
      subject,
      from,
      snippet: message.snippet ?? '',
      date: headerOf(message, 'Date'),
    },
  };
}

/**
 * @param {object} deps
 * @param {(params: { q: string, maxResults?: number, pageToken?: string }) => Promise<object>} deps.listMessages users.messages.list の生レスポンス
 * @param {(id: string) => Promise<object>} deps.getMessage users.messages.get の生レスポンス
 * @param {() => number} [deps.now]
 * @param {{ info: Function, warn: Function }} [deps.log]
 */
export function createGmailProvider({ listMessages, getMessage, now = Date.now, log = console }) {
  /** 前回のポーリングで見えていた重要メールのID。null は「まだ一度も取得していない」 */
  let knownImportantIds = null;

  return {
    /**
     * 重要メールの新着を個別通知にする。
     * 初回ポーリングでは既存の未読をすべて通知済み扱いにし、通知を出さない（7.1）。
     * 起動のたびに溜まった未読が一斉に流れ出すのを防ぐため。
     *
     * @returns {Promise<{ notifications: object[], seeded: boolean }>}
     */
    async pollImportant() {
      const ids = messageIdsOf(await listMessages({ q: QUERY_IMPORTANT }));

      if (knownImportantIds === null) {
        knownImportantIds = new Set(ids);
        return { notifications: [], seeded: true };
      }

      // Gmail は新しい順に返すので、キューには古い方から積む（届いた順に読めるように）
      const newIds = ids.filter((id) => !knownImportantIds.has(id)).reverse();

      const notifications = [];
      const processed = new Set(ids.filter((id) => knownImportantIds.has(id)));
      for (const id of newIds) {
        try {
          notifications.push(normalizeImportantMessage(await getMessage(id), { now: now() }));
          processed.add(id);
        } catch (e) {
          // 1件の取得失敗で他を巻き添えにしない。既知に加えないので次回のポーリングで拾い直す
          log.warn(`[gmail] failed to fetch message metadata: ${e?.message ?? e}`);
        }
      }

      knownImportantIds = processed;
      return { notifications, seeded: false };
    },

    /**
     * 重要でないメールの未読件数（サマリ通知の入力。差分判定は mailSummary.js）。
     * nextPageToken を辿って ID を数える。上限（UNREAD_COUNT_MAX_PAGES）に達したら capped=true（実際はそれ以上）。
     * 途中のページが失敗したら例外をそのまま投げる（中途半端な件数で差分を出さない）。
     * @returns {Promise<{ count: number, capped: boolean }>}
     */
    async pollUnreadOtherCount() {
      let count = 0;
      let pageToken;
      for (let page = 0; page < UNREAD_COUNT_MAX_PAGES; page++) {
        const res = await listMessages({ q: QUERY_OTHER, maxResults: UNREAD_COUNT_PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
        count += messageIdsOf(res).length;
        pageToken = res?.nextPageToken;
        if (!pageToken) return { count, capped: false };
      }
      return { count, capped: true };
    },

    /** テスト・再連携時に初回状態へ戻す。 */
    reset() {
      knownImportantIds = null;
    },
  };
}
