// アイドルトークのトリガー判定（F-15 / 3.4）。Electron に依存しない：時刻・タイマー・乱数・表示は注入する。
//
// 仕組み：setTimeout を1本だけ張る（最終操作＋間隔）。操作（touch）のたびに張り直すので、常時ポーリングはしない（待機CPUを増やさない）。
//   発火時に判定 → 静粛時間帯なら明けまで待つ／表示できない（通知表示中など）なら1分後に再試行／表示できたら発話時刻から再武装する。
//
// 「操作」はアプリ内の操作（v5.8）：ドラッグ・右クリックメニュー・設定／チャットを開く・チャット送信・通知の表示終了・直前のアイドルトーク発話。
//   OS 全体の入力ではない（離席中にだけ話す挙動になり、意味が薄いため）。呼び出し元が touch() を配線する。
//
// カテゴリの優先順：静粛時間帯（発話しない）→ 就寝前 → 朝 → 通常。
//   就寝前：静粛時間帯の開始の直前1時間の、その日最初の発話（既定 23:00〜0:00）
//   朝    ：その日最初の発話が 5:00〜10:00 のとき。静粛時間帯（既定 0:00〜6:00）が優先するので、実際に出るのは 6:00〜10:00
// 「その日」はローカル日付。状態はメモリのみ。

export const IDLE_TALK_DEFAULTS = Object.freeze({ enabled: true, intervalMin: 15, quietHours: Object.freeze([0, 6]) });

/** 誤設定で連発しない／極端に待たせないための範囲（分）。 */
export const MIN_INTERVAL_MIN = 1;
export const MAX_INTERVAL_MIN = 240;
/** 表示できなかった（通知表示中など）ときの再試行間隔。 */
export const BUSY_RETRY_MS = 60 * 1000;
/** 朝の挨拶の時間帯 [start, end)。 */
export const MORNING_HOURS = Object.freeze([5, 10]);
/** 静粛時間帯の明けの判定にかける余裕（タイマーが境界の直前に発火しないように）。 */
const QUIET_END_SLACK_MS = 1000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isHour = (v) => Number.isInteger(v) && v >= 0 && v <= 23;

/**
 * config.json の idleTalk（6.1）の読み出し用の正規化。読み取り専用（設定画面からは変更しない）。
 * @param {unknown} raw
 * @returns {{ enabled: boolean, intervalMin: number, quietHours: [number, number] }}
 */
export function normalizeIdleTalkConfig(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const q = Array.isArray(r.quietHours) && r.quietHours.length === 2 && isHour(r.quietHours[0]) && isHour(r.quietHours[1]) ? r.quietHours : IDLE_TALK_DEFAULTS.quietHours;
  const m = r.intervalMin;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : IDLE_TALK_DEFAULTS.enabled,
    intervalMin: typeof m === 'number' && Number.isFinite(m) ? Math.min(MAX_INTERVAL_MIN, Math.max(MIN_INTERVAL_MIN, Math.round(m))) : IDLE_TALK_DEFAULTS.intervalMin,
    quietHours: [q[0], q[1]],
  };
}

/** 静粛時間帯 [start, end) か。start > end は日跨ぎ（例 [22, 6]）。start === end は静粛なし。 */
export function isQuietHour(hour, [start, end]) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 就寝前の時間帯（静粛時間帯の開始の直前1時間）に入っているか。静粛なし（start === end）なら常に false。 */
export function isBedtimeHour(hour, [start, end]) {
  if (start === end) return false;
  return hour === (start + 23) % 24;
}

export function isMorningHour(hour) {
  return hour >= MORNING_HOURS[0] && hour < MORNING_HOURS[1];
}

const pad2 = (n) => String(n).padStart(2, '0');
/** ローカル日付のキー。 */
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * 発話のカテゴリを決める（純粋関数）。
 * @param {{ hour: number, quietHours: [number, number], day: { talked: boolean, bedtimeDone: boolean } }} p
 * @returns {'quiet' | 'bedtime' | 'morning' | 'normal'}
 */
export function decideCategory({ hour, quietHours, day }) {
  if (isQuietHour(hour, quietHours)) return 'quiet';
  if (!day.bedtimeDone && isBedtimeHour(hour, quietHours)) return 'bedtime';
  if (!day.talked && isMorningHour(hour)) return 'morning';
  return 'normal';
}

