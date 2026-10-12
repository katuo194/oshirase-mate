const sfx = document.getElementById('volume-sfx');
const sfxValue = document.getElementById('volume-sfx-value');
const voice = document.getElementById('volume-voice');
const voiceValue = document.getElementById('volume-voice-value');
const muted = document.getElementById('muted');
const launchAtLogin = document.getElementById('launch-at-login');
const notifyOnly = document.getElementById('notify-only');

const toPercent = (v) => Math.round(v * 100);

// ドラッグ中のスライダー。外部からの変更通知でつまみを巻き戻さないために覚えておく
const dragging = new Set();

function showVolume(slider, output, value) {
  if (dragging.has(slider)) return;
  output.textContent = `${toPercent(value)}%`;
  slider.value = String(toPercent(value));
}

function render(settings) {
  showVolume(sfx, sfxValue, settings.volume.sfx);
  showVolume(voice, voiceValue, settings.volume.voice);
  // チェックボックスはクリック後もフォーカスが残るので、フォーカス有無に関わらず常に反映する
  muted.checked = settings.muted;
  launchAtLogin.checked = settings.launchAtLogin;
  notifyOnly.checked = settings.displayMode === 'notifyOnly';
}

// スライダー：ドラッグ中は表示のみ更新し、離した時（change）に保存する
for (const [slider, output, key] of [
  [sfx, sfxValue, 'sfx'],
  [voice, voiceValue, 'voice'],
]) {
  slider.addEventListener('pointerdown', () => dragging.add(slider));
  slider.addEventListener('input', () => {
    output.textContent = `${slider.value}%`;
  });
  slider.addEventListener('change', async () => {
    dragging.delete(slider);
    render(await window.settingsApi.update({ volume: { [key]: Number(slider.value) / 100 } }));
  });
  // クリックだけで値が変わらない場合は change が来ないので、ここでも解除する
  slider.addEventListener('pointerup', () => dragging.delete(slider));
  slider.addEventListener('pointercancel', () => dragging.delete(slider));
}

muted.addEventListener('change', async () => {
  render(await window.settingsApi.update({ muted: muted.checked }));
});

launchAtLogin.addEventListener('change', async () => {
  render(await window.settingsApi.update({ launchAtLogin: launchAtLogin.checked }));
});

notifyOnly.addEventListener('change', async () => {
  render(await window.settingsApi.update({ displayMode: notifyOnly.checked ? 'notifyOnly' : 'always' }));
});

// トレイ等、他の経路で設定が変わったときの同期
window.settingsApi.onChanged(render);

window.settingsApi.get().then(render);

// ---- Googleアカウント連携 ----
const authStatus = document.getElementById('auth-status');
const authDetail = document.getElementById('auth-detail');
const authLink = document.getElementById('auth-link');
const authCancel = document.getElementById('auth-cancel');
const authUnlink = document.getElementById('auth-unlink');

// 版ごとの文言（個人版は .env、共有版は上の OAuth クライアント欄：2.4・v5.11）。版は oauth:get-state で受け取る
let edition = 'personal';

const CONFIG_PROBLEMS = {
  missing_client_id: '.env に GOOGLE_OAUTH_CLIENT_ID が設定されていません。',
  missing_client_secret: '.env に GOOGLE_OAUTH_CLIENT_SECRET が設定されていません。',
  invalid_client_id: 'GOOGLE_OAUTH_CLIENT_ID の形式が正しくありません（〜.apps.googleusercontent.com）。',
};

function configProblemText(auth) {
  if (edition === 'shared') return '上の「OAuth クライアント」に Client ID と Client Secret を入力して保存してください。';
  return `${CONFIG_PROBLEMS[auth.configProblem] ?? ''} .env.example を参考に .env を作成し、アプリを再起動してください。`;
}

const AUTH_ERRORS = {
  denied: '同意がキャンセルされました。',
  timeout: '同意の待ち時間（5分）が過ぎました。もう一度お試しください。',
  browser_failed: 'ブラウザを開けませんでした。',
  scope_insufficient: '必要な権限がすべて許可されませんでした。同意画面ですべての項目にチェックを入れてください。',
  network: 'Google に接続できませんでした。ネットワークを確認してください。',
  save_failed: 'トークンを暗号化して保存できませんでした。',
  no_refresh_token: 'Google から更新用トークンが返されませんでした。もう一度お試しください。',
  expired: '連携の有効期限が切れました。もう一度連携してください。',
  exchange_failed: '連携に失敗しました。もう一度お試しください。',
};

