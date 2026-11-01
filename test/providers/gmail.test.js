import { describe, expect, it, vi } from 'vitest';
import { NOW, createFakeGoogleApi, fixtures } from '../../mocks/google/index.js';
import {
  CATCH_UP_MAX,
  QUERY_IMPORTANT,
  QUERY_OTHER,
  catchUpQuery,
  createGmailProvider,
  displayNameOf,
  headerOf,
  messageIdsOf,
  normalizeImportantMessage,
} from '../../src/main/providers/gmail.js';

const now = () => NOW;
const silent = { info() {}, warn() {} };

function setup(opts) {
  const api = createFakeGoogleApi(opts);
  const provider = createGmailProvider({ listMessages: api.listMessages, getMessage: api.getMessage, now, log: silent });
  return { api, provider };
}

describe('gmail のヘルパ', () => {
  it('messages キーが無いレスポンス（0件）を空配列として扱う', () => {
    expect(messageIdsOf(fixtures.gmail.importantEmpty)).toEqual([]);
    expect(messageIdsOf(undefined)).toEqual([]);
  });

  it('ヘッダ名は大文字小文字を区別せずに取り出す', () => {
    const m = { payload: { headers: [{ name: 'subject', value: 'やあ' }] } };
    expect(headerOf(m, 'Subject')).toBe('やあ');
    expect(headerOf(m, 'From')).toBe('');
  });

  it('差出人は表示名を優先し、無ければアドレスを使う', () => {
    expect(displayNameOf('山田太郎 <yamada@example.co.jp>')).toBe('山田太郎');
    expect(displayNameOf('"Yamada, Taro" <yamada@example.co.jp>')).toBe('Yamada, Taro');
    expect(displayNameOf('alerts@monitoring.example.com')).toBe('alerts@monitoring.example.com');
    expect(displayNameOf('')).toBe('');
  });

  it('件名が無いメールは (件名なし) にする', () => {
    const n = normalizeImportantMessage(fixtures.gmail.messages['18f3c0a1b2c3d4f1'], { now: NOW });
    expect(n.title).toBe('(件名なし)');
    expect(n.body).toBe('田中一郎');
  });
});

