import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatController, CHAT_SPEECH_MAX, CLOSE_MAX_MS, CLOSE_MIN_MS, CLOSE_TAIL_MS } from '../src/main/chatController.js';
import { CLOSING_MESSAGE, FALLBACK_MESSAGES, createChatSession } from '../src/main/gemini.js';
import { GeminiError } from '../src/main/geminiClient.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 応答を順に返す偽の Gemini クライアント。 */
function fakeClient(script) {
  return {
    async generate() {
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next ?? 'うん';
    },
  };
}

/**
 * @param {object} [opts]
 * @param {Array<string | Error>} [opts.replies]
 * @param {number | null} [opts.voiceMs] 読み上げの長さ（null なら音声なし＝ミュート・VOICEVOX未起動など）
 */
function setup({ replies = ['やあ', 'うん', 'そっか'], voiceMs = 2000, maxTurns = 10, windowOpen = true, showRemainingCount = true } = {}) {
  const sent = []; // sendToWindow の記録
  let ids = 0;
  const reader = {
    prepare: vi.fn(async (id) => (voiceMs === null ? null : { url: `file:///tts/${++ids}.wav`, filePath: `/tts/${ids}.wav`, durationMs: voiceMs, volume: 0.8 })),
    cancel: vi.fn(),
  };
  const state = { windowOpen };
  const closeWindow = vi.fn();
  const onActivity = vi.fn();
  const session = createChatSession({ client: fakeClient(replies), getMaxTurns: () => maxTurns });
  const ctrl = createChatController({
    session,
    voiceReader: reader,
    getConfig: () => ({ showRemainingCount }),
    sendToWindow: (channel, payload) => {
      if (!state.windowOpen) return false;
      sent.push([channel, payload]);
      return true;
    },
    closeWindow,
    onActivity,
    log: { info: vi.fn(), warn: vi.fn() },
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { ctrl, reader, sent, closeWindow, onActivity, state, flush, session };
}

const channelsOf = (sent) => sent.map(([c]) => c);

describe('chatController / 応答と読み上げ（F-16 / F-13）', () => {
  it('応答を返し、残り往復数とカウンター表示の設定を添える', async () => {
    const { ctrl } = setup({ showRemainingCount: false });
    const r = await ctrl.send('こんにちは');
    expect(r).toMatchObject({ ok: true, reply: 'やあ', turn: 1, max: 10, remaining: 9, final: false, showRemainingCount: false });
    expect(ctrl.getState()).toMatchObject({ turn: 1, remaining: 9, showRemainingCount: false });
  });

  it('応答を読み上げる：チャット専用の id で合成を依頼し、できたら音声をチャットウィンドウへ送る', async () => {
    const { ctrl, reader, sent, flush } = setup();
    await ctrl.send('こんにちは');
    await flush();
    expect(reader.prepare).toHaveBeenCalledWith('chat:1', 'やあ');
    expect(sent).toEqual([['chat:voice', { id: 'chat:1', url: 'file:///tts/1.wav', volume: 0.8, durationMs: 2000 }]]);
  });

  it('応答は音声の合成を待たずに返す（読み上げは並行して準備する）', async () => {
    const { ctrl, reader } = setup();
    let release;
    reader.prepare.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(null))));
    const r = await ctrl.send('こんにちは'); // prepare が保留でも応答は返る
    expect(r.reply).toBe('やあ');
    release();
  });

  it('失敗時のフォールバック応答は読み上げない・往復も消費しない', async () => {
    const { ctrl, reader, flush } = setup({ replies: [new GeminiError('server', { status: 500 })] });
    const r = await ctrl.send('こんにちは');
    await flush();
    expect(r).toMatchObject({ ok: true, fallback: true, reply: FALLBACK_MESSAGES.default, turn: 0, remaining: 10 });
    expect(reader.prepare).not.toHaveBeenCalled();
  });

  it('読み上げる文は最大長で切る', async () => {
    const { ctrl, reader } = setup({ replies: ['あ'.repeat(CHAT_SPEECH_MAX + 50)] });
    await ctrl.send('x');
    expect(reader.prepare.mock.calls[0][1]).toHaveLength(CHAT_SPEECH_MAX);
  });

  it('音声が作られなかった（ミュート・VOICEVOX未起動・共有版）ときは何も送らない（テキスト表示のみ）', async () => {
    const { ctrl, sent, flush } = setup({ voiceMs: null });
    const r = await ctrl.send('こんにちは');
    await flush();
    expect(r.reply).toBe('やあ');
    expect(sent).toEqual([]);
  });

  it('空・長すぎる発言は拒否理由をそのまま返す', async () => {
    const { ctrl } = setup();
    expect(await ctrl.send('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('chatController / 読み上げの待ち行列を持たない（3.7）', () => {
  it('次の送信で、前の音声を止めて破棄する（合成済みのファイルを削除）', async () => {
    const { ctrl, reader, sent, flush } = setup();
    await ctrl.send('1');
    await flush();
    await ctrl.send('2');
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
    expect(sent).toContainEqual(['chat:stop-voice', { id: 'chat:1' }]);
  });

  it('通知の読み上げが始まったら（pauseVoice）チャットの音声を止める', async () => {
    const { ctrl, reader, sent, flush } = setup();
    await ctrl.send('1');
    await flush();
    ctrl.pauseVoice();
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
    expect(sent).toContainEqual(['chat:stop-voice', { id: 'chat:1' }]);
  });

  it('合成中に止められた音声は、届けずに捨てる（解除後に再生される経路が無い）', async () => {
    const { ctrl, reader, sent, flush } = setup();
    let release;
    reader.prepare.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ url: 'file:///late.wav', filePath: '/late.wav', durationMs: 1000, volume: 1 }))));
    await ctrl.send('1');
    ctrl.pauseVoice(); // 合成の途中で通知の読み上げが始まった
    release();
    await flush();
    expect(channelsOf(sent)).not.toContain('chat:voice');
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
  });

  it('ミュートされたら再生中の音声を止め、設定をチャットウィンドウへ知らせる', async () => {
    const { ctrl, reader, sent, flush } = setup();
    await ctrl.send('1');
    await flush();
    ctrl.applySettings({ muted: true, voiceVolume: 1 });
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
    expect(sent).toContainEqual(['chat:settings', { muted: true, voiceVolume: 1 }]);
  });

  it('ミュート解除・音量変更では止めず、設定だけを送る', async () => {
    const { ctrl, reader, sent, flush } = setup();
    await ctrl.send('1');
    await flush();
    reader.cancel.mockClear();
    ctrl.applySettings({ muted: false, voiceVolume: 0.5 });
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(sent).toContainEqual(['chat:settings', { muted: false, voiceVolume: 0.5 }]);
  });

  it('再生が終わったら（onVoiceDone）音声ファイルを削除する', async () => {
    const { ctrl, reader, flush } = setup();
    await ctrl.send('1');
    await flush();
    ctrl.onVoiceDone('chat:1');
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
    ctrl.onVoiceDone(42); // 不正な値は無視
  });

  it('チャットウィンドウが無ければ音声は届けずに捨てる', async () => {
    const { ctrl, reader, state, flush } = setup({ windowOpen: false });
    void state;
    await ctrl.send('1');
    await flush();
    expect(reader.cancel).toHaveBeenCalledWith('chat:1');
  });
});

