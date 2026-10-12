import { Menu, Tray, nativeImage } from 'electron';

// 外部アセットなしで黄色い丸のトレイアイコンを生成する（32x32 BGRA, プリマルチプライド）
function createTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1;
  const outline = 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - d)); // 外縁のアンチエイリアス
      const isOutline = d > radius - outline;
      const [r, g, b] = isOutline ? [0xb8, 0x86, 0x00] : [0xff, 0xd7, 0x00];
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * coverage);
      buf[i + 1] = Math.round(g * coverage);
      buf[i + 2] = Math.round(r * coverage);
      buf[i + 3] = Math.round(255 * coverage);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

/**
 * アプリアイコンの画像（assets/icons/icon.png。F-19・v5.12）をトレイ用に 32px（16 DIP × 2倍）へ縮小する。
 * 画像が無い・読めなければ、コードで描いた黄色い丸にする。
 * @param {string} [iconPath]
 */
function loadTrayIcon(iconPath) {
  const img = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (img.isEmpty()) return createTrayIcon();
  const png = img.resize({ width: 32, height: 32, quality: 'best' }).toPNG();
  return nativeImage.createFromBuffer(png, { scaleFactor: 2 });
}

/**
 * トレイ常駐とメニューを生成する。メニューはマスコットの右クリックでも再利用する。
 * 「キャラクター変更」はキャラクター選択画面を開く（Phase 8）。「話しかける」は Gemini APIキーが設定されているときだけ有効（7.3）。
 * @param {object} opts
 * @param {() => void} opts.onQuit
 * @param {() => void} opts.onOpenSettings
 * @param {() => void} [opts.onChangeCharacter] 「キャラクター変更」（キャラクター選択画面を開く）
 * @param {() => void} [opts.onTalk] 「話しかける」（チャットウィンドウを開く）
 * @param {() => boolean} [opts.isTalkEnabled] APIキーが設定済みか
 * @param {() => boolean} opts.getMuted 現在のミュート状態
 * @param {() => void} opts.onToggleMute ミュートを反転して保存する
 * @param {() => boolean} [opts.getNotifyOnly] 「通知時のみ表示」（F-20）が ON か
 * @param {() => void} [opts.onToggleNotifyOnly] 「通知時のみ表示」を反転して保存する
 * @param {string} [opts.iconPath] トレイアイコンの画像（無ければ黄色い丸）
 * @param {() => Electron.MenuItemConstructorOptions[]} [opts.getDevItems] --dev 起動時だけ返す開発用メニュー項目（テスト通知など）。空なら何も足さない
 */
export function createTray({ onQuit, onOpenSettings, onChangeCharacter = () => {}, onTalk = () => {}, isTalkEnabled = () => false, getMuted, onToggleMute, getNotifyOnly = () => false, onToggleNotifyOnly = () => {}, iconPath, getDevItems = () => [] }) {
  const buildMenu = () => {
    const devItems = getDevItems();
    return Menu.buildFromTemplate([
      { label: '設定', click: onOpenSettings },
      { label: 'キャラクター変更', click: onChangeCharacter },
      { label: 'ミュート', type: 'checkbox', checked: getMuted(), click: onToggleMute },
      { label: '通知時のみ表示', type: 'checkbox', checked: getNotifyOnly(), click: onToggleNotifyOnly },
      { label: '話しかける', enabled: isTalkEnabled(), click: onTalk },
      ...(devItems.length > 0 ? [{ type: 'separator' }, { label: '[開発] テスト通知', submenu: devItems }] : []),
      { type: 'separator' },
      { label: '終了', click: onQuit },
    ]);
  };

  const tray = new Tray(loadTrayIcon(iconPath));
  tray.setToolTip('おしらせメイト');
  tray.setContextMenu(buildMenu());

  return {
    buildMenu,
    // トレイ側のメニューは静的なので、設定が変わったら作り直してチェック状態を同期する
    refreshMenu: () => tray.setContextMenu(buildMenu()),
    // Windows でトレイアイコンがゴースト表示で残らないよう終了時に破棄する
    destroy: () => tray.destroy(),
  };
}
