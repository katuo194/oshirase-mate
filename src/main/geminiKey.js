// Gemini APIキーの管理（3.5 / 3.6）。apiKeyStorage.js（暗号化保存）の上に「設定済みかどうか」のキャッシュと変更イベントを載せる。
// キャッシュがあるのは、トレイ／右クリックメニューの「話しかける」の有効・無効が同期的に決まる必要があるため（メニュー生成は同期）。
// キー本体はこのモジュールの外へ出さない（getKey は main の Gemini クライアントだけが使う。レンダラーには状態のみ渡す）。
// Electron に依存しない：safeStorage とファイルは apiKeyStorage 側で注入される。

import { EventEmitter } from 'node:events';
import { validateApiKey } from './apiKeyStorage.js';

/**
 * @param {object} opts
 * @param {ReturnType<import('./apiKeyStorage.js').createApiKeyStorage>} opts.storage
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createGeminiKey({ storage, log = console }) {
  const events = new EventEmitter();
  let configured = false;

  const state = () => ({ configured });
  const setConfigured = (next) => {
    if (next === configured) return;
    configured = next;
    events.emit('change', state());
  };

  return {
    events,
    getState: state,
    isConfigured: () => configured,

    /** 起動時に保存済みキーの有無を確認する（キー本体は保持しない）。 */
    async init() {
      try {
        setConfigured((await storage.load()) !== null);
      } catch (e) {
        log.warn(`[chat] Gemini APIキーを読み込めません: ${e?.code ?? e?.name ?? 'error'}`);
        setConfigured(false);
      }
    },

    /** Gemini クライアント用：保存済みキー（未設定なら null）。 */
    getKey: () => storage.load(),

    /**
     * 設定画面からのキー保存。検証（前後の空白除去・文字種・長さ）を通ったものだけを暗号化して保存する。
     * @returns {Promise<{ ok: true } | { ok: false, reason: 'empty' | 'too_short' | 'too_long' | 'invalid_chars' | 'save_failed' }>}
     */
    async set(input) {
      const v = validateApiKey(input);
      if (!v.ok) return v;
      try {
        await storage.save(v.key);
      } catch (e) {
        log.warn(`[chat] Gemini APIキーを保存できません: ${e?.message ?? e}`);
        return { ok: false, reason: 'save_failed' };
      }
      setConfigured(true);
      log.info('[chat] Gemini APIキーを保存しました');
      return { ok: true };
    },

    async clear() {
      try {
        await storage.remove();
      } catch (e) {
        log.warn(`[chat] Gemini APIキーを削除できません: ${e?.message ?? e}`);
        return { ok: false };
      }
      setConfigured(false);
      log.info('[chat] Gemini APIキーを削除しました');
      return { ok: true };
    },
  };
}
