import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_LINES, SPOKEN_TODO, emptyLines } from '../src/main/characterLines.js';
import { clipFileName, createFixedVoice, parseVoiceIndex, recordingTexts, sameVoice } from '../src/main/fixedVoice.js';

const VOICE = { speakerId: 3, speedScale: 1, pitchScale: 0 };
const DIR = path.join('assets', 'characters', 'bundled-boy', 'voice');

/** 文 → 録音の対応表（voices.json の値） */
function indexOf(texts, voice = VOICE) {
  return parseVoiceIndex({
    version: 1,
    voice,
    clips: Object.fromEntries(texts.map((t) => [t, { file: clipFileName(t, voice), durationMs: 1200 }])),
  });
}

describe('fixedVoice / 声とファイル名', () => {
  it('sameVoice は話者・話速・音高がすべて同じときだけ true', () => {
    expect(sameVoice(VOICE, { ...VOICE })).toBe(true);
    expect(sameVoice(VOICE, { ...VOICE, speakerId: 2 })).toBe(false);
    expect(sameVoice(VOICE, { ...VOICE, speedScale: 1.1 })).toBe(false);
    expect(sameVoice(VOICE, { ...VOICE, pitchScale: 0.05 })).toBe(false);
    expect(sameVoice(VOICE, null)).toBe(false);
  });

  it('clipFileName は文と声から決まる16桁の16進＋.wav（文か声が変われば別の名前）', () => {
    const a = clipFileName('おはよう', VOICE);
    expect(a).toMatch(/^[0-9a-f]{16}\.wav$/);
    expect(clipFileName('おはよう', VOICE)).toBe(a);
    expect(clipFileName('おはよ', VOICE)).not.toBe(a);
    expect(clipFileName('おはよう', { ...VOICE, speakerId: 2 })).not.toBe(a);
  });
});

describe('fixedVoice / voices.json の読み込み', () => {
  it('正しい形なら声と文→録音の対応を返す', () => {
    const index = indexOf(['おはよう']);
    expect(index.voice).toEqual(VOICE);
    expect(index.clips.get('おはよう')).toEqual({ file: clipFileName('おはよう', VOICE), durationMs: 1200 });
  });

  it('version・声・clips が無い・違うなら null', () => {
    expect(parseVoiceIndex(null)).toBeNull();
    expect(parseVoiceIndex({ version: 2, voice: VOICE, clips: {} })).toBeNull();
    expect(parseVoiceIndex({ version: 1, voice: null, clips: {} })).toBeNull();
    expect(parseVoiceIndex({ version: 1, voice: VOICE })).toBeNull();
  });

  it('壊れた項目（パスを含むファイル名・空の文）はその項目だけを捨てる。長さが不正なら null', () => {
    const index = parseVoiceIndex({
      version: 1,
      voice: VOICE,
      clips: {
        よい: { file: '0123456789abcdef.wav', durationMs: -1 },
        外へ: { file: '../../secret.wav' },
        '': { file: '0123456789abcdef.wav' },
        形違い: 'x.wav',
      },
    });
    expect([...index.clips.keys()]).toEqual(['よい']);
    expect(index.clips.get('よい').durationMs).toBeNull();
  });
});

describe('fixedVoice / 録音しておく文（recordingTexts）', () => {
  it('アイドルトーク（空の種類は標準の文）・差し込みの無い通知のセリフ・件名なしの文を、読み上げる形で重複なく返す', () => {
    const lines = emptyLines();
    lines.idle.morning = ['おはようなのだ', 'TODO を確認するのだ'];
    lines.notify.calendar = ['{time}から{title}なのだ', '予定の時間なのだ'];
    lines.chat.closing = ['またなのだ'];
    const texts = recordingTexts({ lines, fallbackLines: { calendar: ['予定の時間なのだ'], tasks: ['TODO の期限なのだ'] } });
    expect(texts).toContain('おはようなのだ');
    expect(texts).toContain(`${SPOKEN_TODO} を確認するのだ`); // 読み替えた後の形で録音する
    expect(texts).toContain('予定の時間なのだ');
    expect(texts).toContain(`${SPOKEN_TODO} の期限なのだ`);
    for (const p of DEFAULT_IDLE_LINES.normal) expect(texts).toContain(p); // 空の種類は標準の文が読まれる
    expect(texts.some((t) => t.includes('{'))).toBe(false); // 差し込みのあるセリフは録音しない
    expect(texts).not.toContain('またなのだ'); // チャットの終わりは返事とつなげて合成する
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('fixedVoice / 録音を選ぶ', () => {
  it('match：同じ文・同じ声の録音があれば、そのファイルと長さを返す', () => {
    const fv = createFixedVoice({ index: indexOf(['おはよう']), dir: DIR, credit: 'VOICEVOX:ずんだもん' });
    expect(fv.match('おはよう', VOICE)).toEqual({ text: 'おはよう', filePath: path.join(DIR, clipFileName('おはよう', VOICE)), durationMs: 1200 });
    expect(fv.match('こんにちは', VOICE)).toBeNull();
    expect(fv.credit).toBe('VOICEVOX:ずんだもん');
  });

  it('利用者が声を変えていれば、録音を使わない（match・fallback・usable）', () => {
    const other = { ...VOICE, speedScale: 1.2 };
    const fv = createFixedVoice({ index: indexOf(['おはよう', '予定なのだ']), dir: DIR, fallbackLines: { calendar: ['予定なのだ'] } });
    expect(fv.usable(VOICE)).toBe(true);
    expect(fv.usable(other)).toBe(false);
    expect(fv.match('おはよう', other)).toBeNull();
    expect(fv.fallback('calendar', other)).toBeNull();
  });

  it('fallback：通知の種類ごとの件名なしの文から、録音のあるものを続けて同じにならないように選ぶ', () => {
    const fv = createFixedVoice({
      index: indexOf(['予定なのだ', '時間なのだ']),
      dir: DIR,
      fallbackLines: { calendar: ['予定なのだ', '時間なのだ', '録音の無い文'] },
      rng: () => 0,
    });
    const picked = Array.from({ length: 4 }, () => fv.fallback('calendar', VOICE).text);
    expect(new Set(picked)).toEqual(new Set(['予定なのだ', '時間なのだ']));
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
    expect(fv.fallback('gmail', VOICE)).toBeNull(); // 文の無い種類
  });

  it('fallback の文の TODO は読み替えた形で録音を探す', () => {
    const spoken = `${SPOKEN_TODO}の期限なのだ`;
    const fv = createFixedVoice({ index: indexOf([spoken]), dir: DIR, fallbackLines: { tasks: ['TODOの期限なのだ'] } });
    expect(fv.fallback('tasks', VOICE).text).toBe(spoken);
  });
});
