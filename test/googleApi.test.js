import { describe, expect, it, vi } from 'vitest';
import { KINDS } from '../src/main/apiErrors.js';
import { createApiUsage } from '../src/main/apiUsage.js';
import { createGoogleApi } from '../src/main/googleApi.js';
import { QUERY_IMPORTANT } from '../src/main/providers/gmail.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');

/** googleapis クライアントのフェイク。呼び出し引数を記録し、data を返す（実通信は自動テスト不可のため、ここでは配線の形だけを検証する）。 */
function setup({ token = { ok: true, token: 'ACCESS-1' }, response = { data: { ok: true } } } = {}) {
  const calls = [];
  const fn = (name) =>
    vi.fn(async (params, options) => {
      calls.push({ name, params, options });
      if (response instanceof Error) throw response;
      return response;
    });
  const clients = {
    calendar: { events: { list: fn('events.list') } },
    tasks: { tasklists: { list: fn('tasklists.list') }, tasks: { list: fn('tasks.list') } },
    gmail: { users: { messages: { list: fn('messages.list'), get: fn('messages.get') } } },
  };
  const auth = {
    getAccessToken: vi.fn(async () => token),
    invalidateAccessToken: vi.fn(),
  };
  const usage = createApiUsage({ now: () => NOW });
  const api = createGoogleApi({ auth, ...clients, usage, now: () => NOW });
  return { api, auth, usage, calls, clients };
}

