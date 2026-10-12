// 仮の効果音（F-12 の動作確認用）を assets/sounds/ に生成する。Node のみ・外部依存なし。
//
//   node scripts/generate-placeholder-sfx.mjs [--force]
//
// 本素材（フリー素材や生成AIツールで制作したもの。要件 2.7）ができたら、同じファイル名
//   notify_calendar / notify_tasks / notify_gmail（拡張子は mp3 / wav / ogg）
// で置き換える。mp3 は wav より先に探されるので、mp3 を置けばこの仮素材は使われなくなる。
// 既存ファイルは --force を付けない限り上書きしない（本素材を消さないため）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');
const RATE = 44100;
const force = process.argv.includes('--force');

/** 1音：サイン波＋倍音、立ち上がり5ms・指数減衰のベル風。 */
function note(freq, durationSec, gain = 0.5) {
  const n = Math.round(RATE * durationSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.005);
    const decay = Math.exp(-t * (4 / durationSec));
    const wave = Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2 * t);
    out[i] = (wave / 1.3) * attack * decay * gain;
  }
  return out;
}

const silence = (sec) => new Float32Array(Math.round(RATE * sec));

/** 音の並びを、各音の開始時刻（秒）に重ねて1本にする。 */
function sequence(parts) {
  const total = Math.max(...parts.map(({ at, samples }) => Math.round(at * RATE) + samples.length));
  const out = new Float32Array(total);
  for (const { at, samples } of parts) {
    const offset = Math.round(at * RATE);
    for (let i = 0; i < samples.length; i++) out[offset + i] += samples[i];
  }
  return out;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// 種別ごとに音の並びを変える（聞き分けられるように）
const SOUNDS = {
  // カレンダー：上昇する2音のチャイム（E5 → A5）
  notify_calendar: sequence([
    { at: 0, samples: note(659.25, 0.45) },
    { at: 0.16, samples: note(880, 0.6) },
  ]),
  // TODO：やわらかい単音（C5 → E5 の短いスラー）
  notify_tasks: sequence([
    { at: 0, samples: note(523.25, 0.4, 0.45) },
    { at: 0.1, samples: note(659.25, 0.5, 0.45) },
  ]),
  // 重要メール：注意を引く速い2連打（高めの G5 を2回）
  notify_gmail: sequence([
    { at: 0, samples: note(784, 0.16, 0.55) },
    { at: 0.18, samples: note(784, 0.16, 0.55) },
    { at: 0.36, samples: silence(0.05) },
  ]),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, samples] of Object.entries(SOUNDS)) {
  const file = path.join(OUT_DIR, `${name}.wav`);
  if (fs.existsSync(file) && !force) {
    console.log(`skip（既存）: ${path.relative(process.cwd(), file)}`);
    continue;
  }
  fs.writeFileSync(file, toWav(samples));
  console.log(`generated: ${path.relative(process.cwd(), file)}（${(samples.length / RATE).toFixed(2)}秒）`);
}
