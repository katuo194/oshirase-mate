// VOICEVOX（localhost:50021）への音声合成リクエスト（F-13・7.2。個人版・共有版とも：v5.11）。Electron に依存しない：fetch とログは注入する。
//
//   GET  /version       … 起動確認（毎回の読み上げの前にも行う。未起動なら合成に進まない）
//   GET  /speakers      … 話者名（クレジット表記「VOICEVOX:〈話者名〉」用。7.2 ライセンス注意）
//   POST /audio_query   … text・speaker からクエリ（JSON）を作る
//   POST /synthesis     … クエリの speedScale / pitchScale / volumeScale を設定値で上書きして WAV を得る
//   POST /initialize_speaker … 話者のモデルを先に読み込ませる（warmUp。VOICEVOX 起動直後の初回合成が遅くならないように）
//
// 合成・先読みは1件ずつ送る（通知とチャットの読み上げで共有する1つの待ち行列）。VOICEVOX は接続を切られても合成を最後まで
// 続けるため、呼び出し側が中断しても送信済みの要求は完了（またはタイムアウト）まで枠を占有し、次の要求はその後に送る
// （中断した要求の後ろに次の要求が積み重なり、次々にタイムアウトするのを防ぐ）。まだ送っていない要求は中断で取り消す。
// CPU モードの VOICEVOX では1件に10秒以上かかることがあるため、合成の待ち時間の上限は表示の上限（MAX_VOICE_HOLD_MS）と同じ20秒。
//
// 接続状態（設定画面の表示・警告用）：
//   unknown     … まだ確認していない
//   available   … 起動している（version / speakerName）
//   unavailable … 応答がない（未起動）。読み上げはサイレントにスキップする
//   error       … 起動しているが合成に失敗した（話者IDが無効など。reason に内容）
// 状態が変わったときだけ 'change' を発火し、ログも変わったときだけ出す（通知ごとに警告を並べない）。

import { EventEmitter } from 'node:events';

export const DEFAULT_BASE_URL = 'http://localhost:50021';
export const VOICEVOX_DEFAULTS = Object.freeze({ speakerId: 3, speedScale: 1.0, pitchScale: 0.0 });

/** 起動確認（/version・/speakers）の待ち時間。未起動時は接続拒否で即座に返るので、これは応答が固まったとき用 */
export const CHECK_TIMEOUT_MS = 1500;
/** audio_query ＋ synthesis の合計の待ち時間（notificationView.MAX_VOICE_HOLD_MS と同じ。これより遅い音声は表示に間に合わない） */
export const SYNTH_TIMEOUT_MS = 20000;
/** 話者の先読み（/initialize_speaker）の待ち時間。モデルの読み込みは数秒〜十数秒かかる */
export const WARMUP_TIMEOUT_MS = 30000;

const num = (v, min, max, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback);

/**
 * config.json の voicevox（6.1）の読み出し用正規化（読み取り専用。話者選択UIは持たない）。
 * @returns {{ speakerId: number, speedScale: number, pitchScale: number }}
 */
export function normalizeVoicevoxConfig(raw) {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    speakerId: Number.isInteger(r.speakerId) && r.speakerId >= 0 ? r.speakerId : VOICEVOX_DEFAULTS.speakerId,
    speedScale: num(r.speedScale, 0.5, 2.0, VOICEVOX_DEFAULTS.speedScale),
    pitchScale: num(r.pitchScale, -0.15, 0.15, VOICEVOX_DEFAULTS.pitchScale),
  };
}

/**
 * WAV の再生時間（ms）。RIFF のチャンクを辿って fmt の byteRate と data の長さから求める。解釈できなければ null。
 * @param {Buffer} buf
 */
export function wavDurationMs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const bytes = Math.min(size, buf.length - offset - 8);
      return Math.round((bytes / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2); // チャンクは偶数境界
  }
  return null;
}

export class VoicevoxError extends Error {
  /**
   * @param {'unavailable' | 'error' | 'aborted'} kind
   * @param {string} message
   */
  constructor(kind, message) {
    super(message);
    this.name = 'VoicevoxError';
    this.kind = kind;
  }
}

const isAbort = (e) => e?.name === 'AbortError';

/** 呼び出し側の中断と、タイムアウトを合わせたシグナル。 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * @param {object} opts
 * @param {typeof globalThis.fetch} opts.fetch
 * @param {string} [opts.baseUrl]
 * @param {{ info: Function, warn: Function }} [opts.log]
 */
