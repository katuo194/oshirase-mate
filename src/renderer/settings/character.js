// キャラクター選択画面（F-17・3.6）。一覧から選ぶと即マスコットへ反映される（メインが設定を保存して切り替える）。
// 設定ウィンドウの「キャラクター」タブ（v5.19。以前は別のウィンドウ）。app.js と同じページで読み込むので、名前がぶつからないよう関数の中に閉じる
(() => {
  const listEl = document.getElementById('character-list');
  const errorEl = document.getElementById('character-error');

  const SLOT_LABELS = { 'notify.calendar': 'カレンダー', 'notify.tasks': 'TODO', 'notify.gmail': 'メール' };

  function subText(c) {
    if (c.builtin) return '組み込み';
    // 同梱キャラクター（F-23）：固定ボイスのクレジット表記（VOICEVOX の利用規約・7.2）をここに出す
    if (c.bundled) return c.voiceCredit ? `同梱・音声：${c.voiceCredit}` : '同梱';
    const kinds = c.slots.filter((s) => SLOT_LABELS[s]).map((s) => SLOT_LABELS[s]);
    return kinds.length > 0 ? `EmoteLab・種別モーション：${kinds.join('／')}` : 'EmoteLab';
  }

  function render(view) {
    listEl.replaceChildren(
      ...view.characters.map((c) => {
        const li = document.createElement('li');
        li.className = `item${c.id === view.selected ? ' selected' : ''}`;

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'character';
        radio.checked = c.id === view.selected;
        radio.setAttribute('aria-label', c.displayName);

        let thumb;
        if (c.thumbnail) {
          thumb = document.createElement('img');
          thumb.src = c.thumbnail;
          thumb.alt = '';
          thumb.className = 'thumb';
        } else {
          thumb = document.createElement('div');
          thumb.className = 'thumb builtin';
        }

        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = c.displayName; // ユーザー入力由来なので textContent のみ
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = subText(c);
        meta.append(name, sub);
        // 読み上げの声（v5.18。「声：ずんだもん（ノーマル）・録音あり」など。名前はメインが VOICEVOX の一覧から決める）
        if (c.voiceLabel) {
          const voice = document.createElement('span');
          voice.className = 'sub';
          voice.textContent = c.voiceLabel;
          meta.append(voice);
        }

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'edit';
        edit.textContent = '編集';
        edit.title = c.builtin || c.bundled ? '声・キャラクター設定・セリフを編集' : '名前・モーション・声・キャラクター設定・セリフを編集';
        edit.addEventListener('click', (e) => {
          e.stopPropagation(); // 行のクリック（選択）にしない
          window.characterEditor.open(c.id); // タブの中身を編集画面に切り替える（v5.19。以前は別のウィンドウ）
        });

        li.append(radio, thumb, meta, edit);
        li.addEventListener('click', () => void choose(c.id));
        return li;
      }),
    );
  }

  async function choose(id) {
    errorEl.hidden = true;
    const result = await window.characterApi.select(id);
    render(result);
    if (!result.ok) {
      errorEl.textContent = 'このキャラクターは選択できませんでした（削除された可能性があります）';
      errorEl.hidden = false;
    }
  }

  document.getElementById('character-create').addEventListener('click', () => window.characterEditor.open());
  window.characterApi.onChanged(render);
  void window.characterApi.list().then(render);
})();
