import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPEAKERS, createFakeVoicevox } from '../mocks/voicevox/index.js';
import { createSpeakerNames, parseSpeakerNames, speakerNameMap, voiceLabel } from '../src/main/speakerNames.js';
import { createVoicevox } from '../src/main/voicevox.js';

const ZUNDA = { speakerId: 3, speedScale: 1.25, pitchScale: -0.03 };
const CONFIG = { speakerId: 2, speedScale: 1, pitchScale: 0 };
const names = new Map([
  [2, '四国めたん（ノーマル）'],
  [3, 'ずんだもん（ノーマル）'],
]);
const nameOf = (id) => names.get(id) ?? null;

describe('speakerNames / 話者一覧 → 名前', () => {
  it('スタイルID → 「話者名（スタイル名）」', () => {
    const m = speakerNameMap([{ name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }, { id: 1, name: 'あまあま' }] }]);
    expect(m.get(3)).toBe('ずんだもん（ノーマル）');
    expect(m.get(1)).toBe('ずんだもん（あまあま）');
  });

  it('保存したファイルの壊れた項目は捨てる', () => {
    const m = parseSpeakerNames({ version: 1, styles: { 3: 'ずんだもん（ノーマル）', x: 'a', 4: '', 5: 'a\nb', 6: 7 } });
    expect([...m]).toEqual([[3, 'ずんだもん（ノーマル）']]);
    expect(parseSpeakerNames({ version: 2, styles: {} }).size).toBe(0);
    expect(parseSpeakerNames(null).size).toBe(0);
  });
});

describe('speakerNames / 選択画面の声の説明（voiceLabel）', () => {
  it('キャラクターの声の名前を出す。声が未設定なら config.json の声に「（既定の声）」を付ける', () => {
    expect(voiceLabel({ voice: ZUNDA, defaultVoice: CONFIG, nameOf })).toBe('声：ずんだもん（ノーマル）');
    expect(voiceLabel({ voice: null, defaultVoice: CONFIG, nameOf })).toBe('声：四国めたん（ノーマル）（既定の声）');
  });

  it('同梱キャラクターで録音と同じ声なら「録音あり」。名前を覚えていなければクレジットの話者名を使う', () => {
    const recorded = { voice: ZUNDA, credit: 'VOICEVOX:ずんだもん' };
    expect(voiceLabel({ voice: ZUNDA, defaultVoice: CONFIG, nameOf, recorded })).toBe('声：ずんだもん（ノーマル）・録音あり');
    expect(voiceLabel({ voice: ZUNDA, defaultVoice: CONFIG, nameOf: () => null, recorded })).toBe('声：ずんだもん・録音あり');
  });

  it('声を変えた同梱キャラクターは録音なし。名前が分からなければ番号で出す', () => {
    const recorded = { voice: ZUNDA, credit: 'VOICEVOX:ずんだもん' };
    const changed = { speakerId: 113, speedScale: 1.25, pitchScale: -0.03 };
    expect(voiceLabel({ voice: changed, defaultVoice: CONFIG, nameOf, recorded })).toBe('声：話者 113');
  });
});

describe('speakerNames / 覚えておく（実ファイル）', () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mascot-speakers-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const setup = (running = true) => {
    const vv = createFakeVoicevox({ running });
    const voicevox = createVoicevox({ fetch: vv.fetch, log: { info: vi.fn(), warn: vi.fn() } });
    const filePath = path.join(dir, 'voicevox-speakers.json');
    return { vv, filePath, create: () => createSpeakerNames({ filePath, fs, listSpeakers: () => voicevox.listSpeakers() }) };
  };

  it('VOICEVOX から一覧を取れたら名前を覚えてファイルに保存し、次に起動したとき止まっていても名前が分かる', async () => {
    const { vv, filePath, create } = setup();
    const a = create();
    expect(await a.refresh()).toBe(true);
    expect(a.nameOf(3)).toBe(`${SPEAKERS[1].name}（ノーマル）`);
    expect(await a.refresh()).toBe(false); // 同じなら書き込まない
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).version).toBe(1);

    vv.setRunning(false);
    const b = create();
    expect(await b.refresh()).toBe(false);
    expect(b.nameOf(3)).toBe(`${SPEAKERS[1].name}（ノーマル）`);
    expect(b.nameOf(999)).toBeNull();
  });

  it('一度も取れていなければ名前は分からない（ファイルが無くても落ちない）', async () => {
    const { create } = setup(false);
    const s = create();
    await s.load();
    expect(await s.refresh()).toBe(false);
    expect(s.nameOf(3)).toBeNull();
  });

  it('remember：作成画面で取った一覧も覚える', async () => {
    const { create } = setup(false);
    const s = create();
    expect(await s.remember([{ name: 'あんこもん', styles: [{ id: 113, name: 'ノーマル' }] }])).toBe(true);
    expect(s.nameOf(113)).toBe('あんこもん（ノーマル）');
  });
});
