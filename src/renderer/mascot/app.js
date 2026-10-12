const CSS_SIZE = 200;

const canvas = document.getElementById('character');
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(CSS_SIZE * dpr);
canvas.height = Math.round(CSS_SIZE * dpr);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.scale(dpr, dpr);

if (new URLSearchParams(location.search).has('dev')) {
  document.body.classList.add('dev');
}

// キャラクターの描画は character.js（Character.draw）。素材（PNG連番）に差し替える際もそちらだけを変える。
// ヒットテストは描画結果のα値を見るので、描画方式が変わっても無変更。
const charEl = document.getElementById('char');
const bubbleEl = document.getElementById('bubble');
const badgeEl = document.getElementById('badge');

const offlineBadgeEl = document.getElementById('offline-badge');

/** オフライン表示中か（F-14）。rest の顔（困り顔）とバッジに反映する。通知の演出とは独立 */
let offline = false;

// rest の描画。EmoteLab キャラクター（Phase 8）の rest は動き続けるが、待機時の CPU を抑えるため rAF は回さず、
// フレームが変わる間隔（1000/fps）の setTimeout で描く。通知の演出中は tick（rAF）が描くので止める
let restTimer = 0;
function drawRest() {
  clearTimeout(restTimer);
  restTimer = 0;
  Character.draw(ctx, { phase: 'rest', offline });
  const interval = Character.restFrameIntervalMs();
  if (interval && !show) restTimer = setTimeout(drawRest, interval);
}
function stopRest() {
  clearTimeout(restTimer);
  restTimer = 0;
}

// 描画されたピクセルのα値でヒットテスト（clientX/Y は CSS px）
function isOverCharacter(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) * dpr);
  const y = Math.floor((clientY - rect.top) * dpr);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  return ctx.getImageData(x, y, 1, 1).data[3] > 0;
}

let ignoring = true; // メイン側の初期状態と一致させる
function setIgnore(ignore) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  window.mascot.setIgnoreMouse(ignore);
}

let drag = null; // { pointerId, startX, startY, moved }

/** これ以上動かしたらクリックではなくドラッグとみなす（px）。ダブルクリックの誤判定を防ぐ */
const CLICK_SLOP_PX = 4;
/** 直近2回の押下でドラッグしたか（ダブルクリックはどちらも動いていないときだけ受け付ける） */
const pressMoved = [false, false];

// ホバー：ignore 中は forward された mousemove のみ届く
document.addEventListener('mousemove', (e) => {
  if (drag) return;
  setIgnore(!isOverCharacter(e.clientX, e.clientY));
});

document.documentElement.addEventListener('mouseleave', () => {
  if (!drag) setIgnore(true);
});

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isOverCharacter(e.clientX, e.clientY)) return;
  drag = { pointerId: e.pointerId, startX: e.screenX, startY: e.screenY, moved: false };
  // ポインタキャプチャで、カーソルが丸の外に出ても move/up を受け取り続ける
  canvas.setPointerCapture(e.pointerId);
  window.mascot.dragStart();
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.screenX - drag.startX;
  const dy = e.screenY - drag.startY;
  if (Math.abs(dx) > CLICK_SLOP_PX || Math.abs(dy) > CLICK_SLOP_PX) drag.moved = true;
  window.mascot.dragMove(dx, dy);
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  pressMoved.shift();
  pressMoved.push(drag.moved);
  drag = null;
  window.mascot.dragEnd();
  setIgnore(!isOverCharacter(e.clientX, e.clientY));
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// ダブルクリック：直前のお知らせをもう一度（F-21）。表示中なら受け付けないなどの判定はメイン（presenter）が行う
document.addEventListener('dblclick', (e) => {
  if (e.button !== 0 || pressMoved.some(Boolean) || !isOverCharacter(e.clientX, e.clientY)) return;
  window.mascot.replay();
});

// 右クリック：メニューはメインプロセスで表示（トレイと同一メニュー）
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (isOverCharacter(e.clientX, e.clientY)) window.mascot.showContextMenu();
});

// ---------------------------------------------------------------------------------------------
// 通知の演出（Phase 5）。メインが notifyQueue から1件ずつ送ってくる：
//   mascot:layout-prepare / -commit … ウィンドウの拡大・縮小に合わせた再配置（下記「切り替え」）
//   mascot:show   … 通知アニメーション（冒頭の動き→内容表示中のループ→終わりに絞って静止へ）を再生し、
//                   終わったら showDone(id) を返す（次の通知はそれから）。マスコットは常時表示なので出現・退場のフェーズは無い
// アニメーションの種類・色・時間はすべてメインが決めた presentation の値。ここは描画するだけ。
// rAF は演出中だけ回す（待機時の CPU をほぼ0にするため）。
// ---------------------------------------------------------------------------------------------

