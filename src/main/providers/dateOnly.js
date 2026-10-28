// 「日付だけ」を表すGoogleの値を、ローカル時刻に変換する（7.1）。
// カレンダーの終日予定（start.date = "2026-09-21"）と Google Tasks の due（"2026-09-21T00:00:00.000Z"）の
// 両方がこのルールを必要とするため、1箇所に集約してある。ここを間違えると通知が1日ずれる。

/**
 * 日付文字列の**日付部分だけ**を取り出し、ローカルのその日の指定時刻を返す。
 *
 * `new Date(value)` でローカル時刻に変換してから日付を取ってはいけない。
 * Tasks の due は常にUTC 0時のタイムスタンプなので、UTCより西のタイムゾーン（例 UTC-5）では
 * ローカル変換すると前日になり、通知が1日早まる。文字列の先頭10文字をそのまま日付として使う。
 *
 * @param {string} value "YYYY-MM-DD" または "YYYY-MM-DDTHH:mm:ss.sssZ"
 * @param {number} hour ローカルの時（終日予定なら0、TODOなら taskNotifyHour）
 * @param {number} [minute] ローカルの分（TODOなら taskNotifyMinute）
 * @returns {number | null} エポックms。日付として読めなければ null
 */
export function localTimeOnDate(value, hour, minute = 0) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), hour, minute, 0, 0);
  // 2026-02-30 のような存在しない日付は Date が繰り上げてしまうので弾く
  if (t.getMonth() !== Number(mo) - 1 || t.getDate() !== Number(d)) return null;
  return t.getTime();
}

/** 日付文字列から "YYYY-MM-DD" の日付部分だけを取り出す（通知IDの構成要素に使う）。 */
export function dateKey(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}
