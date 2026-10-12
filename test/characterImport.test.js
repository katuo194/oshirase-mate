import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANVAS_SIZE,
  PNG_HEADER_BYTES,
  buildManifest,
  characterFrameUrl,
  checkFrameHeaders,
  createCharacterRepository,
  describeImportError,
  frameFileNames,
  isValidCharacterId,
  parseManifest,
  readPngHeader,
  resolveCharacterUrl,
  slotFolderName,
  validateDisplayName,
  validateFps,
  validateSlotSelection,
} from '../src/main/characterImport.js';
import { emptyLines } from '../src/main/characterLines.js';

/** シグネチャ＋IHDR だけの最小 PNG（寸法・色形式の検査用。画像としてはデコードしない） */
function fakePng({ width = 400, height = 400, bitDepth = 8, colorType = 6 } = {}) {
  const buf = Buffer.alloc(33 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = bitDepth;
  buf[25] = colorType;
  return buf;
}

const RGBA400 = { width: 400, height: 400, bitDepth: 8, colorType: 6 };

describe('readPngHeader', () => {
  it('シグネチャと IHDR から寸法・ビット深度・色形式を読む', () => {
    expect(readPngHeader(fakePng({ width: 320, height: 240, colorType: 2 }))).toEqual({ width: 320, height: 240, bitDepth: 8, colorType: 2 });
  });

  it('先頭 PNG_HEADER_BYTES バイトだけで読める', () => {
    expect(readPngHeader(fakePng().subarray(0, PNG_HEADER_BYTES))).toEqual(RGBA400);
  });

  it('PNG でない・短すぎる・IHDR で始まらないものは null', () => {
    expect(readPngHeader(Buffer.from('GIF89a' + ' '.repeat(40)))).toBeNull();
    expect(readPngHeader(fakePng().subarray(0, 20))).toBeNull();
    const broken = fakePng();
    broken.write('IDAT', 12, 'latin1');
    expect(readPngHeader(broken)).toBeNull();
    expect(readPngHeader(null)).toBeNull();
  });
});

describe('frameFileNames（3桁連番の検証）', () => {
  it('番号順に並べ、連番名でないファイルは無視する', () => {
    const r = frameFileNames(['002.png', 'Thumbs.db', '000.png', 'desktop.ini', '001.PNG']);
    expect(r).toEqual({ ok: true, frames: ['000.png', '001.PNG', '002.png'] });
  });

  it('連番の PNG が1枚も無ければ empty', () => {
    expect(frameFileNames([])).toEqual({ ok: false, error: { code: 'empty' } });
    expect(frameFileNames(['0000.png', '0001.png', 'a.png', '00.png'])).toEqual({ ok: false, error: { code: 'empty' } }); // 3桁でない
  });

  it('欠番があれば最初の欠番を missing_frame で返す', () => {
    expect(frameFileNames(['000.png', '001.png', '003.png', '005.png'])).toEqual({ ok: false, error: { code: 'missing_frame', file: '002.png' } });
  });

  it('000 から始まらなければ missing_frame（000.png）', () => {
    expect(frameFileNames(['001.png', '002.png'])).toEqual({ ok: false, error: { code: 'missing_frame', file: '000.png' } });
  });

  it('大文字小文字違いの同じ番号は duplicate_frame', () => {
    expect(frameFileNames(['000.png', '000.PNG'])).toMatchObject({ ok: false, error: { code: 'duplicate_frame' } });
  });
});

describe('checkFrameHeaders（キャンバスサイズ・RGBA）', () => {
  const frames = ['000.png', '001.png'];

  it('全フレームが 400×400 RGBA なら枚数を返す', () => {
    expect(checkFrameHeaders(frames, [RGBA400, RGBA400])).toEqual({ ok: true, frameCount: 2 });
  });

  it('サイズ違いはエラー（自動リサイズしない）', () => {
    expect(checkFrameHeaders(frames, [RGBA400, { ...RGBA400, width: 512, height: 512 }])).toEqual({
      ok: false,
      error: { code: 'size_mismatch', file: '001.png', detail: '512×512' },
    });
  });

  it('RGBA でない（RGB・パレット）ものはエラー', () => {
    expect(checkFrameHeaders(frames, [{ ...RGBA400, colorType: 2 }, RGBA400])).toMatchObject({ ok: false, error: { code: 'not_rgba', file: '000.png' } });
    expect(checkFrameHeaders(frames, [RGBA400, { ...RGBA400, colorType: 3 }])).toMatchObject({ ok: false, error: { code: 'not_rgba' } });
  });

  it('PNG として読めないフレームは invalid_png', () => {
    expect(checkFrameHeaders(frames, [RGBA400, null])).toEqual({ ok: false, error: { code: 'invalid_png', file: '001.png' } });
  });

  it('キャンバスの既定は 400', () => {
    expect(CANVAS_SIZE).toBe(400);
  });
});

describe('入力値の検証', () => {
  it('fps：未入力は30、1〜60の整数のみ', () => {
    expect(validateFps(undefined)).toEqual({ ok: true, value: 30 });
    expect(validateFps('')).toEqual({ ok: true, value: 30 });
    expect(validateFps(60)).toEqual({ ok: true, value: 60 });
    expect(validateFps('24')).toEqual({ ok: true, value: 24 });
    for (const bad of [0, 61, 29.97, 'abc', -1, NaN]) expect(validateFps(bad).ok).toBe(false);
  });

  it('キャラクター名：前後の空白を除いて1〜40文字、改行は不可', () => {
    expect(validateDisplayName('  星空寝夢 ')).toEqual({ ok: true, value: '星空寝夢' });
    expect(validateDisplayName('あ'.repeat(40)).ok).toBe(true);
    expect(validateDisplayName('あ'.repeat(41)).ok).toBe(false);
    expect(validateDisplayName('   ').ok).toBe(false);
    expect(validateDisplayName('a\nb').ok).toBe(false);
    expect(validateDisplayName(undefined).ok).toBe(false);
  });

  it('スロット：rest・notify は必須、未知のスロットは拒否', () => {
    expect(validateSlotSelection(['rest', 'notify'])).toEqual({ ok: true });
    expect(validateSlotSelection(['rest', 'notify', 'notify.gmail'])).toEqual({ ok: true });
    expect(validateSlotSelection(['rest'])).toEqual({ ok: false, error: { code: 'missing_required_slot', slot: 'notify' } });
    expect(validateSlotSelection(['notify.calendar', 'notify'])).toEqual({ ok: false, error: { code: 'missing_required_slot', slot: 'rest' } });
    expect(validateSlotSelection(['rest', 'notify', 'notify.slack'])).toEqual({ ok: false, error: { code: 'unknown_slot', slot: 'notify.slack' } });
  });

  it('キャラクターID：英小文字・数字・ハイフンのみ、default は予約', () => {
    expect(isValidCharacterId('emotelab-3f9a1c2e')).toBe(true);
    for (const bad of ['default', '', '../x', 'Emotelab', 'a/b', 'a.b', '-x', 'x'.repeat(65), 42]) expect(isValidCharacterId(bad)).toBe(false);
  });

  it('スロットの保存先フォルダ名は . を - に', () => {
    expect(slotFolderName('notify.calendar')).toBe('notify-calendar');
    expect(slotFolderName('rest')).toBe('rest');
  });

  it('エラーを画面用の文にする（スロット・ファイル・詳細を添える）', () => {
    expect(describeImportError({ code: 'size_mismatch', slot: 'rest', file: '001.png', detail: '512×512' })).toBe(
      'キャンバスサイズが 400×400px ではありません（rest・001.png・512×512）',
    );
    expect(describeImportError({ code: 'what' })).toBe('取り込みに失敗しました');
  });
});

describe('manifest.json', () => {
  const manifest = () =>
    buildManifest({
      id: 'emotelab-3f9a1c2e',
      displayName: '星空寝夢',
      importedAt: '2026-09-21T07:30:00.000Z',
      slots: { rest: { frameCount: 59, fps: 30 }, notify: { frameCount: 69, fps: 30 }, 'notify.gmail': { frameCount: 40, fps: 60 } },
    });

  it('buildManifest：6.2 の形（未設定の任意スロットは null）', () => {
    expect(manifest()).toEqual({
      version: 1,
      id: 'emotelab-3f9a1c2e',
      displayName: '星空寝夢',
      canvasSize: 400,
      source: 'EmoteLab',
      importedAt: '2026-09-21T07:30:00.000Z',
      updatedAt: '2026-09-21T07:30:00.000Z',
      voice: null,
      persona: '',
      lines: emptyLines(),
      slots: {
        rest: { folder: 'rest', frameCount: 59, fps: 30 },
        notify: { folder: 'notify', frameCount: 69, fps: 30 },
        'notify.calendar': null,
        'notify.tasks': null,
        'notify.gmail': { folder: 'notify-gmail', frameCount: 40, fps: 60 },
      },
    });
  });

  it('parseManifest：正しいものは同じ値、フォルダ名（ID）不一致は null', () => {
    expect(parseManifest(manifest(), 'emotelab-3f9a1c2e')).toEqual(manifest());
    expect(parseManifest(manifest(), 'emotelab-00000000')).toBeNull();
  });

  it('parseManifest：壊れたもの（必須スロット欠落・不正な fps・folder の書き換え・不正ID・版違い）は null', () => {
    const broken = [
      (m) => (m.slots.rest = null),
      (m) => delete m.slots.notify,
      (m) => (m.slots.notify.fps = 0),
      (m) => (m.slots.notify.frameCount = 0),
      (m) => (m.slots['notify.gmail'].folder = '../../etc'),
      (m) => (m.id = '../evil'),
      (m) => (m.version = 2),
      (m) => (m.displayName = ''),
      (m) => (m.canvasSize = '400'),
    ];
    for (const breakIt of broken) {
      const m = manifest();
      breakIt(m);
      expect(parseManifest(m)).toBeNull();
    }
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest([])).toBeNull();
  });
});

