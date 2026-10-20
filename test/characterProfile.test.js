import { describe, expect, it, vi } from 'vitest';
import { createFakeVoicevox } from '../mocks/voicevox/index.js';
import {
  PERSONA_MAX,
  parseDefaultProfile,
  parsePersona,
  parseVoice,
  resolveVoiceConfig,
  validateCharacterProfile,
  validatePersona,
  validateVoice,
} from '../src/main/characterProfile.js';
import { SYSTEM_PROMPT, buildSystemPrompt } from '../src/main/chatPersona.js';
import { emptyLines } from '../src/main/characterLines.js';
import { createChatSession } from '../src/main/gemini.js';
import { VoicevoxError, createVoicevox } from '../src/main/voicevox.js';

describe('characterProfile / 声（voice）', () => {
  it('話者ID・話速・音高を検証し、0.01刻みに丸める', () => {
    expect(validateVoice({ speakerId: 3, speedScale: 1.2345, pitchScale: -0.051 })).toEqual({
      ok: true,
      value: { speakerId: 3, speedScale: 1.23, pitchScale: -0.05 },
    });
    expect(validateVoice({ speakerId: 0 })).toEqual({ ok: true, value: { speakerId: 0, speedScale: 1, pitchScale: 0 } });
  });

  it('未設定（null / undefined）は null＝config.json の声', () => {
    expect(validateVoice(null)).toEqual({ ok: true, value: null });
    expect(validateVoice(undefined)).toEqual({ ok: true, value: null });
  });

  it('範囲外・不正な型は invalid_voice', () => {
    const bad = [
      { speakerId: -1 },
      { speakerId: 1.5 },
      { speakerId: '3' },
      { speakerId: 3, speedScale: 0.4 },
      { speakerId: 3, speedScale: 2.1 },
      { speakerId: 3, pitchScale: 0.2 },
      { speakerId: 3, pitchScale: NaN },
      [],
      3,
    ];
    for (const v of bad) expect(validateVoice(v)).toEqual({ ok: false, error: { code: 'invalid_voice' } });
  });

  it('保存済みの値が壊れていれば null（config.json の声にフォールバック）', () => {
    expect(parseVoice({ speakerId: 'x' })).toBeNull();
    expect(parseVoice({ speakerId: 2, speedScale: 1, pitchScale: 0 })).toEqual({ speakerId: 2, speedScale: 1, pitchScale: 0 });
  });

  it('実際に使う声：キャラクターの声、未設定なら config.json の voicevox', () => {
    const global = { speakerId: 3, speedScale: 1.0, pitchScale: 0.0 };
    expect(resolveVoiceConfig(null, global)).toEqual(global);
    expect(resolveVoiceConfig({ speakerId: 8, speedScale: 1.3, pitchScale: 0.1 }, global)).toEqual({ speakerId: 8, speedScale: 1.3, pitchScale: 0.1 });
    expect(resolveVoiceConfig(null, global)).not.toBe(global); // 呼び出し側が書き換えても元の設定を壊さない
  });
});

describe('characterProfile / キャラクター設定（persona）', () => {
  it('前後の空白を除き、改行を LF にそろえ、制御文字を取り除く', () => {
    expect(validatePersona('  一人称は「わたし」。\r\n語尾は「〜だよ」。\u0007 ')).toEqual({ ok: true, value: '一人称は「わたし」。\n語尾は「〜だよ」。' });
    expect(validatePersona(undefined)).toEqual({ ok: true, value: '' });
  });

  it('1000文字まで（絵文字などのサロゲートペアも1文字）', () => {
    expect(validatePersona('あ'.repeat(PERSONA_MAX)).ok).toBe(true);
    expect(validatePersona('🌙'.repeat(PERSONA_MAX)).ok).toBe(true);
    expect(validatePersona('あ'.repeat(PERSONA_MAX + 1))).toEqual({ ok: false, error: { code: 'invalid_persona' } });
    expect(validatePersona(42)).toEqual({ ok: false, error: { code: 'invalid_persona' } });
  });

  it('保存済みの値が壊れていれば空文字', () => {
    expect(parsePersona(42)).toBe('');
    expect(parsePersona('あ'.repeat(PERSONA_MAX + 1))).toBe('');
  });

  it('既定キャラクターの default-profile.json', () => {
    expect(parseDefaultProfile(null)).toEqual({ voice: null, persona: '', lines: emptyLines() });
    expect(parseDefaultProfile({ voice: { speakerId: 1 }, persona: '丸い', extra: 1 })).toEqual({
      voice: { speakerId: 1, speedScale: 1, pitchScale: 0 },
      persona: '丸い',
      lines: emptyLines(),
    });
    // セリフ（Phase 13）：壊れた行だけを捨てる
    const lines = parseDefaultProfile({ lines: { notify: { tasks: ['やることだよ。{title}', 42, '{nope}{title}'] } } }).lines;
    expect(lines.notify.tasks).toEqual(['やることだよ。{title}']);
  });
});