describe('providers/gmail / F-02 重要メールの検知', () => {
  it('重要／それ以外はGmailのクエリで振り分ける（IMPORTANTラベル依存）', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();
    await provider.pollUnreadOtherCount();
    expect(api.callsTo('listMessages').map((c) => c.args.q)).toEqual([QUERY_IMPORTANT, QUERY_OTHER]);
  });

  it('初回ポーリングでは既存の未読をすべて通知済み扱いにする（7.1）', async () => {
    const { api, provider } = setup();
    const res = await provider.pollImportant();
    expect(res).toEqual({ notifications: [], seeded: true });
    expect(api.callsTo('getMessage')).toEqual([]); // 本文取得すらしない
  });

  it('2回目以降は前回になかったメッセージIDだけを通知する', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();

    api.setImportantIds(['18f3c0a1b2c3d4f1', '18f3c0a1b2c3d4f0', '18f3c0a1b2c3d4e5', '18f3c0a1b2c3d4e6']);
    const { notifications, seeded } = await provider.pollImportant();

    expect(seeded).toBe(false);
    // Gmailは新しい順に返すが、キューには古い方から積む（届いた順に読めるように）
    expect(notifications.map((n) => n.id)).toEqual(['mail:18f3c0a1b2c3d4f0', 'mail:18f3c0a1b2c3d4f1']);
    expect(notifications[0]).toMatchObject({
      source: 'gmail',
      title: '[ALERT] health check failed',
      body: 'alerts@monitoring.example.com',
      notifyAt: NOW,
    });
    expect(notifications[0].data).toMatchObject({ messageId: '18f3c0a1b2c3d4f0', from: 'alerts@monitoring.example.com' });
  });

  it('同じメールを次のポーリングで再び通知しない', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();
    api.addImportantMessage('new-1', { subject: '新着', from: 'a@example.com' });

    expect((await provider.pollImportant()).notifications).toHaveLength(1);
    expect((await provider.pollImportant()).notifications).toHaveLength(0);
  });

  it('既読にしたメールが再び未読になっても、通知の判定はIDの新規性のみで行う', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();
    api.readImportantMessage('18f3c0a1b2c3d4e5');
    expect((await provider.pollImportant()).notifications).toHaveLength(0);

    // 一覧から消えた後に戻ってくると新規扱いになる。二重提示は notifyQueue の重複排除（F-05）が防ぐ
    api.setImportantIds(['18f3c0a1b2c3d4e5', '18f3c0a1b2c3d4e6']);
    expect((await provider.pollImportant()).notifications.map((n) => n.id)).toEqual(['mail:18f3c0a1b2c3d4e5']);
  });

  it('1件のメタデータ取得に失敗しても他の通知は作られ、失敗分は次回に拾い直す', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();
    api.addImportantMessage('ok-1', { subject: '成功', from: 'a@example.com' });
    api.addImportantMessage('broken', { subject: '失敗', from: 'b@example.com' });

    api.failNext('getMessage'); // 最初の getMessage（古い方 = ok-1）だけ失敗させる
    const first = await provider.pollImportant();
    expect(first.notifications.map((n) => n.data.messageId)).toEqual(['broken']);

    const second = await provider.pollImportant();
    expect(second.notifications.map((n) => n.data.messageId)).toEqual(['ok-1']);
  });

  it('重要メールが0件でも落ちない', async () => {
    const { provider } = setup({ importantIds: [] });
    expect(await provider.pollImportant()).toEqual({ notifications: [], seeded: true });
    expect((await provider.pollImportant()).notifications).toEqual([]);
  });

  it('reset() で初回状態に戻る（連携解除・再連携）', async () => {
    const { provider } = setup();
    await provider.pollImportant();
    provider.reset();
    expect((await provider.pollImportant()).seeded).toBe(true);
  });

  it('reset() の後は、それまでに来ていたメールを新着として通知しない（再連携で既存未読が一斉に流れ出さない）', async () => {
    const { api, provider } = setup();
    await provider.pollImportant();
    api.addImportantMessage('18f3c0a1b2c3d4f9', { subject: '解除前に届いた' });
    provider.reset();

    // 再連携後の最初のポーリングは基準値になるだけで、解除前に届いていたメールも通知しない
    expect(await provider.pollImportant()).toEqual({ notifications: [], seeded: true });
    expect(api.callsTo('getMessage')).toEqual([]);

    // その後の新着は通常どおり通知する
    api.addImportantMessage('18f3c0a1b2c3d4fa', { subject: '再連携後に届いた' });
    const res = await provider.pollImportant();
    expect(res.seeded).toBe(false);
    expect(res.notifications.map((n) => n.title)).toEqual(['再連携後に届いた']);
  });
});

