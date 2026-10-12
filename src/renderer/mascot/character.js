// キャラクターの描画（Phase 5）。app.js から「1つの入口 Character.draw(ctx, state)」だけで呼ぶ。
//
// 描画方式は2つ（Phase 8。メインが送る view.type で切り替える）：
//   procedural … 既定キャラクター（黄色い丸）。Canvas の手続き描画（種別ごとの動き・色・リング）。枠 200×200
//   frames     … EmoteLab キャラクター。取り込んだ透過PNG連番（400×400）を fps で再生する。枠は同じ 200×200 で、デコード時に縮小する。
//                動きは連番に焼き込み済みとみなし、手続きの動き・リングは重ねない（v5.9）。困り顔も持たない（オフラインはバッジのみ）
// ヒットテスト（描画結果のα値を見る）・呼び出し側は描画方式に依存しない。
//
// frames の先読み（load）：設定済みの全スロットの PNG を圧縮のまま取得し、rest だけデコードしてから適用（apply）する。
// 種別スロット（notify.calendar など）も最初に取得しておき、通知の表示の開始でデコードするので、その種別の初回の通知から正しいモーションになる（2.6）。
//
// マスコットは常時表示のため、状態は「rest（通知なし・静止）」と「notify（通知中）」の2つだけ。
// notify は「冒頭の動き（burst・約1秒・1回だけ。注意を引く）→ 内容表示中のループ（loop）」で、
// 終わりに fade（0→1）で振幅とリングを絞って rest の姿勢へ戻る。
//
// オフライン（F-14）は第3の状態ではなく、rest に重ねる修飾（offline: true で困り顔）。notify 中は通知の顔を優先する。
//
// state:
//   phase   'rest' | 'notify'
//   offline rest のときの困り顔（八の字眉＋波口）
//   t       notify の経過ms（冒頭の動き・ループの位相の計算用）
//   fade    0..1（notify の終わりの絞り。1 で rest と同じ姿勢）
//   params  notificationView.js の params（accent / tint / mouth / burst / loop）と burstMs・loopCycleMs
//   kind    presentation.kind（'calendar' | 'tasks' | 'gmail' | 'system' | 'idle' | 'generic'）。frames のスロット選択に使う
//
// 描画は 200×200 の枠の内側に収める（円の半径80＋外周の余白20px）。動きの振幅・リングは余白に収まる大きさにしてある。
//
// frames のときの state：
//   phase 'rest' と、notify の終わりの絞りの後半（fade ≥ 0.5）… view.stateSlots.rest を「rest の時計」で再生（途切れずに続く）
//   phase 'notify' … view.stateSlots[state.kind（presentation.kind）] ?? stateSlots.notify を t（通知の経過ms）で再生。アイドルトーク（idle）は rest