describe('chatPersona / buildSystemPrompt（キャラクターごとの人格。3.5）', () => {
  it('既定キャラクターで設定が空なら、従来のプロンプトそのまま', () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({ builtin: true, persona: '   ' })).toBe(SYSTEM_PROMPT);
  });

  it('取り込んだキャラクターで設定が空なら、名前だけ差し替えて従来の話し方（黄色い丸とは言わない）', () => {
    const p = buildSystemPrompt({ builtin: false, displayName: '星空寝夢', persona: '' });
    expect(p).toContain('「星空寝夢」');
    expect(p).not.toContain('黄色い丸');
    expect(p).toContain('一人称（ぼく・わたし等）や自分の名前は使わない');
    expect(p).toContain('返答は1〜3文');
  });

  it('設定があれば設定を入れ、口調の既定（一人称なし）は外す。共通ルールと注意は設定より優先として残す', () => {
    const p = buildSystemPrompt({ builtin: false, displayName: '星空寝夢', persona: '一人称は「わたし」。' });
    expect(p).toContain('<character>\n一人称は「わたし」。\n</character>');
    expect(p).not.toContain('一人称（ぼく・わたし等）や自分の名前は使わない');
    expect(p).toContain('# 話し方（キャラクター設定より優先）');
    expect(p).toContain('返答は1〜3文');
    expect(p).toContain('Markdown');
    expect(p).toContain('# 注意（キャラクター設定より優先）');
    expect(p).toContain('ユーザーの予定・メール・TODOの中身を知らない');
    expect(p).toContain('危険なこと');
  });

  it('既定キャラクターに設定を書いた場合は、黄色い丸のまま設定を使う', () => {
    const p = buildSystemPrompt({ builtin: true, persona: '関西弁で話す' });
    expect(p).toContain('黄色い丸');
    expect(p).toContain('関西弁で話す');
  });
});

describe('gemini / 会話ごとのシステムプロンプト（v5.9）', () => {
  function fakeClient() {
    const calls = [];
    return { calls, generate: async (req) => (calls.push(req.systemPrompt), 'ok') };
  }

  it('会話の開始時（作成・reset）に確定し、会話の途中でキャラクターが変わっても混ざらない', async () => {
    let current = 'A';
    const getSystemPrompt = vi.fn(() => `PROMPT-${current}`);
    const client = fakeClient();
    const s = createChatSession({ client, getSystemPrompt });
    await s.send('1');
    current = 'B'; // 会話の途中でキャラクターを変えた
    await s.send('2');
    expect(client.calls).toEqual(['PROMPT-A', 'PROMPT-A']);
    s.reset(); // 次の会話
    await s.send('3');
    expect(client.calls[2]).toBe('PROMPT-B');
  });

  it('getSystemPrompt が無ければ従来どおり固定のプロンプト', async () => {
    const client = fakeClient();
    const s = createChatSession({ client, systemPrompt: 'FIXED' });
    s.reset();
    await s.send('1');
    expect(client.calls).toEqual(['FIXED']);
  });
});

describe('voicevox / listSpeakers（キャラクターの声の選択。mocks/voicevox）', () => {
  it('話者とスタイルの一覧を返す', async () => {
    const vv = createFakeVoicevox();
    const voicevox = createVoicevox({ fetch: vv.fetch, log: { info: vi.fn(), warn: vi.fn() } });
    expect(await voicevox.listSpeakers()).toEqual([
      { name: '四国めたん', styles: [{ id: 2, name: 'ノーマル' }] },
      { name: 'ずんだもん', styles: [{ id: 3, name: 'ノーマル' }, { id: 1, name: 'あまあま' }] },
    ]);
    expect(vv.callsTo('/speakers')).toHaveLength(1);
  });

  it('未起動なら VoicevoxError（unavailable）', async () => {
    const vv = createFakeVoicevox({ running: false });
    const voicevox = createVoicevox({ fetch: vv.fetch, log: { info: vi.fn(), warn: vi.fn() } });
    const err = await voicevox.listSpeakers().catch((e) => e);
    expect(err).toBeInstanceOf(VoicevoxError);
    expect(err.kind).toBe('unavailable');
  });
});

describe('characterProfile / 声・キャラクター設定・セリフをまとめて検証（validateCharacterProfile）', () => {
  it('正しければ整えた値を返す（取り込み・既定・同梱キャラクターの保存で共通）', () => {
    const r = validateCharacterProfile({ voice: { speakerId: 2, speedScale: 1.234 }, persona: ' 静か ', lines: { idle: { normal: 'ひまだね\n\n' } } });
    expect(r).toMatchObject({ ok: true, voice: { speakerId: 2, speedScale: 1.23, pitchScale: 0 }, persona: '静か' });
    expect(r.lines.idle.normal).toEqual(['ひまだね']);
  });

  it('どれかが不正なら、その項目のエラーを返す', () => {
    expect(validateCharacterProfile({ voice: { speakerId: -1 } })).toEqual({ ok: false, error: { code: 'invalid_voice' } });
    expect(validateCharacterProfile({ persona: 'あ'.repeat(PERSONA_MAX + 1) })).toEqual({ ok: false, error: { code: 'invalid_persona' } });
    expect(validateCharacterProfile({ lines: { idle: { normal: '{title}' } } }).error.code).toBe('lines_unknown_placeholder');
  });
});