describe('mascot-character:// の URL', () => {
  const root = path.join(os.tmpdir(), 'chars');

  it('URL を組み立て、rootDir 配下のパスへ戻せる', () => {
    const url = characterFrameUrl('emotelab-3f9a1c2e', 'notify-calendar', 7);
    expect(url).toBe('mascot-character://emotelab-3f9a1c2e/notify-calendar/007.png');
    expect(resolveCharacterUrl(url, root)).toBe(path.join(root, 'emotelab-3f9a1c2e', 'notify-calendar', '007.png'));
  });

  it('rootDir の外や想定外のファイルは指せない', () => {
    const bad = [
      'mascot-character://emotelab-3f9a1c2e/../../secret/000.png',
      'mascot-character://emotelab-3f9a1c2e/rest/..%2F..%2Fx.png',
      'mascot-character://emotelab-3f9a1c2e/rest/manifest.json',
      'mascot-character://emotelab-3f9a1c2e/rest/sub/000.png',
      'mascot-character://emotelab-3f9a1c2e/other/000.png',
      'mascot-character://default/rest/000.png',
      'mascot-character://emotelab-3f9a1c2e/rest/000.png?x=1',
      'file:///C:/Windows/win.ini',
      'not a url',
    ];
    for (const url of bad) expect(resolveCharacterUrl(url, root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// I/O（一時ディレクトリの実ファイルで確認）
// ---------------------------------------------------------------------------------------------

let dir;
let rootDir;
let srcDir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mascot-chars-'));
  rootDir = path.join(dir, 'characters');
  srcDir = path.join(dir, 'export');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** EmoteLab の書き出しフォルダを作る（name → 中身） */
async function makeFolder(name, count, { png = {}, extra = {} } = {}) {
  const d = path.join(srcDir, name);
  await fs.mkdir(d, { recursive: true });
  for (let i = 0; i < count; i++) {
    const body = Buffer.concat([fakePng(png), Buffer.from(`frame-${i}`)]);
    await fs.writeFile(path.join(d, `${String(i).padStart(3, '0')}.png`), body);
  }
  for (const [file, text] of Object.entries(extra)) await fs.writeFile(path.join(d, file), text);
  return d;
}

function createRepo(opts = {}) {
  let seq = 0;
  return createCharacterRepository({
    rootDir,
    fs,
    randomId: () => `0000000${++seq}`.slice(-8),
    now: () => new Date('2026-09-21T07:30:00.000Z'),
    log: { info: vi.fn(), warn: vi.fn() },
    ...opts,
  });
}

describe('createCharacterRepository / inspectFolder', () => {
  it('正しいフォルダは枚数を返す（連番以外のファイルは無視）', async () => {
    const d = await makeFolder('rest', 3, { extra: { 'Thumbs.db': 'x' } });
    expect(await createRepo().inspectFolder(d)).toEqual({ ok: true, frameCount: 3, frames: ['000.png', '001.png', '002.png'] });
  });

  it('サイズ違い・RGB・欠番・読めないフォルダはエラー', async () => {
    const repo = createRepo();
    expect(await repo.inspectFolder(await makeFolder('big', 2, { png: { width: 512, height: 512 } }))).toMatchObject({ ok: false, error: { code: 'size_mismatch' } });
    expect(await repo.inspectFolder(await makeFolder('rgb', 2, { png: { colorType: 2 } }))).toMatchObject({ ok: false, error: { code: 'not_rgba' } });
    const gap = await makeFolder('gap', 3);
    await fs.rm(path.join(gap, '001.png'));
    expect(await repo.inspectFolder(gap)).toEqual({ ok: false, error: { code: 'missing_frame', file: '001.png' } });
    expect(await repo.inspectFolder(path.join(srcDir, 'nothing'))).toEqual({ ok: false, error: { code: 'unreadable' } });
    const notPng = await makeFolder('notpng', 0, { extra: { '000.png': 'hello' } });
    expect(await repo.inspectFolder(notPng)).toMatchObject({ ok: false, error: { code: 'invalid_png', file: '000.png' } });
  });
});

describe('createCharacterRepository / 取り込み・一覧・削除', () => {
  it('取り込むと <id>/manifest.json と <slotFolder>/000.png… ができ、一覧に出る', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 3, { extra: { 'Thumbs.db': 'x' } });
    const notify = await makeFolder('notify', 2);
    const gmail = await makeFolder('gmail', 4);
    const r = await repo.importCharacter({
      displayName: ' 星空寝夢 ',
      slots: { rest: { dir: rest }, notify: { dir: notify, fps: 24 }, 'notify.gmail': { dir: gmail, fps: 60 } },
    });
    expect(r.ok).toBe(true);
    const id = r.manifest.id;
    expect(id).toBe('emotelab-00000001');
    expect(r.manifest).toMatchObject({
      displayName: '星空寝夢',
      importedAt: '2026-09-21T07:30:00.000Z',
      slots: {
        rest: { folder: 'rest', frameCount: 3, fps: 30 },
        notify: { folder: 'notify', frameCount: 2, fps: 24 },
        'notify.calendar': null,
        'notify.tasks': null,
        'notify.gmail': { folder: 'notify-gmail', frameCount: 4, fps: 60 },
      },
    });

    const saved = JSON.parse(await fs.readFile(path.join(rootDir, id, 'manifest.json'), 'utf8'));
    expect(saved).toEqual(r.manifest);
    expect((await fs.readdir(path.join(rootDir, id, 'rest'))).sort()).toEqual(['000.png', '001.png', '002.png']); // Thumbs.db はコピーしない
    expect((await fs.readFile(path.join(rootDir, id, 'notify-gmail', '003.png'))).toString('latin1').endsWith('frame-3')).toBe(true);

    expect(await repo.list()).toEqual([r.manifest]);
    expect(await repo.get(id)).toEqual(r.manifest);
    expect((await fs.readdir(rootDir)).filter((n) => n.startsWith('.importing-'))).toEqual([]);
  });

  it('大文字の拡張子（000.PNG）も小文字の連番名で保存する', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 2);
    await fs.rename(path.join(rest, '001.png'), path.join(rest, '001.PNG'));
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    expect(r.ok).toBe(true);
    expect((await fs.readdir(path.join(rootDir, r.manifest.id, 'rest'))).sort()).toEqual(['000.png', '001.png']);
  });

  it('検証に失敗したら何も残さない（どのスロットか分かるエラー）', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 2);
    const bad = await makeFolder('bad', 2, { png: { width: 200, height: 200 } });
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: bad } } });
    expect(r).toEqual({ ok: false, error: { code: 'size_mismatch', file: '000.png', detail: '200×200', slot: 'notify' } });
    expect(await fs.readdir(rootDir)).toEqual([]);
    expect(await repo.list()).toEqual([]);
  });

  it('コピーの途中で失敗しても一時フォルダを残さない', async () => {
    const failingFs = { ...fs, copyFile: vi.fn(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }) };
    const repo = createRepo({ fs: failingFs });
    const rest = await makeFolder('rest', 2);
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    expect(r).toEqual({ ok: false, error: { code: 'write_failed' } });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it('必須スロット・名前・fps が不正なら取り込まない', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    expect(await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest } } })).toMatchObject({ ok: false, error: { code: 'missing_required_slot', slot: 'notify' } });
    expect(await repo.importCharacter({ displayName: '', slots: { rest: { dir: rest }, notify: { dir: rest } } })).toMatchObject({ ok: false, error: { code: 'invalid_name' } });
    expect(await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest, fps: 120 } } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_fps', slot: 'notify' },
    });
    await expect(fs.readdir(rootDir)).rejects.toThrow(); // 何も作っていない
  });

  it('一覧は取り込み順。manifest の壊れたフォルダ・不正な名前のフォルダは除外する', async () => {
    let t = 0;
    const repo = createRepo({ now: () => new Date(Date.UTC(2026, 8, 21, 0, 0, t++)) });
    const rest = await makeFolder('rest', 1);
    const a = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    const b = await repo.importCharacter({ displayName: 'B', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    await fs.mkdir(path.join(rootDir, 'emotelab-broken'));
    await fs.writeFile(path.join(rootDir, 'emotelab-broken', 'manifest.json'), '{not json');
    await fs.mkdir(path.join(rootDir, 'Not_Valid'));
    expect((await repo.list()).map((m) => m.displayName)).toEqual(['A', 'B']);
    expect(a.manifest.id).not.toBe(b.manifest.id);
  });

  it('ID が衝突したら別の乱数で作り直す', async () => {
    await fs.mkdir(path.join(rootDir, 'emotelab-00000001'), { recursive: true });
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    expect(r.manifest.id).toBe('emotelab-00000002');
  });

  it('削除するとフォルダごと消える。不正な ID・存在しない ID は not_found（何も消さない）', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    expect(await repo.remove('../export')).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await repo.remove('emotelab-ffffffff')).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await repo.remove(r.manifest.id)).toEqual({ ok: true });
    expect(await repo.list()).toEqual([]);
    expect(await fs.readdir(path.join(srcDir, 'rest'))).toEqual(['000.png']); // 取り込み元は消さない
  });

  it('cleanupPartial：中断した取り込み（.importing-*）だけを消す', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    const r = await repo.importCharacter({ displayName: 'A', slots: { rest: { dir: rest }, notify: { dir: rest } } });
    await fs.mkdir(path.join(rootDir, '.importing-emotelab-dead0000', 'rest'), { recursive: true });
    await repo.cleanupPartial();
    expect(await fs.readdir(rootDir)).toEqual([r.manifest.id]);
  });

  it('get：不正な ID・存在しない ID は null', async () => {
    const repo = createRepo();
    expect(await repo.get('../x')).toBeNull();
    expect(await repo.get('emotelab-00000001')).toBeNull();
    expect(await repo.list()).toEqual([]); // rootDir が無くても空
  });
});

