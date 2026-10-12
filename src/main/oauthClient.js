// 共有版の OAuth Client ID/Secret の管理（2.4・3.6・F-18。v5.11）。oauthClientStorage.js（暗号化保存）の上に、
// 状態（保存済みか・Client ID・変更できるか）と変更イベント、auth への反映（auth.configure）を載せる。geminiKey.js と同じ構え。
// Secret はこのモジュールの外へ出さない（auth へ渡すだけ。getState にもログにも含めない）。Client ID は非秘匿なので確認用に返す。
// 個人版では .env を使うため、保存・削除は受け付けない（edition.js の oauthSourceFor で判定）。
// Electron に依存しない：safeStorage とファイルは storage 側で注入される。

import { EventEmitter } from 'node:events';
import { validateOAuthClient } from './authCore.js';
import { oauthSourceFor } from './edition.js';

/**
 * @param {object} opts
 * @param {'personal' | 'shared'} opts.edition
 * @param {ReturnType<import('./oauthClientStorage.js').createOAuthClientStorage>} opts.storage
 * @param {Pick<ReturnType<import('./auth.js').createAuth>, 'configure' | 'canConfigure' | 'events'>} opts.auth
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createOAuthClient({ edition, storage, auth, log = console }) {
  const events = new EventEmitter();
  const userInput = oauthSourceFor(edition) === 'user';
  /** 保存済みの Client ID（非秘匿）。未設定なら null */
  let clientId = null;

  const state = () => ({
    edition,
    // 設定画面の入力欄を出すか（共有版のみ）
    userInput,
    configured: clientId !== null,
    clientId,
    // 連携中・同意フロー中・確認中は変更できない（トークンは発行したクライアントに結び付く）
    editable: userInput && auth.canConfigure(),
  });
  const emit = () => events.emit('change', state());
  // 連携状態が変わると editable が変わる
  auth.events.on('change', () => {
    if (userInput) emit();
  });

  return {
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
      clientId = saved?.clientId ?? null;
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
      clientId = v.clientId;
      log.info('[oauth] OAuth クライアントの設定を保存しました');
      emit();
      return { ok: true };
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
      clientId = null;
      log.info('[oauth] OAuth クライアントの設定を削除しました');
      emit();
      return { ok: true };
    },
  };
}
