// キャラクターごとの声（voice）とキャラクター設定（persona：チャットの人格）。Electron に依存しない純粋関数（Phase 8・v5.9）。
//
// voice   … { speakerId, speedScale, pitchScale }。未設定（null）なら config.json の voicevox を使う（6.1）。
//           選択中のキャラクターの声を、通知・アイドルトーク・チャットのすべての読み上げに使う（F-13）
// persona … 自由記述（最大1000文字）。chatPersona.buildSystemPrompt でシステムプロンプトに組み込む（3.5）

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;
export const PITCH_MIN = -0.15;
export const PITCH_MAX = 0.15;
export const PERSONA_MAX = 1000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
// スライダー由来の浮動小数誤差を保存しない
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * 声の入力値を検証する。null / undefined は「未設定（config.json の声を使う）」。
 * @returns {{ ok: true, value: { speakerId: number, speedScale: number, pitchScale: number } | null } | { ok: false, error: { code: 'invalid_voice' } }}
 */
export function validateVoice(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!isPlainObject(raw)) return { ok: false, error: { code: 'invalid_voice' } };
  const { speakerId, speedScale = 1.0, pitchScale = 0.0 } = raw;
  if (!Number.isInteger(speakerId) || speakerId < 0) return { ok: false, error: { code: 'invalid_voice' } };
  if (!inRange(speedScale, SPEED_MIN, SPEED_MAX) || !inRange(pitchScale, PITCH_MIN, PITCH_MAX)) {
    return { ok: false, error: { code: 'invalid_voice' } };
  }
  return { ok: true, value: { speakerId, speedScale: round2(speedScale), pitchScale: round2(pitchScale) } };
}

/** 保存済みの voice を読む。壊れていれば null（config.json の声にフォールバックする）。 */
export function parseVoice(raw) {
  const r = validateVoice(raw);
  return r.ok ? r.value : null;
}

/**
 * キャラクター設定の入力値を検証する。未入力は空文字（＝従来の人格）。
 * 改行は LF にそろえ、改行・タブ以外の制御文字は取り除く。前後の空白を除いて最大1000文字。
 * @returns {{ ok: true, value: string } | { ok: false, error: { code: 'invalid_persona' } }}
 */
export function validatePersona(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: { code: 'invalid_persona' } };
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if ([...v].length > PERSONA_MAX) return { ok: false, error: { code: 'invalid_persona' } };
  return { ok: true, value: v };
}

/** 保存済みの persona を読む。壊れていれば空文字。 */
export function parsePersona(raw) {
  const r = validatePersona(raw);
  return r.ok ? r.value : '';
}

/**
 * 既定キャラクターの default-profile.json（{ voice, persona }）を読む。無い・壊れていれば未設定。
 * @returns {{ voice: object | null, persona: string }}
 */
export function parseDefaultProfile(raw) {
  const r = isPlainObject(raw) ? raw : {};
  return { voice: parseVoice(r.voice), persona: parsePersona(r.persona) };
}

/**
 * 実際に使う声。キャラクターの声があればそれ、なければ config.json の voicevox（6.1）。
 * @param {{ speakerId: number, speedScale: number, pitchScale: number } | null} characterVoice
 * @param {{ speakerId: number, speedScale: number, pitchScale: number }} globalConfig normalizeVoicevoxConfig 済み
 */
export function resolveVoiceConfig(characterVoice, globalConfig) {
  return characterVoice ? { ...characterVoice } : { ...globalConfig };
}