describe('mascot-character:// の URL（revision）', () => {
  const root = path.join(os.tmpdir(), 'chars');

  it('revision を付けると ?v= が付き、同じファイルを指す', () => {
    const url = characterFrameUrl('emotelab-3f9a1c2e', 'rest', 0, '2026-09-21T08:00:00.000Z');
    expect(url).toBe('mascot-character://emotelab-3f9a1c2e/rest/000.png?v=2026-09-21T08%3A00%3A00.000Z');
    expect(resolveCharacterUrl(url, root)).toBe(path.join(root, 'emotelab-3f9a1c2e', 'rest', '000.png'));
  });

  it('v 以外の検索部・v の重複は拒否する', () => {
    expect(resolveCharacterUrl('mascot-character://emotelab-3f9a1c2e/rest/000.png?v=1&x=2', root)).toBeNull();
    expect(resolveCharacterUrl('mascot-character://emotelab-3f9a1c2e/rest/000.png?v=1&v=2', root)).toBeNull();
  });
});

describe('manifest.json（声・キャラクター設定。v5.9）', () => {
  const base = { id: 'emotelab-3f9a1c2e', displayName: 'A', importedAt: '2026-09-21T07:30:00.000Z', slots: { rest: { frameCount: 1, fps: 30 }, notify: { frameCount: 1, fps: 30 } } };

  it('voice・persona・updatedAt を保存し、読み戻せる', () => {
    const m = buildManifest({ ...base, updatedAt: '2026-09-22T00:00:00.000Z', voice: { speakerId: 3, speedScale: 1.2, pitchScale: -0.05 }, persona: '一人称はわたし' });
    expect(parseManifest(m, 'emotelab-3f9a1c2e')).toMatchObject({
      updatedAt: '2026-09-22T00:00:00.000Z',
      voice: { speakerId: 3, speedScale: 1.2, pitchScale: -0.05 },
      persona: '一人称はわたし',
    });
  });

  it('Phase 8 初期の manifest（voice・persona・updatedAt なし）も読める。壊れた voice は未設定扱い（一覧から外さない）', () => {
    const m = buildManifest(base);
    delete m.voice;
    delete m.persona;
    delete m.updatedAt;
    expect(parseManifest(m)).toMatchObject({ voice: null, persona: '', updatedAt: '2026-09-21T07:30:00.000Z' });
    expect(parseManifest({ ...buildManifest(base), voice: { speakerId: -1 } })).toMatchObject({ voice: null });
  });
});