function renderAuth(auth) {
  const { status } = auth;
  authStatus.classList.toggle('linked', status === 'linked');
  authStatus.textContent =
    {
      unconfigured: '設定が必要です',
      unlinked: '未連携',
      linking: 'ブラウザで同意を完了してください…',
      checking: '連携状態を確認中…',
      linked: '連携中',
    }[status] ?? '不明';

  authLink.hidden = !(status === 'unlinked' || status === 'unconfigured');
  authLink.disabled = status === 'unconfigured';
  authCancel.hidden = status !== 'linking';
  authUnlink.hidden = status !== 'linked';

  const detail =
    status === 'unconfigured'
      ? configProblemText(auth)
      : auth.lastError === 'invalid_client'
        ? edition === 'shared'
          ? 'Client ID / Secret が Google に受け付けられませんでした。上の「OAuth クライアント」に入力した値を確認してください。'
          : 'Client ID / Secret が Google に受け付けられませんでした。.env の値を確認してください。'
        : (AUTH_ERRORS[auth.lastError] ?? '');
  authDetail.textContent = detail;
  authDetail.hidden = detail === '';
  authDetail.classList.toggle('error', status === 'unconfigured' || Boolean(auth.lastError));
}

authLink.addEventListener('click', async () => renderAuth(await window.authApi.link()));
authCancel.addEventListener('click', async () => renderAuth(await window.authApi.cancel()));
authUnlink.addEventListener('click', async () => renderAuth(await window.authApi.unlink()));

window.authApi.onChanged(renderAuth);

// ---- OAuth クライアント（共有版のみ。2.4・3.6・F-18）----
// 値はメインへ送るだけ。保存後は Secret 欄を空に戻し、Secret はこの画面に二度と表示しない（受け取るのは Client ID と状態だけ）
const oauthSection = document.getElementById('oauth-section');
const oauthStatus = document.getElementById('oauth-status');
const oauthDetail = document.getElementById('oauth-detail');
const oauthClientId = document.getElementById('oauth-client-id');
const oauthClientSecret = document.getElementById('oauth-client-secret');
const oauthSave = document.getElementById('oauth-save');
const oauthClear = document.getElementById('oauth-clear');
const oauthManual = document.getElementById('oauth-manual');

const OAUTH_ERRORS = {
  missing_client_id: 'Client ID を入力してください。',
  missing_client_secret: 'Client Secret を入力してください。',
  invalid_client_id: 'Client ID の形式が正しくありません（〜.apps.googleusercontent.com で終わる値です）。',
  invalid_client_secret: 'Client Secret の形式が正しくありません（空白・改行・全角文字を含まない8〜256文字）。コピーし直してください。',
  swapped: 'Client Secret の欄に Client ID が入っています。欄を入れ替えていないか確認してください。',
  linked: '連携中は変更できません。先に「連携解除」してから変更してください。',
  save_failed: '暗号化して保存できませんでした。',
  not_shared: 'この版では .env の値を使います。',
  manual_failed: 'セットアップ手順書を開けませんでした。アプリのフォルダにある「セットアップ手順書.html」を開いてください。',
};
const LOCKED_MESSAGE = '連携中は変更できません。変更するときは先に「連携解除」してください。';

let oauthBusy = false;
let oauthEditable = false;
/** Client ID 欄を利用者が書き換えたか（書き換え中は保存済みの値で上書きしない） */
let oauthIdDirty = false;

function updateOAuthSave() {
  // 両方の欄が空でないときだけ保存できる（空文字での保存・連携の試行を防ぐ。検証はメインで行う）
  oauthSave.disabled = oauthBusy || !oauthEditable || oauthClientId.value.trim() === '' || oauthClientSecret.value.trim() === '';
}

function showOAuthError(reason) {
  const message = reason ? (OAUTH_ERRORS[reason] ?? '保存できませんでした。') : '';
  oauthDetail.textContent = message;
  oauthDetail.hidden = message === '';
  oauthDetail.classList.toggle('error', message !== '');
}

