// キャラクター作成／編集画面（F-17・3.6・v5.9）。フォルダはメインがOSのダイアログで選び、検証結果（枚数・エラー理由）だけが返ってくる。
// ?edit=<id> で開くと編集モード（取り込んだキャラクターは全項目、既定キャラクター〔id=default〕は声・キャラクター設定・セリフのみ）。
const SLOTS = [
  { slot: 'rest', label: '待機（rest）', required: true },
  { slot: 'notify', label: '通知（notify）', required: true },
  { slot: 'notify.calendar', label: 'カレンダー', required: false },
  { slot: 'notify.tasks', label: 'TODO', required: false },
  { slot: 'notify.gmail', label: '重要メール', required: false },
];
const FPS_DEFAULT = 30;
const FPS_MIN = 1;
const FPS_MAX = 60;
const PERSONA_MAX = 1000;

const $ = (id) => document.getElementById(id);
const nameEl = $('name');
const slotsEl = $('slots');
const submitEl = $('submit');
const submitStatusEl = $('submit-status');
const listEl = $('list');
const listEmptyEl = $('list-empty');
const speakerEl = $('speaker');
const speedEl = $('speed');
const pitchEl = $('pitch');
const personaEl = $('persona');

const editId = new URLSearchParams(location.search).get('edit');
/** 'create' | 'edit' */
let mode = 'create';
/** 編集中のキャラクター（begin の値） */
let editing = null;
let busy = false;

/**
 * スロットの行の状態。
 * state：'none'（未設定）／'keep'（編集：今の画像のまま）／'picked'（検証に通ったフォルダを選んだ）
 */
const rows = {};

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.classList.remove('ok', 'error');
  if (kind) el.classList.add(kind);
}

/** fps の入力値。空欄は既定の 30、範囲外・小数は null */
function fpsValue(slot) {
  const v = rows[slot].fps.value.trim();
  if (v === '') return FPS_DEFAULT;
  const n = Number(v);
  return Number.isInteger(n) && n >= FPS_MIN && n <= FPS_MAX ? n : null;
}

const isBuiltinEdit = () => mode === 'edit' && editing?.builtin === true;
const personaLength = () => [...personaEl.value.trim()].length;

function updateSubmit() {
  let ok = !busy && personaLength() <= PERSONA_MAX && linesWithinCount();
  if (!isBuiltinEdit()) {
    ok &&= nameEl.value.trim() !== '';
    ok &&= SLOTS.filter((s) => s.required).every((s) => rows[s.slot].state !== 'none');
    ok &&= SLOTS.every((s) => rows[s.slot].state === 'none' || fpsValue(s.slot) !== null);
  }
  submitEl.disabled = !ok;
}

// ---- モーションの行 ----

function emptyText(def) {
  return def.required ? '未選択' : '未選択（通知のモーションを使用）';
}

/** 行の表示を state に合わせる */
function renderRow(def) {
  const row = rows[def.slot];
  // 選んだフォルダの名前・エラー理由は選択時に表示済み（ここでは上書きしない）
  if (!row.error && row.state !== 'picked') {
    if (row.state === 'keep') setStatus(row.status, `現在の画像（${row.original.frameCount}枚）`, 'ok');
    else if (row.original) setStatus(row.status, '解除（保存すると画像を削除します）', 'error');
    else setStatus(row.status, emptyText(def));
  }
  // 編集：選び直した・解除した行は「元に戻す」、それ以外（任意スロット）は「解除」
  const changed = row.original && row.state !== 'keep';
  row.clear.textContent = changed ? '元に戻す' : 'クリア';
  row.clear.hidden = !(changed || row.state === 'picked' || row.error || (row.state === 'keep' && !def.required));
  row.fps.disabled = row.state === 'none';
}

