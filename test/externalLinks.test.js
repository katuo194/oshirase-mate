import { describe, expect, it } from 'vitest';
import { EXTERNAL_LINKS, externalUrlFor, isExternalLinkUrl } from '../src/main/externalLinks.js';

// 設定画面のボタンで開く外部のページ（Phase 12・v5.15）。画面はリンクの名前だけを送る
describe('externalLinks', () => {
  it('「Google 連携の準備」の手順 1〜3 と、VOICEVOX・Gemini API キーのページがそろっている', () => {
    expect(Object.keys(EXTERNAL_LINKS).sort()).toEqual(['apis', 'audience', 'branding', 'client', 'geminiKey', 'voicevox']);
  });

  it('すべて https で、決まったホスト（Console・VOICEVOX・AI Studio）', () => {
    const hosts = {
      apis: 'console.cloud.google.com',
      branding: 'console.cloud.google.com',
      audience: 'console.cloud.google.com',
      client: 'console.cloud.google.com',
      voicevox: 'voicevox.hiroshiba.jp',
      geminiKey: 'aistudio.google.com',
    };
    for (const [name, url] of Object.entries(EXTERNAL_LINKS)) {
      const u = new URL(url);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe(hosts[name]);
      expect(u.username + u.password).toBe('');
    }
  });

  it('手順 1 は Calendar・Tasks・Gmail の 3 つの API を一度に有効にするページ', () => {
    const u = new URL(externalUrlFor('apis'));
    expect(u.pathname).toBe('/flows/enableapi');
    expect(u.searchParams.get('apiid').split(',')).toEqual(['calendar-json.googleapis.com', 'tasks.googleapis.com', 'gmail.googleapis.com']);
  });

  it('リンクの名前から URL を引く', () => {
    expect(externalUrlFor('branding')).toBe('https://console.cloud.google.com/auth/branding');
    expect(externalUrlFor('audience')).toBe('https://console.cloud.google.com/auth/audience');
    expect(externalUrlFor('client')).toBe('https://console.cloud.google.com/auth/clients/create');
    expect(externalUrlFor('voicevox')).toBe('https://voicevox.hiroshiba.jp/');
    expect(externalUrlFor('geminiKey')).toBe('https://aistudio.google.com/apikey');
  });

  it('知らない名前・URL・プロトタイプのキー・文字列でない値は拒否する（null）', () => {
    for (const name of ['', 'unknown', 'https://example.com/', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 1, null, undefined, {}, ['apis']]) {
      expect(externalUrlFor(name)).toBeNull();
    }
  });

  it('isExternalLinkUrl は表にある URL そのものだけを通す', () => {
    for (const url of Object.values(EXTERNAL_LINKS)) expect(isExternalLinkUrl(url)).toBe(true);
    for (const url of ['https://console.cloud.google.com/', 'https://voicevox.hiroshiba.jp/evil', 'https://example.com/', 'file:///C:/Windows/System32/cmd.exe', '', null, 42]) {
      expect(isExternalLinkUrl(url)).toBe(false);
    }
  });
});