function renderOAuth(state) {
  edition = state.edition;
  oauthSection.hidden = !state.userInput;
  if (!state.userInput) return;
  oauthEditable = state.editable === true;
  oauthStatus.classList.toggle('linked', state.configured === true);
  oauthStatus.textContent = state.configured ? '保存済み' : '未設定';
  // 保存済みの Client ID（非秘匿）は確認用に表示する。利用者が書き換え中の値は上書きしない
  if (!oauthIdDirty) oauthClientId.value = state.configured ? (state.clientId ?? '') : '';
  oauthClientSecret.placeholder = state.configured ? '保存済み（変更するときだけ入力）' : 'Client Secret を貼り付け';
  oauthClientId.disabled = !oauthEditable;
  oauthClientSecret.disabled = !oauthEditable;
  oauthClear.hidden = !state.configured;
  oauthClear.disabled = !oauthEditable;
  if (!oauthEditable) {
    oauthDetail.textContent = LOCKED_MESSAGE;
    oauthDetail.hidden = false;
    oauthDetail.classList.remove('error');
  } else if (oauthDetail.textContent === LOCKED_MESSAGE) {
    showOAuthError(null);
  }
  updateOAuthSave();
}

for (const input of [oauthClientId, oauthClientSecret]) {
  input.addEventListener('input', () => {
    if (input === oauthClientId) oauthIdDirty = true;
    updateOAuthSave();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !oauthSave.disabled) void saveOAuth();
  });
}

async function saveOAuth() {
  oauthBusy = true;
  updateOAuthSave();
  try {
    const result = await window.oauthApi.set(oauthClientId.value, oauthClientSecret.value);
    if (result.ok) {
      oauthClientSecret.value = ''; // 保存できたら Secret を画面から消す
      oauthIdDirty = false;
    }
    showOAuthError(result.ok ? null : result.reason);
    renderOAuth(result);
  } finally {
    oauthBusy = false;
    updateOAuthSave();
  }
}

oauthSave.addEventListener('click', () => void saveOAuth());
oauthClear.addEventListener('click', async () => {
  const result = await window.oauthApi.clear();
  if (result.ok) {
    oauthClientSecret.value = '';
    oauthIdDirty = false;
  }
  showOAuthError(result.ok ? null : result.reason);
  renderOAuth(result);
});
oauthManual.addEventListener('click', async () => {
  const r = await window.oauthApi.openManual();
  if (!r.ok) showOAuthError('manual_failed');
});

window.oauthApi.onChanged(renderOAuth);
// 版（文言の出し分け）が分かってから連携状態を描く
window.oauthApi
  .getState()
  .then(renderOAuth)
  .finally(() => window.authApi.getState().then(renderAuth));

// ---- ボイス（VOICEVOX。F-13。個人版・共有版とも：v5.11。有効・無効は接続状態だけで決まる）----
const voiceStatus = document.getElementById('voice-status');
const voiceDetail = document.getElementById('voice-detail');
const voiceCredit = document.getElementById('voice-credit');
const voiceRecheck = document.getElementById('voice-recheck');

function renderVoice(v) {
  voiceStatus.classList.toggle('linked', v.status === 'available');
  voiceStatus.classList.toggle('warning', v.status === 'unavailable' || v.status === 'error');
  voiceStatus.textContent =
    {
      unknown: '確認中…',
      available: `接続中（v${v.version}）`,
      unavailable: 'VOICEVOX未検出',
      error: '読み上げに失敗しました',
    }[v.status] ?? '不明';

  const detail =
    v.status === 'unavailable'
      ? 'VOICEVOXが見つかりません。読み上げを使うには、VOICEVOXをインストールして起動してください（今は読み上げをスキップしています。読み上げ以外の機能はそのまま使えます）。'
      : v.status === 'error'
        ? `${v.reason ?? ''}`
        : '';
  voiceDetail.textContent = detail;
  voiceDetail.hidden = detail === '';
  voiceDetail.classList.toggle('error', detail !== '');

  // クレジット表記（VOICEVOX 利用規約・7.2 ライセンス注意）
  const credit = v.status === 'available' && v.speakerName ? `VOICEVOX:${v.speakerName.replace(/（.*）$/, '')}` : '';
  voiceCredit.textContent = credit ? `音声：${credit}` : '';
  voiceCredit.hidden = credit === '';
}

voiceRecheck.addEventListener('click', async () => {
  voiceRecheck.disabled = true;
  try {
    renderVoice(await window.voiceApi.recheck());
  } finally {
    voiceRecheck.disabled = false;
  }
});

window.voiceApi.onChanged(renderVoice);
window.voiceApi.getState().then(renderVoice);