function buildRows() {
  for (const def of SLOTS) {
    const tr = document.createElement('tr');

    const labelTd = document.createElement('td');
    labelTd.className = 'slot-label';
    labelTd.textContent = def.label;
    if (def.required) {
      const req = document.createElement('span');
      req.className = 'required';
      req.textContent = '必須';
      labelTd.append(req);
    }

    const folderTd = document.createElement('td');
    const folder = document.createElement('div');
    folder.className = 'folder';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = '選択…';
    const status = document.createElement('span');
    status.className = 'folder-status';
    folder.append(pick, status);
    folderTd.append(folder);

    const fpsTd = document.createElement('td');
    const fps = document.createElement('input');
    fps.type = 'number';
    fps.min = String(FPS_MIN);
    fps.max = String(FPS_MAX);
    fps.step = '1';
    fps.value = String(FPS_DEFAULT);
    fps.setAttribute('aria-label', `${def.label} の fps`);
    fps.addEventListener('input', updateSubmit);
    fpsTd.append(fps);

    const clearTd = document.createElement('td');
    const clear = document.createElement('button');
    clear.type = 'button';
    clearTd.append(clear);

    const row = { state: 'none', original: null, error: false, status, fps, clear };
    rows[def.slot] = row;

    pick.addEventListener('click', async () => {
      pick.disabled = true;
      try {
        const r = await window.characterCreateApi.pickFolder(def.slot);
        if (r.canceled) return;
        if (r.ok) {
          row.state = 'picked';
          row.error = false;
          if (row.original) fps.value = String(FPS_DEFAULT); // 差し替えた画像は書き出し設定が違うかもしれないので既定へ
          setStatus(status, `${r.folderName}（${r.frameCount}枚）`, 'ok'); // フォルダ名は外部由来なので textContent のみ
        } else {
          // 失敗：編集なら今の画像のまま、作成なら未設定
          row.state = row.original ? 'keep' : 'none';
          row.error = true;
          setStatus(status, `${r.folderName}：${r.message}`, 'error');
        }
      } finally {
        pick.disabled = false;
        renderRow(def);
        updateSubmit();
      }
    });

    clear.addEventListener('click', async () => {
      await window.characterCreateApi.clearSlot(def.slot);
      row.error = false;
      if (row.original && row.state !== 'keep') {
        row.state = 'keep'; // 元に戻す
        fps.value = String(row.original.fps);
      } else {
        row.state = 'none'; // 解除（作成：選んだフォルダを外す／編集：任意スロットの画像を削除）
      }
      renderRow(def);
      updateSubmit();
    });

    tr.append(labelTd, folderTd, fpsTd, clearTd);
    slotsEl.append(tr);
  }
}

function resetRows(slots = {}) {
  for (const def of SLOTS) {
    const row = rows[def.slot];
    const original = slots[def.slot] ?? null;
    row.original = original;
    row.state = original ? 'keep' : 'none';
    row.error = false;
    row.fps.value = String(original?.fps ?? FPS_DEFAULT);
    renderRow(def);
  }
}

// ---- 声（個人版・共有版とも。話者を選べるかは VOICEVOX が起動しているかで決まる：v5.11） ----

const fmt = (n) => Number(n).toFixed(2);
function syncVoiceOutputs() {
  $('speed-value').textContent = fmt(speedEl.value);
  $('pitch-value').textContent = fmt(pitchEl.value);
  const none = speakerEl.value === '';
  speedEl.disabled = none;
  pitchEl.disabled = none;
}
speedEl.addEventListener('input', syncVoiceOutputs);
pitchEl.addEventListener('input', syncVoiceOutputs);
speakerEl.addEventListener('change', syncVoiceOutputs);

/** 話者の選択肢を作る。保存済みの声が一覧に無ければ（VOICEVOX 未起動など）その値を残す選択肢を足す */
async function loadSpeakers(voice) {
  const r = await window.characterCreateApi.listSpeakers();
  speakerEl.replaceChildren();
  const def = new Option('指定しない（config.json の声）', '');
  speakerEl.append(def);
  let found = false;
  for (const sp of r.speakers) {
    const group = document.createElement('optgroup');
    group.label = sp.name;
    for (const st of sp.styles) {
      const opt = new Option(`${sp.name}（${st.name}）`, String(st.id));
      if (voice && voice.speakerId === st.id) found = true;
      group.append(opt);
    }
    speakerEl.append(group);
  }
  if (voice && !found) speakerEl.append(new Option(`保存済みの声（話者ID ${voice.speakerId}）`, String(voice.speakerId)));
  speakerEl.value = voice ? String(voice.speakerId) : '';
  speedEl.value = String(voice?.speedScale ?? 1);
  pitchEl.value = String(voice?.pitchScale ?? 0);
  setStatus($('voice-status'), r.available ? '' : 'VOICEVOX が起動していないため話者を選べません。VOICEVOX を起動してから開き直してください（保存済みの声はそのまま残ります）。', r.available ? '' : 'error');
  syncVoiceOutputs();
}