/** 現在の配置。既定は通常（キャラクター枠が窓の左上）。 */
let layout = { characterOffset: { x: 100, y: 100 }, bubble: null };

function applyLayout(next) {
  layout = next;
  charEl.style.left = `${next.characterOffset.x - Character.SIZE / 2}px`;
  charEl.style.top = `${next.characterOffset.y - Character.SIZE / 2}px`;
}

// ---- ウィンドウ拡大・縮小の切り替え（ちらつき対策。手順は main/window.js）----
// ウィンドウ左上が動くのに合わせて描画位置も動かすが、両者は同じフレームに載らない。
// 間違った位置のキャラクターを見せないため、切り替えの間だけキャラクターとバッジを隠す。
//   prepare … 隠す → 再配置 → HIDE_FRAMES フレーム待って（隠した状態を描画させて）ACK
//   commit  … メインがウィンドウを切り替えた。リサイズの反映（resize イベント）＋ REVEAL_FRAMES フレーム待って再表示
// 隠す時間は合計で約0.1秒。ちらつきが残る場合は、この2つのフレーム数と RESIZE_WAIT_MS を調整する。
const HIDE_FRAMES = 2; // 「隠した状態」が確実に画面へ出てから setBounds させる（足りないと位置ずれが見える）
const REVEAL_FRAMES = 1;
const RESIZE_WAIT_MS = 0; // resize イベントが来ない場合でも再表示する
const TRANSITION_FAILSAFE_MS = 1500; // commit が来ない場合でも、キャラクターを隠したままにしない

let transition = null; // { seq, target, failSafe }
let pendingShow = null; // 切り替え中に届いた演出。再表示の後に始める

function afterFrames(n, callback) {
  if (n <= 0) callback();
  else requestAnimationFrame(() => afterFrames(n - 1, callback));
}

function reveal(t) {
  if (transition !== t) return;
  transition = null;
  clearTimeout(t.failSafe);
  charEl.style.visibility = '';
  if (pendingShow) {
    const show = pendingShow;
    pendingShow = null;
    startShow(show);
  }
}

window.mascot.onLayoutPrepare(({ seq, layout: next }) => {
  if (transition) clearTimeout(transition.failSafe); // 新しい切り替えが古いものを置き換える
  const t = { seq, target: next.size, failSafe: 0 };
  transition = t;
  t.failSafe = setTimeout(() => reveal(t), TRANSITION_FAILSAFE_MS);
  if (!next.bubble) pendingShow = null; // 通常サイズへ戻る切り替えでは、古い演出は始めない

  charEl.style.visibility = 'hidden';
  applyLayout(next);
  afterFrames(HIDE_FRAMES, () => {
    if (transition === t) window.mascot.layoutReady(seq);
  });
});

window.mascot.onLayoutCommit(({ seq }) => {
  const t = transition;
  if (!t || t.seq !== seq) return;
  const finish = () => afterFrames(REVEAL_FRAMES, () => reveal(t));
  // すでに新しいサイズが反映済み（または同サイズの再配置）なら resize は来ないので待たない
  if (window.innerWidth === t.target.width && window.innerHeight === t.target.height) {
    finish();
    return;
  }
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.removeEventListener('resize', go);
    finish();
  };
  window.addEventListener('resize', go);
  setTimeout(go, RESIZE_WAIT_MS);
});

