import { describe, expect, it, vi } from 'vitest';
import { createFakeGemini } from '../mocks/gemini/index.js';
import {
  CHAT_DEFAULTS,
  CLOSING_MESSAGE,
  FALLBACK_MESSAGES,
  MAX_INPUT_LENGTH,
  createChatSession,
  fallbackFor,
  normalizeChatConfig,
} from '../src/main/gemini.js';
import { GeminiError, createGeminiClient } from '../src/main/geminiClient.js';

/** 応答を順に返す偽の client（geminiClient.generate と同じ形）。 */
function fakeClient(script) {
  const calls = [];
  const client = {
    calls,
    async generate(req) {
      calls.push({ ...req, contents: req.contents.map((c) => ({ ...c })) });
      const next = script.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(req);
      return next ?? 'うん';
    },
  };
  return client;
}

describe('gemini / 設定の正規化（6.1 chat）', () => {
  it('欠損・型不正は既定（10往復・カウンター表示）', () => {
    expect(normalizeChatConfig(undefined)).toEqual({ maxTurns: 10, showRemainingCount: true });
    expect(normalizeChatConfig({ maxTurns: 'x', showRemainingCount: 1 })).toEqual(CHAT_DEFAULTS);
    expect(normalizeChatConfig({ maxTurns: 0 }).maxTurns).toBe(10);
    expect(normalizeChatConfig({ maxTurns: 3, showRemainingCount: false })).toEqual({ maxTurns: 3, showRemainingCount: false });
  });
});

describe('gemini / 往復カウンター（残り n/10）', () => {
  it('開始時は 0 往復（残り 10/10）', () => {
    const s = createChatSession({ client: fakeClient([]) });
    expect(s.state()).toMatchObject({ turn: 0, max: 10, remaining: 10, finished: false });
  });

  it('応答が得られるたびに 1 往復ずつ進み、残りが減る', async () => {
    const s = createChatSession({ client: fakeClient(['a', 'b', 'c']) });
    const r1 = await s.send('1');
    expect(r1).toMatchObject({ ok: true, reply: 'a', turn: 1, max: 10, remaining: 9, final: false, fallback: false, closing: null });
    const r2 = await s.send('2');
    expect(r2).toMatchObject({ turn: 2, remaining: 8 });
    expect(s.state()).toMatchObject({ turn: 2, remaining: 8 });
  });

  it('10往復目の応答に定型の終了メッセージが付き final: true（残り 0/10）', async () => {
    const s = createChatSession({ client: fakeClient(Array.from({ length: 10 }, (_, i) => `r${i + 1}`)) });
    let last;
    for (let i = 1; i <= 10; i++) {
      last = await s.send(`m${i}`);
      if (i < 10) expect(last).toMatchObject({ final: false, closing: null });
    }
    expect(last).toMatchObject({ ok: true, reply: 'r10', turn: 10, remaining: 0, final: true, closing: CLOSING_MESSAGE });
    expect(s.state().finished).toBe(true);
  });

  it('終了後の送信は受け付けない（11往復目は無い）', async () => {
    const client = fakeClient(['a', 'b']);
    const s = createChatSession({ client, getMaxTurns: () => 2 });
    await s.send('1');
    await s.send('2');
    expect(await s.send('3')).toEqual({ ok: false, reason: 'finished' });
    expect(client.calls).toHaveLength(2);
  });

  it('最大往復数は設定（chat.maxTurns）に従う', async () => {
    const s = createChatSession({ client: fakeClient(['a', 'b', 'c']), getMaxTurns: () => 3 });
    await s.send('1');
    await s.send('2');
    expect(await s.send('3')).toMatchObject({ turn: 3, max: 3, remaining: 0, final: true, closing: CLOSING_MESSAGE });
  });

  it('終了メッセージは getClosingMessage（キャラクターのセリフ：Phase 14）で、会話の開始時と reset のときに決まる', async () => {
    const picks = ['またねA', 'またねB'];
    let n = 0;
    const s = createChatSession({ client: fakeClient(['r1', 'r2', 'r3']), getMaxTurns: () => 1, getClosingMessage: () => picks[n++] });
    expect(await s.send('1')).toMatchObject({ final: true, closing: 'またねA' });
    s.reset();
    expect(await s.send('2')).toMatchObject({ final: true, closing: 'またねB' });
    expect(n).toBe(2); // 送信のたびには呼ばない

    // 空・null なら定型文
    const empty = createChatSession({ client: fakeClient(['r']), getMaxTurns: () => 1, getClosingMessage: () => '  ' });
    expect(await empty.send('1')).toMatchObject({ closing: CLOSING_MESSAGE });
  });

  it('reset で往復数 0・履歴なし（残り 10/10）の新規の会話に戻る', async () => {
    const client = fakeClient(['a', 'b']);
    const s = createChatSession({ client });
    await s.send('1');
    s.reset();
    expect(s.state()).toMatchObject({ turn: 0, remaining: 10, finished: false });
    await s.send('2');
    expect(client.calls[1].contents).toEqual([{ role: 'user', text: '2' }]); // 履歴は破棄されている
  });
});

