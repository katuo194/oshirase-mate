// 重要でないメールのサマリ通知（F-02b / 2.1 / 6章）。未読件数の差分だけを管理する。
//
// 個別通知ではないので notifyQueue も notified.json も通らない。アニメーションは発生させず、
// 表示中のサマリを最新の件数に差し替えるだけ（Phase 5 の描画側が購読する）。
// 件数は毎回のポーリングで取り直せるため永続化しない。再起動後の最初のポーリングが基準値になる
// （7.1「初回起動時は既存の未読をすべて通知済み扱いにする」と同じ考え方）。

import { EventEmitter } from 'node:events';

const isCount = (v) => Number.isFinite(v) && v >= 0;

/**
 * @param {object} [opts]
 * @param {number|null} [opts.initialCount] 基準値を与えて始める場合（通常は null＝初回ポーリングで決める）
 */
export function createMailSummary({ initialCount = null } = {}) {
  // 'updated'：基準値の確定（initial）と件数の変化（increased / decreased）のときだけ発火する（unchanged / invalid では発火しない）。
  // ペイロードは update() の戻り値。Phase 5 の描画側とログコンシューマーがここを購読する（notifyQueue.events と同じ方式）。
  // 'reset'：連携解除などで状態を捨てたとき。ペイロードは reset 後の表示（0件・非表示）。描画側はバッジを消す。
  const events = new EventEmitter();

  let count = isCount(initialCount) ? initialCount : null;
  /** 件数が数え上げの上限に達している（実際はそれ以上）。表示は「2500+件」 */
  let capped = false;

  /** @returns {{ count: number, capped: boolean, text: string, visible: boolean }} 現在のサマリ表示 */
  const view = () => ({
    count: count ?? 0,
    capped,
    text: `${count ?? 0}${capped ? '+' : ''}件`,
    visible: (count ?? 0) > 0,
  });

  return {
    events,

    /**
     * 新しい未読件数を反映する。
     *
     * kind:
     *   initial   … 初回。基準値を置くだけで通知しない
     *   increased … 増えた（新着あり）
     *   decreased … 減った（別端末で既読にした等。表示は追随するが新着ではない）
     *   unchanged … 変化なし
     *   invalid   … 件数として読めない値（前回値を保つ）
     *
     * @param {number} next
     * @param {{ capped?: boolean }} [opts] capped：next が数え上げの上限で頭打ち（実際はそれ以上）。差分は next の数値どうしで判定する
     * @returns {{ changed: boolean, kind: string, count: number, capped: boolean, previous: number|null, delta: number, text: string, visible: boolean }}
     */
    update(next, { capped: isCapped = false } = {}) {
      if (!isCount(next)) {
        return { changed: false, kind: 'invalid', previous: count, delta: 0, ...view() };
      }
      const previous = count;
      count = next;
      capped = isCapped === true;

      if (previous === null) {
        const result = { changed: false, kind: 'initial', previous, delta: 0, ...view() };
        events.emit('updated', { ...result });
        return result;
      }
      const delta = next - previous;
      const kind = delta > 0 ? 'increased' : delta < 0 ? 'decreased' : 'unchanged';
      const result = { changed: delta !== 0, kind, previous, delta, ...view() };
      if (result.changed) events.emit('updated', { ...result });
      return result;
    },

    /** 現在のサマリ表示。まだ一度も取得していなければ 0件・非表示。 */
    get: view,

    /** まだ基準値を持っていないか（初回ポーリング前）。 */
    isSeeded: () => count !== null,

    /** 連携解除・再連携時に初回状態へ戻す。'reset' を発火する（バッジを消すため。'updated' は発火しない）。 */
    reset() {
      count = null;
      capped = false;
      events.emit('reset', { ...view() });
    },
  };
}