describe('manifest.json（セリフ。Phase 13・F-22）', () => {
  const base = { id: 'emotelab-3f9a1c2e', displayName: 'A', importedAt: '2026-09-21T07:30:00.000Z', slots: { rest: { frameCount: 1, fps: 30 }, notify: { frameCount: 1, fps: 30 } } };

  it('lines を保存し、読み戻せる（version は 1 のまま）', () => {
    const lines = emptyLines();
    lines.notify.gmail = ['{from}さんからだよ。{title}'];
    lines.idle.normal = ['ひまだなあ'];
    const m = buildManifest({ ...base, lines });
    expect(m.version).toBe(1);
    expect(parseManifest(m, 'emotelab-3f9a1c2e').lines).toEqual(lines);
  });

  it('lines が無い古い manifest も読め、壊れた行だけを捨てる（キャラクターは一覧から外さない）', () => {
    const old = buildManifest(base);
    delete old.lines;
    expect(parseManifest(old)).toMatchObject({ id: 'emotelab-3f9a1c2e', lines: emptyLines() });
    const broken = { ...buildManifest(base), lines: { notify: { tasks: ['{title}だよ', '件名なし', 7] }, idle: 'x' } };
    const parsed = parseManifest(broken);
    expect(parsed).not.toBeNull();
    expect(parsed.lines.notify.tasks).toEqual(['{title}だよ']);
    expect(parsed.lines.idle.normal).toEqual([]);
  });

  it('セリフのエラーは種類と行を含む文にする', () => {
    expect(describeImportError({ code: 'lines_missing_title', group: 'notify', kind: 'tasks', line: 2 })).toBe('セリフ「TODO」の 2 行目：{title}（件名）を入れてください');
  });
});

