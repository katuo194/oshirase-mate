import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_COUNT_MAX, createBundledCharacters, parseBundledManifest, parseFallbackLines, profileFileName } from '../src/main/bundledCharacters.js';
import { emptyLines } from '../src/main/characterLines.js';
import { clipFileName } from '../src/main/fixedVoice.js';

const VOICE = { speakerId: 3, speedScale: 1, pitchScale: 0 };

function rawManifest(overrides = {}) {
  return {
    version: 1,
    id: 'bundled-boy',
    displayName: '男の子',
    canvasSize: 400,
    updatedAt: '2026-10-20T00:00:00.000Z',
    slots: { rest: { fps: 30 }, notify: { fps: 24 }, 'notify.calendar': { fps: 30 }, 'notify.tasks': null, 'notify.gmail': { fps: 30 } },
    voice: VOICE,
    voiceCredit: 'VOICEVOX:ずんだもん',
    persona: '元気な男の子。語尾は「〜なのだ」。',
    lines: { idle: { morning: ['おはようなのだ'] } },
    fallbackLines: { calendar: ['予定の時間なのだ'] },
    ...overrides,
  };
}

const FRAMES = { rest: 3, notify: 2, 'notify.calendar': null, 'notify.tasks': null, 'notify.gmail': 4 };

describe('bundledCharacters / manifest.json の読み込み', () => {
  it('取り込んだキャラクターと同じ形（スロットは枚数つき）に揃え、声・クレジット・件名なしの文を持つ', () => {
    const m = parseBundledManifest(rawManifest(), 'bundled-boy', FRAMES);
    expect(m).toMatchObject({ id: 'bundled-boy', displayName: '男の子', canvasSize: 400, voice: VOICE, voiceCredit: 'VOICEVOX:ずんだもん' });
    expect(m.slots).toEqual({
      rest: { folder: 'rest', frameCount: 3, fps: 30 },
      notify: { folder: 'notify', frameCount: 2, fps: 24 },
      'notify.calendar': null, // manifest にあっても画像が無ければ未設定
      'notify.tasks': null,
      'notify.gmail': { folder: 'notify-gmail', frameCount: 4, fps: 30 },
    });
    expect(m.lines.idle.morning).toEqual(['おはようなのだ']);
    expect(m.fallbackLines.calendar).toEqual(['予定の時間なのだ']);
    expect(m.fallbackLines.gmail).toEqual([]);
  });

  it('必須のモーション（rest・notify）の画像が無ければ null（一覧に出さない）', () => {
    expect(parseBundledManifest(rawManifest(), 'bundled-boy', { ...FRAMES, rest: null })).toBeNull();
    expect(parseBundledManifest(rawManifest(), 'bundled-boy', { ...FRAMES, notify: null })).toBeNull();
  });

  it('id・version・名前・キャンバスが違えば null', () => {
    expect(parseBundledManifest(rawManifest(), 'bundled-girl', FRAMES)).toBeNull();
    expect(parseBundledManifest(rawManifest({ id: 'emotelab-12345678' }), 'emotelab-12345678', FRAMES)).toBeNull(); // 同梱の ID ではない
    expect(parseBundledManifest(rawManifest({ version: 2 }), 'bundled-boy', FRAMES)).toBeNull();
    expect(parseBundledManifest(rawManifest({ displayName: '' }), 'bundled-boy', FRAMES)).toBeNull();
    expect(parseBundledManifest(rawManifest({ canvasSize: 800 }), 'bundled-boy', FRAMES)).toBeNull();
  });

  it('壊れた声・クレジットは未設定として読む', () => {
    const m = parseBundledManifest(rawManifest({ voice: { speakerId: -1 }, voiceCredit: 'a\nb' }), 'bundled-boy', FRAMES);
    expect(m.voice).toBeNull();
    expect(m.voiceCredit).toBeNull();
  });

  it('件名なしの文：差し込み入り・長すぎる・文字列でない文は捨て、種類ごとに上限まで', () => {
    const many = Array.from({ length: FALLBACK_COUNT_MAX + 2 }, (_, i) => `文${i}`);
    const f = parseFallbackLines({ calendar: ['{title}なのだ', 'あ'.repeat(31), 3, ' 予定なのだ '], tasks: many, gmail: 'x' });
    expect(f.calendar).toEqual(['予定なのだ']);
    expect(f.tasks).toHaveLength(FALLBACK_COUNT_MAX);
    expect(f.gmail).toEqual([]);
    expect(f.calendarAllDay).toEqual([]);
  });
});