describe('providers/gmail / 重要でないメールの未読件数（ID を数える）', () => {
  it('件数を返す。増減に追随する', async () => {
    const { api, provider } = setup();
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 3, capped: false });
    api.setUnreadOtherCount(5);
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 5, capped: false });
    api.setUnreadOtherCount(4);
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 4, capped: false });
  });

  it('0件のとき（messages キーが無い）も 0 を返す', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(0);
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 0, capped: false });
  });

  it('resultSizeEstimate に頼らない：未読が多いとき実 API は 201 の固定値を返すが、ID を数えて実件数を返す（実機で確認した不具合）', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(300);
    // 実 API の癖の再現：1ページに収まらない結果の resultSizeEstimate は実件数ではない
    expect((await api.listMessages({ q: QUERY_OTHER })).resultSizeEstimate).toBe(201);

    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 300, capped: false });
    api.setUnreadOtherCount(299); // 201 のまま動かない、という状態にならない
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 299, capped: false });
  });

  it('nextPageToken を辿って全ページを数える（500件ずつ）', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(1201);
    const res = await provider.pollUnreadOtherCount();
    expect(res).toEqual({ count: 1201, capped: false });

    const calls = api.callsTo('listMessages').map((c) => c.args);
    expect(calls).toEqual([
      { q: QUERY_OTHER, maxResults: 500, pageToken: undefined },
      { q: QUERY_OTHER, maxResults: 500, pageToken: '500' },
      { q: QUERY_OTHER, maxResults: 500, pageToken: '1000' },
    ]);
  });

  it('ちょうど1ページ分（500件）なら1回の呼び出しで済む', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(500);
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 500, capped: false });
    expect(api.callsTo('listMessages')).toHaveLength(1);
  });

  it('上限（5ページ = 2,500件）に達したら capped で止める。API を叩きすぎない', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(9000);
    expect(await provider.pollUnreadOtherCount()).toEqual({ count: 2500, capped: true });
    expect(api.callsTo('listMessages')).toHaveLength(5);
  });

  it('途中のページで失敗したら、中途半端な件数を返さず例外にする', async () => {
    const { api, provider } = setup();
    api.setUnreadOtherCount(1200);
    let n = 0;
    const flaky = createGmailProvider({
      listMessages: async (p) => {
        if (++n === 2) throw new Error('boom');
        return api.listMessages(p);
      },
      getMessage: api.getMessage,
      now,
      log: silent,
    });
    await expect(flaky.pollUnreadOtherCount()).rejects.toThrow('boom');
  });
});

describe('providers/gmail / 連携が切れていた間の分を拾う（Phase 16）', () => {
  it('catchUpQuery は重要な未読のうち、指定した時刻（秒に切り捨て）より後に届いたもの', () => {
    expect(catchUpQuery(1_700_000_000_999)).toBe(`${QUERY_IMPORTANT} after:1700000000`);
  });

  it('catchUp のあとの初回取得では、その時刻より後に届いたものを古い順に通知し、ほかの未読は通知済み扱いにする', async () => {
    const { api, provider } = setup();
    api.addImportantMessage('gap-1', { subject: '1通目', at: NOW + 1000 });
    api.addImportantMessage('gap-2', { subject: '2通目', at: NOW + 2000 });
    provider.catchUp(NOW);
    const res = await provider.pollImportant();
    expect(res.seeded).toBe(true);
    expect(res.caughtUp).toBe(2);
    expect(res.notifications.map((n) => n.title)).toEqual(['1通目', '2通目']);
    expect(api.callsTo('listMessages').map((c) => c.args)).toContainEqual({ q: catchUpQuery(NOW), maxResults: CATCH_UP_MAX, pageToken: undefined });
    // 次からは通常どおり（拾ったものも既存の未読も、二度と通知しない）
    expect((await provider.pollImportant()).notifications).toEqual([]);
  });

  it(`多すぎるときは新しい方から ${CATCH_UP_MAX} 件だけ`, async () => {
    const { provider, api } = setup();
    for (let i = 1; i <= CATCH_UP_MAX + 3; i++) api.addImportantMessage(`gap-${i}`, { subject: `${i}通目`, at: NOW + i * 1000 });
    provider.catchUp(NOW);
    const res = await provider.pollImportant();
    expect(res.notifications).toHaveLength(CATCH_UP_MAX);
    expect(res.notifications[0].title).toBe('4通目');
    expect(res.notifications.at(-1).title).toBe(`${CATCH_UP_MAX + 3}通目`);
    expect((await provider.pollImportant()).notifications).toEqual([]);
  });

  it('拾うのは一度だけ。reset したら拾う予定も消える', async () => {
    const { provider, api } = setup();
    api.addImportantMessage('gap-1', { at: NOW + 1000 });
    provider.catchUp(NOW);
    provider.reset();
    expect(await provider.pollImportant()).toEqual({ notifications: [], seeded: true });
    provider.catchUp(NOW);
    expect((await provider.pollImportant()).notifications).toEqual([]); // 初回取得は済んでいるので使われない
  });
});
