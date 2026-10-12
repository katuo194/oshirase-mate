import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendar } from '@googleapis/calendar';
import { tasks } from '@googleapis/tasks';
import { gmail } from '@googleapis/gmail';
import { KINDS } from '../src/main/apiErrors.js';
import { createGoogleApi } from '../src/main/googleApi.js';
import { NOW, fixtures } from '../mocks/google/index.js';

// 個別パッケージ（@googleapis/calendar・tasks・gmail。9章#7）の実クライアントを createGoogleApi に渡したときの配線を検証する。
// 送信先は rootUrl でローカルの HTTP サーバへ向け、mocks/google の固定レスポンスを返す（Google には接続しない）。

/** @type {Array<{ method: string, path: string, query: URLSearchParams, authorization: string | undefined }>} */
const requests = [];
/** 次のリクエストへのステータスの上書き（null なら fixture を返す） */
let nextStatus = null;
let server;
let rootUrl;

function route(pathname) {
  if (pathname === '/calendar/v3/calendars/primary/events') return fixtures.calendar;
  if (pathname === '/tasks/v1/users/@me/lists') return fixtures.tasks.tasklists;
  const list = pathname.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks$/);
  if (list) return fixtures.tasks.tasks[decodeURIComponent(list[1])];
  if (pathname === '/gmail/v1/users/me/messages') return fixtures.gmail.importantInitial;
  const msg = pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
  if (msg) return fixtures.gmail.messages[decodeURIComponent(msg[1])];
  return undefined;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });
    if (nextStatus !== null) {
      const status = nextStatus;
      nextStatus = null;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: status, message: 'x', errors: [{ reason: 'backendError' }] } }));
      return;
    }
    const body = route(url.pathname);
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: { code: 404, message: 'not found' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  rootUrl = `http://127.0.0.1:${server.address().port}/`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

function setup() {
  requests.length = 0;
  nextStatus = null;
  return createGoogleApi({
    auth: { getAccessToken: async () => ({ ok: true, token: 'ACCESS-1' }), invalidateAccessToken: () => {} },
    calendar: calendar({ version: 'v3', rootUrl }),
    tasks: tasks({ version: 'v1', rootUrl }),
    gmail: gmail({ version: 'v1', rootUrl }),
    now: () => NOW,
  });
}

describe('googleApi / 個別パッケージの実クライアント', () => {
  it('events.list：パラメータとアクセストークンが送られ、レスポンスの data がそのまま返る', async () => {
    const api = setup();
    const data = await api.listEvents();
    expect(data.items).toEqual(fixtures.calendar.items);
    expect(requests).toHaveLength(1);
    const [r] = requests;
    expect(r).toMatchObject({ method: 'GET', path: '/calendar/v3/calendars/primary/events', authorization: 'Bearer ACCESS-1' });
    expect(r.query.get('singleEvents')).toBe('true');
    expect(r.query.get('orderBy')).toBe('startTime');
    expect(r.query.get('timeMin')).toBe(new Date(NOW).toISOString());
  });

  it('tasklists.list → tasks.list', async () => {
    const api = setup();
    const lists = await api.listTaskLists();
    expect(lists.items).toEqual(fixtures.tasks.tasklists.items);
    const id = lists.items[0].id;
    const t = await api.listTasks(id);
    expect(t).toEqual(fixtures.tasks.tasks[id]);
    expect(requests[1].path).toBe(`/tasks/v1/lists/${id}/tasks`);
    expect(requests[1].query.get('showCompleted')).toBe('false');
  });

  it('messages.list → messages.get（metadata と対象ヘッダーを指定）', async () => {
    const api = setup();
    const list = await api.listMessages({ q: 'is:important is:unread' });
    expect(list.messages).toEqual(fixtures.gmail.importantInitial.messages);
    const id = list.messages[0].id;
    const msg = await api.getMessage(id);
    expect(msg).toEqual(fixtures.gmail.messages[id]);
    expect(requests[1].query.get('format')).toBe('metadata');
    expect(requests[1].query.getAll('metadataHeaders')).toEqual(['Subject', 'From', 'Date']);
  });

  it('5xx は1回だけ送って server に分類される（自動リトライが無効）', async () => {
    const api = setup();
    nextStatus = 503;
    await expect(api.listEvents()).rejects.toMatchObject({ kind: KINDS.SERVER, status: 503 });
    expect(requests).toHaveLength(1);
  });
});
