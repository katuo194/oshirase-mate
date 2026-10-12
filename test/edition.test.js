import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITIONS, isEdition, oauthSourceFor, resolveEdition } from '../src/main/edition.js';
import { readBuildEdition } from '../src/main/buildInfo.js';

describe('resolveEdition（6.1：保存された値 → ビルド時の既定値 → personal）', () => {
  it.each([
    // [config.json に保存された値, ビルド時の既定値, 結果]
    [undefined, undefined, 'personal'],
    [undefined, null, 'personal'],
    [undefined, 'shared', 'shared'],
    [undefined, 'personal', 'personal'],
    ['shared', undefined, 'shared'],
    ['personal', undefined, 'personal'],
    ['personal', 'shared', 'personal'], // 本当に保存された値はビルド時の既定値より優先
    ['shared', 'personal', 'shared'],
  ])('stored=%s, buildDefault=%s → %s', (stored, buildDefault, expected) => {
    expect(resolveEdition({ stored, buildDefault })).toBe(expected);
  });

  it('保存値が不正（型違い・未知の値・空）なら「未保存」とみなしてビルド時の既定値へ進む', () => {
    for (const stored of ['', 'Shared', 'SHARED', 'team', 1, true, null, {}, ['shared']]) {
      expect(resolveEdition({ stored, buildDefault: 'shared' })).toBe('shared');
      expect(resolveEdition({ stored })).toBe('personal');
    }
  });

  it('ビルド時の既定値も不正なら personal', () => {
    for (const buildDefault of ['', 'Shared', 'enterprise', 0, {}]) {
      expect(resolveEdition({ buildDefault })).toBe('personal');
    }
  });

  it('引数なしでも personal', () => {
    expect(resolveEdition()).toBe('personal');
  });

  it('isEdition は2値だけを受け付ける', () => {
    expect(EDITIONS).toEqual(['personal', 'shared']);
    expect(EDITIONS.every(isEdition)).toBe(true);
    for (const v of [undefined, null, '', 'Personal', 'free']) expect(isEdition(v)).toBe(false);
  });
});

describe('oauthSourceFor（2.4：OAuth 資格情報の提供元）', () => {
  it('個人版は .env、共有版は利用者の入力', () => {
    expect(oauthSourceFor('personal')).toBe('env');
    expect(oauthSourceFor('shared')).toBe('user');
  });
});

describe('readBuildEdition（package.json の mascotEdition）', () => {
  const withPkg = (content, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-info-'));
    try {
      const file = path.join(dir, 'package.json');
      if (content !== null) fs.writeFileSync(file, content);
      return fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('extraMetadata で埋め込まれた値を返す（検証は resolveEdition）', () => {
    expect(withPkg(JSON.stringify({ name: 'x', mascotEdition: 'shared' }), readBuildEdition)).toBe('shared');
  });

  it('未設定・読めない・壊れている場合は null', () => {
    expect(withPkg(JSON.stringify({ name: 'x' }), readBuildEdition)).toBeNull();
    expect(withPkg(JSON.stringify({ mascotEdition: 1 }), readBuildEdition)).toBeNull();
    expect(withPkg('{broken', readBuildEdition)).toBeNull();
    expect(withPkg(null, readBuildEdition)).toBeNull();
  });

  it('開発時のリポジトリの package.json には mascotEdition が無い（開発時は personal）', () => {
    expect(readBuildEdition()).toBeNull();
  });
});
