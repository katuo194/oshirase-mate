// userData の保存先を固定する（v5.12。個人版・開発時は旧名のフォルダ、共有版は専用のフォルダ。理由は userDataDir.js）。
// index.js の最初の import にすること：store.js は import 時に electron-store を生成して userData を読み、
// 単一インスタンスのロックも userData に置かれるため、どちらよりも先に setPath する必要がある。
// 起動時に --user-data-dir が明示されていれば、その場所を使い、固定しない（v5.15。開発中の共有版の動作確認用）。
import { app } from 'electron';
import path from 'node:path';
import { BUILD_EDITION } from './buildInfo.js';
import { userDataDirToPin } from './userDataDir.js';

const dirName = userDataDirToPin({ buildEdition: BUILD_EDITION, hasUserDataDirSwitch: app.commandLine.hasSwitch('user-data-dir') });
if (dirName) app.setPath('userData', path.join(app.getPath('appData'), dirName));
