import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNotifiedStore } from '../src/main/notifiedStore.js';
import { SOURCES, createNotifyQueue, makeNotificationId, normalizeNotification } from '../src/main/notifyQueue.js';

const NOW = Date.parse('2026-09-20T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let dir;
let filePath;
let clock;
let queues;
const now = () => clock;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notifyqueue-'));
  filePath = path.join(dir, 'notified.json');
  clock = NOW;
  queues = [];
});
afterEach(async () => {
  // 書き込みは非同期にコアレスされるため、片付ける前に必ず完了を待つ（実アプリでは終了処理で同じことをする）
  await Promise.all(queues.map((q) => q.whenPersisted()));
  await fs.rm(dir, { recursive: true, force: true });
});

/** 実際の永続化層を一時ディレクトリで使う（再起動の再現のため、同じ filePath で作り直せる） */
async function newQueue() {
  const q = createNotifyQueue({ store: createNotifiedStore({ filePath, now }), now });
  await q.init();
  queues.push(q);
  return q;
}

const mail = (id, title = `件名${id}`) => ({
  id: makeNotificationId(SOURCES.GMAIL, id),
  source: SOURCES.GMAIL,
  title,
  body: '差出人',
  notifyAt: NOW,
});

describe('makeNotificationId', () => {
  it('ソース種別をプレフィックスにする', () => {
    expect(makeNotificationId(SOURCES.CALENDAR, 'evt-1', 1758361800000)).toBe('cal:evt-1:1758361800000');
    expect(makeNotificationId(SOURCES.TASKS, 'list-main', 'task-1', '2026-09-20')).toBe('task:list-main:task-1:2026-09-20');
    expect(makeNotificationId(SOURCES.GMAIL, '18f3c0a1')).toBe('mail:18f3c0a1');
  });

  it('別ソースが同じ生IDを持ってもIDは衝突しない', () => {
    const raw = 'same-raw-id';
    const ids = new Set([
      makeNotificationId(SOURCES.CALENDAR, raw, 1),
      makeNotificationId(SOURCES.TASKS, raw, 1),
      makeNotificationId(SOURCES.GMAIL, raw),
    ]);
    expect(ids.size).toBe(3);
  });

  it('未知のソース・空のパーツは組み立てない', () => {
    expect(() => makeNotificationId('slack', 'x')).toThrow();
    expect(() => makeNotificationId(SOURCES.GMAIL)).toThrow();
    expect(() => makeNotificationId(SOURCES.GMAIL, '')).toThrow();
  });
});

describe('normalizeNotification', () => {
  it('欠けているフィールドを補う', () => {
    expect(normalizeNotification({ id: 'mail:1', source: 'gmail' }, { now: NOW })).toEqual({
      id: 'mail:1',
      source: 'gmail',
      title: '',
      body: '',
      notifyAt: NOW,
      data: {},
    });
  });

  it('ID欠落・未知のソースは受け付けない', () => {
    expect(normalizeNotification({ source: 'gmail' }, { now: NOW })).toBeNull();
    expect(normalizeNotification({ id: 'x:1', source: 'slack' }, { now: NOW })).toBeNull();
    expect(normalizeNotification(null, { now: NOW })).toBeNull();
  });
});

describe('notifyQueue / F-08 キューへの整列', () => {
  it('重要メール5件が同時発生しても、到着順でキューに並び先入れ先出しで取り出せる', async () => {
    const q = await newQueue();
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    for (const id of ids) expect(q.push(mail(id)).accepted).toBe(true);

    expect(q.size()).toBe(5);
    const taken = [];
    for (let i = 0; i < 5; i++) taken.push(q.take().id);
    expect(taken).toEqual(ids.map((id) => `mail:${id}`));
    expect(q.size()).toBe(0);
    expect(q.take()).toBeNull();
  });

  it('push のたびに enqueued イベントが出る（Phase 5 の描画側が購読する口）', async () => {
    const q = await newQueue();
    const seen = [];
    q.events.on('enqueued', (n) => seen.push(n.id));
    q.push(mail('m1'));
    q.push(mail('m2'));
    expect(seen).toEqual(['mail:m1', 'mail:m2']);
  });

  it('peek は取り出さずに先頭を見る', async () => {
    const q = await newQueue();
    q.push(mail('m1'));
    expect(q.peek().id).toBe('mail:m1');
    expect(q.size()).toBe(1);
  });
});

