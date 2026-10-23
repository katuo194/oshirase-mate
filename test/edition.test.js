import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITIONS, hasEnvCredentials, isEdition, oauthSourceFor, resolveEdition } from '../src/main/edition.js';
import { readBuildEdition, readEnvHasCredentials } from '../src/main/buildInfo.js';

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

  it('保存値もビルド時の既定値も無く、.env に資格情報が無ければ shared（GitHub から取得したソース。v5.19）', () => {
    expect(resolveEdition({ envHasCredentials: false })).toBe('shared');
    expect(resolveEdition({ buildDefault: null, envHasCredentials: false })).toBe('shared');
    expect(resolveEdition({ envHasCredentials: true })).toBe('personal');
    // 保存された値・ビルド時の既定値が優先
    expect(resolveEdition({ stored: 'personal', envHasCredentials: false })).toBe('personal');
    expect(resolveEdition({ buildDefault: 'personal', envHasCredentials: false })).toBe('personal');
  });

  it('isEdition は2値だけを受け付ける', () => {
    expect(EDITIONS).toEqual(['personal', 'shared']);
    expect(EDITIONS.every(isEdition)).toBe(true);
    for (const v of [undefined, null, '', 'Personal', 'free']) expect(isEdition(v)).toBe(false);
  });
});

describe('hasEnvCredentials（.env に Client ID と Secret が両方入っているか：v5.19）', () => {
  it('両方入っていれば true（形式は見ない。形式の誤りは個人版のまま設定画面に出す）', () => {
    expect(hasEnvCredentials({ GOOGLE_OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'abc' })).toBe(true);
    expect(hasEnvCredentials({ GOOGLE_OAUTH_CLIENT_ID: 'typo', GOOGLE_OAUTH_CLIENT_SECRET: 'abc' })).toBe(true);
  });

  it('.env.example をコピーしただけ（空）・片方だけ・空白だけ・無いときは false', () => {
    expect(hasEnvCredentials({ GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' })).toBe(false);
    expect(hasEnvCredentials({ GOOGLE_OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com' })).toBe(false);
    expect(hasEnvCredentials({ GOOGLE_OAUTH_CLIENT_ID: '  ', GOOGLE_OAUTH_CLIENT_SECRET: 'abc' })).toBe(false);
    expect(hasEnvCredentials({})).toBe(false);
    expect(hasEnvCredentials(null)).toBe(false);
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

  it('開発時のリポジトリの package.json には mascotEdition が無い（開発時は .env の有無で決まる）', () => {
    expect(readBuildEdition()).toBeNull();
  });
});

describe('readEnvHasCredentials（ソースからの起動で .env を読む：v5.19）', () => {
  const withEnv = (content, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
    try {
      const file = path.join(dir, '.env');
      if (content !== null) fs.writeFileSync(file, content);
      return fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('値が入った .env は true', () => {
    const env = 'GOOGLE_OAUTH_CLIENT_ID=x.apps.googleusercontent.com\nGOOGLE_OAUTH_CLIENT_SECRET=abc\n';
    expect(withEnv(env, readEnvHasCredentials)).toBe(true);
  });

  it('.env.example のコピー（空の値）・無い .env は false', () => {
    expect(withEnv(fs.readFileSync(new URL('../.env.example', import.meta.url)), readEnvHasCredentials)).toBe(false);
    expect(withEnv(null, readEnvHasCredentials)).toBe(false);
  });
});