function voiceValue() {
  if (speakerEl.value === '') return null;
  return { speakerId: Number(speakerEl.value), speedScale: Number(speedEl.value), pitchScale: Number(pitchEl.value) };
}

// ---- キャラクター設定 ----

function syncPersonaCount() {
  const n = personaLength();
  const el = $('persona-count');
  el.textContent = `${n}/${PERSONA_MAX}`;
  el.classList.toggle('error', n > PERSONA_MAX);
  updateSubmit();
}
personaEl.addEventListener('input', syncPersonaCount);

// ---- セリフ（F-22）。欄はメインの案内（linesGuide：種類ごとの既定の文・使える差し込み・上限）から作る ----

/** 差し込みの説明（どれも任意。{title} を入れない文は件名を読まない） */
const PLACEHOLDER_HELP = {
  title: '{title}＝件名（入れないと件名は読みません）',
  time: '{time}＝開始時刻（例「10時30分」）',
  from: '{from}＝差出人',
};

/** 'notify.calendar' など → { def, textarea, count } */
const lineFields = {};
const lineFieldKey = (def) => `${def.group}.${def.kind}`;
/** 書いた文の数（空行は数えない。検証はメインが行う） */
const lineCount = (textarea) => textarea.value.split(/\r?\n/).filter((s) => s.trim() !== '').length;
const linesWithinCount = () => Object.values(lineFields).every((f) => lineCount(f.textarea) <= f.def.countMax);

function syncLineCount(field) {
  const n = lineCount(field.textarea);
  field.count.textContent = n === 0 ? `標準の文／${field.def.countMax}文まで` : `${n}/${field.def.countMax}文`;
  field.count.classList.toggle('error', n > field.def.countMax);
}

function buildLineFields(guide) {
  for (const def of guide) {
    const id = `lines-${def.group}-${def.kind}`;
    const wrap = document.createElement('div');
    wrap.className = 'line-field';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = def.label;

    const textarea = document.createElement('textarea');
    textarea.id = id;
    textarea.rows = def.group === 'idle' && def.kind === 'normal' ? 6 : 3;
    // 空欄のときは標準の文を薄く表示する（何も書かなければそれを使う）
    textarea.placeholder = def.defaults.join('\n');

    const foot = document.createElement('div');
    foot.className = 'line-foot';
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent =
      def.group === 'notify'
        ? `${def.placeholders.map((p) => PLACEHOLDER_HELP[p] ?? `{${p}}`).join('、')}。差し込みを除いて1文${def.lineMax}文字まで。`
        : `1文${def.lineMax}文字まで。差し込みは使えません。`;
    const count = document.createElement('span');
    count.className = 'count';
    foot.append(hint, count);

    wrap.append(label, textarea, foot);
    $(def.group === 'notify' ? 'lines-notify' : 'lines-idle').append(wrap);

    const field = { def, textarea, count };
    lineFields[lineFieldKey(def)] = field;
    textarea.addEventListener('input', () => {
      textarea.classList.remove('error');
      syncLineCount(field);
      updateSubmit();
    });
  }
}

/** 保存済みのセリフ（{ notify: { [kind]: string[] }, idle: … }）を欄に入れる。null なら空にする */
function setLines(lines) {
  for (const field of Object.values(lineFields)) {
    const saved = lines?.[field.def.group]?.[field.def.kind];
    field.textarea.value = Array.isArray(saved) ? saved.join('\n') : '';
    field.textarea.classList.remove('error');
    syncLineCount(field);
  }
}

/** 送るセリフ。各欄の文字列のまま送り、行の分割・検証はメインが行う（エラーに何行目かを入れるため） */
function linesValue() {
  const out = { notify: {}, idle: {} };
  for (const field of Object.values(lineFields)) out[field.def.group][field.def.kind] = field.textarea.value;
  return out;
}

/** セリフのエラーの欄を開いて示す */
function showLineError(fieldKey) {
  const field = lineFields[fieldKey];
  if (!field) return;
  $('lines-section').open = true;
  field.textarea.classList.add('error');
  field.textarea.focus();
}

// ---- 送信（作成＝取り込み／編集＝保存） ----

