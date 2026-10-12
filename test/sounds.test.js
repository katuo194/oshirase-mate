import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSfxResolver } from '../src/main/sounds.js';

const DIR = path.join('C:', 'app', 'assets', 'sounds');
const file = (name) => path.join(DIR, name);

function setup(existing = []) {
  const files = new Set(existing.map(file));
  const log = { warn: vi.fn() };
  const exists = vi.fn((p) => files.has(p));
  const resolver = createSfxResolver({ baseDir: DIR, exists, log, toUrl: (p) => `test://${p}` });
  return { resolver, log, exists };
}

const args = (extra = {}) => ({ sfxKey: 'calendar', muted: false, volume: 0.8, ...extra });

describe('sounds / F-12 効果音の解決', () => {
  it('種別ごとのファイルがあればそれを使い、音量を渡す', () => {
    const { resolver } = setup(['notify_calendar.mp3', 'notify.wav']);
    expect(resolver.resolve(args())).toEqual({ url: `test://${file('notify_calendar.mp3')}`, volume: 0.8 });
  });

  it('拡張子は mp3 → wav → ogg の順に探す', () => {
    expect(setup(['notify_tasks.ogg', 'notify_tasks.wav']).resolver.resolve(args({ sfxKey: 'tasks' })).url).toContain('notify_tasks.wav');
    expect(setup(['notify_gmail.ogg']).resolver.resolve(args({ sfxKey: 'gmail' })).url).toContain('notify_gmail.ogg');
  });

  it('種別ごとのファイルが無ければ共通の notify.* にフォールバックする', () => {
    const { resolver, log } = setup(['notify.wav']);
    expect(resolver.resolve(args({ sfxKey: 'gmail' })).url).toContain('notify.wav');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('未知の種別（default）は共通ファイルだけを探す', () => {
    const { resolver } = setup(['notify_default.wav', 'notify.mp3']);
    expect(resolver.resolve(args({ sfxKey: 'default' })).url).toContain('notify.mp3');
  });
});

describe('sounds / 3.7 ミュート・音量', () => {
  it('ミュート中は鳴らさない（null）。ファイルの有無を調べず、警告も出さない', () => {
    const { resolver, log, exists } = setup([]);
    expect(resolver.resolve(args({ muted: true }))).toBeNull();
    expect(exists).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('ミュートを解除すれば鳴る', () => {
    const { resolver } = setup(['notify_calendar.mp3']);
    expect(resolver.resolve(args({ muted: true }))).toBeNull();
    expect(resolver.resolve(args({ muted: false }))).not.toBeNull();
  });

  it('音量 0 は鳴らさない。不正な値も鳴らさない', () => {
    const { resolver } = setup(['notify_calendar.mp3']);
    expect(resolver.resolve(args({ volume: 0 }))).toBeNull();
    expect(resolver.resolve(args({ volume: NaN }))).toBeNull();
    expect(resolver.resolve(args({ volume: undefined }))).toBeNull();
  });

  it('音量は 0〜1 に収める', () => {
    const { resolver } = setup(['notify_calendar.mp3']);
    expect(resolver.resolve(args({ volume: 3 })).volume).toBe(1);
  });
});

describe('sounds / 素材が無い場合は無音で続行する（2.7）', () => {
  it('ファイルが無ければ null を返し、警告ログを出す', () => {
    const { resolver, log } = setup([]);
    expect(resolver.resolve(args())).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('notify_calendar / notify');
  });

  it('同じ種別の警告は1回だけ（通知のたびにログを汚さない）。別の種別は別に1回出す', () => {
    const { resolver, log } = setup([]);
    resolver.resolve(args());
    resolver.resolve(args());
    expect(log.warn).toHaveBeenCalledTimes(1);
    resolver.resolve(args({ sfxKey: 'gmail' }));
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('あとからファイルを置けば、再起動せずに鳴るようになる', () => {
    const files = new Set();
    const resolver = createSfxResolver({ baseDir: DIR, exists: (p) => files.has(p), log: { warn() {} }, toUrl: (p) => p });
    expect(resolver.resolve(args())).toBeNull();
    files.add(file('notify_calendar.wav'));
    expect(resolver.resolve(args())).toMatchObject({ volume: 0.8 });
  });
});
