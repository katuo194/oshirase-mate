import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeVoicevox } from '../mocks/voicevox/index.js';
import { createVoiceReader } from '../src/main/voiceReader.js';
import { createVoicevox } from '../src/main/voicevox.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-tts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup({ muted = false, voice = 1.0, running = true } = {}) {
  const vv = createFakeVoicevox({ running, wavMs: 1800 });
  const log = { info: vi.fn(), warn: vi.fn() };
  const settings = { muted, volume: { sfx: 0.8, voice } };
  let seq = 0;
  const reader = createVoiceReader({
    voicevox: createVoicevox({ fetch: vv.fetch, log }),
    getSettings: () => settings,
    getVoiceConfig: () => ({ speakerId: 3, speedScale: 1.0, pitchScale: 0.0 }),
    dir: path.join(dir, 'tts'),
    fs: fsp,
    toUrl: (p) => `file://${p}`,
    randomId: () => `voice${++seq}`,
    log,
  });
  const files = () => (fs.existsSync(path.join(dir, 'tts')) ? fs.readdirSync(path.join(dir, 'tts')) : []);
  return { vv, reader, settings, log, files };
}

describe('voiceReader / 読み上げの準備（F-13）', () => {
  it('合成して tts/ に一意名で保存し、URL・長さ・ボイス音量を返す', async () => {
    const { reader, files } = setup({ voice: 0.7 });
    const v = await reader.prepare('n1', '予定のお知らせです');
    expect(v).toMatchObject({ durationMs: 1800, volume: 0.7 });
    expect(v.url).toBe(`file://${path.join(dir, 'tts', 'voice1.wav')}`);
    expect(files()).toEqual(['voice1.wav']);
  });

  it('表示が終わったら（cancel）ファイルを削除する', async () => {
    const { reader, files } = setup();
    await reader.prepare('n1', 'テスト');
    reader.cancel('n1');
    await vi.waitFor(() => expect(files()).toEqual([]));
    expect(reader.currentId()).toBeNull();
  });

  it('VOICEVOX 未起動ならサイレントに null（ファイルも作らない）', async () => {
    const { reader, files, log } = setup({ running: false });
    expect(await reader.prepare('n1', 'テスト')).toBeNull();
    expect(files()).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1); // voicevox.js の「見つかりません」1回だけ
  });

  it('ボイス音量0・読み上げ文なしでは合成しない', async () => {
    {
      const { reader, vv } = setup({ voice: 0 });
      expect(await reader.prepare('n1', 'テスト')).toBeNull();
      expect(vv.calls).toEqual([]);
    }
    const { reader, vv } = setup();
    expect(await reader.prepare('n1', null)).toBeNull();
    expect(vv.calls).toEqual([]);
  });

  it('willSpeak は prepare が合成に進むかを返す（表示側が音声を待つかの判定。通信しない）', () => {
    expect(setup().reader.willSpeak('テスト')).toBe(true);
    expect(setup({ running: false }).reader.willSpeak('テスト')).toBe(true); // 未起動は合成を試みて null で分かる
    for (const opts of [{ voice: 0 }, { muted: true }]) {
      const { reader, vv } = setup(opts);
      expect(reader.willSpeak('テスト')).toBe(false);
      expect(vv.calls).toEqual([]);
    }
    expect(setup().reader.willSpeak(null)).toBe(false);
    expect(setup().reader.willSpeak('  ')).toBe(false);
  });
});

describe('voiceReader / 版によらない（v5.11：判定は VOICEVOX への疎通確認だけ）', () => {
  it('createVoiceReader は edition を受け取らず、渡しても読み上げの可否に影響しない', async () => {
    const vv = createFakeVoicevox({ running: true, wavMs: 1200 });
    const reader = createVoiceReader({
      voicevox: createVoicevox({ fetch: vv.fetch, log: { info() {}, warn() {} } }),
      getSettings: () => ({ muted: false, volume: { sfx: 0.8, voice: 1.0 } }),
      getVoiceConfig: () => ({ speakerId: 3, speedScale: 1.0, pitchScale: 0.0 }),
      getEdition: () => 'shared', // 旧インターフェース。無視される
      dir: path.join(dir, 'tts'),
      fs: fsp,
      toUrl: (p) => `file://${p}`,
      randomId: () => 'shared1',
      log: { info() {}, warn() {} },
    });
    expect(reader.willSpeak('テスト')).toBe(true);
    expect(await reader.prepare('n1', 'テスト')).toMatchObject({ durationMs: 1200 });
  });

  it('VOICEVOX が起動していなければ（版に関係なく）読み上げはスキップされる', async () => {
    const { reader } = setup({ running: false });
    expect(reader.willSpeak('テスト')).toBe(true); // 可否は合成時の起動確認で決まる
    expect(await reader.prepare('n1', 'テスト')).toBeNull();
  });
});

describe('voiceReader / ミュート（3.7：破棄し、解除後にまとめて再生しない）', () => {
  it('ミュート中に発生した読み上げは合成しない', async () => {
    const { reader, vv } = setup({ muted: true });
    expect(await reader.prepare('n1', 'テスト')).toBeNull();
    expect(vv.calls).toEqual([]);
  });

  it('合成中にミュートされたら、完了時に破棄する（ファイルを作らない）', async () => {
    const { reader, vv, settings, files } = setup();
    const gate = vv.holdSynthesis();
    const p = reader.prepare('n1', 'テスト');
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    settings.muted = true;
    gate.release();
    expect(await p).toBeNull();
    expect(files()).toEqual([]);
  });

  it('ミュート解除後に、ミュート中の読み上げが再生されることはない（待ち行列を持たない）', async () => {
    const { reader, vv, settings } = setup({ muted: true });
    await reader.prepare('n1', 'ミュート中の1件目');
    await reader.prepare('n2', 'ミュート中の2件目');
    settings.muted = false;
    expect(reader.currentId()).toBeNull(); // 保留中の読み上げは何もない
    expect(vv.callsTo('/synthesis')).toHaveLength(0);
    // 解除後の新しい通知だけが読み上げられる
    const v = await reader.prepare('n3', '解除後の通知');
    expect(v).not.toBeNull();
    expect(vv.callsTo('/audio_query').map((c) => c.query.text)).toEqual(['解除後の通知']);
  });
});

describe('voiceReader / 中断・掃除', () => {
  it('合成中に表示が終わったら（cancel）合成を中断し、null を返す', async () => {
    const { reader, vv, files } = setup();
    const gate = vv.holdSynthesis();
    const p = reader.prepare('n1', 'テスト');
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    reader.cancel('n1');
    expect(await p).toBeNull();
    gate.release();
    expect(files()).toEqual([]);
  });

  it('別の id の cancel は無視する', async () => {
    const { reader, files } = setup();
    await reader.prepare('n1', 'テスト');
    reader.cancel('other');
    expect(files()).toEqual(['voice1.wav']);
  });

  it('cleanupDir() は tts/ に残った .wav だけを消す', async () => {
    const { reader } = setup();
    fs.mkdirSync(path.join(dir, 'tts'));
    fs.writeFileSync(path.join(dir, 'tts', 'old1.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'tts', 'old2.wav'), 'x');
    fs.writeFileSync(path.join(dir, 'tts', 'keep.txt'), 'x');
    expect(await reader.cleanupDir()).toBe(2);
    expect(fs.readdirSync(path.join(dir, 'tts'))).toEqual(['keep.txt']);
  });

  it('cleanupDir() は tts/ が無くても落ちない', async () => {
    const { reader } = setup();
    expect(await reader.cleanupDir()).toBe(0);
  });
});
