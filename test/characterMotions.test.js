import { describe, expect, it } from 'vitest';
import { buildManifest } from '../src/main/characterImport.js';
import { DEFAULT_VIEW, buildCharacterView, resolveMotion, slotForState } from '../src/main/characterMotions.js';

const manifest = (extra = {}) =>
  buildManifest({
    id: 'emotelab-3f9a1c2e',
    displayName: '星空寝夢',
    importedAt: '2026-09-21T07:30:00.000Z',
    slots: { rest: { frameCount: 3, fps: 30 }, notify: { frameCount: 2, fps: 24 }, ...extra },
  });

describe('slotForState（状態 → 使いたいスロット）', () => {
  it('rest は rest', () => {
    expect(slotForState({ phase: 'rest' })).toBe('rest');
  });

  it('通知は種別ごとの notify.*', () => {
    expect(slotForState({ phase: 'notify', kind: 'calendar' })).toBe('notify.calendar');
    expect(slotForState({ phase: 'notify', kind: 'tasks' })).toBe('notify.tasks');
    expect(slotForState({ phase: 'notify', kind: 'gmail' })).toBe('notify.gmail');
  });

  it('アプリからのお知らせ（system）・未知の種別は notify', () => {
    expect(slotForState({ phase: 'notify', kind: 'system' })).toBe('notify');
    expect(slotForState({ phase: 'notify', kind: 'generic' })).toBe('notify');
    expect(slotForState({ phase: 'notify' })).toBe('notify');
  });

  it('アイドルトークは notify を使わず rest のまま（v5.8・v5.9）', () => {
    expect(slotForState({ phase: 'notify', kind: 'idle' })).toBe('rest');
  });
});

describe('resolveMotion（フォールバック）', () => {
  it('設定済みのスロットはそのまま', () => {
    const m = manifest({ 'notify.calendar': { frameCount: 5, fps: 60 } });
    expect(resolveMotion(m, 'notify.calendar')).toEqual({ slot: 'notify.calendar', folder: 'notify-calendar', frameCount: 5, fps: 60 });
    expect(resolveMotion(m, 'rest')).toEqual({ slot: 'rest', folder: 'rest', frameCount: 3, fps: 30 });
  });

  it('未設定の notify.calendar / tasks / gmail は notify にフォールバック', () => {
    const m = manifest({ 'notify.calendar': { frameCount: 5, fps: 60 } });
    for (const slot of ['notify.tasks', 'notify.gmail']) {
      expect(resolveMotion(m, slot)).toEqual({ slot: 'notify', folder: 'notify', frameCount: 2, fps: 24 });
    }
  });

  it('manifest が無い・未知のスロットは null', () => {
    expect(resolveMotion(null, 'rest')).toBeNull();
    expect(resolveMotion(manifest(), 'unknown')).toBeNull();
  });
});

describe('buildCharacterView（レンダラーへ送る描画情報）', () => {
  it('manifest が無ければ既定キャラクター（手続き描画・200）', () => {
    expect(buildCharacterView(null)).toBe(DEFAULT_VIEW);
    expect(DEFAULT_VIEW).toEqual({ type: 'procedural', id: 'default', canvasSize: 200 });
  });

  it('設定済みのスロットだけをデコード対象にし、URL を枚数分並べる', () => {
    const view = buildCharacterView(manifest({ 'notify.gmail': { frameCount: 2, fps: 60 } }));
    expect(view).toMatchObject({ type: 'frames', id: 'emotelab-3f9a1c2e', displayName: '星空寝夢', canvasSize: 400 });
    expect(Object.keys(view.sources).sort()).toEqual(['notify', 'notify.gmail', 'rest']);
    expect(view.sources.rest).toEqual({
      frameCount: 3,
      fps: 30,
      // 更新日時（revision）付き：編集で画像が差し替わったときに古い画像がキャッシュから出ない
      urls: [
        'mascot-character://emotelab-3f9a1c2e/rest/000.png?v=2026-09-21T07%3A30%3A00.000Z',
        'mascot-character://emotelab-3f9a1c2e/rest/001.png?v=2026-09-21T07%3A30%3A00.000Z',
        'mascot-character://emotelab-3f9a1c2e/rest/002.png?v=2026-09-21T07%3A30%3A00.000Z',
      ],
    });
    expect(view.sources['notify.gmail'].urls[1]).toBe('mascot-character://emotelab-3f9a1c2e/notify-gmail/001.png?v=2026-09-21T07%3A30%3A00.000Z');
    expect(view.revision).toBe('2026-09-21T07:30:00.000Z');
  });

  it('状態 → スロットはフォールバック解決済み（未設定の種別は notify、アイドルトークは rest）', () => {
    const view = buildCharacterView(manifest({ 'notify.gmail': { frameCount: 2, fps: 60 } }));
    expect(view.stateSlots).toEqual({
      rest: 'rest',
      idle: 'rest',
      notify: 'notify',
      calendar: 'notify',
      tasks: 'notify',
      gmail: 'notify.gmail',
    });
    // レンダラーが引くキーはすべて sources にある
    for (const slot of Object.values(view.stateSlots)) expect(view.sources[slot]).toBeDefined();
  });

  it('全5スロットを埋めた場合は種別ごとに別のスロット', () => {
    const all = manifest({
      'notify.calendar': { frameCount: 1, fps: 30 },
      'notify.tasks': { frameCount: 1, fps: 30 },
      'notify.gmail': { frameCount: 1, fps: 30 },
    });
    const view = buildCharacterView(all);
    expect(Object.keys(view.sources)).toHaveLength(5);
    expect(view.stateSlots).toMatchObject({ calendar: 'notify.calendar', tasks: 'notify.tasks', gmail: 'notify.gmail' });
  });
});