// ---- チャット（Gemini APIキー。F-16）----
// キーはメインへ送るだけ。保存後は入力欄を空に戻し、キー自体はこの画面に二度と表示しない（状態＝設定済みか、のみ受け取る）
const geminiStatus = document.getElementById('gemini-status');
const geminiDetail = document.getElementById('gemini-detail');
const geminiKey = document.getElementById('gemini-key');
const geminiSave = document.getElementById('gemini-save');
const geminiClear = document.getElementById('gemini-clear');

const GEMINI_ERRORS = {
  empty: 'キーを入力してください。',
  too_short: 'キーが短すぎます。コピーし直してください。',
  too_long: 'キーが長すぎます。コピーし直してください。',
  invalid_chars: 'キーに使えない文字（空白・改行・全角文字など）が含まれています。',
  save_failed: 'キーを暗号化して保存できませんでした。',
};

function renderGemini(state) {
  geminiStatus.classList.toggle('linked', state.configured === true);
  geminiStatus.textContent = state.configured ? '設定済み（話しかけるが使えます）' : '未設定';
  geminiClear.hidden = state.configured !== true;
}

function showGeminiError(reason) {
  const message = reason ? (GEMINI_ERRORS[reason] ?? 'キーを保存できませんでした。') : '';
  geminiDetail.textContent = message;
  geminiDetail.hidden = message === '';
  geminiDetail.classList.toggle('error', message !== '');
}

async function saveGeminiKey() {
  geminiSave.disabled = true;
  try {
    const result = await window.geminiApi.setKey(geminiKey.value);
    if (result.ok) geminiKey.value = ''; // 保存できたらキーを画面から消す
    showGeminiError(result.ok ? null : result.reason);
    renderGemini(result);
  } finally {
    geminiSave.disabled = false;
  }
}

geminiSave.addEventListener('click', saveGeminiKey);
geminiKey.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) void saveGeminiKey();
});
geminiClear.addEventListener('click', async () => {
  showGeminiError(null);
  renderGemini(await window.geminiApi.clearKey());
});

window.geminiApi.onChanged(renderGemini);
window.geminiApi.getState().then(renderGemini);

// ---- ショートカット（F-19。配布版のみ） ----
const SHORTCUT_LOCATIONS = ['desktop', 'startMenu'];
const shortcutDetail = document.getElementById('shortcut-detail');
const SHORTCUT_STATUS_TEXT = { none: 'なし', ok: '作成済み', stale: '場所が古い（作り直してください）' };
const SHORTCUT_ERRORS = {
  unsupported: '開発中の実行ではショートカットを作れません（配布版でのみ使えます）。',
  write_failed: 'ショートカットを作成できませんでした。',
  remove_failed: 'ショートカットを削除できませんでした。',
};

function renderShortcuts(state) {
  for (const loc of SHORTCUT_LOCATIONS) {
    const status = document.getElementById(`shortcut-${loc}-status`);
    const create = document.getElementById(`shortcut-${loc}-create`);
    const remove = document.getElementById(`shortcut-${loc}-remove`);
    const s = state.supported ? state[loc] : null;
    status.textContent = state.supported ? SHORTCUT_STATUS_TEXT[s] : '配布版でのみ使えます';
    status.classList.toggle('linked', s === 'ok');
    status.classList.toggle('warning', s === 'stale');
    create.hidden = !state.supported || s === 'ok';
    create.textContent = s === 'stale' ? '作り直す' : '作成';
    remove.hidden = !state.supported || s === 'none';
  }
}

function showShortcutError(reason) {
  const message = reason ? (SHORTCUT_ERRORS[reason] ?? 'ショートカットを変更できませんでした。') : '';
  shortcutDetail.textContent = message;
  shortcutDetail.hidden = message === '';
  shortcutDetail.classList.toggle('error', message !== '');
}

for (const loc of SHORTCUT_LOCATIONS) {
  for (const action of ['create', 'remove']) {
    const button = document.getElementById(`shortcut-${loc}-${action}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await window.shortcutApi[action](loc);
        showShortcutError(result.ok ? null : result.reason);
        renderShortcuts(result);
      } finally {
        button.disabled = false;
      }
    });
  }
}

// 設定画面の外（エクスプローラー）で消された場合もあるので、開くたびに確かめる
window.shortcutApi.status().then(renderShortcuts);
