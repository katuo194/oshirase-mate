import { describe, expect, it } from 'vitest';
import { NORMAL_PHRASES } from '../src/main/idleTalkPhrases.js';
import { createBag, createPhrasePicker } from '../src/main/phrasePicker.js';

/** 固定シードの乱数（mulberry32）。テストを再現可能にする。 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('phrasePicker / シャッフル袋（v5.8）', () => {
  it('1周（20回）で通常20種がちょうど1回ずつ出る', () => {
    const bag = createBag(NORMAL_PHRASES, seeded(1));
    const round = Array.from({ length: 20 }, () => bag.next());
    expect(new Set(round).size).toBe(20);
    expect([...round].sort()).toEqual([...NORMAL_PHRASES].sort());
  });

  it('周の切り替わりを含め、同じ文面が連続しない（多数のシードで検証）', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const bag = createBag(NORMAL_PHRASES, seeded(seed));
      let prev = null;
      for (let i = 0; i < 20 * 6; i++) {
        const p = bag.next();
        expect(p).not.toBe(prev);
        prev = p;
      }
    }
  });

  it('乱数が常に同じ値でも（最悪ケース）連続しない', () => {
    for (const v of [0, 0.999999]) {
      const bag = createBag(['a', 'b', 'c'], () => v);
      let prev = null;
      for (let i = 0; i < 30; i++) {
        const p = bag.next();
        expect(p).not.toBe(prev);
        prev = p;
      }
    }
  });

  it('カテゴリごとに独立した袋：朝・就寝前は各5種を1周するまで重複しない', () => {
    const picker = createPhrasePicker({ rng: seeded(7) });
    const morning = Array.from({ length: 5 }, () => picker.pick('morning'));
    const bedtime = Array.from({ length: 5 }, () => picker.pick('bedtime'));
    expect(new Set(morning).size).toBe(5);
    expect(new Set(bedtime).size).toBe(5);
  });

  it('通常は20種の全体から選ぶ（独り言・話しかけ・疑問のいずれも出る）', () => {
    const picker = createPhrasePicker({ rng: seeded(3) });
    const seen = new Set(Array.from({ length: 20 }, () => picker.pick('normal')));
    expect(seen).toEqual(new Set(NORMAL_PHRASES));
  });

  it('未知のカテゴリ・空の文面セットは例外', () => {
    expect(() => createPhrasePicker().pick('unknown')).toThrow();
    expect(() => createBag([])).toThrow();
  });

  it('1種しかない袋は同じ文面を返し続ける（無限ループしない）', () => {
    const bag = createBag(['only'], () => 0.5);
    expect([bag.next(), bag.next()]).toEqual(['only', 'only']);
  });
});