export function createVoicevox({ fetch, baseUrl = DEFAULT_BASE_URL, log = console }) {
  const events = new EventEmitter();
  /** @type {{ status: 'unknown' } | { status: 'available', version: string, speakerId: number, speakerName: string | null } | { status: 'unavailable' } | { status: 'error', reason: string }} */
  let state = { status: 'unknown' };
  /** 重い要求（audio_query・synthesis・initialize_speaker）を送信中か。この間は VOICEVOX の応答が遅れる */
  let busy = false;
  /** 合成・先読みの待ち行列の末尾（これが終わったら次を送る） */
  let tail = Promise.resolve();

  /**
   * 重い要求を1件ずつ実行する。signal が中断されたら aborted で返す：まだ始まっていなければ取り消し、
   * 始まっていれば結果を待たずに返す（始まった work は VOICEVOX 側で続くので、完了まで枠を占有する）。
   * @template T
   * @param {() => Promise<T>} work
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  function exclusive(work, signal) {
    const run = tail.then(async () => {
      if (signal?.aborted) return { skipped: true };
      try {
        return { value: await work() };
      } catch (error) {
        return { error };
      }
    });
    tail = run;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new VoicevoxError('aborted', 'aborted'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      void run.then((r) => {
        signal?.removeEventListener('abort', onAbort);
        if (r.skipped || signal?.aborted) onAbort();
        else if ('error' in r) reject(r.error);
        else resolve(r.value);
      });
    });
  }

  function setState(next) {
    const same = JSON.stringify(next) === JSON.stringify(state);
    state = next;
    if (same) return;
    if (next.status === 'available') log.info(`[voicevox] 接続しました（v${next.version}・${next.speakerName ?? `話者ID ${next.speakerId}`}）`);
    else if (next.status === 'unavailable') log.warn('[voicevox] VOICEVOXが見つかりません。読み上げはスキップします（起動すると次の通知から有効になります）');
    else if (next.status === 'error') log.warn(`[voicevox] 読み上げに失敗しました: ${next.reason}`);
    events.emit('change', { ...state });
  }

  async function getJson(pathname, signal) {
    const res = await fetch(`${baseUrl}${pathname}`, { signal });
    if (!res.ok) throw new VoicevoxError('error', `${pathname} ${res.status}`);
    return res.json();
  }

  /** 話者IDから「キャラ名（スタイル名）」。見つからなければ null。 */
  async function lookupSpeakerName(speakerId, signal) {
    const speakers = await getJson('/speakers', signal);
    for (const sp of Array.isArray(speakers) ? speakers : []) {
      const style = (sp.styles ?? []).find((s) => s.id === speakerId);
      if (style) return { name: sp.name, style: style.name };
    }
    return null;
  }

  /**
   * 起動確認。/version に応答があれば available（話者名も取る）、なければ unavailable。
   * @param {{ speakerId: number }} config
   * @param {{ signal?: AbortSignal }} [opts]
   */
  async function checkStatus({ speakerId }, { signal } = {}) {
    let version;
    try {
      version = await getJson('/version', withTimeout(signal, CHECK_TIMEOUT_MS));
    } catch (e) {
      if (signal?.aborted) throw new VoicevoxError('aborted', 'aborted');
      // 自分の合成・先読みの最中は VOICEVOX の応答が遅れる。未起動と取り違えないよう、タイムアウトなら状態を変えない
      if (busy && e?.name === 'TimeoutError') return getState();
      setState({ status: 'unavailable' });
      return getState();
    }
    // 話者名は同じ話者で確認済みなら取り直さない
    if (state.status === 'available' && state.speakerId === speakerId && state.version === String(version)) return getState();
    let speaker = null;
    try {
      speaker = await lookupSpeakerName(speakerId, withTimeout(signal, CHECK_TIMEOUT_MS));
      if (speaker === null) {
        // 一覧は取れたのに見つからない＝話者IDが無効
        setState({
          status: 'error',
          reason: `話者ID ${speakerId} が見つかりません（キャラクターの声、または config.json の voicevox.speakerId を確認してください）`,
        });
        return getState();
      }
    } catch (e) {
      if (signal?.aborted) throw new VoicevoxError('aborted', 'aborted');
      // 話者一覧が取れなくても読み上げ自体は試せる（名前なしで available）
    }
    setState({
      status: 'available',
      version: String(version),
      speakerId,
      speakerName: speaker ? `${speaker.name}（${speaker.style}）` : null,
    });
    return getState();
  }

  /**
   * 1件を合成して WAV を返す（7.2 の疑似コード）。先に起動確認し、未起動なら unavailable で投げる。
   * 待ち行列の順番を待ってから送る。中断（signal）はすぐ aborted で返る（送信済みなら VOICEVOX 側の完了まで次の要求は待つ）。
   * @param {string} text
   * @param {{ speakerId: number, speedScale: number, pitchScale: number, volumeScale?: number }} params
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<Buffer>}
   */
  function synthesize(text, params, { signal } = {}) {
    return exclusive(() => synthesizeNow(text, params, signal), signal);
  }

  /** 待ち行列の順番が来てからの合成。VOICEVOX 側で止められないので、送信後は呼び出し側の中断では fetch を切らない */
  async function synthesizeNow(text, { speakerId, speedScale, pitchScale, volumeScale = 1.0 }, signal) {
    const checked = await checkStatus({ speakerId });
    if (checked.status === 'unavailable') throw new VoicevoxError('unavailable', 'VOICEVOX not running');
    if (checked.status === 'error') throw new VoicevoxError('error', checked.reason);
    if (signal?.aborted) throw new VoicevoxError('aborted', 'aborted'); // 確認の間に中断された：まだ合成は送っていない

    const s = AbortSignal.timeout(SYNTH_TIMEOUT_MS);
    busy = true;
    try {
      const q = await fetch(`${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, { method: 'POST', signal: s });
      if (!q.ok) throw new VoicevoxError('error', `audio_query ${q.status}`);
      const query = await q.json();

      Object.assign(query, { speedScale, pitchScale, volumeScale });

      const res = await fetch(`${baseUrl}/synthesis?speaker=${speakerId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal: s,
      });
      if (!res.ok) throw new VoicevoxError('error', `synthesis ${res.status}`);
      return Buffer.from(await res.arrayBuffer()); // WAV
    } catch (e) {
      if (signal?.aborted) throw new VoicevoxError('aborted', 'aborted'); // 呼び出し側の中断（表示が終わった）は状態を変えない
      const err = e instanceof VoicevoxError ? e : new VoicevoxError(isAbort(e) || e?.name === 'TimeoutError' ? 'error' : 'unavailable', e?.message ?? String(e));
      if (err.kind === 'unavailable') setState({ status: 'unavailable' });
      else setState({ status: 'error', reason: e?.name === 'TimeoutError' ? '合成がタイムアウトしました' : err.message });
      throw err;
    } finally {
      busy = false;
    }
  }

  /**
   * 話者のモデルを先に読み込ませる（起動時・声を変えたとき）。VOICEVOX を起動した直後は、その話者の初回の合成でモデルを読み込むため遅い。
   * 起動していなければ何もしない。失敗しても読み上げ時に改めて読み込まれるだけなので、状態は変えず結果だけ返す。
   * 合成と同じ待ち行列に入る（先読み中の読み上げは、先読みの完了後に送る）。
   * @param {{ speakerId: number }} config
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<boolean>} 先読みできたか
   */
  function warmUp({ speakerId }, { signal } = {}) {
    return exclusive(async () => {
      const checked = await checkStatus({ speakerId });
      if (checked.status !== 'available' || signal?.aborted) return false;
      busy = true;
      try {
        const res = await fetch(`${baseUrl}/initialize_speaker?speaker=${speakerId}&skip_reinit=true`, {
          method: 'POST',
          signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        busy = false;
      }
    }, signal).catch(() => false);
  }

  function getState() {
    return { ...state };
  }

  /**
   * 話者の一覧（キャラクターの声の選択用。Phase 8）。起動していなければ unavailable で投げる。
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ name: string, styles: { id: number, name: string }[] }[]>}
   */
  async function listSpeakers({ signal } = {}) {
    let speakers;
    try {
      speakers = await getJson('/speakers', withTimeout(signal, CHECK_TIMEOUT_MS));
    } catch (e) {
      if (signal?.aborted) throw new VoicevoxError('aborted', 'aborted');
      throw e instanceof VoicevoxError ? e : new VoicevoxError('unavailable', e?.message ?? String(e));
    }
    const out = [];
    for (const sp of Array.isArray(speakers) ? speakers : []) {
      if (typeof sp?.name !== 'string') continue;
      const styles = (Array.isArray(sp.styles) ? sp.styles : [])
        .filter((st) => Number.isInteger(st?.id) && st.id >= 0 && typeof st.name === 'string')
        .map((st) => ({ id: st.id, name: st.name }));
      if (styles.length > 0) out.push({ name: sp.name, styles });
    }
    return out;
  }

  return { events, getState, checkStatus, synthesize, warmUp, listSpeakers };
}
