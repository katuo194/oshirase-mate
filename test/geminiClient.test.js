import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeGemini } from '../mocks/gemini/index.js';
import { GEMINI_MODELS, GeminiError, MAX_OUTPUT_TOKENS, classifyHttpFailure, createGeminiClient, extractText, safeApiMessage } from '../src/main/geminiClient.js';

const KEY = 'fake-gemini-key-for-tests-0123456789';
const req = { systemPrompt: 'SYS', contents: [{ role: 'user', text: 'こんにちは' }] };

function setup({ replies, key = KEY, timeoutMs } = {}) {
  const gm = createFakeGemini({ replies });
  const log = { info: vi.fn(), warn: vi.fn() };
  const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => key, log, ...(timeoutMs ? { timeoutMs } : {}) });
  return { gm, client, log };
}

const kindOf = async (promise) => {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(GeminiError);
    return e.kind;
  }
  return 'no-error';
};

describe('geminiClient / 成功', () => {
  it('応答本文を返す。リクエストは systemInstruction・contents（role/parts）・generationConfig を含む', async () => {
    const { gm, client } = setup({ replies: ['やあ、元気？'] });
    const text = await client.generate({
      systemPrompt: 'SYS',
      contents: [
        { role: 'user', text: 'a' },
        { role: 'model', text: 'b' },
        { role: 'user', text: 'c' },
      ],
    });
    expect(text).toBe('やあ、元気？');

    const call = gm.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELS[0]}:generateContent`);
    expect(call.body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(call.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'model', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] },
    ]);
    expect(call.body.generationConfig.maxOutputTokens).toBeGreaterThan(0);
  });

  it('キーは x-goog-api-key ヘッダで送り、URL・本文には含めない', async () => {
    const { gm, client } = setup();
    await client.generate(req);
    const call = gm.calls[0];
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.url).not.toContain(KEY);
    expect(call.url).not.toContain('key=');
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it('generationConfig は既定に上書きして送る（セリフの生成の JSON 出力：Phase 14）。渡さなければ既定のまま', async () => {
    const { gm, client } = setup({ replies: ['{}'] });
    await client.generate({ ...req, generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' } });
    expect(gm.calls[0].body.generationConfig).toEqual({ maxOutputTokens: 8192, temperature: 0.9, responseMimeType: 'application/json' });
    await client.generate(req);
    expect(gm.calls[1].body.generationConfig).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.9 });
  });

  it('ログの頭は logTag で変えられる（既定は [chat]）', async () => {
    const gm = createFakeGemini();
    const log = { info: vi.fn(), warn: vi.fn() };
    const client = createGeminiClient({ fetch: gm.fetch, getApiKey: async () => KEY, logTag: 'lines', log });
    gm.failNext(503);
    await kindOf(client.generate(req));
    expect(log.warn.mock.calls[0][0]).toMatch(/^\[lines\] /);
  });

  it('複数の parts は連結し、前後の空白を除く', async () => {
    expect(extractText({ candidates: [{ content: { parts: [{ text: ' こん' }, { text: 'にちは ' }] }, finishReason: 'STOP' }] })).toBe('こんにちは');
  });
});

describe('geminiClient / 失敗の分類（フォールバック応答の入力）', () => {
  it('キー未設定は auth（通信しない）', async () => {
    const { gm, client } = setup({ key: null });
    expect(await kindOf(client.generate(req))).toBe('auth');
    expect(gm.calls).toEqual([]);
  });

  it('400 のキー不正（API_KEY_INVALID）・401・403 は auth', async () => {
    const a = setup();
    a.gm.invalidKeyNext();
    expect(await kindOf(a.client.generate(req))).toBe('auth');

    const b = setup();
    b.gm.failNext(401);
    expect(await kindOf(b.client.generate(req))).toBe('auth');

    const c = setup();
    c.gm.failNext(403, { errorStatus: 'PERMISSION_DENIED' });
    expect(await kindOf(c.client.generate(req))).toBe('auth');
  });

  it('429 は rate_limit、5xx は server、その他の 4xx は unknown', async () => {
    const a = setup();
    a.gm.failNext(429, { errorStatus: 'RESOURCE_EXHAUSTED' });
    expect(await kindOf(a.client.generate(req))).toBe('rate_limit');

    const b = setup();
    b.gm.failNext(503);
    expect(await kindOf(b.client.generate(req))).toBe('server');

    const c = setup();
    c.gm.failNext(400, { message: 'Bad request: too many tokens' });
    expect(await kindOf(c.client.generate(req))).toBe('unknown');
  });

  it('接続できないときは network', async () => {
    const { gm, client } = setup();
    gm.networkDownNext();
    expect(await kindOf(client.generate(req))).toBe('network');
  });

  it('安全フィルタでブロックされたら blocked、候補なし・本文なしは empty', async () => {
    const a = setup();
    a.gm.blockNext();
    expect(await kindOf(a.client.generate(req))).toBe('blocked');

    const b = setup();
    b.gm.emptyNext();
    expect(await kindOf(b.client.generate(req))).toBe('empty');

    expect(() => extractText({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })).toThrow(GeminiError);
    try {
      extractText({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
    } catch (e) {
      expect(e.kind).toBe('blocked');
    }
  });

  it('classifyHttpFailure は純粋関数として種別を返す', () => {
    expect(classifyHttpFailure(400, { message: 'API key not valid' })).toBe('auth');
    expect(classifyHttpFailure(400, { message: 'something else' })).toBe('unknown');
    expect(classifyHttpFailure(500, null)).toBe('server');
    expect(classifyHttpFailure(404, null)).toBe('model_unavailable');
  });
});

describe('geminiClient / タイムアウト・中止', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('応答が遅ければタイムアウト（timeout）', async () => {
    const { gm, client } = setup({ timeoutMs: 15000 });
    gm.hangNext();
    const p = kindOf(client.generate(req));
    await vi.advanceTimersByTimeAsync(15000);
    expect(await p).toBe('timeout');
  });

  it('上限時間は呼び出しごとに timeoutMs で変えられる', async () => {
    const { gm, client } = setup({ timeoutMs: 15000 });
    gm.hangNext();
    let kind = null;
    const p = kindOf(client.generate({ ...req, timeoutMs: 60000 })).then((k) => (kind = k));
    await vi.advanceTimersByTimeAsync(15000);
    expect(kind).toBeNull(); // 既定の 15 秒では切れない
    await vi.advanceTimersByTimeAsync(45000);
    await p;
    expect(kind).toBe('timeout');
  });

  it('呼び出し側が中止したら aborted（失敗ログは出さない）', async () => {
    const { gm, client, log } = setup();
    gm.hangNext();
    const controller = new AbortController();
    const p = kindOf(client.generate({ ...req, signal: controller.signal }));
    controller.abort();
    expect(await p).toBe('aborted');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('開始前にすでに中止されていたら aborted', async () => {
    const { gm, client } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(client.generate({ ...req, signal: controller.signal }))).toBe('aborted');
    expect(gm.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('geminiClient / 秘密を漏らさない', () => {
  it('失敗ログにキー・ユーザーの発言・プロンプトを含めない', async () => {
    const { gm, client, log } = setup();
    gm.failNext(500);
    await kindOf(client.generate({ systemPrompt: 'SECRET-PROMPT', contents: [{ role: 'user', text: 'ひみつの発言' }] }));
    gm.invalidKeyNext();
    await kindOf(client.generate(req));
    const logged = JSON.stringify(log.warn.mock.calls) + JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('ひみつの発言');
    expect(logged).not.toContain('SECRET-PROMPT');
  });

  it('GeminiError のメッセージにキー・本文を含めない', async () => {
    const { gm, client } = setup();
    gm.failNext(500, { message: `leaked ${KEY}` });
    try {
      await client.generate(req);
    } catch (e) {
      expect(e.message).not.toContain(KEY);
    }
  });
});