describe('bundledCharacters / 読み込み・編集の保存（実ファイル）', () => {
  let tmp;
  let assetsDir;
  let profileDir;
  let log;

  /** assets/characters/<id>/ に manifest と連番のファイルを置く（中身は検査しない：PNG の決まりは bundle:check と check-dist で確かめる） */
  async function placeCharacter(id, { manifest = rawManifest({ id }), frames = { rest: 3, notify: 2 } } = {}) {
    const dir = path.join(assetsDir, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [folder, n] of Object.entries(frames)) {
      await fs.mkdir(path.join(dir, folder), { recursive: true });
      for (let i = 0; i < n; i++) await fs.writeFile(path.join(dir, folder, `${String(i).padStart(3, '0')}.png`), 'x');
    }
  }

  const repo = () => createBundledCharacters({ assetsDir, profileDir, fs, log });

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mascot-bundled-'));
    assetsDir = path.join(tmp, 'assets');
    profileDir = path.join(tmp, 'userData', 'characters');
    log = { info: vi.fn(), warn: vi.fn() };
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('画像のそろったキャラクターだけを、決まった順で一覧に出す（無い理由のログは1回だけ）', async () => {
    await placeCharacter('bundled-girl', { manifest: rawManifest({ id: 'bundled-girl', displayName: '女の子' }) });
    await placeCharacter('bundled-boy', { frames: { rest: 3 } }); // notify が無い
    const r = repo();
    expect((await r.list()).map((c) => c.id)).toEqual(['bundled-girl']);
    await r.list();
    expect(log.info.mock.calls.filter(([m]) => m.includes('bundled-boy'))).toHaveLength(1);

    await placeCharacter('bundled-boy');
    expect((await r.list()).map((c) => c.id)).toEqual(['bundled-boy', 'bundled-girl']);
  });

  it('連番が欠けていれば、そのモーションの画像は無いものとして扱う', async () => {
    await placeCharacter('bundled-boy');
    await fs.rm(path.join(assetsDir, 'bundled-boy', 'rest', '001.png'));
    expect(await repo().get('bundled-boy')).toBeNull();
  });

  it('編集していなければ同梱の値（customized: false）。保存すると userData に書き、同梱の値の上に重ねる', async () => {
    await placeCharacter('bundled-boy');
    const r = repo();
    const before = await r.get('bundled-boy');
    expect(before).toMatchObject({ customized: false, voice: VOICE, persona: rawManifest().persona });
    expect(before.slots.rest.frameCount).toBe(3);

    const lines = emptyLines();
    lines.idle.normal = ['ひまなのだ'];
    const saved = await r.saveProfile('bundled-boy', { voice: { speakerId: 1, speedScale: 1.2, pitchScale: 0 }, persona: '静か', lines });
    expect(saved.ok).toBe(true);
    const file = JSON.parse(await fs.readFile(path.join(profileDir, profileFileName('bundled-boy')), 'utf8'));
    expect(file).toEqual({ voice: { speakerId: 1, speedScale: 1.2, pitchScale: 0 }, persona: '静か', lines: saved.profile.lines });

    const after = await r.get('bundled-boy');
    expect(after).toMatchObject({ customized: true, displayName: '男の子', voice: { speakerId: 1, speedScale: 1.2, pitchScale: 0 }, persona: '静か' });
    expect(after.lines.idle.normal).toEqual(['ひまなのだ']);
    expect(after.defaults).toMatchObject({ voice: VOICE, persona: rawManifest().persona }); // 同梱の値は残っている
    expect(after.fallbackLines.calendar).toEqual(['予定の時間なのだ']); // 件名なしの文は編集の対象外
  });

  it('不正な入力は保存しない（セリフのエラーは種類と行番号つき）', async () => {
    await placeCharacter('bundled-boy');
    const r = await repo().saveProfile('bundled-boy', { voice: null, persona: '', lines: { idle: { normal: 'よい\n{title}' } } });
    expect(r).toMatchObject({ ok: false, error: { code: 'lines_unknown_placeholder', group: 'idle', kind: 'normal', line: 2 } });
    await expect(fs.access(path.join(profileDir, profileFileName('bundled-boy')))).rejects.toThrow();
  });

  it('同梱の状態に戻すと userData のファイルを消し、同梱の値に戻る', async () => {
    await placeCharacter('bundled-boy');
    const r = repo();
    await r.saveProfile('bundled-boy', { voice: null, persona: '静か', lines: null });
    const reset = await r.resetProfile('bundled-boy');
    expect(reset.ok).toBe(true);
    expect(reset.character).toMatchObject({ customized: false, voice: VOICE, persona: rawManifest().persona });
    await expect(fs.access(path.join(profileDir, profileFileName('bundled-boy')))).rejects.toThrow();
  });

  it('同梱でない・画像の無いキャラクターは保存も戻しもしない', async () => {
    const r = repo();
    expect(await r.saveProfile('bundled-boy', { persona: 'x' })).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await r.saveProfile('emotelab-12345678', { persona: 'x' })).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await r.resetProfile('default')).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await r.get('../bundled-boy')).toBeNull();
  });

  it('壊れた userData のファイルは無いものとして同梱の値を使う', async () => {
    await placeCharacter('bundled-boy');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(path.join(profileDir, profileFileName('bundled-boy')), '{');
    expect(await repo().get('bundled-boy')).toMatchObject({ customized: false, persona: rawManifest().persona });
  });

  it('固定ボイス：voice/voices.json があれば読み、録音のフォルダの中のファイルを指す。無ければ null', async () => {
    await placeCharacter('bundled-boy');
    const r = repo();
    const character = await r.get('bundled-boy');
    expect(await r.loadFixedVoice(character)).toBeNull();

    const voiceDir = path.join(assetsDir, 'bundled-boy', 'voice');
    await fs.mkdir(voiceDir);
    const file = clipFileName('予定の時間なのだ', VOICE);
    await fs.writeFile(path.join(voiceDir, 'voices.json'), JSON.stringify({ version: 1, voice: VOICE, clips: { 予定の時間なのだ: { file, durationMs: 900 } } }));
    const fv = await r.loadFixedVoice(character);
    expect(fv.credit).toBe('VOICEVOX:ずんだもん');
    expect(fv.fallback('calendar', VOICE)).toEqual({ text: '予定の時間なのだ', filePath: path.join(voiceDir, file), durationMs: 900 });

    await fs.writeFile(path.join(voiceDir, 'voices.json'), JSON.stringify({ version: 9 }));
    expect(await r.loadFixedVoice(character)).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});
