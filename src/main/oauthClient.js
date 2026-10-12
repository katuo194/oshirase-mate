// 共有版の OAuth Client ID/Secret の管理（2.4・3.6・F-18。v5.11）。oauthClientStorage.js（暗号化保存）の上に、
// 状態（保存済みか・変更できるか）と変更イベント、auth への反映（auth.configure）を載せる。geminiKey.js と同じ構え。
// Secret はこのモジュールの外へ出さない（auth へ渡すだけ。getState にもログにも含めない）。
// Client ID も画面へは返さない（v5.15。非秘匿だが、画面に表示しないため渡す理由がない）。
// 個人版では .env を使うため、保存・削除は受け付けない（edition.js の oauthSourceFor で判定）。
// Phase 12（v5.15）で、Console からダウンロードした JSON（client_secret_〜.json）の読み込み（importFile）を追加した。保存の経路は set() と同じ。
// Electron に依存しない：safeStorage とファイルは storage 側、JSON の読み込みは fs で注入される。

import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs/promises';
import { validateOAuthClient } from './authCore.js';
import { oauthSourceFor } from './edition.js';
import { readOAuthClientFile } from './oauthClientFile.js';

/**
 * @param {object} opts
 * @param {'personal' | 'shared'} opts.edition
 * @param {ReturnType<import('./oauthClientStorage.js').createOAuthClientStorage>} opts.storage
 * @param {Pick<ReturnType<import('./auth.js').createAuth>, 'configure' | 'canConfigure' | 'events'>} opts.auth
 * @param {{ info: Function, warn: Function }} [opts.log]
 * @param {Parameters<typeof readOAuthClientFile>[1]} [opts.fs] JSON の読み込み（既定は node:fs/promises）
 */
export function createOAuthClient({ edition, storage, auth, log = console, fs = nodeFs }) {
  const events = new EventEmitter();
  const userInput = oauthSourceFor(edition) === 'user';
  /** Client ID/Secret が保存済みか */
  let configured = false;

  const state = () => ({
    edition,
    // 設定画面の入力欄を出すか（共有版のみ）
    userInput,
    configured,
    // 連携中・同意フロー中・確認中は変更できない（トークンは発行したクライアントに結び付く）
    editable: userInput && auth.canConfigure(),
  });
  const emit = () => events.emit('change', state());
  // 連携状態が変わると editable が変わる
  auth.events.on('change', () => {
    if (userInput) emit();
  });

  const api = {
    events,
    getState: state,

    /**
     * 起動時に保存済みの値を読み込み、auth に反映する（共有版のみ。auth.init より前に呼ぶ）。reject しない。
     */
    async init() {
      if (!userInput) return;
      let saved = null;
      try {
        saved = await storage.load();
      } catch (e) {
        log.warn(`[oauth] OAuth クライアントの設定を読み込めません: ${e?.code ?? e?.name ?? 'error'}`);
      }
      configured = Boolean(saved);
      auth.configure(saved ? { ok: true, ...saved } : { ok: false, reason: 'missing_client_id' });
      emit();
    },

    /**
     * 設定画面からの保存。検証（前後の空白除去・形式・取り違え）を通ったものだけを暗号化して保存し、再起動なしで auth に反映する。
     * @param {{ clientId?: unknown, clientSecret?: unknown }} input
     * @returns {Promise<{ ok: true } | { ok: false, reason: 'not_shared' | 'linked' | 'save_failed' | ReturnType<typeof validateOAuthClient>['reason'] }>}
     */
    async set(input) {
      if (!userInput) return { ok: false, reason: 'not_shared' };
      const v = validateOAuthClient(input);
      if (!v.ok) return v;
      if (!auth.canConfigure()) return { ok: false, reason: 'linked' };
      try {
        await storage.save({ clientId: v.clientId, clientSecret: v.clientSecret });
      } catch (e) {
        log.warn(`[oauth] OAuth クライアントの設定を保存できません: ${e?.message ?? e}`);
        return { ok: false, reason: 'save_failed' };
      }
      // 保存の間に連携が始まることは無い（unconfigured/unlinked から linking へは設定画面の操作だけ）が、念のため結果を見る
      if (!auth.configure(v)) return { ok: false, reason: 'linked' };
      configured = true;
      log.info('[oauth] OAuth クライアントの設定を保存しました');
      emit();
      return { ok: true };
    },

    /**
     * Console からダウンロードした JSON を読み込んで保存する（「Google 連携の準備」の手順 4）。読み込みはメインで行い、値は画面へ返さない。
     * ログには理由だけを出す（ファイルの場所・中身は出さない）。
     * @param {string} filePath
     * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
     */
    async importFile(filePath) {
      if (!userInput) return { ok: false, reason: 'not_shared' };
      if (!auth.canConfigure()) return { ok: false, reason: 'linked' };
      const parsed = await readOAuthClientFile(filePath, fs);
      if (!parsed.ok) {
        log.info(`[oauth] OAuth クライアントの JSON を読み込めません: ${parsed.reason}`);
        return parsed;
      }
      return api.set(parsed);
    },

    /** 保存済みの値を削除し、未設定に戻す（共有版・未連携のときだけ）。 */
    async clear() {
      if (!userInput) return { ok: false, reason: 'not_shared' };
      if (!auth.canConfigure()) return { ok: false, reason: 'linked' };
      try {
        await storage.remove();
      } catch (e) {
        log.warn(`[oauth] OAuth クライアントの設定を削除できません: ${e?.message ?? e}`);
        return { ok: false, reason: 'save_failed' };
      }
      auth.configure({ ok: false, reason: 'missing_client_id' });
      configured = false;
      log.info('[oauth] OAuth クライアントの設定を削除しました');
      emit();
      return { ok: true };
    },
  };
  return api;
}
