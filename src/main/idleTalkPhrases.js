// アイドルトークの定型文（3.4・合計30種）。Electron に依存しない純粋なデータ。
//
// キャラクター性（v5.8）：親しみやすい友だち口調（敬語なし・語尾「〜だよ／〜ね／〜かな」）。
// 一人称・名前・呼びかけは使わない（EmoteLab の別キャラへ差し替わっても、そのまま使えるようにするため）。
// 絵文字・顔文字は使わない（VOICEVOX が読めないため）。吹き出し（3行まで）に収まるよう 30 字以内。
// v5.16（Phase 13・F-22）：キャラクターごとにアイドルトークの文を設定でき（characterLines.js）、ここの文は設定の無い種類の既定になる。

/** 1文の最大長（吹き出しは idle 表示で3行＝約40字まで。余裕を見て30字）。 */
export const PHRASE_MAX_LENGTH = 30;

export const MORNING_PHRASES = Object.freeze([
  'おはよう。今日もゆっくり始めていこうね。',
  'おはよう！今日の予定はもう見たかな？',
  'おはよう。朝ごはんは食べた？',
  '朝だね。まずは深呼吸してみよう。',
  'おはよう。今日もよろしくね。',
]);

export const BEDTIME_PHRASES = Object.freeze([
  'もうこんな時間。そろそろ休もうか。',
  '今日もおつかれさま。ゆっくり休んでね。',
  '夜ふかしはほどほどにね。',
  '明日の予定は大丈夫かな？早めに寝ようね。',
  'そろそろおやすみの時間だよ。',
]);

/** 通常アイドルトーク（20種）の内訳。 */
export const MONOLOGUE_PHRASES = Object.freeze([
  'ふわぁ…ちょっとぼーっとしちゃった。',
  '今日はなんだか静かだなあ。',
  'ここ、あったかくて落ち着くなあ。',
  'むにゃ…少し眠ってたかも。',
  'ふんふんふ〜ん。今日も平和だなあ。',
]);

export const CALLING_PHRASES = Object.freeze([
  'ねえ、ちょっと肩の力を抜いてみない？',
  '水分とってる？のどが乾く前にひと口どうぞ。',
  'ずっと座りっぱなしだよ。少し立ってみよう。',
  '目を休めよう。遠くを見てゆっくりまばたきしてね。',
  'がんばってるね。えらいよ。',
  '予定があるときは、ちゃんと知らせるからね。',
  'ぐーっと伸びをしよう。気持ちいいよ。',
  'おしゃべりしたくなったら、右クリックから話しかけてね。',
  '大事な予定は、ちゃんと見張ってるよ。',
  'たまには窓を開けて、空気を入れかえようよ。',
]);

export const QUESTION_PHRASES = Object.freeze([
  'ねえ、今日はどんな一日だった？',
  '何かあたたかい飲み物はいかが？',
  '今どんなことをしてるの？',
  '最近、ちゃんと眠れてる？',
  'ひと休みしたくならない？',
]);

/** 通常アイドルトーク20種（独り言5＋話しかけてくる系10＋疑問形5）。1つの袋として選ぶ（phrasePicker.js）。 */
export const NORMAL_PHRASES = Object.freeze([...MONOLOGUE_PHRASES, ...CALLING_PHRASES, ...QUESTION_PHRASES]);

/** カテゴリ名 → 文面。 */
export const PHRASE_SETS = Object.freeze({
  morning: MORNING_PHRASES,
  bedtime: BEDTIME_PHRASES,
  normal: NORMAL_PHRASES,
});
