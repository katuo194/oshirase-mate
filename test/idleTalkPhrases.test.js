import { describe, expect, it } from 'vitest';
import {
  BEDTIME_PHRASES,
  CALLING_PHRASES,
  MONOLOGUE_PHRASES,
  MORNING_PHRASES,
  NORMAL_PHRASES,
  PHRASE_MAX_LENGTH,
  PHRASE_SETS,
  QUESTION_PHRASES,
} from '../src/main/idleTalkPhrases.js';

describe('idleTalkPhrases / 定型文30種（3.4・9章#1）', () => {
  it('内訳：朝5・就寝前5・独り言5・話しかけてくる系10・疑問形5（合計30）', () => {
    expect(MORNING_PHRASES).toHaveLength(5);
    expect(BEDTIME_PHRASES).toHaveLength(5);
    expect(MONOLOGUE_PHRASES).toHaveLength(5);
    expect(CALLING_PHRASES).toHaveLength(10);
    expect(QUESTION_PHRASES).toHaveLength(5);
    expect(MORNING_PHRASES.length + BEDTIME_PHRASES.length + NORMAL_PHRASES.length).toBe(30);
  });

  it('通常アイドルトークは20種（朝・就寝前以外）', () => {
    expect(NORMAL_PHRASES).toHaveLength(20);
    expect(PHRASE_SETS.normal).toBe(NORMAL_PHRASES);
  });

  it('30種すべてが重複しない', () => {
    const all = [...MORNING_PHRASES, ...BEDTIME_PHRASES, ...NORMAL_PHRASES];
    expect(new Set(all).size).toBe(all.length);
  });

  it('すべて空でなく、吹き出しに収まる長さ・絵文字なし（VOICEVOXが読めない）', () => {
    for (const p of [...MORNING_PHRASES, ...BEDTIME_PHRASES, ...NORMAL_PHRASES]) {
      expect(p.trim()).not.toBe('');
      expect(p.length).toBeLessThanOrEqual(PHRASE_MAX_LENGTH);
      expect(p).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('疑問形は疑問の形（？で終わる、または「〜いかが？」等）になっている', () => {
    for (const p of QUESTION_PHRASES) expect(p).toMatch(/[？?]$/);
  });
});