describe('chatController / 10往復での自動終了（3.5）', () => {
  async function toFinal(t) {
    for (let i = 1; i < 10; i++) {
      await t.ctrl.send(`m${i}`);
      await t.flush();
    }
    return t.ctrl.send('m10');
  }

  it('10往復目：応答に終了メッセージが付き final。読み上げは「応答＋終了メッセージ」を1回で合成する', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, (_, i) => `r${i + 1}`) });
    const r = await toFinal(t);
    expect(r).toMatchObject({ ok: true, reply: 'r10', closing: CLOSING_MESSAGE, final: true, turn: 10, remaining: 0 });
    expect(t.reader.prepare).toHaveBeenLastCalledWith('chat:10', `r10${CLOSING_MESSAGE}`);
  });

  it('9往復までは閉じない', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r') });
    for (let i = 1; i <= 9; i++) {
      await t.ctrl.send(`m${i}`);
      await t.flush();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.closeWindow).not.toHaveBeenCalled();
  });

  it('音声が短くても最低4秒（終了メッセージを読める時間）は閉じない', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r'), voiceMs: 1000 });
    await toFinal(t);
    await t.flush();
    await vi.advanceTimersByTimeAsync(CLOSE_MIN_MS - 1);
    expect(t.closeWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('音声が長ければ、再生の終わり＋約1秒後に閉じる', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r'), voiceMs: 9000 });
    await toFinal(t);
    await t.flush();
    await vi.advanceTimersByTimeAsync(9000 + CLOSE_TAIL_MS - 1);
    expect(t.closeWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('音声が極端に長くても上限（20秒）で閉じる', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r'), voiceMs: 60_000 });
    await toFinal(t);
    await t.flush();
    await vi.advanceTimersByTimeAsync(CLOSE_MAX_MS);
    expect(t.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('音声なし（ミュート等）でも閉じる（最低待ち時間の後）', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r'), voiceMs: null });
    await toFinal(t);
    await t.flush();
    await vi.advanceTimersByTimeAsync(CLOSE_MIN_MS);
    expect(t.closeWindow).toHaveBeenCalledTimes(1);
  });

  it('自動終了の後は、次の送信を受け付けない', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r') });
    await toFinal(t);
    expect(await t.ctrl.send('もう1回')).toEqual({ ok: false, reason: 'finished' });
  });

  it('最大往復数は設定（chat.maxTurns）に従って終了する', async () => {
    const t = setup({ maxTurns: 2 });
    await t.ctrl.send('1');
    const r = await t.ctrl.send('2');
    expect(r).toMatchObject({ final: true, remaining: 0, closing: CLOSING_MESSAGE });
  });

  it('失敗（フォールバック）は往復を数えないので、それだけでは自動終了しない', async () => {
    const t = setup({ replies: Array.from({ length: 12 }, () => new GeminiError('network')) });
    for (let i = 0; i < 12; i++) await t.ctrl.send(`m${i}`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.closeWindow).not.toHaveBeenCalled();
    expect(t.ctrl.getState().remaining).toBe(10);
  });
});

describe('chatController / ウィンドウを閉じたとき（履歴の破棄）', () => {
  it('dispose で往復数・履歴を破棄し、再生中の音声を止め、自動終了の予約も取り消す', async () => {
    const t = setup({ replies: Array.from({ length: 10 }, () => 'r'), voiceMs: 9000 });
    for (let i = 1; i <= 10; i++) {
      await t.ctrl.send(`m${i}`);
      await t.flush();
    }
    t.ctrl.dispose(); // ユーザーが先に閉じた
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.closeWindow).not.toHaveBeenCalled();
    expect(t.reader.cancel).toHaveBeenCalledWith('chat:10');
    expect(t.session.state()).toMatchObject({ turn: 0, remaining: 10, finished: false });
  });

  it('dispose 後の送信は受け付けない。begin（新しくウィンドウを開く）で新規の会話（残り 10/10）になる', async () => {
    const t = setup();
    await t.ctrl.send('1');
    t.ctrl.dispose();
    expect(await t.ctrl.send('2')).toEqual({ ok: false, reason: 'aborted' });
    t.ctrl.begin();
    expect(t.ctrl.getState()).toMatchObject({ turn: 0, remaining: 10 });
    expect(await t.ctrl.send('3')).toMatchObject({ ok: true, turn: 1, remaining: 9 });
  });

  it('送信中に閉じられたら、応答は捨てる（読み上げも始めない）', async () => {
    const t = setup();
    let release;
    const slow = createChatSession({
      client: { generate: () => new Promise((resolve) => (release = () => resolve('遅い応答'))) },
    });
    const ctrl = createChatController({
      session: slow,
      voiceReader: t.reader,
      getConfig: () => ({ showRemainingCount: true }),
      sendToWindow: () => true,
      closeWindow: t.closeWindow,
      log: { info() {}, warn() {} },
    });
    const pending = ctrl.send('こんにちは');
    ctrl.dispose();
    release();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    expect(t.reader.prepare).not.toHaveBeenCalled();
  });
});

describe('chatController / 操作の通知（アイドルトークの再武装）', () => {
  it('送信・応答・ウィンドウ終了で onActivity を呼ぶ', async () => {
    const t = setup();
    await t.ctrl.send('1');
    expect(t.onActivity.mock.calls.length).toBeGreaterThanOrEqual(2);
    const before = t.onActivity.mock.calls.length;
    t.ctrl.dispose();
    expect(t.onActivity.mock.calls.length).toBe(before + 1);
  });
});
