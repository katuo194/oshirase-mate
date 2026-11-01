// 設定ウィンドウのタブ（設定／Google 連携／キャラクター。v5.19。Google 連携は Phase 16）。表示を切り替えるだけで、ページは読み込み直さない（入力中の内容・スクロール位置を残す）。
// 最初のタブはメインが ?tab= で渡す。開いている間はトレイの「設定」「キャラクター変更」・右クリックの「Google と連携し直す」で settings:show-tab が届く。
// 「Google 連携」タブは .env を使う版では隠れている（app.js の renderOAuth が隠し、開いていたら設定タブへ戻す）
(() => {
  const TITLES = { settings: '設定', google: 'Google 連携', character: 'キャラクター選択' };
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];

  function show(name) {
    if (!Object.hasOwn(TITLES, name)) return;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    // キャラクタータブは一覧と作成・編集画面でタイトルが変わる（characterEditor.js が panel の data-title に入れる）
    const panel = document.getElementById(`panel-${name}`);
    document.title = panel.dataset.title || TITLES[name];
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.tab));
    // 左右キーで隣のタブへ（WAI-ARIA のタブの操作）。隠れているタブは飛ばす
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const visible = tabs.filter((t) => !t.hidden);
      const i = visible.indexOf(tab);
      const next = visible[(i + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
      show(next.dataset.tab);
      next.focus();
    });
  }

  // 設定タブの「連携の準備を開く」（app.js）から使う
  window.SettingsTabs = { show };

  window.tabsApi.onShowTab(show);
  show(new URLSearchParams(location.search).get('tab') ?? 'settings');
})();
