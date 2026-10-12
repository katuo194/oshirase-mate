import { describe, expect, it, vi } from 'vitest';
import { createMailSummary } from '../src/main/mailSummary.js';

describe('mailSummary / F-02b 未読件数のサマリ通知', () => {
  it('未読が3件→5件に増えたとき、サマリ表示が「5件」に更新される', () => {
    const s = createMailSummary();
    // 初回ポーリングが基準値になる（7.1「初回起動時は既存の未読をすべて通知済み扱い」）
    expect(s.update(3)).toMatchObject({ kind: 'initial', changed: false, count: 3, text: '3件' });

    const res = s.update(5);
    expect(res).toMatchObject({ kind: 'increased', changed: true, previous: 3, count: 5, delta: 2, text: '5件', visible: true });
    expect(s.get()).toEqual({ count: 5, capped: false, text: '5件', visible: true });
  });

  it('初回は基準値を置くだけで通知しない（起動時に未読が一斉に流れ出さない）', () => {
    const s = createMailSummary();
    expect(s.isSeeded()).toBe(false);
    expect(s.update(42).changed).toBe(false);
    expect(s.isSeeded()).toBe(true);
  });

  it('件数が変わらなければ変化なしとして扱う', () => {
    const s = createMailSummary();
    s.update(3);
    expect(s.update(3)).toMatchObject({ kind: 'unchanged', changed: false, delta: 0 });
  });

  it('減ったときも表示は追随するが、新着ではないと区別できる', () => {
    const s = createMailSummary();
    s.update(5);
    const res = s.update(1);
    expect(res).toMatchObject({ kind: 'decreased', changed: true, delta: -4, count: 1, text: '1件' });
  });

  it('0件になったらサマリを非表示にできる', () => {
    const s = createMailSummary();
    s.update(3);
    expect(s.update(0)).toMatchObject({ kind: 'decreased', count: 0, text: '0件', visible: false });
  });

  it('連続した増加を積み上げず、常に最新の件数を表示する（個別アニメーションは発生しない）', () => {
    const s = createMailSummary();
    s.update(0);
    expect(s.update(2).text).toBe('2件');
    expect(s.update(7).text).toBe('7件');
    expect(s.get().count).toBe(7);
  });

  it('件数として読めない値は無視し、前回の件数を保つ', () => {
    const s = createMailSummary();
    s.update(3);
    for (const bad of [undefined, null, NaN, -1, 'いくつか']) {
      expect(s.update(bad)).toMatchObject({ kind: 'invalid', changed: false, count: 3 });
    }
  });

  it('取得前は0件・非表示', () => {
    expect(createMailSummary().get()).toEqual({ count: 0, capped: false, text: '0件', visible: false });
  });

  it('数え上げの上限で頭打ちの件数は「2500+件」と表示する。差分は数値どうしで判定する', () => {
    const s = createMailSummary();
    expect(s.update(2500, { capped: true })).toMatchObject({ kind: 'initial', count: 2500, capped: true, text: '2500+件' });
    expect(s.update(2500, { capped: true })).toMatchObject({ kind: 'unchanged', changed: false });
    // 上限を下回れば通常表示に戻る
    expect(s.update(2400)).toMatchObject({ kind: 'decreased', delta: -100, capped: false, text: '2400件' });
    expect(s.get().capped).toBe(false);
  });

  it('reset() で capped も戻る', () => {
    const s = createMailSummary();
    s.update(2500, { capped: true });
    s.reset();
    expect(s.get()).toEqual({ count: 0, capped: false, text: '0件', visible: false });
  });

  it('基準値を与えて開始できる', () => {
    const s = createMailSummary({ initialCount: 3 });
    expect(s.isSeeded()).toBe(true);
    expect(s.update(5)).toMatchObject({ kind: 'increased', delta: 2 });
  });

  it('reset() で初回状態に戻る（連携解除・再連携）', () => {
    const s = createMailSummary();
    s.update(3);
    s.reset();
    expect(s.isSeeded()).toBe(false);
    expect(s.update(9).kind).toBe('initial');
  });
});

describe('mailSummary / updated イベント（Phase 4：ログコンシューマー・Phase 5 の描画が購読する）', () => {
  function setup() {
    const s = createMailSummary();
    const updated = vi.fn();
    s.events.on('updated', updated);
    return { s, updated };
  }

  it('初回（基準値の確定）と件数の変化で、update() の戻り値と同じ内容を発火する', () => {
    const { s, updated } = setup();
    const first = s.update(3);
    const second = s.update(5);
    expect(updated).toHaveBeenCalledTimes(2);
    expect(updated.mock.calls[0][0]).toEqual(first);
    expect(updated.mock.calls[0][0]).toMatchObject({ kind: 'initial', count: 3 });
    expect(updated.mock.calls[1][0]).toEqual(second);
    expect(updated.mock.calls[1][0]).toMatchObject({ kind: 'increased', previous: 3, count: 5, delta: 2, text: '5件' });
  });

  it('減ったときも発火する（表示を追随させるため）', () => {
    const { s, updated } = setup();
    s.update(5);
    s.update(2);
    expect(updated.mock.calls[1][0]).toMatchObject({ kind: 'decreased', delta: -3 });
  });

  it('変化なし・不正な値では発火しない（毎分のログ・再描画を防ぐ）', () => {
    const { s, updated } = setup();
    s.update(3);
    s.update(3);
    s.update(NaN);
    s.update(-1);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it('reset() では発火しない。再連携後の最初の update が initial として発火する', () => {
    const { s, updated } = setup();
    s.update(3);
    s.reset();
    expect(updated).toHaveBeenCalledTimes(1);
    s.update(9);
    expect(updated).toHaveBeenCalledTimes(2);
    expect(updated.mock.calls[1][0]).toMatchObject({ kind: 'initial', count: 9 });
  });

  it('reset() は別イベント reset を発火する（描画側がバッジを消す）。ペイロードは0件・非表示', () => {
    const s = createMailSummary();
    const reset = vi.fn();
    s.events.on('reset', reset);
    s.update(3);
    s.reset();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0][0]).toEqual({ count: 0, capped: false, text: '0件', visible: false });
  });

  it('購読者がいなくても落ちない', () => {
    expect(() => createMailSummary().update(1)).not.toThrow();
  });
});
