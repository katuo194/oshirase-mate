import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyManualLink } from '../src/main/manualLinks.js';

// 手順書ウィンドウのリンクの扱い（F-18・v5.11）。日本語・空白を含むパス（zip の展開先・ファイル名）でも判定できること
const MANUAL = pathToFileURL('C:\\Users\\user\\Documents\\おしらせメイト\\セットアップ手順書.html').href;

describe('classifyManualLink', () => {
  it('同じ手順書の中の見出しへの移動は in-page（ウィンドウ内で移動）', () => {
    expect(classifyManualLink(`${MANUAL}#google-consent`, MANUAL)).toBe('in-page');
    expect(classifyManualLink(`${MANUAL}#trouble`, MANUAL)).toBe('in-page');
    expect(classifyManualLink(MANUAL, MANUAL)).toBe('in-page');
  });

  it('https のリンク（Google Cloud Console・VOICEVOX・AI Studio 等）は external（既定のブラウザで開く）', () => {
    for (const url of ['https://console.cloud.google.com/', 'https://voicevox.hiroshiba.jp/term/', 'https://aistudio.google.com/apikey']) {
      expect(classifyManualLink(url, MANUAL)).toBe('external');
    }
  });

  it('別のローカルファイル・http・javascript: 等・壊れた URL は block', () => {
    for (const url of [
      pathToFileURL('C:\\Windows\\System32\\cmd.exe').href,
      pathToFileURL('C:\\Users\\user\\Documents\\おしらせメイト\\other.html').href,
      `${MANUAL}?x=1`,
      'http://example.com/',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'ms-settings:privacy',
      'not a url',
      '',
    ]) {
      expect(classifyManualLink(url, MANUAL)).toBe('block');
    }
  });

  it('手順書の URL が壊れていれば何も許さない', () => {
    expect(classifyManualLink(`${MANUAL}#x`, 'not a url')).toBe('block');
  });
});