function placeBubble(b) {
  bubbleEl.style.left = `${b.x}px`;
  bubbleEl.style.top = `${b.y}px`;
  bubbleEl.style.width = `${b.width}px`;
  bubbleEl.style.height = `${b.height}px`;
  bubbleEl.classList.toggle('side-top', b.side === 'top');
  bubbleEl.classList.toggle('side-bottom', b.side !== 'top');
  bubbleEl.querySelector('.tail').style.left = `${b.tailX}px`;
  // 尻尾の先（キャラクター側）から広がる／縮むように見せる
  bubbleEl.style.transformOrigin = `${b.tailX}px ${b.side === 'top' ? '100%' : '0%'}`;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 効果音の設定（メインが表示開始時に解決した値。表示中にミュート・音量が変わったら onSettings で追随） */
let audio = null;

/**
 * 効果音を鳴らす。onEnd は鳴り終わり（再生できなかった場合を含む）に1回だけ呼ぶ（読み上げの開始の合図。下記「読み上げ」）。
 * @returns {boolean} 鳴らしたか
 */
function playSfx(sfx, onEnd) {
  if (!sfx) return false; // ミュート・ファイル無し・音量0（メイン側で判定済み）
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  try {
    const a = new Audio(sfx.url);
    a.volume = clamp01(sfx.volume);
    audio = a;
    a.addEventListener('ended', () => {
      if (audio === a) audio = null;
      end();
    });
    a.addEventListener('error', end);
    a.play().catch((e) => {
      console.warn('効果音を再生できませんでした:', e?.message ?? e);
      end();
    });
    return true;
  } catch (e) {
    console.warn('効果音を再生できませんでした:', e?.message ?? e);
    return false;
  }
}

// ---- 読み上げ（F-13）----
// メインは表示を始めてから並行して音声を合成し、できあがったら mascot:voice で送ってくる（表示は音声を待たない：4章 応答性）。
//   - 表示中の id と一致し、まだ絞りに入っていなければ受け取る（遅れて届いた音声は捨てる：吹き出しのない声は出さない）
//   - 再生開始は「効果音の終わり＋voiceAfterSfxMs」以降（効果音と重ねない）。効果音が無ければすぐ。合図が来なくても voiceGateMaxMs で解禁
//   - 絞りの開始 = max(holdMs, 読み上げの終わり＋voiceTailMs)。表示開始から maxVoiceHoldMs が上限（上限では音声も絞って止める）
//   - ミュートされたら止めて捨てる（3.7。解除しても再生しない）
//   - 読み上げる通知（presentation.voicePending）は、音声が届くまで吹き出しを保持する（上限 maxVoiceHoldMs。v5.10：合成が遅い環境向け）。
//     合成できなかったときはメインが url: null を送ってくるので、保持を解いて holdMs 基準に戻す
let voiceVolume = 1;
/** 表示の開始より先に届いた「合成できなかった」の id（ウィンドウの切り替え中など） */
let noVoiceFor = null;

function stopVoice(s) {
  const v = s?.voice;
  if (!v) return;
  s.voice = null;
  try {
    v.audio.pause();
  } catch {
    // 破棄するだけ
  }
}

function startVoiceIfReady(s) {
  const v = s.voice;
  if (!v || v.playing || !s.gateOpen || s.out) return;
  v.playing = true;
  v.audio.play().catch((e) => {
    console.warn('読み上げを再生できませんでした:', e?.message ?? e);
    if (s.voice === v) v.endT = performance.now() - s.t0;
  });
}

function openVoiceGate(s) {
  if (show !== s || s.gateOpen) return;
  s.gateOpen = true;
  clearTimeout(s.gateTimer);
  startVoiceIfReady(s);
}

window.mascot.onVoice(({ id, url, volume }) => {
  const s = show;
  if (url === null) {
    if (s && s.presentation.id === id) s.voicePending = false;
    else noVoiceFor = id;
    return;
  }
  if (!s || s.presentation.id !== id || s.out) return; // 表示が終わった・絞りに入った後の音声は捨てる（ファイルはメインが消す）
  s.voicePending = false;
  stopVoice(s);
  const a = new Audio(url);
  a.volume = clamp01(volume ?? voiceVolume);
  const v = { audio: a, playing: false, endT: null };
  const markEnd = () => {
    if (s.voice === v && v.endT === null) v.endT = performance.now() - s.t0;
  };
  a.addEventListener('ended', markEnd);
  a.addEventListener('error', markEnd);
  s.voice = v;
  startVoiceIfReady(s);
});

window.mascot.onSettings(({ muted, sfxVolume, voiceVolume: vv }) => {
  if (Number.isFinite(vv)) voiceVolume = clamp01(vv);
  if (muted) {
    // ミュート中は効果音と読み上げを停止して捨てる（アニメーションと吹き出しは継続）。保持時間は元の holdMs 基準に戻る
    if (audio) audio.pause();
    audio = null;
    if (show) {
      stopVoice(show);
      show.voicePending = false; // メインも合成結果を破棄する
    }
    return;
  }
  if (audio) audio.volume = clamp01(sfxVolume);
  if (show?.voice) show.voice.audio.volume = voiceVolume;
});

let show = null; // { presentation, t0, raf, out, voice, voicePending, gateOpen, gateTimer }

function fillBubble(p) {
  bubbleEl.style.setProperty('--accent', p.params.accent);
  bubbleEl.classList.toggle('idle', p.kind === 'idle'); // アイドルトーク（F-15）：ラベルなし・3行まで。動きは params が none
  bubbleEl.querySelector('.label').textContent = p.label;
  bubbleEl.querySelector('.title').textContent = p.title; // 外部由来の文字列なので textContent のみ（HTML として解釈しない）
  bubbleEl.querySelector('.sub').textContent = p.sub;
}

function finishShow() {
  const s = show;
  if (!s) return;
  show = null;
  cancelAnimationFrame(s.raf);
  clearTimeout(s.gateTimer);
  stopVoice(s);
  bubbleEl.classList.remove('in');
  bubbleEl.hidden = true;
  Character.releaseNotify(); // 通知のスロットのデコード済み画像を解放する（rest だけを持つ）
  applyPendingCharacter(); // 表示中に先読みが終わっていたキャラクターへ差し替える
  drawRest();
  window.mascot.showDone(s.presentation.id);
}

function tick(now) {
  if (!show) return;
  const { timing, params } = show.presentation;
  const t = Math.max(0, now - show.t0);
  // 表示時間が過ぎたら、吹き出しと動きを絞って静止へ戻す。読み上げがあればその終わりまで延ばす（上限 maxVoiceHoldMs）
  let outStart = show.outStart ?? timing.holdMs;
  if (!show.out) {
    const v = show.voice;
    outStart = timing.holdMs;
    if (!v && show.voicePending) outStart = Math.max(timing.holdMs, timing.maxVoiceHoldMs); // 合成待ち：届くまで保持
    if (v) {
      const voiceEnd = v.endT !== null ? v.endT + timing.voiceTailMs : Infinity; // 再生待ち・再生中は終わるまで待つ
      outStart = Math.min(Math.max(timing.holdMs, voiceEnd), Math.max(timing.holdMs, timing.maxVoiceHoldMs));
    }
    // 中断（アイドルトーク表示中に通知が来た）：今から絞りに入る
    if (show.abortT !== null) outStart = Math.min(outStart, show.abortT);
  }
  const end = outStart + timing.outMs;

  if (t >= end) {
    finishShow();
    return;
  }

  let fade = 0;
  if (t >= outStart) {
    if (!show.out) {
      show.out = true;
      show.outStart = outStart;
      bubbleEl.classList.remove('in'); // 吹き出しを消し始める（CSS トランジション。outMs と揃えてある）
      if (show.voice && !show.voice.playing) stopVoice(show); // 始まっていない読み上げは捨てる
    }
    fade = (t - outStart) / timing.outMs;
    // 上限で切られた読み上げは、吹き出しと一緒に絞って止める
    if (show.voice?.playing && show.voice.endT === null) show.voice.audio.volume = voiceVolume * (1 - clamp01(fade));
  }
  Character.draw(ctx, {
    phase: 'notify',
    kind: show.presentation.kind,
    t,
    fade,
    params: { ...params, burstMs: timing.burstMs, loopCycleMs: timing.loopCycleMs },
  });
  show.raf = requestAnimationFrame(tick);
}

function startShow({ presentation, sfx }) {
  stopRest(); // 演出中は tick が描く
  if (show) {
    // 通常は起きない（メインは done を受けてから次を送る）。残っていれば捨てて新しい演出に切り替える
    cancelAnimationFrame(show.raf);
    show = null;
  }
  if (audio) {
    audio.pause();
    audio = null;
  }
  if (!layout.bubble) {
    // レイアウトが届いていない：内容は出せないので、次へ進めるよう即完了を返す
    console.warn('吹き出しのレイアウトが未受信のため表示をスキップします');
    window.mascot.showDone(presentation.id);
    return;
  }

  fillBubble(presentation);
  placeBubble(layout.bubble);
  bubbleEl.hidden = false;
  bubbleEl.classList.remove('in');
  void bubbleEl.offsetWidth; // 初期状態を確定させてから in を付け、出現のトランジションを発火させる
  bubbleEl.classList.add('in');

  const voicePending = presentation.voicePending === true && noVoiceFor !== presentation.id;
  noVoiceFor = null;
  const s = { presentation, t0: performance.now(), raf: 0, out: false, outStart: null, abortT: null, voice: null, voicePending, gateOpen: false, gateTimer: 0 };
  show = s;
  const t = presentation.timing;
  const played = playSfx(sfx, () => {
    s.gateTimer = setTimeout(() => openVoiceGate(s), t.voiceAfterSfxMs ?? 200);
  });
  if (played) setTimeout(() => openVoiceGate(s), t.voiceGateMaxMs ?? 1500); // 効果音の終わりが分からなくても解禁
  else s.gateOpen = true; // 効果音なし：読み上げは届き次第すぐ
  s.raf = requestAnimationFrame(tick);
}
// ---- アイドルトークの中断（Phase 7）。通知が来たので、表示中のアイドルトークを今から約0.5秒で絞って終える（完了は通常どおり showDone）----
window.mascot.onAbort(({ id }) => {
  const s = show;
  if (!s || s.presentation.id !== id || s.out || s.abortT !== null) return;
  s.abortT = Math.max(0, performance.now() - s.t0);
});

// 切り替え中（キャラクターを隠している間）に届いた演出は、再表示の後に始める
window.mascot.onShow((payload) => {
  // EmoteLab キャラクター：この種別のスロットのデコードを今から始める（000 から順に。切り替え中の約0.1秒も先に進めておく）。
  // 解放は表示の終わり（finishShow）。表示されずに捨てられた場合も、次の表示の終わりにまとめて解放される
  Character.prepareNotify(payload?.presentation?.kind);
  if (transition) pendingShow = payload;
  else startShow(payload);
});

// ---- オフライン表示（F-14）。rest の困り顔と左下のバッジ。通知の演出中はバッジだけ出し、顔は通知の顔のまま ----
window.mascot.onOffline(({ offline: next }) => {
  offline = next === true;
  offlineBadgeEl.hidden = !offline;
  if (!show) drawRest();
});

// ---- サマリバッジ（重要でないメールの未読件数）。件数が変わったら静かに数字を差し替えるだけ ----
let badgeText = null;
window.mascot.onSummary(({ text }) => {
  if (text == null) {
    badgeEl.hidden = true;
    badgeText = null;
    return;
  }
  const changed = badgeText !== null && text !== badgeText;
  badgeEl.textContent = text;
  badgeEl.classList.toggle('wide', text.length >= 3);
  badgeEl.hidden = false;
  if (changed) {
    badgeEl.classList.remove('pop');
    void badgeEl.offsetWidth;
    badgeEl.classList.add('pop');
  }
  badgeText = text;
});

// ---- キャラクターの切り替え（Phase 8）----
// 全スロットの PNG を圧縮のまま先読みし、rest をデコードし終えたら差し替える（通知の表示中なら終わってから）。
// 差し替えたらメインへ知らせる（枠は 200 のままなので、ウィンドウの操作は要らない）
let pendingCharacter = null; // { seq, loaded }：先読み済み・差し替え待ち
let loadingSeq = 0;

function discardPending() {
  if (!pendingCharacter) return;
  Character.release(pendingCharacter.loaded);
  pendingCharacter = null;
}

function applyPendingCharacter() {
  if (!pendingCharacter || show) return;
  const { seq, loaded } = pendingCharacter;
  pendingCharacter = null;
  Character.apply(loaded);
  if (!show) drawRest();
  window.mascot.characterLoaded(seq, true);
}

window.mascot.onCharacterLoad(async ({ seq, view }) => {
  loadingSeq = seq;
  discardPending(); // 差し替える前に次の選択が来た
  let loaded;
  try {
    loaded = await Character.load(view, dpr);
  } catch (e) {
    console.warn('キャラクターの画像を読み込めませんでした:', e?.message ?? e);
    if (loadingSeq === seq) window.mascot.characterLoaded(seq, false);
    return;
  }
  if (loadingSeq !== seq) {
    Character.release(loaded); // 読み込み中に別のキャラクターが選ばれた
    return;
  }
  pendingCharacter = { seq, loaded };
  applyPendingCharacter();
});

window.mascot.onCharacterCancel(() => {
  loadingSeq = -1; // 読み込み中のものは捨てる
  discardPending();
});

drawRest();

// 出入りのフェード（F-20）。透明な間もヒットテスト・描画はそのまま（通知時のみ表示ではウィンドウごと隠れる）
window.mascot.onVisibility(({ visible }) => {
  document.body.classList.toggle('concealed', visible !== true);
});

// リスナーをすべて登録した後に準備完了を伝える（メインはこれ以降に演出・バッジを送り始める）
window.mascot.ready();
