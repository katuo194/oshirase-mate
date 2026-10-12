import { describe, expect, it } from 'vitest';
import { DEFAULTS, diffPatch, normalizeSettings, sanitizePatch } from '../src/main/settingsSchema.js';

describe('normalizeSettings', () => {
  it('欠損（空・null・非オブジェクト）は既定値になる', () => {
    for (const raw of [undefined, null, {}, 'x', 42, []]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULTS);
    }
  });

  it('正しい保存値はそのまま返す', () => {
    const raw = { character: 'default', muted: true, volume: { sfx: 0.3, voice: 0.5 }, launchAtLogin: true, displayMode: 'notifyOnly' };
    expect(normalizeSettings(raw)).toEqual(raw);
  });

  it('型不正は既定値に戻す', () => {
    const s = normalizeSettings({ character: 5, muted: 'yes', volume: { sfx: 'loud', voice: NaN }, launchAtLogin: 1, displayMode: 'hidden' });
    expect(s).toEqual(DEFAULTS);
  });

  it('volume が範囲外なら 0〜1 に丸める', () => {
    const s = normalizeSettings({ volume: { sfx: 5, voice: -2 } });
    expect(s.volume).toEqual({ sfx: 1, voice: 0 });
  });

  it('volume が壊れたオブジェクトでも片方だけ既定値になる', () => {
    expect(normalizeSettings({ volume: { sfx: 0.2 } }).volume).toEqual({ sfx: 0.2, voice: DEFAULTS.volume.voice });
    expect(normalizeSettings({ volume: 'x' }).volume).toEqual(DEFAULTS.volume);
  });

  it('Phase 1 対象外のキー（characterAnchor など）は含めない', () => {
    const s = normalizeSettings({ characterAnchor: { x: 1, y: 2 }, oauth: { clientId: 'a' } });
    expect(Object.keys(s).sort()).toEqual(['character', 'displayMode', 'launchAtLogin', 'muted', 'volume']);
  });
});

describe('sanitizePatch', () => {
  it('許可されたキーだけを通す', () => {
    expect(sanitizePatch({ muted: true, launchAtLogin: false, volume: { sfx: 0.5, voice: 0.25 } })).toEqual({
      muted: true,
      launchAtLogin: false,
      volume: { sfx: 0.5, voice: 0.25 },
    });
  });

  it('displayMode は always / notifyOnly だけを通す（F-20）', () => {
    expect(sanitizePatch({ displayMode: 'notifyOnly' })).toEqual({ displayMode: 'notifyOnly' });
    expect(sanitizePatch({ displayMode: 'always' })).toEqual({ displayMode: 'always' });
    for (const displayMode of ['hidden', '', 1, true, null, ['always']]) {
      expect(sanitizePatch({ displayMode })).toEqual({});
    }
  });

  it('character・未知キー・characterAnchor は捨てる', () => {
    expect(sanitizePatch({ character: 'evil', characterAnchor: { x: 0, y: 0 }, oauth: {}, foo: 1 })).toEqual({});
  });

  it('不正な型は捨てる', () => {
    expect(sanitizePatch({ muted: 'true', launchAtLogin: 1, volume: { sfx: '0.5', voice: NaN } })).toEqual({});
  });

  it('volume は 0〜1 に丸め、0.01 刻みにする', () => {
    expect(sanitizePatch({ volume: { sfx: 3, voice: 0.123456 } })).toEqual({ volume: { sfx: 1, voice: 0.12 } });
  });

  it('オブジェクト以外は空パッチ', () => {
    for (const p of [undefined, null, 'x', 1, []]) {
      expect(sanitizePatch(p)).toEqual({});
    }
  });
});

describe('diffPatch', () => {
  const current = normalizeSettings({});

  it('値が変わるキーだけを、キー単位（ドット記法）で返す', () => {
    const entries = diffPatch(current, { muted: true, volume: { sfx: 0.5 } });
    expect(entries).toEqual([
      ['muted', true],
      ['volume.sfx', 0.5],
    ]);
  });

  it('displayMode の変更を返す（F-20）', () => {
    expect(diffPatch(current, { displayMode: 'notifyOnly' })).toEqual([['displayMode', 'notifyOnly']]);
    expect(diffPatch(current, { displayMode: 'always' })).toEqual([]);
  });

  it('現在値と同じなら何も返さない', () => {
    expect(diffPatch(current, { muted: false, volume: { sfx: 0.8 }, launchAtLogin: false })).toEqual([]);
  });

  it('パッチに含まれないキーは触らない（characterAnchor・未知キー・character を書き込み対象にしない）', () => {
    const patch = sanitizePatch({ muted: true, character: 'x', characterAnchor: { x: 9, y: 9 } });
    const keys = diffPatch(current, patch).map(([k]) => k);
    expect(keys).toEqual(['muted']);
  });

  it('書き込みキーは常に許可リスト内', () => {
    const allowed = new Set(['muted', 'launchAtLogin', 'displayMode', 'volume.sfx', 'volume.voice']);
    const patch = sanitizePatch({ muted: true, launchAtLogin: true, displayMode: 'notifyOnly', volume: { sfx: 0.1, voice: 0.2 } });
    for (const [k] of diffPatch(current, patch)) expect(allowed.has(k)).toBe(true);
  });
});

describe('edition はスキーマの対象外（v5.11：既定値で埋めない・書き込まない）', () => {
  // 「edition が保存されている」を「スキーマの既定値で埋まっている」ではなく「本当に保存されている」で判定するため（edition.js）。
  // スキーマが edition を埋めると、配布パッケージのビルド時の既定値（mascotEdition）が常に上書きされてしまう。
  it('DEFAULTS・normalizeSettings の結果に edition が出ない（保存値があっても）', () => {
    expect(DEFAULTS).not.toHaveProperty('edition');
    for (const raw of [undefined, {}, { edition: 'personal' }, { edition: 'shared' }]) {
      expect(normalizeSettings(raw)).not.toHaveProperty('edition');
    }
  });

  it('sanitizePatch・diffPatch は edition を通さない（設定画面から版を書き換えられない）', () => {
    for (const edition of ['personal', 'shared']) {
      expect(sanitizePatch({ edition })).toEqual({});
      expect(diffPatch(normalizeSettings({}), sanitizePatch({ edition, muted: true })).map(([k]) => k)).toEqual(['muted']);
    }
  });
});
