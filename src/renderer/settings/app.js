const sfx = document.getElementById('volume-sfx');
const sfxValue = document.getElementById('volume-sfx-value');
const voice = document.getElementById('volume-voice');
const voiceValue = document.getElementById('volume-voice-value');
const muted = document.getElementById('muted');
const launchAtLogin = document.getElementById('launch-at-login');
const notifyOnly = document.getElementById('notify-only');

// TODO のお知らせ時刻（時・分のリール。timeReel.js）。回している間は保存せず、止まって少し経ってから 1 回だけ保存する
// （1 目盛りごとに保存すると、そのたびに TODO を取り直すため）
const TASK_TIME_SAVE_DELAY_MS = 700;
let taskTimeSaveTimer = null;
const scheduleTaskTimeSave = () => {
  clearTimeout(taskTimeSaveTimer);
  taskTimeSaveTimer = setTimeout(async () => {
    taskTimeSaveTimer = null;
    render(await window.settingsApi.update({ taskNotifyHour: taskHourReel.value, taskNotifyMinute: taskMinuteReel.value }));
  }, TASK_TIME_SAVE_DELAY_MS);
};
const taskHourReel = window.TimeReel.mount(document.getElementById('task-notify-hour'), { max: 23, onInput: scheduleTaskTimeSave });
const taskMinuteReel = window.TimeReel.mount(document.getElementById('task-notify-minute'), { max: 59, onInput: scheduleTaskTimeSave });
// 保存待ちのままウィンドウを閉じたら、待たずに送る（動かした値を取りこぼさない）
window.addEventListener('pagehide', () => {
  if (taskTimeSaveTimer === null) return;
  clearTimeout(taskTimeSaveTimer);
  taskTimeSaveTimer = null;
  void window.settingsApi.update({ taskNotifyHour: taskHourReel.value, taskNotifyMinute: taskMinuteReel.value });
});

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
  // 保存待ちの間（回している途中）は書き換えない。動かした値を巻き戻さないため
  if (taskTimeSaveTimer === null) {
    taskHourReel.set(settings.taskNotifyHour);
    taskMinuteReel.set(settings.taskNotifyMinute);
  }
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
const authExpiry = document.getElementById('auth-expiry');
const authLink = document.getElementById('auth-link');
const authRelink = document.getElementById('auth-relink');
const authCancel = document.getElementById('auth-cancel');
const authUnlink = document.getElementById('auth-unlink');
const googleSetupEntry = document.getElementById('google-setup-entry');
const openGoogleTab = document.getElementById('open-google-tab');
const tabGoogle = document.getElementById('tab-google');

// 版ごとの文言（個人版は .env、共有版は「Google 連携」タブ：2.4・v5.11）。版は oauth:get-state で受け取る（画面には版の名前を出さない）
let edition = 'personal';
/** 読み込んだクライアントをどの道で入れたか（'received' 受け取った／'self' 自分で作った／null 不明。Phase 16） */
let oauthOrigin = null;
/** 最後に受け取った連携の状態（クライアントの状態が変わったときに描き直す） */
let lastAuth = null;

/** 自分で作ったクライアント（テストモード）の連携が切れるまで（Google の仕様。linkExpiry.js と同じ値） */
const TEST_MODE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const CONFIG_PROBLEMS = {
  missing_client_id: '.env に GOOGLE_OAUTH_CLIENT_ID が設定されていません。',
  missing_client_secret: '.env に GOOGLE_OAUTH_CLIENT_SECRET が設定されていません。',
  invalid_client_id: 'GOOGLE_OAUTH_CLIENT_ID の形式が正しくありません（〜.apps.googleusercontent.com）。',
};