describe('notifyQueue / pause・resume（Phase 5 のドラッグ処理向け）', () => {
  it('一時停止中は take() が null を返し、push は受け付け続ける', async () => {
    const q = await newQueue();
    q.push(mail('m1'));
    q.pause();
    expect(q.isPaused()).toBe(true);
    expect(q.take()).toBeNull();
    expect(q.push(mail('m2')).accepted).toBe(true);
    expect(q.size()).toBe(2);
  });

  it('再開すると、溜まっていた分を到着順のまま取り出せる', async () => {
    const q = await newQueue();
    q.push(mail('m1'));
    q.pause();
    q.push(mail('m2'));
    q.push(mail('m3'));
    q.resume();
    expect(q.isPaused()).toBe(false);
    expect([q.take().id, q.take().id, q.take().id]).toEqual(['mail:m1', 'mail:m2', 'mail:m3']);
  });

  it('再開時に resumed イベントで残件数を知らせる', async () => {
    const q = await newQueue();
    q.pause();
    q.push(mail('m1'));
    q.push(mail('m2'));
    const seen = [];
    q.events.on('resumed', (e) => seen.push(e.pending));
    q.resume();
    q.resume(); // 二重呼び出しでは発火しない
    expect(seen).toEqual([2]);
  });

  it('一時停止中に通知済みとして記録されることはない', async () => {
    const q = await newQueue();
    q.push(mail('m1'));
    q.pause();
    q.take();
    expect(q.isNotified('mail:m1')).toBe(false);
  });
});

describe('notifyQueue / F-05 重複排除', () => {
  it('取り出し済みの通知は二度と受け付けない', async () => {
    const q = await newQueue();
    q.push(mail('m1'));
    q.take();
    expect(q.push(mail('m1'))).toEqual({ accepted: false, reason: 'duplicate' });
    expect(q.size()).toBe(0);
  });

  it('キューで待機中の通知も重複として弾く（ポーリングのたびに同じメールが来ても増えない）', async () => {
    const q = await newQueue();
    expect(q.push(mail('m1')).accepted).toBe(true);
    expect(q.push(mail('m1'))).toEqual({ accepted: false, reason: 'duplicate' });
    expect(q.size()).toBe(1);
  });

  it('別ソースが同じ生IDを持っていても衝突しない', async () => {
    const q = await newQueue();
    const raw = 'collide';
    expect(q.push({ id: makeNotificationId(SOURCES.CALENDAR, raw, NOW), source: SOURCES.CALENDAR }).accepted).toBe(true);
    expect(q.push({ id: makeNotificationId(SOURCES.TASKS, 'list-main', raw, '2026-09-20'), source: SOURCES.TASKS }).accepted).toBe(true);
    expect(q.push({ id: makeNotificationId(SOURCES.GMAIL, raw), source: SOURCES.GMAIL }).accepted).toBe(true);
    expect(q.size()).toBe(3);
  });

  it('不正な通知は受け付けない', async () => {
    const q = await newQueue();
    expect(q.push({ source: 'gmail' })).toEqual({ accepted: false, reason: 'invalid' });
    expect(q.push({ id: 'x:1', source: 'slack' })).toEqual({ accepted: false, reason: 'invalid' });
    expect(q.size()).toBe(0);
  });
});

describe('notifyQueue / F-05 再起動後も再提示されない', () => {
  it('取り出した通知は永続化され、再起動後に同じIDを受け付けない', async () => {
    const q1 = await newQueue();
    q1.push(mail('m1'));
    q1.push(mail('m2'));
    q1.take(); // m1 だけ取り出す
    await q1.whenPersisted();

    const q2 = await newQueue(); // 再起動
    expect(q2.isNotified('mail:m1')).toBe(true);
    expect(q2.push(mail('m1'))).toEqual({ accepted: false, reason: 'duplicate' });
    // 取り出す前にアプリが落ちた m2 は、次回ポーリングで再度拾える
    expect(q2.push(mail('m2')).accepted).toBe(true);
  });

  it('複数件を連続で取り出しても、すべてのIDが永続化される（書き込みのコアレス）', async () => {
    const q1 = await newQueue();
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) q1.push(mail(id));
    while (q1.take() !== null);
    await q1.whenPersisted();

    const q2 = await newQueue();
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      expect(q2.isNotified(`mail:${id}`)).toBe(true);
    }
  });

  it('7日を過ぎた履歴はパージされ、再び通知できる', async () => {
    const q1 = await newQueue();
    q1.push(mail('m1'));
    q1.take();
    await q1.whenPersisted();

    clock = NOW + 8 * DAY;
    const q2 = await newQueue();
    expect(q2.isNotified('mail:m1')).toBe(false);
    expect(q2.push(mail('m1')).accepted).toBe(true);
  });

  it('永続化に失敗してもキューは動き続ける（履歴の喪失で起動を止めない）', async () => {
    const failing = {
      load: async () => ({}),
      save: async () => {
        throw new Error('disk full');
      },
      remove: async () => {},
    };
    const q = createNotifyQueue({ store: failing, now, log: { info() {}, warn() {} } });
    await q.init();
    q.push(mail('m1'));
    expect(q.take().id).toBe('mail:m1');
    await expect(q.whenPersisted()).resolves.toBeUndefined();
    expect(q.isNotified('mail:m1')).toBe(true); // メモリ上では通知済みのまま
  });
});
