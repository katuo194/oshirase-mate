import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMOTELAB_EXPORT_DIR, resolveFolderDialogStart } from '../src/main/folderDialogStart.js';

let documentsDir;

beforeEach(async () => {
  documentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-start-'));
});
afterEach(async () => {
  await fs.rm(documentsDir, { recursive: true, force: true });
});

describe('resolveFolderDialogStart（フォルダ選択で最初に開く場所：v5.19）', () => {
  it('前に選んだフォルダがあれば、その親を開く（同じキャラクターの他のモーションを選びやすくする）', async () => {
    const character = path.join(documentsDir, EMOTELAB_EXPORT_DIR, 'シアン');
    await fs.mkdir(path.join(character, 'rest'), { recursive: true });
    const r = await resolveFolderDialogStart({ lastPicked: path.join(character, 'rest'), documentsDir, fs });
    expect(r).toBe(character);
  });

  it('前に選んでいなければ、ドキュメント\\EmoteLab\\Export を開く', async () => {
    const exportDir = path.join(documentsDir, 'EmoteLab', 'Export');
    await fs.mkdir(exportDir, { recursive: true });
    expect(await resolveFolderDialogStart({ lastPicked: null, documentsDir, fs })).toBe(exportDir);
  });

  it('前に選んだフォルダの親が消えていれば、EmoteLab の書き出し先に戻る', async () => {
    const exportDir = path.join(documentsDir, 'EmoteLab', 'Export');
    await fs.mkdir(exportDir, { recursive: true });
    const r = await resolveFolderDialogStart({ lastPicked: path.join(documentsDir, 'gone', 'rest'), documentsDir, fs });
    expect(r).toBe(exportDir);
  });

  it('EmoteLab の書き出し先が無ければ undefined（OS の既定の場所）', async () => {
    expect(await resolveFolderDialogStart({ lastPicked: null, documentsDir, fs })).toBeUndefined();
  });

  it('EmoteLab\\Export がフォルダでなければ使わない', async () => {
    await fs.mkdir(path.join(documentsDir, 'EmoteLab'), { recursive: true });
    await fs.writeFile(path.join(documentsDir, 'EmoteLab', 'Export'), '');
    expect(await resolveFolderDialogStart({ lastPicked: null, documentsDir, fs })).toBeUndefined();
  });

  it('相対パスの「前に選んだフォルダ」は使わない', async () => {
    expect(await resolveFolderDialogStart({ lastPicked: 'rest', documentsDir, fs })).toBeUndefined();
  });
});
