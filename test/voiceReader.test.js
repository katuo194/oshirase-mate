import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeVoicevox } from '../mocks/voicevox/index.js';
import { clipFileName, createFixedVoice, parseVoiceIndex } from '../src/main/fixedVoice.js';
import { createVoiceReader } from '../src/main/voiceReader.js';
import { createVoicevox } from '../src/main/voicevox.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-tts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup({ muted = false, voice = 1.0, running = true, fixedVoice = null, voiceConfig = { speakerId: 3, speedScale: 1.0, pitchScale: 0.0 } } = {}) {
  const vv = createFakeVoicevox({ running, wavMs: 1800 });
  const log = { info: vi.fn(), warn: vi.fn() };
  const settings = { muted, volume: { sfx: 0.8, voice } };
  let seq = 0;
  const reader = createVoiceReader({
    voicevox: createVoicevox({ fetch: vv.fetch, log }),
    getSettings: () => settings,
    getVoiceConfig: () => voiceConfig,
    dir: path.join(dir, 'tts'),
    fs: fsp,
    toUrl: (p) => `file://${p}`,
    randomId: () => `voice${++seq}`,
    getFixedVoice: () => fixedVoice,
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

describe('voiceReader / 同梱キャラクターの固定ボイス（F-23）', () => {
  const VOICE = { speakerId: 3, speedScale: 1.0, pitchScale: 0.0 };
  const recorded = ['おはようなのだ', '予定の時間なのだ'];
  /** 録音のフォルダ（同梱のファイル。cancel で消えてはいけない） */
  function fixedVoiceIn(voiceDir) {
    fs.mkdirSync(voiceDir, { recursive: true });
    for (const t of recorded) fs.writeFileSync(path.join(voiceDir, clipFileName(t, VOICE)), 'wav');
    const index = parseVoiceIndex({
      version: 1,
      voice: VOICE,
      clips: Object.fromEntries(recorded.map((t) => [t, { file: clipFileName(t, VOICE), durationMs: 1100 }])),
    });
    return createFixedVoice({ index, dir: voiceDir, fallbackLines: { calendar: ['予定の時間なのだ'] } });
  }

  it('読み上げる文の録音があれば、VOICEVOX に問い合わせずに録音を流す（起動していても）', async () => {
    const voiceDir = path.join(dir, 'voice');
    const { reader, vv, files } = setup({ voice: 0.6, fixedVoice: fixedVoiceIn(voiceDir) });
    const v = await reader.prepare('idle1', 'おはようなのだ');
    expect(v).toEqual({ url: `file://${path.join(voiceDir, clipFileName('おはようなのだ', VOICE))}`, filePath: null, durationMs: 1100, volume: 0.6 });
    expect(vv.calls).toEqual([]);
    expect(files()).toEqual([]); // tts/ にファイルを作らない
    expect(reader.currentId()).toBe('idle1');
  });

  it('表示が終わっても（cancel）同梱の録音は消さない', async () => {
    const voiceDir = path.join(dir, 'voice');
    const { reader } = setup({ fixedVoice: fixedVoiceIn(voiceDir) });
    await reader.prepare('idle1', 'おはようなのだ');
    reader.cancel('idle1');
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(voiceDir)).toHaveLength(recorded.length);
    expect(reader.currentId()).toBeNull();
  });

  it('録音の無い文は VOICEVOX で合成する', async () => {
    const { reader, vv } = setup({ fixedVoice: fixedVoiceIn(path.join(dir, 'voice')) });
    const v = await reader.prepare('n1', '10時から会議なのだ', { speechKind: 'calendar' });
    expect(v.url).toBe(`file://${path.join(dir, 'tts', 'voice1.wav')}`);
    expect(vv.callsTo('/synthesis')).toHaveLength(1);
  });

  it('VOICEVOX が無ければ、通知は種類ごとの件名なしの録音で代わりに読み上げる', async () => {
    const voiceDir = path.join(dir, 'voice');
    const { reader, files } = setup({ running: false, fixedVoice: fixedVoiceIn(voiceDir) });
    const v = await reader.prepare('n1', '10時から会議なのだ', { speechKind: 'calendar' });
    expect(v).toMatchObject({ url: `file://${path.join(voiceDir, clipFileName('予定の時間なのだ', VOICE))}`, filePath: null, durationMs: 1100 });
    expect(files()).toEqual([]);
  });

  it('合成に失敗した（VOICEVOX のエラー）ときも件名なしの録音を使う', async () => {
    const { reader, vv } = setup({ fixedVoice: fixedVoiceIn(path.join(dir, 'voice')) });
    vv.failNext('/synthesis', 500);
    const v = await reader.prepare('n1', '10時から会議なのだ', { speechKind: 'calendar' });
    expect(v?.durationMs).toBe(1100);
  });

  it('種類の文が無い・アイドルトーク（speechKind なし）・同梱キャラクターでないときは、今までどおり読み上げない', async () => {
    {
      const { reader } = setup({ running: false, fixedVoice: fixedVoiceIn(path.join(dir, 'voice')) });
      expect(await reader.prepare('n1', 'メールなのだ', { speechKind: 'gmail' })).toBeNull();
      expect(await reader.prepare('idle1', 'ひまなのだ')).toBeNull();
    }
    const { reader } = setup({ running: false });
    expect(await reader.prepare('n2', '会議なのだ', { speechKind: 'calendar' })).toBeNull();
  });

  it('利用者が声を変えていれば録音を使わない（合成する。合成できなければ読み上げない）', async () => {
    const changed = { speakerId: 1, speedScale: 1.0, pitchScale: 0.0 };
    {
      const { reader, vv } = setup({ voiceConfig: changed, fixedVoice: fixedVoiceIn(path.join(dir, 'voice')) });
      expect((await reader.prepare('idle1', 'おはようなのだ')).filePath).not.toBeNull();
      expect(vv.callsTo('/synthesis')).toHaveLength(1);
    }
    const { reader } = setup({ running: false, voiceConfig: changed, fixedVoice: fixedVoiceIn(path.join(dir, 'voice2')) });
    expect(await reader.prepare('n1', '会議なのだ', { speechKind: 'calendar' })).toBeNull();
  });

  it('ミュート中は録音も流さない。合成中に表示が終わったら、代わりの録音も流さない', async () => {
    {
      const { reader } = setup({ muted: true, fixedVoice: fixedVoiceIn(path.join(dir, 'voice')) });
      expect(await reader.prepare('idle1', 'おはようなのだ')).toBeNull();
    }
    const { reader, vv } = setup({ fixedVoice: fixedVoiceIn(path.join(dir, 'voice2')) });
    const gate = vv.holdSynthesis();
    const p = reader.prepare('n1', '会議なのだ', { speechKind: 'calendar' });
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    reader.cancel('n1');
    expect(await p).toBeNull();
    gate.release();
  });
});
