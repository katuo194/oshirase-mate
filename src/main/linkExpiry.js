// Google 連携が切れた・切れそうなときのお知らせ（Phase 16）。Electron に依存しない：auth・タイマー・時刻・お知らせの表示はすべて注入する。
//
// 自分で作ったクライアント（origin 'self'）は、同意画面が「テスト」のまま（テストユーザーに自分を追加するだけで済む）なので、
// Google の仕様でリフレッシュトークンが同意から 7 日で失効する（要件定義書 付録 A-3）。そこで：
//   expiring … 同意から 6 日たったら「もうすぐ切れる」と知らせる（連携ごとに 1 回。起動し直したら、期間内ならもう一度）
//   expired  … 連携が切れたら（invalid_grant で未連携に戻ったら）知らせる。受け取ったクライアント・.env でも、切れたら知らせる
// どちらも、マスコットの右クリックメニューに「Google と連携し直す…」を出す（needsRelink）。
// 受け取ったクライアント（開発者の本番環境のプロジェクト）・.env・どちらで入れたか不明（Phase 16 より前の保存）は 7 日で切れないので予告しない。

/** テストモードのリフレッシュトークンが失効するまで（同意から） */
export const TEST_MODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** 予告するのは切れる何ミリ秒前か（6 日目） */
export const EXPIRY_WARNING_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * 予告する時刻。予告の対象でなければ null（純粋関数）。
 * @param {{ origin: string | null, linkedAt: unknown }} p
 * @returns {number | null}
 */
export function expiryWarningAt({ origin, linkedAt }) {
  if (origin !== 'self' || !Number.isFinite(linkedAt)) return null;
  return linkedAt + TEST_MODE_LIFETIME_MS - EXPIRY_WARNING_LEAD_MS;
}

/**
 * @param {object} deps
 * @param {{ getState: () => { status: string, lastError?: string | null, linkedAt?: number | null, relinking?: boolean }, events: import('node:events').EventEmitter }} deps.auth
 * @param {() => 'received' | 'self' | null} deps.getOrigin 読み込んだクライアントをどの道で入れたか（oauthClient.getOrigin）
 * @param {(kind: 'expiring' | 'expired') => void} deps.notify マスコットのお知らせ
 * @param {() => void} [deps.onChange] needsRelink が変わったとき（右クリックメニューの作り直し）
 * @param {() => number} [deps.now]
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [deps.timers]
 * @param {{ info: Function }} [deps.log]
 */
export function createLinkExpiryWatch({ auth, getOrigin, notify, onChange = () => {}, now = Date.now, timers = {}, log = console }) {
  const setT = timers.setTimeout ?? globalThis.setTimeout;
  const clearT = timers.clearTimeout ?? globalThis.clearTimeout;

  let timer = null;
  /** 予告済みの連携（linkedAt）。同じ連携で 2 回予告しない */
  let warnedFor = null;
  let needsRelink = false;
  let previousStatus = null;

  const setNeedsRelink = (value) => {
    if (needsRelink === value) return;
    needsRelink = value;
    onChange();
  };

  function warn(linkedAt) {
    timer = null;
    const s = auth.getState();
    // 予告の時刻までに連携し直した・解除した
    if (s.status !== 'linked' || s.linkedAt !== linkedAt || warnedFor === linkedAt) return;
    warnedFor = linkedAt;
    log.info('[auth] 連携の期限が近いことを知らせます（自分で作ったクライアント。テストモードのため 7 日で切れる）');
    setNeedsRelink(true);
    notify('expiring');
  }

  /** 連携の状態・クライアントの入手の道から、予告のタイマーと右クリックメニューを合わせ直す */
  function evaluate() {
    const s = auth.getState();
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }

    const prev = previousStatus;
    previousStatus = s.status;
    if (s.status === 'unconfigured') {
      setNeedsRelink(false);
      return;
    }
    // 未連携・同意の途中・起動時の確認中は、切れたときだけメニューを出す（連携し直すまで、失敗してもそのまま出しておく）
    if (s.status !== 'linked') {
      if (s.status === 'unlinked' && s.lastError === 'expired') {
        setNeedsRelink(true);
        if (prev !== 'unlinked') {
          log.info('[auth] 連携が切れたことを知らせます');
          notify('expired');
        }
      }
      return;
    }

    const at = expiryWarningAt({ origin: getOrigin(), linkedAt: s.linkedAt });
    if (at === null) {
      setNeedsRelink(false);
      return;
    }
    if (warnedFor === s.linkedAt) {
      setNeedsRelink(true); // 予告済み（連携し直すまでメニューに出す）
      return;
    }
    setNeedsRelink(false);
    const delay = at - now();
    if (delay <= 0) warn(s.linkedAt);
    else timer = setT(() => warn(s.linkedAt), delay);
  }

  const onAuthChange = () => evaluate();
  auth.events.on('change', onAuthChange);
  // 作る前に起動時の確認（auth.init）で切れていた場合も、ここで知らせる
  evaluate();

  return {
    /** クライアントの入手の道が変わったとき（oauthClient の change）に呼ぶ */
    refresh: evaluate,
    /** 右クリックメニューに「Google と連携し直す…」を出すか */
    needsRelink: () => needsRelink,
    dispose() {
      auth.events.off('change', onAuthChange);
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