function request() {
  const fps = {};
  const slots = {};
  for (const def of SLOTS) {
    const row = rows[def.slot];
    slots[def.slot] = row.state;
    if (row.state !== 'none') fps[def.slot] = fpsValue(def.slot);
  }
  return { displayName: nameEl.value, slots, fps, voice: voiceValue(), persona: personaEl.value, lines: linesValue() };
}

submitEl.addEventListener('click', async () => {
  busy = true;
  updateSubmit();
  setStatus(submitStatusEl, mode === 'create' ? '取り込み中…' : '保存中…');
  try {
    if (mode === 'create') {
      const r = await window.characterCreateApi.importCharacter(request());
      if (r.ok) {
        nameEl.value = '';
        personaEl.value = '';
        resetRows();
        setLines(null);
        await loadSpeakers(null);
        syncPersonaCount();
        setStatus(submitStatusEl, `「${r.displayName}」を取り込みました。キャラクター選択画面から選べます。`, 'ok');
      } else {
        setStatus(submitStatusEl, r.message, 'error');
        if (r.field) showLineError(r.field);
      }
    } else {
      const r = await window.characterCreateApi.save(editing.id, request());
      if (r.ok) {
        if (!editing.builtin) resetRows(r.slots);
        setLines(r.lines); // 前後の空白・空行を除いた、保存した形に揃える
        setStatus(submitStatusEl, `「${r.displayName}」を保存しました。`, 'ok');
      } else {
        setStatus(submitStatusEl, r.message, 'error');
        if (r.field) showLineError(r.field);
      }
    }
  } catch (e) {
    setStatus(submitStatusEl, mode === 'create' ? '取り込みに失敗しました' : '保存に失敗しました', 'error');
    console.warn(e);
  } finally {
    busy = false;
    updateSubmit();
  }
});

nameEl.addEventListener('input', updateSubmit);

// ---- 取り込み済みの一覧（作成モードのみ） ----

function renderList(view) {
  const imported = view.characters.filter((c) => !c.builtin);
  listEmptyEl.hidden = imported.length > 0;
  listEl.replaceChildren(
    ...imported.map((c) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = c.thumbnail;
      img.alt = '';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.displayName; // ユーザー入力由来なので textContent のみ
      li.append(img, name);
      if (c.id === view.selected) {
        const current = document.createElement('span');
        current.className = 'current';
        current.textContent = '選択中';
        li.append(current);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '削除';
      del.addEventListener('click', async () => {
        del.disabled = true;
        try {
          const r = await window.characterCreateApi.remove(c.id);
          if (!r.ok && !r.canceled) setStatus(submitStatusEl, r.message, 'error');
        } finally {
          del.disabled = false;
        }
      });
      li.append(del);
      return li;
    }),
  );
}

// ---- 開始 ----

async function start() {
  buildRows();
  const r = await window.characterCreateApi.begin(editId);

  if (r.mode === 'missing') {
    $('heading').textContent = 'キャラクター編集';
    document.title = 'キャラクター編集';
    $('intro').hidden = true;
    $('missing').hidden = false;
    $('form').hidden = true;
    $('list-section').hidden = true;
    return;
  }

  mode = r.mode;
  buildLineFields(r.linesGuide ?? []);
  setLines(mode === 'edit' ? r.character.lines : null);
  if (mode === 'edit') {
    editing = r.character;
    const title = editing.builtin ? `${editing.displayName} の編集` : 'キャラクター編集';
    $('heading').textContent = title;
    document.title = title;
    $('list-section').hidden = true;
    submitEl.textContent = '保存';
    personaEl.value = editing.persona ?? '';
    if (editing.builtin) {
      // 既定キャラクター：画像と名前は変えられない（声・キャラクター設定・セリフだけ）
      $('intro').textContent = '組み込みのキャラクターです。声・キャラクター設定・セリフだけを変更できます。';
      $('name-section').hidden = true;
      $('slots-section').hidden = true;
    } else {
      $('intro').textContent = '名前・モーション・声・キャラクター設定・セリフを変更できます。モーションのフォルダを選び直すと、保存時に画像を差し替えます。';
      nameEl.value = editing.displayName;
      resetRows(editing.slots);
    }
  } else {
    resetRows();
    window.characterCreateApi.onChanged(renderList);
    renderList(await window.characterCreateApi.list());
  }

  await loadSpeakers(mode === 'edit' ? editing.voice : null);
  syncPersonaCount();
  updateSubmit();
}

void start();
