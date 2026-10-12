// VOICEVOX エンジン（localhost:50021）のスタブ。ネットワークには一切出ない。
// voicevox.js に fetch として注入する（mocks/google と同じ「呼び出し記録・失敗注入」の構え）。
//
//   const vv = createFakeVoicevox();
//   const voicevox = createVoicevox({ fetch: vv.fetch });
//
// 扱うエンドポイント（7.2）：GET /version、GET /speakers、POST /audio_query、POST /synthesis、POST /initialize_speaker

/** 16bit mono PCM の無音 WAV（durationMs の長さ）。 */
export function makeWav(durationMs, rate = 24000) {
  const samples = Math.round((rate * durationMs) / 1000);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

export const SPEAKERS = Object.freeze([
  { name: '四国めたん', speaker_uuid: 'a', styles: [{ name: 'ノーマル', id: 2 }] },
  { name: 'ずんだもん', speaker_uuid: 'b', styles: [{ name: 'ノーマル', id: 3 }, { name: 'あまあま', id: 1 }] },
]);

/** 接続拒否（VOICEVOX 未起動）と同じ形の例外。undici の fetch は TypeError('fetch failed') に cause を付ける。 */
function connectionRefused() {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:50021'), { code: 'ECONNREFUSED' });
  return err;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * @param {object} [opts]
 * @param {boolean} [opts.running] false なら全リクエストが接続拒否になる（未起動）
 * @param {string} [opts.version]
 * @param {number} [opts.wavMs] synthesis が返す音声の長さ
 */
export function createFakeVoicevox({ running = true, version = '0.21.1', wavMs = 1500 } = {}) {
  /** [{ method, path, query, body }] */
  const calls = [];
  /** path → { status, times } 次の times 回だけ HTTP エラーを返す */
  const failures = new Map();
  /** synthesis の応答を手動で解放するための待ち（合成中のミュート・中断のテスト用） */
  let hold = null;

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });

    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    if (!running) throw connectionRefused();

    const f = failures.get(u.pathname);
    if (f && f.times > 0) {
      f.times--;
      return json({ detail: 'fake failure' }, f.status);
    }

    switch (`${method} ${u.pathname}`) {
      case 'GET /version':
        return json(version);
      case 'GET /speakers':
        return json(SPEAKERS);
      case 'POST /audio_query':
        return json({
          accent_phrases: [],
          speedScale: 1,
          pitchScale: 0,
          intonationScale: 1,
          volumeScale: 1,
          prePhonemeLength: 0.1,
          postPhonemeLength: 0.1,
          outputSamplingRate: 24000,
          outputStereo: false,
          kana: u.searchParams.get('text'),
        });
      case 'POST /synthesis': {
        if (hold) {
          const gate = hold;
          await new Promise((resolve, reject) => {
            gate.release = resolve;
            init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')));
          });
        }
        return new Response(makeWav(wavMs), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }
      case 'POST /initialize_speaker': {
        const id = Number(u.searchParams.get('speaker'));
        const known = SPEAKERS.some((sp) => sp.styles.some((st) => st.id === id));
        return known ? new Response(null, { status: 204 }) : json({ detail: 'speaker not found' }, 422);
      }
      default:
        return json({ detail: 'Not Found' }, 404);
    }
  }

  return {
    fetch,
    calls,
    callsTo: (path) => calls.filter((c) => c.path === path),
    setRunning(v) {
      running = v;
    },
    failNext(path, status = 422, times = 1) {
      failures.set(path, { status, times });
    },
    /** 以降の synthesis を release() まで止める。戻り値の release() で解放 */
    holdSynthesis() {
      hold = { release: null };
      const h = hold;
      return {
        release: () => {
          hold = null;
          h.release?.();
        },
      };
    },
  };
}
