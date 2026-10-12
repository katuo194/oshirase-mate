import { describe, expect, it, vi } from 'vitest';
import { createFakeVoicevox, makeWav } from '../mocks/voicevox/index.js';
import { MAX_VOICE_HOLD_MS } from '../src/main/notificationView.js';
import { SYNTH_TIMEOUT_MS, VOICEVOX_DEFAULTS, VoicevoxError, createVoicevox, normalizeVoicevoxConfig, wavDurationMs } from '../src/main/voicevox.js';

const CONFIG = { speakerId: 3, speedScale: 1.2, pitchScale: 0.05, volumeScale: 1.0 };
const quietLog = () => ({ info: vi.fn(), warn: vi.fn() });

function setup(opts) {
  const vv = createFakeVoicevox(opts);
  const log = quietLog();
  const voicevox = createVoicevox({ fetch: vv.fetch, log });
  const changes = [];
  voicevox.events.on('change', (s) => changes.push(s.status));
  return { vv, voicevox, log, changes };
}

describe('voicevox / 合成リクエストの組み立て（7.2）', () => {
  it('/version で起動確認 → audio_query → synthesis の順に呼び、WAV を返す', async () => {
    const { vv, voicevox } = setup({ wavMs: 1200 });
    const wav = await voicevox.synthesize('予定のお知らせです。10時から、定例 & 会議', CONFIG);

    expect(vv.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /version',
      'GET /speakers',
      'POST /audio_query',
      'POST /synthesis',
    ]);
    const q = vv.callsTo('/audio_query')[0];
    expect(q.query).toEqual({ text: '予定のお知らせです。10時から、定例 & 会議', speaker: '3' }); // 記号も正しくエンコードされる
    expect(vv.callsTo('/synthesis')[0].query).toEqual({ speaker: '3' });
    expect(wavDurationMs(wav)).toBe(1200);
  });

  it('クエリの speedScale / pitchScale / volumeScale を設定値で上書きして synthesis に送る', async () => {
    const { vv, voicevox } = setup();
    await voicevox.synthesize('テスト', CONFIG);
    const body = vv.callsTo('/synthesis')[0].body;
    expect(body).toMatchObject({ speedScale: 1.2, pitchScale: 0.05, volumeScale: 1.0, kana: 'テスト' });
  });

  it('成功すると available（バージョン・話者名つき）になる', async () => {
    const { voicevox, changes } = setup({ version: '0.21.1' });
    await voicevox.synthesize('テスト', CONFIG);
    expect(voicevox.getState()).toEqual({ status: 'available', version: '0.21.1', speakerId: 3, speakerName: 'ずんだもん（ノーマル）' });
    expect(changes).toEqual(['available']);
  });

  it('同じ話者で確認済みなら、2回目からは /speakers を取り直さない', async () => {
    const { vv, voicevox } = setup();
    await voicevox.synthesize('a', CONFIG);
    await voicevox.synthesize('b', CONFIG);
    expect(vv.callsTo('/speakers')).toHaveLength(1);
    expect(vv.callsTo('/version')).toHaveLength(2); // 起動確認は毎回
  });
});