describe('createCharacterRepository / 編集（v5.9）', () => {
  let t;
  const clock = () => new Date(Date.UTC(2026, 8, 21, 0, 0, t++));
  beforeEach(() => {
    t = 0;
  });

  async function imported(repo, extra = {}) {
    const rest = await makeFolder('rest', 3);
    const notify = await makeFolder('notify', 2);
    const gmail = await makeFolder('gmail', 2);
    const r = await repo.importCharacter({
      displayName: 'A',
      slots: { rest: { dir: rest }, notify: { dir: notify, fps: 24 }, 'notify.gmail': { dir: gmail } },
      ...extra,
    });
    expect(r.ok).toBe(true);
    return r.manifest;
  }

  it('取り込み時に声とキャラクター設定を保存できる', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo, { voice: { speakerId: 3, speedScale: 1.1, pitchScale: 0 }, persona: '  おっとり  ' });
    expect(m).toMatchObject({ voice: { speakerId: 3, speedScale: 1.1, pitchScale: 0 }, persona: 'おっとり' });
    expect(await repo.get(m.id)).toEqual(m);
  });

  it('不正な声・長すぎるキャラクター設定は取り込まない', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    const slots = { rest: { dir: rest }, notify: { dir: rest } };
    expect(await repo.importCharacter({ displayName: 'A', slots, voice: { speakerId: 3, speedScale: 3 } })).toMatchObject({ ok: false, error: { code: 'invalid_voice' } });
    expect(await repo.importCharacter({ displayName: 'A', slots, persona: 'あ'.repeat(1001) })).toMatchObject({ ok: false, error: { code: 'invalid_persona' } });
  });

  it('取り込み時にセリフを保存できる（textarea の文字列を1行1文に。空行・前後の空白は除く）', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo, { lines: { notify: { tasks: '  {title}をやろう \n\n{title}、期限だよ' }, idle: { morning: 'おはよ' } } });
    expect(m.lines.notify.tasks).toEqual(['{title}をやろう', '{title}、期限だよ']);
    expect(m.lines.idle.morning).toEqual(['おはよ']);
    expect(m.lines.notify.gmail).toEqual([]);
    expect(await repo.get(m.id)).toEqual(m);
  });

  it('不正なセリフは取り込まない（何も作らない）', async () => {
    const repo = createRepo();
    const rest = await makeFolder('rest', 1);
    const slots = { rest: { dir: rest }, notify: { dir: rest } };
    const r = await repo.importCharacter({ displayName: 'A', slots, lines: { notify: { gmail: '{title}\n{from}だけ' } } });
    expect(r).toEqual({ ok: false, error: { code: 'lines_missing_title', group: 'notify', kind: 'gmail', line: 2 } });
    expect(await repo.list()).toEqual([]);
  });

  it('編集でセリフを変えられ、不正なら何も変えない', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo, { lines: { idle: { normal: 'ひま' } } });
    const keep = { rest: { keep: true }, notify: { keep: true }, 'notify.gmail': { keep: true } };
    const r = await repo.updateCharacter(m.id, { displayName: 'A', slots: keep, lines: { notify: { calendar: '{time}から{title}' } } });
    expect(r.ok).toBe(true);
    expect(r.manifest.lines.notify.calendar).toEqual(['{time}から{title}']);
    expect(r.manifest.lines.idle.normal).toEqual([]); // 送ったものに置き換わる
    expect(await repo.get(m.id)).toEqual(r.manifest);

    const bad = await repo.updateCharacter(m.id, { displayName: 'B', slots: keep, lines: { idle: { normal: '{title}' } } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'lines_unknown_placeholder', group: 'idle', kind: 'normal', line: 1 } });
    expect(await repo.get(m.id)).toEqual(r.manifest);
  });

  it('名前・fps・声・設定だけの編集は manifest の置き換えだけ（画像はそのまま）', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo);
    const before = await fs.readFile(path.join(rootDir, m.id, 'rest', '002.png'));
    const r = await repo.updateCharacter(m.id, {
      displayName: 'B',
      slots: { rest: { keep: true, fps: 12 }, notify: { keep: true }, 'notify.gmail': { keep: true } },
      voice: { speakerId: 1, speedScale: 0.9, pitchScale: 0.05 },
      persona: '元気',
    });
    expect(r.ok).toBe(true);
    expect(r.manifest).toMatchObject({
      id: m.id,
      displayName: 'B',
      importedAt: m.importedAt,
      voice: { speakerId: 1, speedScale: 0.9, pitchScale: 0.05 },
      persona: '元気',
      slots: { rest: { frameCount: 3, fps: 12 }, notify: { frameCount: 2, fps: 24 }, 'notify.gmail': { frameCount: 2, fps: 30 } },
    });
    expect(r.manifest.updatedAt).not.toBe(m.updatedAt);
    expect(await repo.get(m.id)).toEqual(r.manifest);
    expect(await fs.readFile(path.join(rootDir, m.id, 'rest', '002.png'))).toEqual(before);
    expect((await fs.readdir(path.join(rootDir, m.id))).sort()).toEqual(['manifest.json', 'notify', 'notify-gmail', 'rest']);
  });

  it('任意スロットの解除：manifest を null にして画像も消す。rest・notify は解除できない', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo);
    const r = await repo.updateCharacter(m.id, { displayName: 'A', slots: { rest: { keep: true }, notify: { keep: true } } });
    expect(r.ok).toBe(true);
    expect(r.manifest.slots['notify.gmail']).toBeNull();
    expect((await fs.readdir(path.join(rootDir, m.id))).sort()).toEqual(['manifest.json', 'notify', 'rest']);
    expect(await repo.updateCharacter(m.id, { displayName: 'A', slots: { rest: { keep: true } } })).toMatchObject({
      ok: false,
      error: { code: 'missing_required_slot', slot: 'notify' },
    });
  });

  it('フォルダの差し替え：組み直して入れ替える（残したスロットの画像も引き継ぐ）', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo);
    const newNotify = await makeFolder('notify2', 5);
    const calendar = await makeFolder('calendar', 4);
    const r = await repo.updateCharacter(m.id, {
      displayName: 'A',
      slots: { rest: { keep: true }, notify: { dir: newNotify, fps: 60 }, 'notify.calendar': { dir: calendar } },
      persona: 'p',
    });
    expect(r.ok).toBe(true);
    expect(r.manifest.slots).toMatchObject({
      rest: { frameCount: 3, fps: 30 },
      notify: { frameCount: 5, fps: 60 },
      'notify.calendar': { frameCount: 4, fps: 30 },
      'notify.gmail': null,
      'notify.tasks': null,
    });
    const dir = path.join(rootDir, m.id);
    expect((await fs.readdir(dir)).sort()).toEqual(['manifest.json', 'notify', 'notify-calendar', 'rest']);
    expect((await fs.readdir(path.join(dir, 'notify'))).length).toBe(5);
    expect((await fs.readFile(path.join(dir, 'rest', '002.png'))).toString('latin1').endsWith('frame-2')).toBe(true);
    expect((await fs.readdir(rootDir)).sort()).toEqual([m.id]); // 一時フォルダ・退避フォルダを残さない
    expect(await repo.get(m.id)).toEqual(r.manifest);
  });

  it('差し替えるフォルダが不正なら何も変えない', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo);
    const bad = await makeFolder('bad', 2, { png: { width: 200, height: 200 } });
    const r = await repo.updateCharacter(m.id, { displayName: 'B', slots: { rest: { keep: true }, notify: { dir: bad } } });
    expect(r).toMatchObject({ ok: false, error: { code: 'size_mismatch', slot: 'notify' } });
    expect(await repo.get(m.id)).toEqual(m);
    expect(await fs.readdir(rootDir)).toEqual([m.id]);
  });

  it('入れ替えの途中で失敗したら元のキャラクターを戻す', async () => {
    const repo0 = createRepo({ now: clock });
    const m = await imported(repo0);
    const calendar = await makeFolder('calendar', 1);
    let renames = 0;
    // 2回目の rename（組み直したフォルダ → <id>）だけ失敗させる
    const flakyFs = {
      ...fs,
      rename: vi.fn(async (a, b) => {
        if (++renames === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return fs.rename(a, b);
      }),
    };
    const repo = createRepo({ fs: flakyFs, now: clock });
    const r = await repo.updateCharacter(m.id, { displayName: 'B', slots: { rest: { keep: true }, notify: { keep: true }, 'notify.calendar': { dir: calendar } } });
    expect(r).toEqual({ ok: false, error: { code: 'write_failed' } });
    expect(await repo0.get(m.id)).toEqual(m);
    expect(await fs.readdir(rootDir)).toEqual([m.id]);
  });

  it('存在しない・不正な ID は not_found', async () => {
    const repo = createRepo();
    expect(await repo.updateCharacter('emotelab-ffffffff', { displayName: 'A', slots: {} })).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await repo.updateCharacter('../x', { displayName: 'A', slots: {} })).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('cleanupPartial：入れ替えの途中で止まった .removing-<id> は、<id> が無ければ元に戻す', async () => {
    const repo = createRepo({ now: clock });
    const m = await imported(repo);
    await fs.rename(path.join(rootDir, m.id), path.join(rootDir, `.removing-${m.id}`));
    await repo.cleanupPartial();
    expect(await fs.readdir(rootDir)).toEqual([m.id]);
    expect(await repo.get(m.id)).toEqual(m);
    // <id> があれば .removing-<id> は古いものなので消す
    await fs.mkdir(path.join(rootDir, `.removing-${m.id}`));
    await repo.cleanupPartial();
    expect(await fs.readdir(rootDir)).toEqual([m.id]);
  });
});

