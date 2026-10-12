// Google Cloud Console からダウンロードした OAuth クライアントの JSON（client_secret_〜.json）の読み込み（2.4・3.6。Phase 12・v5.15）。
// 設定画面の「Google 連携の準備」の手順 4（ファイルを選ぶ／ドラッグ＆ドロップ）で使う。Client ID/Secret の検証は authCore.validateOAuthClient に任せる。
// 解析（parseOAuthClientFile）は純粋関数。読み込み（readOAuthClientFile）は fs を注入する（Vitest で一時ファイルを読む）。
// 値そのもの（特に Secret）は理由・例外・ログに含めない。

import path from 'node:path';
import { validateOAuthClient } from './authCore.js';

/** 受け付けるファイルの大きさの上限。Console の JSON は 1KB 未満なので、明らかに別のファイルを弾くためのもの */
export const MAX_CLIENT_FILE_BYTES = 64 * 1024;

/**
 * @typedef {'too_large' | 'not_json' | 'web_client' | 'not_client_file' | 'missing_values' | 'invalid_values'} ParseFailure
 *   too_large       … 64KB を超える
 *   not_json        … JSON として読めない
 *   web_client      … 種類が「ウェブ アプリケーション」（{"web": …}）。デスクトップ アプリで作り直してもらう
 *   not_client_file … JSON だが OAuth クライアントのファイルではない（installed も web も無い）
 *   missing_values  … client_id か client_secret が無い・空（作成後に詳細画面からダウンロードした JSON には Secret が入らない）
 *   invalid_values  … 値はあるが形式が正しくない（validateOAuthClient に通らない）
 */

/**
 * ダウンロードした JSON の中身を解析して Client ID/Secret を取り出す。先頭の BOM・前後の空白は許す。
 * @param {Buffer | Uint8Array | string} content
 * @returns {{ ok: true, clientId: string, clientSecret: string } | { ok: false, reason: ParseFailure }}
 */
export function parseOAuthClientFile(content) {
  const size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : (content?.byteLength ?? 0);
  if (size > MAX_CLIENT_FILE_BYTES) return { ok: false, reason: 'too_large' };
  const text = (typeof content === 'string' ? content : Buffer.from(content ?? []).toString('utf8')).replace(/^﻿/, '');

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'not_client_file' };

  const installed = json.installed;
  if (installed === null || typeof installed !== 'object' || Array.isArray(installed)) {
    const web = json.web;
    if (web !== null && typeof web === 'object' && !Array.isArray(web)) return { ok: false, reason: 'web_client' };
    return { ok: false, reason: 'not_client_file' };
  }

  const v = validateOAuthClient({ clientId: installed.client_id, clientSecret: installed.client_secret });
  if (v.ok) return v;
  return { ok: false, reason: v.reason === 'missing_client_id' || v.reason === 'missing_client_secret' ? 'missing_values' : 'invalid_values' };
}

/**
 * ファイルを読み込んで解析する。大きすぎるファイルは中身を読まない。拡張子は .json に限る（ドロップされた別のファイルを読まない）。
 * @param {string} filePath
 * @param {{ stat: (p: string) => Promise<{ isFile(): boolean, size: number }>, readFile: (p: string) => Promise<Buffer> }} fs
 * @returns {Promise<ReturnType<typeof parseOAuthClientFile> | { ok: false, reason: 'read_failed' }>}
 */
export async function readOAuthClientFile(filePath, fs) {
  if (typeof filePath !== 'string' || filePath === '' || !path.isAbsolute(filePath)) return { ok: false, reason: 'read_failed' };
  if (path.extname(filePath).toLowerCase() !== '.json') return { ok: false, reason: 'not_json' };
  let content;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return { ok: false, reason: 'read_failed' };
    if (st.size > MAX_CLIENT_FILE_BYTES) return { ok: false, reason: 'too_large' };
    content = await fs.readFile(filePath);
  } catch {
    return { ok: false, reason: 'read_failed' };
  }
  return parseOAuthClientFile(content);
}