/** 静粛時間帯が明けるまでの ms（次に end 時 0 分になるまで＋余裕）。 */
export function msUntilQuietEnd(nowMs, [, end]) {
  const t = new Date(nowMs);
  t.setHours(end, 0, 0, 0);
  if (t.getTime() <= nowMs) t.setDate(t.getDate() + 1);
  return t.getTime() - nowMs + QUIET_END_SLACK_MS;
}

/**
 * @param {object} opts
 * @param {() => { enabled: boolean, intervalMin: number, quietHours: [number, number] }} opts.getConfig
 * @param {(category: 'morning' | 'bedtime' | 'normal') => string} opts.pickPhrase 文面の選択（phrasePicker.js）
 * @param {(talk: { category: string, text: string }) => boolean} opts.show 表示を試みる。受理されたら true（通知表示中などで断られたら false）
 * @param {() => number} [opts.now]
 * @param {{ setTimeout?: Function, clearTimeout?: Function }} [opts.timers] テストでは fake timers が入る
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createIdleTalk({ getConfig, pickPhrase, show, now = Date.now, timers = {}, log = console }) {
  const setTimer = timers.setTimeout ?? ((...a) => globalThis.setTimeout(...a));
  const clearTimer = timers.clearTimeout ?? ((...a) => globalThis.clearTimeout(...a));

  let started = false;
  let timer = null;
  let lastActivityAt = now();
  /** その日の状態（ローカル日付が変わったらリセット） */
  let day = { key: dayKey(now()), talked: false, bedtimeDone: false };

  function rollDay() {
    const key = dayKey(now());
    if (day.key !== key) day = { key, talked: false, bedtimeDone: false };
  }

  function schedule(delayMs) {
    clearTimer(timer);
    timer = setTimer(tick, Math.max(0, delayMs));
  }

  /** 最終操作＋間隔まで待つ。 */
  function arm() {
    if (!started) return;
    const { intervalMin } = getConfig();
    schedule(lastActivityAt + intervalMin * 60 * 1000 - now());
  }

  /** 表示を試み、受理されたら状態を進める。 */
  function speak(category) {
    const text = pickPhrase(category);
    const accepted = show({ category, text });
    if (!accepted) return false;
    day.talked = true;
    if (category === 'bedtime') day.bedtimeDone = true;
    lastActivityAt = now(); // 発話も「最終操作」：次は間隔の後
    log.info(`[idle] アイドルトーク（${category}）: ${text}`);
    return true;
  }

  function tick() {
    timer = null;
    if (!started) return;
    rollDay();
    const cfg = getConfig();

    if (!cfg.enabled) {
      lastActivityAt = now();
      arm();
      return;
    }
    if (now() < lastActivityAt + cfg.intervalMin * 60 * 1000) {
      arm(); // タイマーが早く発火した・操作で延びた
      return;
    }

    const category = decideCategory({ hour: new Date(now()).getHours(), quietHours: cfg.quietHours, day });
    if (category === 'quiet') {
      schedule(msUntilQuietEnd(now(), cfg.quietHours));
      return;
    }
    if (speak(category)) arm();
    else schedule(BUSY_RETRY_MS); // 通知表示中・ドラッグ中など。状態は消費せず再試行
  }

  return {
    start() {
      if (started) return;
      started = true;
      lastActivityAt = now();
      arm();
    },

    stop() {
      started = false;
      clearTimer(timer);
      timer = null;
    },

    /** アプリ内の操作があった（最終操作を今にして張り直す）。スリープ復帰・チャット中の再武装にも使う。 */
    touch() {
      lastActivityAt = now();
      arm();
    },

    /**
     * 開発用：間隔・静粛時間帯を無視して、指定カテゴリを今すぐ表示する（状態は進めない）。
     * @returns {boolean} 受理されたか
     */
    fireNow(category = 'normal') {
      const text = pickPhrase(category);
      const accepted = show({ category, text });
      if (accepted) log.info(`[idle] アイドルトーク（開発・${category}）: ${text}`);
      return accepted;
    },
  };
}
