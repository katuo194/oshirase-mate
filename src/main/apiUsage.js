// Google API の呼び出し回数の実測（4章「API制限」・8章 Phase 4 完了条件）。
// メソッド別の回数とクォータ消費の概算を数え、定期的にログへ出す。Electron に依存しない。
//
// 失敗した呼び出しも数える（Google 側のクォータには失敗も乗るため）。
// 単位：Calendar / Tasks は「リクエスト数」、Gmail は「クォータユニット」（users.messages.list / get は各5）。

/** メソッド名 → 1回あたりのクォータ消費。載っていないメソッドは 1。 */
export const QUOTA_UNITS = Object.freeze({
  'gmail.users.messages.list': 5,
  'gmail.users.messages.get': 5,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 'calendar.events.list' → 'calendar' */
const serviceOf = (method) => method.split('.')[0];

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 */
export function createApiUsage({ now = Date.now } = {}) {
  const startedAt = now();
  /** @type {Map<string, { calls: number, failures: number, units: number }>} */
  const byMethod = new Map();

  return {
    /**
     * 1回の呼び出しを記録する。
     * @param {string} method 'calendar.events.list' など
     * @param {{ ok?: boolean }} [result]
     */
    record(method, { ok = true } = {}) {
      const rec = byMethod.get(method) ?? { calls: 0, failures: 0, units: 0 };
      rec.calls++;
      if (!ok) rec.failures++;
      rec.units += QUOTA_UNITS[method] ?? 1;
      byMethod.set(method, rec);
    },

    /**
     * 集計を返す。perDay は経過時間から24時間に換算した値（起動直後は誤差が大きいので elapsedMs も返す）。
     * @returns {{ elapsedMs: number, methods: Array<{ method: string, service: string, calls: number, failures: number, units: number, unitsPerDay: number }>, services: Record<string, { calls: number, units: number, unitsPerDay: number }> }}
     */
    snapshot() {
      const elapsedMs = Math.max(now() - startedAt, 1);
      const scale = DAY_MS / Math.max(elapsedMs, HOUR_MS / 60); // 1分未満の経過では換算しない（極端な値を避ける）
      const methods = [...byMethod.entries()]
        .map(([method, r]) => ({
          method,
          service: serviceOf(method),
          calls: r.calls,
          failures: r.failures,
          units: r.units,
          unitsPerDay: Math.round(r.units * scale),
        }))
        .sort((a, b) => a.method.localeCompare(b.method));

      const services = {};
      for (const m of methods) {
        const s = (services[m.service] ??= { calls: 0, units: 0, unitsPerDay: 0 });
        s.calls += m.calls;
        s.units += m.units;
        s.unitsPerDay += m.unitsPerDay;
      }
      return { elapsedMs, methods, services };
    },

    /** ログ用の複数行テキスト。 */
    format() {
      const { elapsedMs, methods, services } = this.snapshot();
      const minutes = Math.round(elapsedMs / 60000);
      const lines = [`[apiUsage] 起動から${minutes}分の集計（1日換算は概算）`];
      for (const m of methods) {
        lines.push(
          `  ${m.method}: ${m.calls}回（失敗${m.failures}）/ ${m.units}${m.service === 'gmail' ? 'ユニット' : 'リクエスト'} → 1日換算 約${m.unitsPerDay}`,
        );
      }
      for (const [name, s] of Object.entries(services)) {
        lines.push(`  合計 ${name}: ${s.units}（1日換算 約${s.unitsPerDay}）`);
      }
      return lines.join('\n');
    },
  };
}
