import { describe, expect, it } from 'vitest';
import { IDLE_HOLD_MS, SPEECH_MAX, idlePresentation, systemPresentation, toPresentation, totalMs } from '../src/main/notificationView.js';

describe('notificationView / idlePresentation（アイドルトークの軽い表現・v5.8）', () => {
  const p = idlePresentation({ id: 'idle:1', text: 'ふわぁ…ちょっとぼーっとしちゃった。' });

  it('吹き出しのみ：ラベルなし・副題なし・効果音なし、文面がそのまま題名になる', () => {
    expect(p).toMatchObject({ id: 'idle:1', kind: 'idle', label: '', sub: '', sfxKey: null, title: 'ふわぁ…ちょっとぼーっとしちゃった。' });
  });

  it('動きなし：冒頭の動き・ループとも none（リング・揺れを出さない）', () => {
    expect(p.params).toMatchObject({ burst: 'none', loop: 'none', mouth: 'smile' });
  });

  it('通知（青・緑・橙）やお知らせ（灰）と区別できる色', () => {
    const colors = ['calendar', 'tasks', 'gmail'].map((source) =>
      toPresentation({ id: `${source}:1`, source, title: 't', body: '', data: {} }).params.accent,
    );
    colors.push(systemPresentation({ id: 's', title: 't' }).params.accent);
    expect(colors).not.toContain(p.params.accent);
  });

  it('文面は読み上げにそのまま使う（最大長で切る）。ミュート中の破棄は voiceReader が行う', () => {
    expect(p.speech).toBe('ふわぁ…ちょっとぼーっとしちゃった。');
    const long = idlePresentation({ id: 'idle:2', text: 'あ'.repeat(SPEECH_MAX + 20) });
    expect(long.speech).toHaveLength(SPEECH_MAX);
  });

  it('保持時間は通知（5〜8秒）と同程度の短さ。合計時間は保持＋絞り', () => {
    expect(p.timing.holdMs).toBe(IDLE_HOLD_MS);
    expect(IDLE_HOLD_MS).toBeLessThanOrEqual(8000);
    expect(totalMs(p.timing)).toBe(IDLE_HOLD_MS + p.timing.outMs);
  });
});
