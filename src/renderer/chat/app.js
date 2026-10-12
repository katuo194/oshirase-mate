// チャットウィンドウ（F-16 / 3.5）。Gemini のキー・リクエストはメインだけが扱い、ここには発言と応答のテキストしか届かない。
// 応答・発言はすべて textContent で描画する（HTML として解釈しない）。

const logEl = document.getElementById('log');
const hintEl = document.getElementById('empty-hint');
const counterEl = document.getElementById('counter');
const form = document.getElementById('form');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

let busy = false;
let finished = false;

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
}

function addMessage(kind, text, extraClass = '') {
  hintEl.hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${kind} ${extraClass}`.trim();
  el.textContent = text;
  logEl.appendChild(el);
  scrollToEnd();
  return el;
}

function addNotice(text) {
  const el = document.createElement('div');
  el.className = 'notice';
  el.textContent = text;
  logEl.appendChild(el);
  scrollToEnd();
}

/** 残り往復数のカウンター（v5.8：「残り {max−turn}/{max} 往復」。開始時 10/10 → 終了時 0/10）。 */
function renderCounter({ remaining, max, showRemainingCount }) {
  counterEl.hidden = showRemainingCount === false;
  counterEl.textContent = `残り ${remaining}/${max} 往復`;
}

function setBusy(next) {
  busy = next;
  const off = busy || finished;
  input.disabled = off;
  sendBtn.disabled = off;
  if (!off) input.focus();
}

// ---- 読み上げ（メインが合成した音声を再生する。待ち行列は持たない：新しい音声・停止指示で前の音声は止めて捨てる）----
let voice = null; // { id, audio }

function stopVoice() {
  const v = voice;
  if (!v) return;
  voice = null;
  try {
    v.audio.pause();
  } catch {
    // 破棄するだけ
  }
  window.chatApi.voiceDone(v.id); // メインが音声ファイルを削除する
}

window.chatApi.onVoice(({ id, url, volume }) => {
  stopVoice();
  const audio = new Audio(url);
  audio.volume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
  const v = { id, audio };
  voice = v;
  const end = () => {
    if (voice === v) {
      voice = null;
      window.chatApi.voiceDone(id);
    }
  };
  audio.addEventListener('ended', end);
  audio.addEventListener('error', end);
  audio.play().catch((e) => {
    console.warn('読み上げを再生できませんでした:', e?.message ?? e);
    end();
  });
});

window.chatApi.onStopVoice(({ id }) => {
  if (voice && voice.id === id) stopVoice();
});

window.chatApi.onSettings(({ muted, voiceVolume }) => {
  if (muted) {
    stopVoice(); // ミュート中は止めて捨てる（解除しても再生しない：3.7）
    return;
  }
  if (voice && Number.isFinite(voiceVolume)) voice.audio.volume = Math.min(1, Math.max(0, voiceVolume));
});

// ---- 送信 ----
const REJECTIONS = {
  too_long: 'メッセージが長すぎます（500文字まで）。',
};

async function submit() {
  const text = input.value.trim();
  if (text === '' || busy || finished) return;
  input.value = '';
  addMessage('user', text);
  setBusy(true);
  const thinking = addMessage('bot', '考え中…', 'thinking');

  let result;
  try {
    result = await window.chatApi.send(text);
  } catch (e) {
    result = { ok: true, reply: '今はちょっと考えられないみたい。', fallback: true, closing: null, final: false };
  }
  thinking.remove();

  if (!result?.ok) {
    if (REJECTIONS[result?.reason]) addNotice(REJECTIONS[result.reason]);
    setBusy(false);
    return;
  }

  addMessage('bot', result.reply, result.fallback ? 'fallback' : '');
  if (Number.isFinite(result.remaining)) renderCounter(result);
  if (result.closing) addMessage('bot', result.closing);
  if (result.final) {
    finished = true;
    addNotice('この会話は終了します。ウィンドウは自動で閉じます。');
  }
  setBusy(false);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void submit();
});

input.addEventListener('keydown', (e) => {
  // 日本語入力の変換確定の Enter では送信しない
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    void submit();
  }
});

window.chatApi.getState().then((state) => {
  renderCounter(state);
  finished = state.finished === true;
  setBusy(false);
});
input.focus();
