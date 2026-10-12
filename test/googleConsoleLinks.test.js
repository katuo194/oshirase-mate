import { describe, expect, it } from 'vitest';
import { CONSOLE_LINKS, consoleUrlFor } from '../src/main/googleConsoleLinks.js';

// 「Google 連携の準備」の各手順のボタンで開く Console のページ（Phase 12・v5.15）。画面は手順の名前だけを送る
describe('googleConsoleLinks', () => {
  it('手順 1〜3 のページがそろっている', () => {
    expect(Object.keys(CONSOLE_LINKS).sort()).toEqual(['apis', 'audience', 'branding', 'client']);
  });

  it('すべて https の console.cloud.google.com', () => {
    for (const url of Object.values(CONSOLE_LINKS)) {
      const u = new URL(url);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe('console.cloud.google.com');
      expect(u.username + u.password).toBe('');
    }
  });

  it('手順 1 は Calendar・Tasks・Gmail の 3 つの API を一度に有効にするページ', () => {
    const u = new URL(consoleUrlFor('apis'));
    expect(u.pathname).toBe('/flows/enableapi');
    expect(u.searchParams.get('apiid').split(',')).toEqual(['calendar-json.googleapis.com', 'tasks.googleapis.com', 'gmail.googleapis.com']);
  });

  it('手順の名前から URL を引く', () => {
    expect(consoleUrlFor('branding')).toBe('https://console.cloud.google.com/auth/branding');
    expect(consoleUrlFor('audience')).toBe('https://console.cloud.google.com/auth/audience');
    expect(consoleUrlFor('client')).toBe('https://console.cloud.google.com/auth/clients/create');
  });

  it('知らない手順の名前・URL・プロトタイプのキー・文字列でない値は拒否する（null）', () => {
    for (const step of ['', 'unknown', 'https://example.com/', 'toString', '__proto__', 'constructor', 'hasOwnProperty', 1, null, undefined, {}, ['apis']]) {
      expect(consoleUrlFor(step)).toBeNull();
    }
  });
});