const gaxiosError = (status, reason) =>
  Object.assign(new Error('request failed'), {
    status,
    config: { headers: { Authorization: 'Bearer ACCESS-1' } },
    response: { status, headers: {}, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });

describe('googleApi / リクエストの形', () => {
  it('カレンダー：primary の今後24時間を、展開済み・開始順で取得する（7.1）', async () => {
    const { api, calls } = setup();
    await api.listEvents();
    expect(calls[0].params).toEqual({
      calendarId: 'primary',
      timeMin: '2026-09-20T09:00:00.000Z',
      timeMax: '2026-09-21T09:00:00.000Z',
      singleEvents: true,
      orderBy: 'startTime',
    });
  });

  it('TODO：リスト一覧 → 各リストの未完了タスク', async () => {
    const { api, calls } = setup();
    await api.listTaskLists();
    await api.listTasks('list-1');
    expect(calls[1].params).toMatchObject({ tasklist: 'list-1', showCompleted: false });
  });

  it('Gmail：list は q をそのまま渡し、get は metadata（Subject/From/Date）だけ取る', async () => {
    const { api, calls } = setup();
    await api.listMessages({ q: QUERY_IMPORTANT });
    await api.getMessage('msg-1');
    expect(calls[0].params).toEqual({ userId: 'me', q: 'is:important is:unread' });
    expect(calls[1].params).toEqual({ userId: 'me', id: 'msg-1', format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
  });

  it('Gmail：件数の数え上げでは maxResults と pageToken を渡す。指定しなければ付けない', async () => {
    const { api, calls } = setup();
    await api.listMessages({ q: 'is:unread', maxResults: 500 });
    await api.listMessages({ q: 'is:unread', maxResults: 500, pageToken: 'next-1' });
    expect(calls[0].params).toEqual({ userId: 'me', q: 'is:unread', maxResults: 500 });
    expect(calls[1].params).toEqual({ userId: 'me', q: 'is:unread', maxResults: 500, pageToken: 'next-1' });
  });

  it('レスポンスの data を返す', async () => {
    const { api } = setup({ response: { data: { items: [1, 2] } } });
    expect(await api.listTaskLists()).toEqual({ items: [1, 2] });
  });
});

describe('googleApi / 認証：アクセストークンだけを都度渡す', () => {
  it('Authorization ヘッダにアクセストークンを付ける。クライアントに auth（OAuth2Client）は渡さない', async () => {
    const { api, calls } = setup();
    await api.listEvents();
    expect(calls[0].options.headers).toEqual({ Authorization: 'Bearer ACCESS-1' });
    expect(calls[0].params.auth).toBeUndefined();
    expect(calls[0].options.auth).toBeUndefined();
    expect(JSON.stringify(calls[0])).not.toContain('refresh_token');
  });

  it('呼び出しのたびに getAccessToken を呼ぶ（更新は auth 側の単一フライトに任せる）', async () => {
    const { api, auth } = setup();
    await api.listEvents();
    await api.listTaskLists();
    expect(auth.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('googleapis の自動リトライを無効にする（Phase 6 のバックオフ・呼び出し回数の実測と二重にならないように）', async () => {
    const { api, calls } = setup();
    await api.listEvents();
    expect(calls[0].options.retry).toBe(false);
    expect(calls[0].options.timeout).toBeGreaterThan(0);
  });

  it('fetch を渡したら gaxios の fetchImplementation に使う（OS のプロキシ設定に従う net.fetch を通すため）。省略時は付けない', async () => {
    const { api: plain, calls: plainCalls } = setup();
    await plain.listEvents();
    expect(plainCalls[0].options).not.toHaveProperty('fetchImplementation');

    const fetch = vi.fn();
    const { calls, clients } = setup();
    const withFetch = createGoogleApi({ auth: { getAccessToken: async () => ({ ok: true, token: 'ACCESS-1' }), invalidateAccessToken() {} }, ...clients, fetch });
    await withFetch.listTaskLists();
    expect(calls[0].options.fetchImplementation).toBe(fetch);
  });

  it('トークンを用意できなければ API を呼ばず auth_unavailable を投げる（元の kind を保持）', async () => {
    const { api, clients, usage } = setup({ token: { ok: false, kind: 'network' } });
    await expect(api.listEvents()).rejects.toMatchObject({ kind: KINDS.AUTH_UNAVAILABLE, offlineCandidate: true });
    expect(clients.calendar.events.list).not.toHaveBeenCalled();
    expect(usage.snapshot().methods).toEqual([]); // 通信していないので数えない
  });
});

describe('googleApi / 失敗の分類', () => {
  it('401 → unauthorized を投げ、保持中のアクセストークンを捨てる（次回の呼び出しで更新される）', async () => {
    const { api, auth } = setup({ response: gaxiosError(401) });
    await expect(api.listEvents()).rejects.toMatchObject({ kind: KINDS.UNAUTHORIZED, status: 401, api: 'calendar.events.list' });
    expect(auth.invalidateAccessToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['403 quota', gaxiosError(403, 'quotaExceeded'), KINDS.QUOTA],
    ['403 forbidden', gaxiosError(403, 'accessNotConfigured'), KINDS.FORBIDDEN],
    ['429', gaxiosError(429), KINDS.RATE_LIMITED],
    ['503', gaxiosError(503), KINDS.SERVER],
    ['ネットワーク', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), KINDS.NETWORK],
  ])('%s → kind が保たれる。トークンは捨てない', async (_n, error, kind) => {
    const { api, auth } = setup({ response: error });
    await expect(api.listMessages({ q: 'x' })).rejects.toMatchObject({ kind });
    expect(auth.invalidateAccessToken).not.toHaveBeenCalled();
  });

  it('投げるエラーにアクセストークンを含めない', async () => {
    const { api } = setup({ response: gaxiosError(401) });
    const e = await api.listEvents().catch((x) => x);
    expect(JSON.stringify(e)).not.toContain('ACCESS-1');
    expect(e.message).not.toContain('ACCESS-1');
  });
});

describe('googleApi / 呼び出し回数の実測', () => {
  it('成功・失敗ともメソッド別に数える', async () => {
    const ok = setup();
    await ok.api.listEvents();
    await ok.api.getMessage('a');
    expect(ok.usage.snapshot().methods.map((m) => [m.method, m.calls, m.failures])).toEqual([
      ['calendar.events.list', 1, 0],
      ['gmail.users.messages.get', 1, 0],
    ]);

    const ng = setup({ response: gaxiosError(429) });
    await ng.api.listEvents().catch(() => {});
    expect(ng.usage.snapshot().methods[0]).toMatchObject({ method: 'calendar.events.list', calls: 1, failures: 1 });
  });
});