function configProblemText(auth) {
  if (edition === 'shared') return '「Google 連携」タブで準備を済ませてください。';
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

function invalidClientText() {
  if (edition !== 'shared') return 'Client ID / Secret が Google に受け付けられませんでした。.env の値を確認してください。';
  if (oauthOrigin === 'received') {
    return 'クライアントが Google に受け付けられませんでした。貼り付けた値が正しいか確かめ、だめなら送ってくれた人に確認してください。';
  }
  return 'クライアントが Google に受け付けられませんでした。Google Cloud でクライアントを削除していないか確認し、「Google 連携」タブの B の手順 3・4 をやり直してください。';
}

/** 期限の表示（例：11月8日 15:00） */
const formatDeadline = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function renderAuth(auth) {
  lastAuth = auth;
  const { status } = auth;
  const relinking = status === 'linked' && auth.relinking === true;
  authStatus.classList.toggle('linked', status === 'linked' && !relinking);
  authStatus.textContent = relinking
    ? 'ブラウザで同意を完了してください…'
    : ({
        unconfigured: '設定が必要です',
        unlinked: '未連携',
        linking: 'ブラウザで同意を完了してください…',
        checking: '連携状態を確認中…',
        linked: '連携中',
      }[status] ?? '不明');

  // 自分で作ったクライアント（テストモード）は連携が 7 日で切れるので、連携したまま同意をやり直せる（Phase 16）
  const expires = status === 'linked' && oauthOrigin === 'self';
  authLink.hidden = !(status === 'unlinked' || status === 'unconfigured');
  authLink.disabled = status === 'unconfigured';
  authRelink.hidden = !expires || relinking;
  authCancel.hidden = !(status === 'linking' || relinking);
  authUnlink.hidden = status !== 'linked' || relinking;

  let detail =
    status === 'unconfigured'
      ? configProblemText(auth)
      : auth.lastError === 'invalid_client'
        ? invalidClientText()
        : (AUTH_ERRORS[auth.lastError] ?? '');
  if (auth.lastError === 'expired' && oauthOrigin === 'self') {
    detail += '（自分で作ったクライアントは、テストモードのため 7 日で切れます）';
  }
  authDetail.textContent = detail;
  authDetail.hidden = detail === '';
  authDetail.classList.toggle('error', status === 'unconfigured' || Boolean(auth.lastError));

  const expiry =
    expires && Number.isFinite(auth.linkedAt)
      ? `テストモードのため、${formatDeadline(auth.linkedAt + TEST_MODE_LIFETIME_MS)} ごろに連携が切れます。その前に「連携し直す」を押してください（前日にマスコットがお知らせします）。`
      : '';
  authExpiry.textContent = expiry;
  authExpiry.hidden = expiry === '';
  renderWizardLink(auth);
}

authLink.addEventListener('click', async () => renderAuth(await window.authApi.link()));
authRelink.addEventListener('click', async () => renderAuth(await window.authApi.relink()));
authCancel.addEventListener('click', async () => renderAuth(await window.authApi.cancel()));
authUnlink.addEventListener('click', async () => renderAuth(await window.authApi.unlink()));
openGoogleTab.addEventListener('click', () => window.SettingsTabs?.show('google'));

window.authApi.onChanged(renderAuth);

// ---- Google 連携の準備（「Google 連携」タブ。利用者が OAuth クライアントを読み込む版だけ。2.4・3.6・F-18）----
// Phase 12 でウィザードにし、Phase 16 で設定タブから分けて 2 つの道にした（A：受け取った人、B：自分で作る人）。
// 手順のボタンは手順の名前だけをメインへ送る（開くページはメインが決める）。JSON はメインが読み込み、値はこの画面を通らない。
// 貼り付けた Secret もメインへ送るだけで、保存後は欄を空に戻す（受け取るのは状態だけ）。
// 保存・読み込みには、どちらの道で入れたか（origin）を付けて送る（自分で作ったものだけ、連携の期限を予告する）
const oauthSection = document.getElementById('oauth-section');
const oauthStatus = document.getElementById('oauth-status');
const oauthDetail = document.getElementById('oauth-detail');
const oauthImports = [...document.querySelectorAll('[data-oauth-import]')];
const oauthDrop = document.getElementById('oauth-drop');
const oauthStepPaste = document.getElementById('oauth-step-paste');
const oauthStepImport = document.getElementById('oauth-step-import');
const oauthLinkSteps = [...document.querySelectorAll('[data-oauth-step="link"]')];
const oauthLinks = [...document.querySelectorAll('[data-oauth-link]')];
const oauthClientId = document.getElementById('oauth-client-id');
const oauthClientSecret = document.getElementById('oauth-client-secret');
const oauthSave = document.getElementById('oauth-save');
const oauthClear = document.getElementById('oauth-clear');
const oauthManual = document.getElementById('oauth-manual');

const OAUTH_ERRORS = {
  // 貼り付け
  missing_client_id: 'Client ID を入力してください。',
  missing_client_secret: 'Client Secret を入力してください。',
  invalid_client_id: 'Client ID の形式が正しくありません（〜.apps.googleusercontent.com で終わる値です）。',
  invalid_client_secret: 'Client Secret の形式が正しくありません（空白・改行・全角文字を含まない8〜256文字）。コピーし直してください。',
  swapped: 'Client Secret の欄に Client ID が入っています。欄を入れ替えていないか確認してください。',
  // JSON の読み込み（oauthClientFile.js）
  not_json: 'JSON ファイルではありません。「client_secret_〜.json」という名前のファイルを選んでください。',
  too_large: 'ファイルが大きすぎます。「client_secret_〜.json」という名前のファイルを選んでください。',
  web_client: 'このクライアントは種類が「ウェブ アプリケーション」です。B の手順 3 で、種類を「デスクトップ アプリ」にして作り直してください。',
  not_client_file: 'OAuth クライアントの JSON ではありません。「client_secret_〜.json」という名前のファイルを選んでください。',
  missing_values:
    'この JSON にはクライアント シークレットが入っていません。シークレットは作成直後の画面でダウンロードした JSON にだけ入っています。B の手順 3 でクライアントを作り直し、作成直後の画面で「JSON をダウンロード」を押してください。',
  invalid_values: 'JSON の中の値の形式が正しくありません。ダウンロードし直したファイルを読み込んでください。',
  read_failed: 'ファイルを読み込めませんでした。',
  // 共通
  linked: '連携中は変更できません。先に設定タブの「連携解除」をしてから変更してください。',
  save_failed: '暗号化して保存できませんでした。',
  not_shared: 'この版では .env の値を使います。',
  manual_failed: 'セットアップ手順書を開けませんでした。アプリのフォルダにある「セットアップ手順書.html」を開いてください。',
};
const LOCKED_MESSAGE = '連携中は変更できません。変更するときは先に設定タブの「連携解除」をしてください。';
const ORIGIN_TEXT = { received: '受け取ったもの', self: '自分で作ったもの' };

let oauthBusy = false;
let oauthEditable = false;
let oauthConfigured = false;
/** Client ID 欄を利用者が書き換えたか（書き換え中は保存済みの値で上書きしない） */
let oauthIdDirty = false;

function updateOAuthSave() {
  // 両方の欄が空でないときだけ保存できる（空文字での保存・連携の試行を防ぐ。検証はメインで行う）
  oauthSave.disabled = oauthBusy || !oauthEditable || oauthClientId.value.trim() === '' || oauthClientSecret.value.trim() === '';
  for (const button of oauthImports) button.disabled = oauthBusy || !oauthEditable;
  oauthDrop.classList.toggle('disabled', oauthBusy || !oauthEditable);
}

function showOAuthError(reason) {
  const message = reason ? (OAUTH_ERRORS[reason] ?? '保存できませんでした。') : '';
  oauthDetail.textContent = message;
  oauthDetail.hidden = message === '';
  oauthDetail.classList.toggle('error', message !== '');
}

/** A の手順 2・B の手順 5（連携する）。✓ は連携中のとき。ボタンは設定タブの「連携する」と同じ */
function renderWizardLink(auth) {
  const { status } = auth;
  for (const step of oauthLinkSteps) step.classList.toggle('done', status === 'linked');
  for (const button of oauthLinks) {
    button.disabled = status !== 'unlinked';
    button.textContent = status === 'linked' ? '連携中' : status === 'linking' ? '同意を待っています…' : '連携する';
  }
}

function renderOAuth(state) {
  edition = state.edition;
  oauthOrigin = state.origin ?? null;
  // .env を使う版では「Google 連携」タブを出さない（開いていたら設定タブへ戻す）
  tabGoogle.hidden = !state.userInput;
  googleSetupEntry.hidden = !state.userInput;
  if (!state.userInput && tabGoogle.getAttribute('aria-selected') === 'true') window.SettingsTabs?.show('settings');
  oauthSection.hidden = !state.userInput;
  if (lastAuth) renderAuth(lastAuth);
  if (!state.userInput) return;
  oauthEditable = state.editable === true;
  oauthConfigured = state.configured === true;
  // 読み込んだ道の手順に ✓（どちらで入れたか分からない古い保存は ✓ を付けない）。Client ID も画面には表示しない（v5.15）
  oauthStepPaste.classList.toggle('done', oauthConfigured && oauthOrigin === 'received');
  oauthStepImport.classList.toggle('done', oauthConfigured && oauthOrigin === 'self');
  oauthStatus.classList.toggle('linked', oauthConfigured);
  oauthStatus.textContent = oauthConfigured
    ? `読み込み済み${ORIGIN_TEXT[oauthOrigin] ? `（${ORIGIN_TEXT[oauthOrigin]}）` : ''}`
    : 'まだ読み込んでいません';
  // 利用者が書き換え中の値は消さない。保存・削除のあとは空に戻す
  if (!oauthIdDirty) oauthClientId.value = '';
  oauthClientId.placeholder = oauthConfigured ? '保存済み（変更するときだけ入力）' : '〜.apps.googleusercontent.com';
  oauthClientSecret.placeholder = oauthConfigured ? '保存済み（変更するときだけ入力）' : 'Client Secret を貼り付け';
  oauthClientId.disabled = !oauthEditable;
  oauthClientSecret.disabled = !oauthEditable;
  oauthClear.hidden = !oauthConfigured;
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

/** 保存・読み込み・削除の共通の後始末。成功したら Secret 欄を空に戻す */
async function runOAuthAction(action) {
  oauthBusy = true;
  updateOAuthSave();
  try {
    const result = await action();
    if (result.ok) {
      oauthClientSecret.value = '';
      oauthIdDirty = false;
    }
    if (!result.canceled) showOAuthError(result.ok ? null : result.reason);
    renderOAuth(result);
  } finally {
    oauthBusy = false;
    updateOAuthSave();
  }
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

// 貼り付けは A（受け取った人）の手順
const saveOAuth = () => runOAuthAction(() => window.oauthApi.set(oauthClientId.value, oauthClientSecret.value, 'received'));

oauthSave.addEventListener('click', () => void saveOAuth());
oauthClear.addEventListener('click', () => void runOAuthAction(() => window.oauthApi.clear()));
// 「ファイルを選ぶ」は A（JSON で受け取ったとき）と B の手順 4 にある。どちらの道かはボタンの data-oauth-import
for (const button of oauthImports) {
  button.addEventListener('click', () => void runOAuthAction(() => window.oauthApi.importFile(button.dataset.oauthImport)));
}

// 外部のページを既定のブラウザで開くボタン（B の手順の Console・ボイス欄の VOICEVOX・チャット欄の Gemini API キー。v5.15）。
// リンクの名前（data-link）だけをメインへ送る。開けなかったら、そのボタンがあるタブの詳細の行に出す
for (const button of document.querySelectorAll('[data-link]')) {
  button.addEventListener('click', async () => {
    const r = await window.linksApi.open(button.dataset.link);
    if (r.ok) return;
    const detail = button.closest('[role="tabpanel"]') === document.getElementById('panel-google')
      ? oauthDetail
      : button.closest('section')?.querySelector('p[id$="-detail"]');
    if (!detail) return;
    detail.textContent = 'ブラウザを開けませんでした。';
    detail.hidden = false;
    detail.classList.add('error');
  });
}

for (const button of oauthLinks) {
  button.addEventListener('click', async () => renderAuth(await window.authApi.link()));
}

// B の手順 4：ドラッグ＆ドロップ。画面のどこに落としてもページが移動しないよう、文書全体で既定の動作を止める
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
oauthDrop.addEventListener('dragenter', () => oauthDrop.classList.add('over'));
oauthDrop.addEventListener('dragleave', () => oauthDrop.classList.remove('over'));
oauthDrop.addEventListener('drop', (e) => {
  oauthDrop.classList.remove('over');
  if (oauthBusy || !oauthEditable) return;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  void runOAuthAction(() => window.oauthApi.importDropped(file, 'self'));
});

oauthManual.addEventListener('click', async () => {
  const r = await window.oauthApi.openManual();
  if (!r.ok) showOAuthError('manual_failed');
});

window.oauthApi.onChanged(renderOAuth);
// 版（文言の出し分け）とクライアントの入手の道が分かってから連携状態を描く
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

  // 同梱キャラクターの固定ボイス（F-23）：VOICEVOX が無くても、録音してある文は読み上げる
  const fixed = typeof v.fixedVoiceCredit === 'string' && v.fixedVoiceCredit !== '';
  const detail =
    v.status === 'unavailable'
      ? fixed
        ? 'VOICEVOXが見つかりません。このキャラクターは録音してある文だけを話します（件名などは読み上げません）。VOICEVOXを起動すると、すべて読み上げます。'
        : v.fixedVoiceChanged === true
          ? // 同梱キャラクターの声を変えているため、録音の声も使えない（v5.18）
            'VOICEVOXが見つかりません。このキャラクターは声を変えているため、録音してある声も使えません（今は読み上げをスキップしています）。キャラクターの編集画面の「同梱の状態に戻す」で録音の声に戻ります。'
          : 'VOICEVOXが見つかりません。読み上げを使うには、VOICEVOXをインストールして起動してください（今は読み上げをスキップしています。読み上げ以外の機能はそのまま使えます）。'
      : v.status === 'error'
        ? `${v.reason ?? ''}`
        : '';
  voiceDetail.textContent = detail;
  voiceDetail.hidden = detail === '';
  voiceDetail.classList.toggle('error', detail !== '');

  // クレジット表記（VOICEVOX 利用規約・7.2 ライセンス注意）。接続中の話者、無ければ同梱キャラクターの録音の話者
  const credit =
    v.status === 'available' && v.speakerName ? `VOICEVOX:${v.speakerName.replace(/（.*）$/, '')}` : fixed ? v.fixedVoiceCredit : '';
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

// ---- ショートカット（F-19。ソースからの起動でも作れる：v5.15。作れないのは Windows 以外だけ） ----
const SHORTCUT_LOCATIONS = ['desktop', 'startMenu'];
const shortcutDetail = document.getElementById('shortcut-detail');
const SHORTCUT_STATUS_TEXT = { none: 'なし', ok: '作成済み', stale: '場所が古い（作り直してください）' };
const SHORTCUT_ERRORS = {
  unsupported: 'この環境ではショートカットを作れません。',
  write_failed: 'ショートカットを作成できませんでした。',
  remove_failed: 'ショートカットを削除できませんでした。',
};

function renderShortcuts(state) {
  for (const loc of SHORTCUT_LOCATIONS) {
    const status = document.getElementById(`shortcut-${loc}-status`);
    const create = document.getElementById(`shortcut-${loc}-create`);
    const remove = document.getElementById(`shortcut-${loc}-remove`);
    const s = state.supported ? state[loc] : null;
    status.textContent = state.supported ? SHORTCUT_STATUS_TEXT[s] : 'この環境では使えません';
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