describe('gemini / 履歴の送信', () => {
  it('毎回、これまでの往復（user/model 交互）と今回の発言を送る。システムプロンプトも付く', async () => {
    const client = fakeClient(['r1', 'r2']);
    const s = createChatSession({ client, systemPrompt: 'PERSONA' });
    await s.send('こんにちは');
    await s.send('元気？');
    expect(client.calls[0].systemPrompt).toBe('PERSONA');
    expect(client.calls[1].contents).toEqual([
      { role: 'user', text: 'こんにちは' },
      { role: 'model', text: 'r1' },
      { role: 'user', text: '元気？' },
    ]);
  });

  it('履歴は最大 maxTurns 往復分（それ以上は往復自体が起きない）', async () => {
    const client = fakeClient(Array.from({ length: 10 }, () => 'r'));
    const s = createChatSession({ client });
    for (let i = 0; i < 10; i++) await s.send(`m${i}`);
    expect(client.calls[9].contents).toHaveLength(19); // 9往復＋今回の発言
  });

  it('前後の空白を除いて送る・空や長すぎる発言は送らない', async () => {
    const client = fakeClient(['ok']);
    const s = createChatSession({ client });
    expect(await s.send('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(await s.send(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(await s.send('あ'.repeat(MAX_INPUT_LENGTH + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(client.calls).toHaveLength(0);
    await s.send('  やあ  ');
    expect(client.calls[0].contents).toEqual([{ role: 'user', text: 'やあ' }]);
  });
});

describe('gemini / 失敗時のフォールバック応答（7.3）', () => {
  it('失敗しても往復を消費せず、履歴にも積まない', async () => {
    const client = fakeClient([new GeminiError('server', { status: 500 }), 'やっと返せた']);
    const s = createChatSession({ client });
    const failed = await s.send('こんにちは');
    expect(failed).toMatchObject({ ok: true, fallback: true, turn: 0, remaining: 10, final: false, closing: null });
    expect(failed.reply).toBe(FALLBACK_MESSAGES.default);

    const ok = await s.send('もう一度');
    expect(ok).toMatchObject({ fallback: false, turn: 1, remaining: 9 });
    expect(client.calls[1].contents).toEqual([{ role: 'user', text: 'もう一度' }]); // 失敗した発言は履歴にない
  });

  it('種別ごとに文言を出し分ける（キー不正・レート制限・その他）', () => {
    expect(fallbackFor('auth')).toBe(FALLBACK_MESSAGES.auth);
    expect(fallbackFor('auth')).toContain('APIキー');
    expect(fallbackFor('rate_limit')).toBe(FALLBACK_MESSAGES.rate_limit);
    for (const kind of ['server', 'network', 'timeout', 'blocked', 'empty', 'unknown', undefined]) {
      expect(fallbackFor(kind)).toBe(FALLBACK_MESSAGES.default);
    }
    expect(FALLBACK_MESSAGES.default).toContain('今はちょっと考えられないみたい');
  });

  it('失敗が続いても残り回数は減らず、10往復目の自動終了にも達しない', async () => {
    const client = fakeClient(Array.from({ length: 15 }, () => new GeminiError('rate_limit', { status: 429 })));
    const s = createChatSession({ client });
    for (let i = 0; i < 15; i++) {
      const r = await s.send(`m${i}`);
      expect(r).toMatchObject({ fallback: true, remaining: 10, final: false });
    }
    expect(s.state().finished).toBe(false);
  });

  it('想定外の例外（GeminiError 以外）もフォールバックにする', async () => {
    const s = createChatSession({ client: fakeClient([new Error('boom')]) });
    expect(await s.send('x')).toMatchObject({ ok: true, fallback: true, reply: FALLBACK_MESSAGES.default });
  });
});

describe('gemini / 送信中の扱い', () => {
  it('送信中の二重送信は拒否する（busy）', async () => {
    let release;
    const client = fakeClient([() => new Promise((resolve) => (release = () => resolve('done')))]);
    const s = createChatSession({ client });
    const first = s.send('1');
    expect(await s.send('2')).toEqual({ ok: false, reason: 'busy' });
    expect(s.state().busy).toBe(true);
    release();
    expect(await first).toMatchObject({ ok: true, reply: 'done', turn: 1 });
    expect(s.state().busy).toBe(false);
  });

  it('送信中にリセット（ウィンドウを閉じた）すると中止され、応答は新しい会話に混ざらない', async () => {
    const gm = createFakeGemini({ replies: ['遅れて届いた応答'] });
    gm.hangNext();
    const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => 'K'.repeat(30), log: { info() {}, warn() {} } });
    const s = createChatSession({ client });
    const pending = s.send('こんにちは');
    s.reset();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    expect(s.state()).toMatchObject({ turn: 0, busy: false });
  });

  it('リセット後の新しい送信が、古い送信の後始末に巻き込まれない', async () => {
    let releaseOld;
    const client = fakeClient([
      () => new Promise((resolve) => (releaseOld = () => resolve('old'))),
      'new',
    ]);
    const s = createChatSession({ client });
    const old = s.send('old');
    s.reset();
    const fresh = s.send('new');
    releaseOld(); // 古い応答が今さら届く
    expect(await old).toEqual({ ok: false, reason: 'aborted' });
    expect(await fresh).toMatchObject({ ok: true, reply: 'new', turn: 1 });
    expect(s.state()).toMatchObject({ turn: 1, busy: false });
  });

  it('abort() は送信中のリクエストを中止する', async () => {
    const seen = vi.fn();
    const client = {
      generate: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            seen();
            reject(new GeminiError('aborted'));
          });
        }),
    };
    const s = createChatSession({ client });
    const p = s.send('x');
    s.abort();
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
    expect(seen).toHaveBeenCalled();
  });
});
