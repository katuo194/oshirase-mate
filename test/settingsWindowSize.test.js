import { describe, expect, it } from 'vitest';
import {
  SETTINGS_DEFAULT_SIZE,
  SETTINGS_MIN_SIZE,
  SETTINGS_TABS,
  isSettingsTab,
  resolveSettingsWindowSize,
} from '../src/main/settingsWindowSize.js';

const FULL_HD = { width: 1920, height: 1040 };

describe('resolveSettingsWindowSize（設定ウィンドウの大きさ：v5.19）', () => {
  it('覚えた大きさが無ければ既定の 1000×660', () => {
    expect(resolveSettingsWindowSize(null, FULL_HD)).toEqual({ width: 1000, height: 660 });
    expect(SETTINGS_DEFAULT_SIZE).toEqual({ width: 1000, height: 660 });
  });

  it('覚えた大きさで開く（小数は丸める）', () => {
    expect(resolveSettingsWindowSize({ width: 640.4, height: 900.6 }, FULL_HD)).toEqual({ width: 640, height: 901 });
  });

  it('壊れた値（数でない・0 以下・型違い）は既定の大きさ', () => {
    for (const saved of [{ width: 'a', height: 600 }, { width: 0, height: 600 }, { width: -5, height: 600 }, { width: 800 }, 'big', 3, []]) {
      expect(resolveSettingsWindowSize(saved, FULL_HD)).toEqual(SETTINGS_DEFAULT_SIZE);
    }
  });

  it('最小より小さければ最小にする', () => {
    expect(resolveSettingsWindowSize({ width: 100, height: 100 }, FULL_HD)).toEqual(SETTINGS_MIN_SIZE);
  });

  it('作業領域より大きくはしない（高さはタイトルバーの分 40 を引く）', () => {
    expect(resolveSettingsWindowSize({ width: 3000, height: 3000 }, FULL_HD)).toEqual({ width: 1920, height: 1000 });
    expect(resolveSettingsWindowSize(null, { width: 900, height: 600 })).toEqual({ width: 900, height: 560 });
  });

  it('作業領域が最小より小さいときは作業領域に合わせる', () => {
    expect(resolveSettingsWindowSize(null, { width: 400, height: 300 })).toEqual({ width: 400, height: 260 });
  });
});

describe('isSettingsTab（設定ウィンドウのタブ）', () => {
  it('設定とキャラクターの 2 つだけ', () => {
    expect(SETTINGS_TABS).toEqual(['settings', 'character']);
    expect(SETTINGS_TABS.every(isSettingsTab)).toBe(true);
    for (const v of [undefined, null, '', 'Settings', 'chat', 'toString']) expect(isSettingsTab(v)).toBe(false);
  });
});
