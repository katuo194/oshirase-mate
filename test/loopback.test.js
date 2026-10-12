import { describe, expect, it } from 'vitest';
import { startLoopbackServer } from '../src/main/loopback.js';

// 実際の 127.0.0.1 に HTTP を送る（ブラウザ・Google は使わない）
describe('startLoopbackServer', () => {
  it('127.0.0.1 の動的ポートで待ち受け、正しいコールバックで code を返して閉じる', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE' });
    expect(s.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const res = await fetch(`${s.redirectUri}?code=THE_CODE&state=STATE`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('charset=utf-8');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await s.result).toEqual({ code: 'THE_CODE' });

    // 1回受けたら閉じている
    await expect(fetch(`${s.redirectUri}?code=X&state=STATE`)).rejects.toThrow();
  });

  it('state 不一致は 400 で無視し、その後の正しいコールバックを受け付ける', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE' });
    const bad = await fetch(`${s.redirectUri}?code=EVIL&state=WRONG`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${s.redirectUri}?code=GOOD&state=STATE`);
    expect(good.status).toBe(200);
    expect(await s.result).toEqual({ code: 'GOOD' });
  });

  it('/callback 以外（favicon 等）は 404 で、待機は継続する', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE' });
    const origin = new URL(s.redirectUri).origin;
    expect((await fetch(`${origin}/favicon.ico`)).status).toBe(404);
    await fetch(`${s.redirectUri}?code=C&state=STATE`);
    expect(await s.result).toEqual({ code: 'C' });
  });

  it('ユーザーが拒否した場合は { error: "denied" }', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE' });
    await fetch(`${s.redirectUri}?error=access_denied&state=STATE`);
    expect(await s.result).toEqual({ error: 'denied' });
  });

  it('タイムアウトで reject（code=timeout）し、ポートを閉じる', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE', timeoutMs: 30 });
    await expect(s.result).rejects.toMatchObject({ code: 'timeout' });
    await expect(fetch(`${s.redirectUri}?code=C&state=STATE`)).rejects.toThrow();
  });

  it('close() でキャンセル（code=cancelled）できる', async () => {
    const s = await startLoopbackServer({ expectedState: 'STATE' });
    s.close();
    await expect(s.result).rejects.toMatchObject({ code: 'cancelled' });
    await expect(fetch(`${s.redirectUri}?code=C&state=STATE`)).rejects.toThrow();
  });
});