const Character = (() => {
  const SIZE = 200;
  const CX = 100;
  const CY = 100;
  const RADIUS = 80;
  const RING_RADIUS = 85;
  /** ループ中のリングの基準アルファ。冒頭の動きの終わり・ループの始まりと連続させる（アルファが跳ばないように） */
  const RING_BASE = 0.7;

  const TAU = Math.PI * 2;

  function easeOutBounce(x) {
    const n = 7.5625;
    const d = 2.75;
    if (x < 1 / d) return n * x * x;
    if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
    if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
    return n * (x -= 2.625 / d) * x + 0.984375;
  }

  const IDENTITY = { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, ring: 0 };
  const ringIn = (p) => RING_BASE * Math.min(1, p * 2);

  // 冒頭の動き：p は 0..1。p=1 で静止位置に戻り、そのままループの位相0へ続く
  const BURST = {
    // なし：動かない（アイドルトーク。通知と紛らわしくならないよう、動き・リングを出さない）
    none: () => IDENTITY,
    // ポップ：一度ふくらんで戻る
    pop: (p) => ({ ...IDENTITY, sx: 1 + 0.1 * Math.sin(Math.PI * p), sy: 1 + 0.1 * Math.sin(Math.PI * p), ring: ringIn(p) }),
    // ホップ：2回跳ねる（跳ぶ高さは徐々に低く）
    hop: (p) => ({ ...IDENTITY, dy: -10 * Math.abs(Math.sin(TAU * p)) * (1 - 0.4 * p), ring: ringIn(p) }),
    // ドロップ：上から落ちてバウンド
    drop: (p) => ({ ...IDENTITY, dy: -10 * (1 - easeOutBounce(p)), ring: ringIn(p) }),
  };

  // ループ：c は 0..1（1周期内の位相。c=0 は静止位置）。リングは常に見せて脈打たせる
  const LOOP = {
    none: () => IDENTITY,
    pulse: (c) => ({ ...IDENTITY, sx: 1 + 0.035 * Math.sin(TAU * c), sy: 1 + 0.035 * Math.sin(TAU * c), ring: RING_BASE + 0.2 * Math.sin(TAU * c) }),
    sway: (c) => ({ ...IDENTITY, dx: 8 * Math.sin(TAU * c), rot: 0.06 * Math.sin(TAU * c), ring: RING_BASE }),
    // 小刻みな震えを周期の前半だけ行い、後半は静止（ずっと震え続けると読みにくい）
    shake: (c) => ({ ...IDENTITY, dx: c < 0.6 ? 3 * Math.sin(TAU * c * 8) : 0, ring: RING_BASE + 0.2 * Math.sin(TAU * c * 2) }),
  };

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function motionFor(state) {
    const params = state.params;
    if (!params || state.phase !== 'notify') return IDENTITY;

    const t = Math.max(0, state.t ?? 0);
    const burstMs = params.burstMs > 0 ? params.burstMs : 1000;
    const cycle = params.loopCycleMs > 0 ? params.loopCycleMs : 1500;

    const m =
      t < burstMs
        ? (BURST[params.burst] ?? BURST.pop)(t / burstMs)
        : (LOOP[params.loop] ?? LOOP.pulse)(((t - burstMs) % cycle) / cycle);

    // 終わりの絞り：全成分を静止（IDENTITY）へ向けて k = 1→0 で縮める
    const k = 1 - clamp01(state.fade ?? 0);
    return {
      dx: m.dx * k,
      dy: m.dy * k,
      sx: 1 + (m.sx - 1) * k,
      sy: 1 + (m.sy - 1) * k,
      rot: m.rot * k,
      ring: m.ring * k,
    };
  }

  /** 困り顔の眉（八の字）。 */
  function drawBrows(ctx) {
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#3a2a00';
    ctx.beginPath();
    ctx.moveTo(63, 68);
    ctx.lineTo(85, 74);
    ctx.moveTo(137, 68);
    ctx.lineTo(115, 74);
    ctx.stroke();
  }

  function drawBody(ctx, mouth) {
    ctx.beginPath();
    ctx.arc(CX, CY, RADIUS, 0, TAU);
    ctx.fillStyle = '#ffd83b';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#c99a00';
    ctx.stroke();

    ctx.fillStyle = '#3a2a00';
    for (const x of [75, 125]) {
      ctx.beginPath();
      ctx.ellipse(x, 88, 7, 10, 0, 0, TAU);
      ctx.fill();
    }

    if (mouth === 'worried') {
      // 困り顔：八の字眉＋波打つ口（オフライン・お知らせ）
      drawBrows(ctx);
      ctx.beginPath();
      ctx.moveTo(80, 124);
      ctx.bezierCurveTo(88, 116, 94, 116, 100, 122);
      ctx.bezierCurveTo(106, 128, 112, 128, 120, 120);
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#3a2a00';
      ctx.stroke();
    } else if (mouth === 'open') {
      // 「お」：驚き・注意（重要メール）
      ctx.beginPath();
      ctx.ellipse(CX, 118, 11, 14, 0, 0, TAU);
      ctx.fillStyle = '#3a2a00';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(CX, 105, 32, Math.PI * 0.2, Math.PI * 0.8);
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#3a2a00';
      ctx.stroke();
    }
  }

  function drawProcedural(ctx, state) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    const m = motionFor(state);
    const params = state.params;
    const notifying = Boolean(params) && state.phase === 'notify';

    ctx.save();
    ctx.translate(CX + m.dx, CY + m.dy);
    ctx.rotate(m.rot);
    ctx.scale(m.sx, m.sy);
    ctx.translate(-CX, -CY);

    // 種別の色のリング（通知中だけ。アルファは動きごとに変わる）
    if (notifying && m.ring > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, m.ring);
      ctx.beginPath();
      ctx.arc(CX, CY, RING_RADIUS, 0, TAU);
      ctx.lineWidth = 4;
      ctx.strokeStyle = params.tint;
      ctx.stroke();
      ctx.restore();
    }

    // 口は絞りの進行に合わせて元（笑顔）へ戻す：fade が半分を過ぎたら静止時の顔にする
    const restMouth = state.offline === true ? 'worried' : 'smile';
    const mouth = notifying && (state.fade ?? 0) < 0.5 ? params.mouth : restMouth;
    drawBody(ctx, mouth);
    ctx.restore();
  }

  // ---- frames（EmoteLab キャラクター。Phase 8・v5.9）----
  // 先読み（load）：全スロットの PNG を圧縮データ（Blob）のまま取得し、デコードは rest だけ。
  // 通知の表示（prepareNotify）でその種別のスロットを 000 から順にデコードし、表示の終わり（releaseNotify）で解放する
  // （全スロットをデコード済みで持つと、5スロット×70枚で約290MB増えたため：4章 メモリ）。
  // デコード時に canvas の実ピクセル（200×表示倍率）へ高品質で縮小する（400px の画像を毎フレーム縮小描画するより綺麗で、メモリも小さい）。

  const PROCEDURAL = Object.freeze({ view: Object.freeze({ type: 'procedural', id: 'default', canvasSize: SIZE }), blobs: null, decoded: null, px: 0 });
  /** 表示中のキャラクター。{ view, blobs: { [slot]: Blob[] }, decoded: { [slot]: (ImageBitmap | null)[] }, px } */
  let active = PROCEDURAL;
  /** rest の時計の起点（rest は通知をまたいで途切れずに続ける） */
  let restEpoch = performance.now();

  async function fetchBlob(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.blob();
  }

  function closeAll(list) {
    for (const b of list ?? []) b?.close?.();
  }

  /** デコード済みの画像をすべて解放する（先読みした Blob は参照を切れば GC される） */
  function release(loaded) {
    if (!loaded?.decoded) return;
    for (const slot of Object.keys(loaded.decoded)) {
      closeAll(loaded.decoded[slot]);
      delete loaded.decoded[slot];
    }
  }

  /** スロットを 000 から順にデコードする（途中で解放されたらやめる）。まだのフレームは描画側が直前のフレームで代用する */
  async function decodeSlot(loaded, slot) {
    if (loaded.decoded[slot]) return;
    const blobs = loaded.blobs[slot];
    const list = new Array(blobs.length).fill(null);
    loaded.decoded[slot] = list;
    for (let i = 0; i < list.length; i++) {
      const bitmap = await createImageBitmap(blobs[i], { resizeWidth: loaded.px, resizeHeight: loaded.px, resizeQuality: 'high' });
      if (loaded.decoded[slot] !== list) {
        bitmap.close(); // デコード中に解放された（表示が終わった・キャラクターが替わった）
        return;
      }
      list[i] = bitmap;
    }
  }

  /**
   * view の全スロットを圧縮のまま先読みし、rest をデコードする（まだ表示は切り替えない）。失敗したら解放して reject。
   * @param {object} view
   * @param {number} [dpr] 表示倍率（デコードの大きさ＝200×dpr）
   */
  async function load(view, dpr = 1) {
    if (view?.type !== 'frames') return PROCEDURAL;
    const blobs = {};
    const jobs = [];
    for (const [slot, src] of Object.entries(view.sources)) {
      blobs[slot] = new Array(src.frameCount).fill(null);
      src.urls.forEach((url, i) => jobs.push(fetchBlob(url).then((b) => (blobs[slot][i] = b))));
    }
    const failed = (await Promise.allSettled(jobs)).find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const loaded = { view, blobs, decoded: {}, px: Math.max(1, Math.round(SIZE * dpr)) };
    try {
      await decodeSlot(loaded, view.stateSlots.rest);
    } catch (e) {
      release(loaded);
      throw e;
    }
    return loaded;
  }

  /** 先読み済みのキャラクターに切り替える（前のキャラクターの画像は解放する）。 */
  function apply(loaded) {
    if (loaded === active) return;
    const old = active;
    active = loaded;
    restEpoch = performance.now();
    release(old);
  }

  /** 通知の表示の開始：その種別のスロットのデコードを始める（rest を使う種別・手続き描画なら何もしない） */
  function prepareNotify(kind) {
    if (active.view.type !== 'frames') return;
    const { stateSlots } = active.view;
    const slot = stateSlots[kind] ?? stateSlots.notify;
    if (slot === stateSlots.rest) return;
    const loaded = active;
    decodeSlot(loaded, slot).catch((e) => console.warn(`通知のモーション（${slot}）をデコードできませんでした:`, e?.message ?? e));
  }

  /** 通知の表示の終わり：rest 以外のデコード済み画像を解放する */
  function releaseNotify() {
    if (active.view.type !== 'frames') return;
    for (const slot of Object.keys(active.decoded)) {
      if (slot === active.view.stateSlots.rest) continue;
      closeAll(active.decoded[slot]);
      delete active.decoded[slot];
    }
  }

  /** rest を動かし続けるための描画間隔（ms）。動かない（手続き描画・1枚だけ）なら null */
  function restFrameIntervalMs() {
    if (active.view.type !== 'frames') return null;
    const src = active.view.sources[active.view.stateSlots.rest];
    return src.frameCount > 1 ? 1000 / src.fps : null;
  }

  /** スロットの t（ms）の時点のフレーム。まだデコードされていなければ直前のデコード済みフレーム、1枚も無ければ null */
  function frameAt(slot, t) {
    const src = active.view.sources[slot];
    const list = active.decoded[slot];
    if (!src || !list) return null;
    const index = Math.floor((Math.max(0, t) * src.fps) / 1000) % src.frameCount;
    for (let i = index; i >= 0; i--) if (list[i]) return list[i];
    return null;
  }

  function drawFrames(ctx, state) {
    const { stateSlots } = active.view;
    const restT = performance.now() - restEpoch;
    const notifying = state.phase === 'notify' && (state.fade ?? 0) < 0.5;
    const slot = notifying ? (stateSlots[state.kind] ?? stateSlots.notify) : stateSlots.rest;
    // アイドルトークなど rest を使う場合は rest の時計のまま（途切れさせない）。通知のスロットは表示の経過時間で再生する。
    // 通知のスロットの出だし（1枚目のデコード前の数ms）は rest のフレームで代用する
    const bitmap = (slot === stateSlots.rest ? frameAt(slot, restT) : frameAt(slot, state.t ?? 0)) ?? frameAt(stateSlots.rest, restT);
    if (!bitmap) return; // 何も無い：前の描画をそのまま残す
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  }

  function draw(ctx, state) {
    if (active.view.type === 'frames') drawFrames(ctx, state);
    else drawProcedural(ctx, state);
  }

  return { SIZE, draw, load, apply, release, prepareNotify, releaseNotify, restFrameIntervalMs };
})();