describe('createCharacterRepository / 既定キャラクターの声と設定（default-profile.json）', () => {
  it('未保存なら未設定。保存すると読み戻せ、一覧には出ない', async () => {
    const repo = createRepo();
    expect(await repo.getDefaultProfile()).toEqual({ voice: null, persona: '', lines: emptyLines() });
    const r = await repo.saveDefaultProfile({ voice: { speakerId: 2, speedScale: 1, pitchScale: 0 }, persona: '丸い' });
    expect(r).toEqual({ ok: true, profile: { voice: { speakerId: 2, speedScale: 1, pitchScale: 0 }, persona: '丸い', lines: emptyLines() } });
    expect(await repo.getDefaultProfile()).toEqual(r.profile);
    expect(JSON.parse(await fs.readFile(path.join(rootDir, 'default-profile.json'), 'utf8'))).toEqual(r.profile);
    expect(await repo.list()).toEqual([]);
  });

  it('不正な値は保存しない。壊れたファイルは未設定として読む', async () => {
    const repo = createRepo();
    expect(await repo.saveDefaultProfile({ voice: { speakerId: 'x' } })).toMatchObject({ ok: false, error: { code: 'invalid_voice' } });
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'default-profile.json'), '{broken');
    expect(await repo.getDefaultProfile()).toEqual({ voice: null, persona: '', lines: emptyLines() });
  });

  it('黄色い丸のセリフを保存・読み戻せる。lines の無い古いファイルは空、不正なセリフは保存しない', async () => {
    const repo = createRepo();
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'default-profile.json'), JSON.stringify({ voice: null, persona: '丸い' }));
    expect(await repo.getDefaultProfile()).toEqual({ voice: null, persona: '丸い', lines: emptyLines() });

    const r = await repo.saveDefaultProfile({ persona: '丸い', lines: { notify: { calendarAllDay: '今日は{title}！' }, idle: { bedtime: 'おやすみ' } } });
    expect(r.ok).toBe(true);
    expect(r.profile.lines.notify.calendarAllDay).toEqual(['今日は{title}！']);
    expect(r.profile.lines.idle.bedtime).toEqual(['おやすみ']);
    expect(await repo.getDefaultProfile()).toEqual(r.profile);

    expect(await repo.saveDefaultProfile({ lines: { notify: { tasks: '{date}{title}' } } })).toMatchObject({
      ok: false,
      error: { code: 'lines_unknown_placeholder', placeholder: 'date' },
    });
    expect(await repo.getDefaultProfile()).toEqual(r.profile);
  });
});