describe('voicevox / 未起動・失敗（サイレントにスキップし、状態で知らせる）', () => {
  it('未起動（接続拒否）なら unavailable で投げ、合成には進まない', async () => {
    const { vv, voicevox, changes, log } = setup({ running: false });
    await expect(voicevox.synthesize('テスト', CONFIG)).rejects.toMatchObject({ name: 'VoicevoxError', kind: 'unavailable' });
    expect(vv.callsTo('/audio_query')).toHaveLength(0);
    expect(voicevox.getState()).toEqual({ status: 'unavailable' });
    expect(changes).toEqual(['unavailable']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('未起動が続いても警告ログ・変化イベントは最初の1回だけ', async () => {
    const { voicevox, changes, log } = setup({ running: false });
    for (let i = 0; i < 3; i++) await voicevox.synthesize('テスト', CONFIG).catch(() => {});
    expect(changes).toEqual(['unavailable']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('後から起動されたら次の読み上げで available に戻る', async () => {
    const { vv, voicevox, changes } = setup({ running: false });
    await voicevox.synthesize('テスト', CONFIG).catch(() => {});
    vv.setRunning(true);
    await voicevox.synthesize('テスト', CONFIG);
    expect(changes).toEqual(['unavailable', 'available']);
  });

  it('起動しているが合成が HTTP エラー（422 など）なら error', async () => {
    const { vv, voicevox } = setup();
    vv.failNext('/audio_query', 422);
    await expect(voicevox.synthesize('テスト', CONFIG)).rejects.toMatchObject({ kind: 'error' });
    expect(voicevox.getState()).toMatchObject({ status: 'error', reason: 'audio_query 422' });
  });

  it('話者IDが存在しなければ error（config.json の確認を促す）', async () => {
    const { voicevox } = setup();
    await expect(voicevox.synthesize('テスト', { ...CONFIG, speakerId: 9999 })).rejects.toMatchObject({ kind: 'error' });
    expect(voicevox.getState().status).toBe('error');
    expect(voicevox.getState().reason).toContain('話者ID 9999');
  });

  it('呼び出し側の中断は aborted で投げ、状態は変えない', async () => {
    const { vv, voicevox, changes } = setup();
    await voicevox.synthesize('warm up', CONFIG);
    const gate = vv.holdSynthesis();
    const controller = new AbortController();
    const p = voicevox.synthesize('テスト', CONFIG, { signal: controller.signal });
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(2));
    controller.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    gate.release();
    expect(changes).toEqual(['available']);
  });
});

describe('voicevox / 1件ずつの合成（VOICEVOX は中断された要求も最後まで合成する）', () => {
  it('待ち時間の上限は表示の上限（MAX_VOICE_HOLD_MS）と同じ', () => {
    expect(SYNTH_TIMEOUT_MS).toBe(MAX_VOICE_HOLD_MS);
  });

  it('合成中に次の要求が来ても、前の合成が終わるまで送らない', async () => {
    const { vv, voicevox } = setup();
    const gate = vv.holdSynthesis();
    const first = voicevox.synthesize('1件目', CONFIG);
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    const second = voicevox.synthesize('2件目', CONFIG);
    await new Promise((r) => setTimeout(r, 20));
    expect(vv.callsTo('/audio_query').map((c) => c.query.text)).toEqual(['1件目']);
    gate.release();
    await first;
    await second;
    expect(vv.callsTo('/audio_query').map((c) => c.query.text)).toEqual(['1件目', '2件目']);
  });

  it('送信済みの合成を中断しても、VOICEVOX 側が終わるまで次の要求は送らない（中断はすぐ返る）', async () => {
    const { vv, voicevox, changes } = setup();
    const gate = vv.holdSynthesis();
    const controller = new AbortController();
    const first = voicevox.synthesize('中断される', CONFIG, { signal: controller.signal });
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    const second = voicevox.synthesize('次の通知', CONFIG);
    controller.abort();
    await expect(first).rejects.toMatchObject({ kind: 'aborted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(vv.callsTo('/audio_query')).toHaveLength(1); // まだ送らない
    gate.release();
    await second;
    expect(vv.callsTo('/audio_query').map((c) => c.query.text)).toEqual(['中断される', '次の通知']);
    expect(changes).toEqual(['available']); // 中断はエラーにしない
  });

  it('順番待ちの間に中断された要求は送らずに取り消す', async () => {
    const { vv, voicevox } = setup();
    const gate = vv.holdSynthesis();
    const first = voicevox.synthesize('1件目', CONFIG);
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(1));
    const controller = new AbortController();
    const queued = voicevox.synthesize('取り消される', CONFIG, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ kind: 'aborted' });
    gate.release();
    await first;
    await voicevox.synthesize('3件目', CONFIG);
    expect(vv.callsTo('/audio_query').map((c) => c.query.text)).toEqual(['1件目', '3件目']);
  });

  it('前の要求が失敗しても、次の要求は送られる', async () => {
    const { vv, voicevox } = setup();
    vv.failNext('/synthesis', 500);
    await expect(voicevox.synthesize('失敗', CONFIG)).rejects.toMatchObject({ kind: 'error' });
    await expect(voicevox.synthesize('成功', CONFIG)).resolves.toBeInstanceOf(Buffer);
  });

  it('合成中の起動確認がタイムアウトしても未起動（unavailable）にしない', async () => {
    const vv = createFakeVoicevox();
    let stallVersion = false;
    const fetch = (url, init) => {
      if (stallVersion && new URL(url).pathname === '/version') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
      return vv.fetch(url, init);
    };
    const voicevox = createVoicevox({ fetch, log: quietLog() });
    await voicevox.synthesize('warm up', CONFIG);
    const gate = vv.holdSynthesis();
    const p = voicevox.synthesize('合成中', CONFIG);
    await vi.waitFor(() => expect(vv.callsTo('/synthesis')).toHaveLength(2));
    stallVersion = true;
    expect(await voicevox.checkStatus({ speakerId: 3 })).toMatchObject({ status: 'available' });
    gate.release();
    await p;
    // 合成していないときのタイムアウトは未起動
    expect(await voicevox.checkStatus({ speakerId: 3 })).toEqual({ status: 'unavailable' });
  });
});

describe('voicevox / 話者の先読み（warmUp）', () => {
  it('起動していれば /initialize_speaker を skip_reinit つきで送る', async () => {
    const { vv, voicevox } = setup();
    expect(await voicevox.warmUp({ speakerId: 3 })).toBe(true);
    expect(vv.callsTo('/initialize_speaker')[0]).toMatchObject({ method: 'POST', query: { speaker: '3', skip_reinit: 'true' } });
  });

  it('未起動なら送らない。話者が無効なら false（状態は checkStatus のまま）', async () => {
    const off = setup({ running: false });
    expect(await off.voicevox.warmUp({ speakerId: 3 })).toBe(false);
    expect(off.vv.callsTo('/initialize_speaker')).toHaveLength(0);

    const bad = setup();
    expect(await bad.voicevox.warmUp({ speakerId: 9999 })).toBe(false);
    expect(bad.vv.callsTo('/initialize_speaker')).toHaveLength(0);
    expect(bad.voicevox.getState().status).toBe('error');
  });

  it('先読みが失敗しても状態を変えない', async () => {
    const { vv, voicevox, changes } = setup();
    vv.failNext('/initialize_speaker', 500);
    expect(await voicevox.warmUp({ speakerId: 3 })).toBe(false);
    expect(changes).toEqual(['available']);
  });

  it('合成と同じ待ち行列に入る（先読みの後に合成を送る）', async () => {
    const { vv, voicevox } = setup();
    const w = voicevox.warmUp({ speakerId: 3 });
    const s = voicevox.synthesize('テスト', CONFIG);
    await w;
    await s;
    const order = vv.calls.map((c) => c.path).filter((p) => p === '/initialize_speaker' || p === '/audio_query');
    expect(order).toEqual(['/initialize_speaker', '/audio_query']);
  });
});

describe('voicevox / checkStatus（設定画面の表示用）', () => {
  it('起動していれば available、していなければ unavailable を返す', async () => {
    const { vv, voicevox } = setup();
    expect(await voicevox.checkStatus({ speakerId: 3 })).toMatchObject({ status: 'available', speakerName: 'ずんだもん（ノーマル）' });
    vv.setRunning(false);
    expect(await voicevox.checkStatus({ speakerId: 3 })).toEqual({ status: 'unavailable' });
  });

  it('起動確認では合成しない', async () => {
    const { vv, voicevox } = setup();
    await voicevox.checkStatus({ speakerId: 3 });
    expect(vv.callsTo('/audio_query')).toHaveLength(0);
  });
});

describe('voicevox / 補助関数', () => {
  it('wavDurationMs：byteRate と data 長から再生時間を求める。WAV でなければ null', () => {
    expect(wavDurationMs(makeWav(2500))).toBe(2500);
    expect(wavDurationMs(makeWav(730, 44100))).toBe(730);
    expect(wavDurationMs(Buffer.from('not a wav file'))).toBeNull();
    expect(wavDurationMs(null)).toBeNull();
  });

  it('normalizeVoicevoxConfig：欠損・範囲外は既定値（6.1）', () => {
    expect(normalizeVoicevoxConfig(undefined)).toEqual(VOICEVOX_DEFAULTS);
    expect(normalizeVoicevoxConfig({ speakerId: 1, speedScale: 1.5, pitchScale: -0.1 })).toEqual({ speakerId: 1, speedScale: 1.5, pitchScale: -0.1 });
    expect(normalizeVoicevoxConfig({ speakerId: '3', speedScale: 9, pitchScale: 'x' })).toEqual(VOICEVOX_DEFAULTS);
  });

  it('VoicevoxError は kind を持つ', () => {
    expect(new VoicevoxError('unavailable', 'x')).toMatchObject({ name: 'VoicevoxError', kind: 'unavailable' });
  });
});
