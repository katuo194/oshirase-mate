// 実際の Google API 呼び出し（Phase 4）。providers（calendar / tasks / gmail）に注入する取得関数を作る。
// 返す関数の形は mocks/google/index.js と同じ（listEvents / listTaskLists / listTasks / listMessages / getMessage）。
//
// 認証：auth.getAccessToken() が返すアクセストークンを呼び出しごとに Authorization ヘッダで渡す。
// googleapis の OAuth2Client は使わない（refresh_token を持たせると auth.js と更新経路が二重化するため）。
// クライアント（@googleapis/calendar の calendar({ version: 'v3' }) 等）は index.js が生成して渡す。ここは Google API のパッケージを import しない。
//
// リトライ：googleapis は既定で retry=true（gaxios が最大3回・指数バックオフで再試行）になっている。
// Phase 6 のバックオフと二重になり、呼び出し回数の実測（apiUsage）も狂うため、retry: false を明示する。
//
// 通信：fetch を渡されたら gaxios の fetchImplementation に使う（index.js は Electron の net.fetch を渡し、OS のプロキシ設定に従わせる）。
//
// 失敗はすべて GoogleApiError（apiErrors.js）にして throw する。401 のときはアクセストークンを破棄して次回の更新を促す。

import { LOOKAHEAD_HOURS } from './providers/calendar.js';
import { authUnavailableError, classifyGoogleError } from './apiErrors.js';

/** 1リクエストの上限。応答が返らないままポーリングが inFlight で詰まらないようにする。 */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/**
 * @param {object} deps
 * @param {{ getAccessToken: () => Promise<{ ok: true, token: string } | { ok: false, kind: string }>, invalidateAccessToken: () => void }} deps.auth
 * @param {object} deps.calendar google.calendar({ version: 'v3' })
 * @param {object} deps.tasks google.tasks({ version: 'v1' })
 * @param {object} deps.gmail google.gmail({ version: 'v1' })
 * @param {typeof globalThis.fetch} [deps.fetch] gaxios に使わせる fetch（省略時は gaxios の既定）
 * @param {ReturnType<import('./apiUsage.js').createApiUsage>} [deps.usage]
 * @param {() => number} [deps.now]
 */
export function createGoogleApi({ auth, calendar, tasks, gmail, fetch, usage, now = Date.now }) {
  /**
   * 1回の API 呼び出し。
   * @param {string} method 'calendar.events.list' など（apiUsage・エラーのラベル）
   * @param {(options: object) => Promise<{ data: any }>} request googleapis のメソッドを呼ぶ関数
   */
  async function call(method, request) {
    const t = await auth.getAccessToken();
    if (!t.ok) throw authUnavailableError(t.kind, { api: method });

    try {
      const res = await request({
        headers: { Authorization: `Bearer ${t.token}` },
        retry: false,
        timeout: REQUEST_TIMEOUT_MS,
        ...(fetch ? { fetchImplementation: fetch } : {}),
      });
      usage?.record(method);
      return res.data;
    } catch (e) {
      usage?.record(method, { ok: false });
      const err = classifyGoogleError(e, { api: method, now: now() });
      if (err.kind === 'unauthorized') auth.invalidateAccessToken();
      throw err;
    }
  }

  return {
    /** events.list（今後24時間分。2.1 / 7.1）。 */
    listEvents() {
      const t = now();
      return call('calendar.events.list', (options) =>
        calendar.events.list(
          {
            calendarId: 'primary',
            timeMin: new Date(t).toISOString(),
            timeMax: new Date(t + LOOKAHEAD_HOURS * 60 * 60 * 1000).toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
          },
          options,
        ),
      );
    },

    listTaskLists() {
      return call('tasks.tasklists.list', (options) => tasks.tasklists.list({ maxResults: 100 }, options));
    },

    /** 未完了タスクのみ（完了済みは通知対象外）。1リスト100件まで（ページングはしない）。 */
    listTasks(taskListId) {
      return call('tasks.tasks.list', (options) =>
        tasks.tasks.list({ tasklist: taskListId, showCompleted: false, maxResults: 100 }, options),
      );
    },

    listMessages({ q, maxResults, pageToken }) {
      const params = { userId: 'me', q, ...(maxResults === undefined ? {} : { maxResults }), ...(pageToken ? { pageToken } : {}) };
      return call('gmail.users.messages.list', (options) => gmail.users.messages.list(params, options));
    },

    getMessage(id) {
      return call('gmail.users.messages.get', (options) =>
        gmail.users.messages.get(
          { userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] },
          options,
        ),
      );
    },
  };
}
