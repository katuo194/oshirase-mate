import { beforeEach, describe, expect, it, vi } from 'vitest';

// electron-store をメモリ上の偽物に差し替える（config.json の中身＝ data。set の呼び出しを記録する）
const fake = vi.hoisted(() => ({ data: {}, setCalls: [], buildEdition: null, envHasCredentials: true }));
vi.mock('electron-store', () => ({
  default: class FakeStore {
    get(key) {
      return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), fake.data);
    }
    set(key, value) {
      fake.setCalls.push([key, value]);
      const keys = key.split('.');
      let o = fake.data;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = value;
    }
  },
}));

// ビルド時の既定の版（配布パッケージの package.json の mascotEdition）。テストごとに差し替える
vi.mock('../src/main/buildInfo.js', () => ({
  get BUILD_EDITION() {
    return fake.buildEdition;
  },
  get ENV_HAS_CREDENTIALS() {
    return fake.envHasCredentials;
  },
}));

const { getEdition, setCharacter, settingsEvents, updateSettings } = await import('../src/main/store.js');

/** Phase 1〜7 のキーが入った config.json */
const initialConfig = () => ({
  character: 'default',
  muted: true,
  volume: { sfx: 0.5, voice: 0.7 },
  voicevox: { speakerId: 3, speedScale: 1.1, pitchScale: 0 },
  polling: { mailIntervalSec: 60 },
  idleTalk: { enabled: true, intervalMin: 20, quietHours: [0, 6] },
  chat: { maxTurns: 10 },
  launchAtLogin: true,
  characterAnchor: { x: 1700, y: 900 },
});

const IDS = ['default', 'emotelab-3f9a1c2e'];

beforeEach(() => {
  fake.data = initialConfig();
  fake.setCalls = [];
  fake.buildEdition = null;
  fake.envHasCredentials = true;
  settingsEvents.removeAllListeners();
});

describe('store.setCharacter（6.1 character だけを書く）', () => {
  it('character キーだけを書き、characterAnchor 等の他のキーは変えない', () => {
    const r = setCharacter('emotelab-3f9a1c2e', IDS);
    expect(r.ok).toBe(true);
    expect(r.settings.character).toBe('emotelab-3f9a1c2e');
    expect(fake.setCalls).toEqual([['character', 'emotelab-3f9a1c2e']]);
    expect(fake.data).toEqual({ ...initialConfig(), character: 'emotelab-3f9a1c2e' });
    expect(fake.data.characterAnchor).toEqual({ x: 1700, y: 900 });
  });

  it('変更したら change を発火する（トレイ・マスコット・画面が購読）', () => {
    const onChange = vi.fn();
    settingsEvents.on('change', onChange);
    setCharacter('emotelab-3f9a1c2e', IDS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ character: 'emotelab-3f9a1c2e', muted: true, volume: { sfx: 0.5, voice: 0.7 } });
  });

  it('既定キャラクターへ戻せる', () => {
    fake.data.character = 'emotelab-3f9a1c2e';
    expect(setCharacter('default', IDS).ok).toBe(true);
    expect(fake.setCalls).toEqual([['character', 'default']]);
  });

  it('選べない ID（存在しない・不正な値）は書かない', () => {
    const onChange = vi.fn();
    settingsEvents.on('change', onChange);
    for (const bad of ['emotelab-ffffffff', '../x', '', undefined, 42, null]) {
      const r = setCharacter(bad, IDS);
      expect(r.ok).toBe(false);
      expect(r.settings.character).toBe('default');
    }
    expect(fake.setCalls).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.data).toEqual(initialConfig());
  });

  it('同じ ID なら書き込みも change も起きない', () => {
    const onChange = vi.fn();
    settingsEvents.on('change', onChange);
    expect(setCharacter('default', IDS).ok).toBe(true);
    expect(fake.setCalls).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('store.getEdition（6.1：保存された edition → ビルド時の既定値 → .env の有無。v5.11・v5.19）', () => {
  it('開発時（edition 未保存・ビルド時の既定値なし）で .env に資格情報があれば personal', () => {
    expect(fake.data).not.toHaveProperty('edition');
    expect(getEdition()).toBe('personal');
  });

  it('ソースから .env なしで起動したら shared（GitHub から取得したソース。v5.19）', () => {
    fake.envHasCredentials = false;
    expect(getEdition()).toBe('shared');
    expect(fake.data).not.toHaveProperty('edition');
    // 保存された値・ビルド時の既定値が優先
    fake.data.edition = 'personal';
    expect(getEdition()).toBe('personal');
    delete fake.data.edition;
    fake.buildEdition = 'personal';
    expect(getEdition()).toBe('personal');
  });

  it('共有版のパッケージ（ビルド時の既定値 shared）で edition 未保存なら shared（既定値で上書きされない）', () => {
    fake.buildEdition = 'shared';
    expect(getEdition()).toBe('shared');
    // 読み出しで edition が書き込まれることもない
    expect(fake.setCalls).toEqual([]);
    expect(fake.data).not.toHaveProperty('edition');
  });

  it('config.json に本当に保存された値はビルド時の既定値より優先（開発・検証時の手動編集）', () => {
    fake.buildEdition = 'shared';
    fake.data.edition = 'personal';
    expect(getEdition()).toBe('personal');
    fake.buildEdition = null;
    fake.data.edition = 'shared';
    expect(getEdition()).toBe('shared');
  });

  it('保存値が不正なら未保存とみなす', () => {
    fake.data.edition = 'Shared';
    expect(getEdition()).toBe('personal');
    fake.buildEdition = 'shared';
    expect(getEdition()).toBe('shared');
  });

  it('updateSettings・setCharacter は edition を書き込まない（パッチに含めても）', () => {
    fake.buildEdition = 'shared';
    updateSettings({ muted: false, edition: 'personal', volume: { sfx: 0.9 } });
    setCharacter('emotelab-3f9a1c2e', IDS);
    expect(fake.setCalls.map(([k]) => k)).toEqual(['muted', 'volume.sfx', 'character']);
    expect(fake.data).not.toHaveProperty('edition');
    expect(getEdition()).toBe('shared');
  });
});
