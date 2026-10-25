import { describe, expect, it, vi } from 'vitest';
import { createFakeGemini } from '../mocks/gemini/index.js';
import { FALLBACK_MESSAGES, createChatSession, fallbackFor } from '../src/main/gemini.js';
import { GEMINI_MODELS, GeminiError, createGeminiClient, safeApiMessage } from '../src/main/geminiClient.js';

const KEY = 'fake-gemini-key-for-tests-0123456789';
const req = { systemPrompt: 'SYS', contents: [{ role: 'user', text: 'こんにちは' }] };
const modelOf = (call) => /models\/([^:]+):generateContent/.exec(call.url)[1];

function setup({ replies } = {}) {
  const gm = createFakeGemini({ replies });
  const log = { info: vi.fn(), warn: vi.fn() };
  const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => KEY, log });
  return { gm, client, log };
}

const notFound = { message: 'models/x is not found for API version v1beta, or is not supported for generateContent.', errorStatus: 'NOT_FOUND' };

describe('geminiClient / モデルの自動切り替え（404）', () => {
  it('候補は複数あり、先頭のモデルから試す', async () => {
    expect(GEMINI_MODELS.length).toBeGreaterThan(1);
    const { gm, client } = setup();
    await client.generate(req);
    expect(modelOf(gm.calls[0])).toBe(GEMINI_MODELS[0]);
  });

  it('404（モデルが無い・使えない）なら次の候補で再試行し、成功すれば応答を返す', async () => {
    const { gm, client, log } = setup({ replies: ['やあ'] });
    gm.failNext(404, notFound);
    expect(await client.generate(req)).toBe('やあ');
    expect(gm.calls.map(modelOf)).toEqual([GEMINI_MODELS[0], GEMINI_MODELS[1]]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining(GEMINI_MODELS[1]));
  });

  it('使えたモデルを覚え、次回以降は404を踏まずにそのモデルから始める', async () => {
    const { gm, client } = setup();
    gm.failNext(404, notFound);
    gm.failNext(404, notFound);
    await client.generate(req);
    await client.generate(req);
    expect(gm.calls.map(modelOf)).toEqual([GEMINI_MODELS[0], GEMINI_MODELS[1], GEMINI_MODELS[2], GEMINI_MODELS[2]]);
  });

  it('すべての候補が404なら model_unavailable（全候補を1回ずつ試す）', async () => {
    const { gm, client } = setup();
    for (let i = 0; i < GEMINI_MODELS.length; i++) gm.failNext(404, notFound);
    await expect(client.generate(req)).rejects.toMatchObject({ kind: 'model_unavailable', status: 404 });
    expect(gm.calls.map(modelOf)).toEqual([...GEMINI_MODELS]);
  });

  it('404以外の失敗（キー不正・レート制限など）ではモデルを切り替えない', async () => {
    const { gm, client } = setup();
    gm.invalidKeyNext();
    await expect(client.generate(req)).rejects.toMatchObject({ kind: 'auth' });
    gm.failNext(429);
    await expect(client.generate(req)).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(gm.calls.map(modelOf)).toEqual([GEMINI_MODELS[0], GEMINI_MODELS[0]]);
  });

  it('呼び出し側の中止では切り替えず、そのまま aborted', async () => {
    const { gm, client } = setup();
    gm.hangNext();
    const controller = new AbortController();
    const p = client.generate({ ...req, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    expect(gm.calls).toHaveLength(1);
  });
});

describe('geminiClient / 失敗の原因をログで追える（Google のエラー区分・メッセージ）', () => {
  it('404 のログに、HTTP ステータス・Google の status・メッセージ・モデル名が出る（キーは出ない）', async () => {
    const { gm, client, log } = setup();
    for (let i = 0; i < GEMINI_MODELS.length; i++) gm.failNext(404, { message: `${notFound.message} key=${KEY}`, errorStatus: 'NOT_FOUND' });
    await client.generate(req).catch(() => {});
    const logged = log.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('HTTP 404 NOT_FOUND');
    expect(logged).toContain(`model=${GEMINI_MODELS.at(-1)}`);
    expect(logged).toContain('not found for API version');
    expect(logged).not.toContain(KEY);
  });

  it('safeApiMessage：キーの値・AIza 形式の文字列を伏せ、改行を潰し、長さを切る', () => {
    expect(safeApiMessage(`bad ${KEY} value`, KEY)).toBe('bad *** value');
    expect(safeApiMessage('token AIzaSyABCDEFGHIJKLMNOP leaked', 'other')).toBe('token *** leaked');
    expect(safeApiMessage('a\n\n  b')).toBe('a b');
    expect(safeApiMessage('x'.repeat(500))).toHaveLength(201);
    expect(safeApiMessage(undefined)).toBeUndefined();
  });

  it('GeminiError に apiStatus・apiMessage を載せる（本文・キーは含めない）', async () => {
    const { gm, client } = setup();
    gm.failNext(500, { message: 'internal', errorStatus: 'INTERNAL' });
    const e = await client.generate(req).catch((err) => err);
    expect(e).toBeInstanceOf(GeminiError);
    expect(e).toMatchObject({ kind: 'server', status: 500, apiStatus: 'INTERNAL', apiMessage: 'internal' });
    expect(e.message).not.toContain('internal');
  });
});

describe('geminiClient / 402（プリペイドのクレジット切れ）', () => {
  const depleted = { message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.', errorStatus: 'RESOURCE_EXHAUSTED' };

  it('402 は quota として分類する（429 のレート制限とは別）', async () => {
    const { gm, client } = setup();
    for (let i = 0; i < GEMINI_MODELS.length; i++) gm.failNext(402, depleted);
    await expect(client.generate(req)).rejects.toMatchObject({ kind: 'quota', status: 402, apiStatus: 'RESOURCE_EXHAUSTED' });
  });

  it('モデルごとに課金条件が違い得るので、402 のときも次の候補を試し、使えたモデルで応答を返す', async () => {
    const { gm, client } = setup({ replies: ['やあ'] });
    gm.failNext(402, depleted);
    expect(await client.generate(req)).toBe('やあ');
    expect(gm.calls.map(modelOf)).toEqual([GEMINI_MODELS[0], GEMINI_MODELS[1]]);
  });

  it('ログにクレジット切れの原因（Google のメッセージ）が出る', async () => {
    const { gm, client, log } = setup();
    for (let i = 0; i < GEMINI_MODELS.length; i++) gm.failNext(402, depleted);
    await client.generate(req).catch(() => {});
    const logged = log.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('HTTP 402 RESOURCE_EXHAUSTED');
    expect(logged).toContain('prepayment credits are depleted');
  });

  it('チャットには「利用枠が足りない」旨のフォールバック応答を返し、往復は消費しない', async () => {
    expect(fallbackFor('quota')).toBe(FALLBACK_MESSAGES.quota);
    expect(FALLBACK_MESSAGES.quota).toContain('AI Studio');
    const session = createChatSession({ client: { generate: async () => Promise.reject(new GeminiError('quota', { status: 402 })) } });
    expect(await session.send('こんにちは')).toMatchObject({ ok: true, fallback: true, reply: FALLBACK_MESSAGES.quota, turn: 0, remaining: 10 });
  });
});

describe('gemini / model_unavailable のフォールバック応答', () => {
  it('専用の文言を返し、往復は消費しない', async () => {
    expect(fallbackFor('model_unavailable')).toBe(FALLBACK_MESSAGES.model_unavailable);
    const client = { generate: async () => Promise.reject(new GeminiError('model_unavailable', { status: 404 })) };
    const session = createChatSession({ client });
    const r = await session.send('こんにちは');
    expect(r).toMatchObject({ ok: true, fallback: true, reply: FALLBACK_MESSAGES.model_unavailable, turn: 0, remaining: 10 });
  });
});
