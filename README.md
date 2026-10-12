# おしらせメイト（デスクトップマスコット通知アプリ）

Googleカレンダー・Google Tasks・Gmail の通知を、デスクトップに常駐するマスコットがアニメーション・効果音・音声読み上げで知らせる Electron アプリです（Windows 11 専用）。
要件は [docs/要件定義書_v5.md](docs/要件定義書_v5.md) を参照してください。

## 動かし方

Node.js 20 以降が必要です。

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` は開発用メニュー（テスト通知など）付きで起動します。通常起動は `npm start`、ユニットテストは `npm test` です。

Google アカウント連携（個人版）には、プロジェクト直下の `.env` に OAuth クライアントの値が必要です（`.env.example` を参照。`.env` はリポジトリに含めません）。

## 個人版と共有版

違いは **OAuth 資格情報の提供元** と **配布形態** だけです（要件定義書 2.5）。VOICEVOX の読み上げは両版とも、VOICEVOX が起動していれば使えます。

| | 個人版 | 共有版 |
|---|---|---|
| OAuth Client ID/Secret | `.env`（開発者のもの） | 利用者が自分で作成し、設定画面に入力（暗号化して保存） |
| 配布 | 開発者本人のみ | 実行ファイル一式の zip＋[セットアップ手順書（HTML）](docs/shared-edition-setup.html) |

版は「`config.json` に保存された `edition`」→「ビルド時の既定値（配布パッケージの `package.json` の `mascotEdition`）」→「個人版」の順で決まります。
開発中に共有版の動きを確かめるときは、個人版のデータと混ざらないよう専用の userData で起動します（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\mascot-shared" | Out-Null
[IO.File]::WriteAllText("$env:TEMP\mascot-shared\config.json", '{"edition":"shared"}')  # BOM なしで書く
npx.cmd electron . --dev --user-data-dir="$env:TEMP\mascot-shared"  # npx.ps1 は実行ポリシーで止まることがあるため .cmd を使う
```

## 配布用のビルド（Windows・zip）

```bash
npm run dist:shared
```

共有版を `dist/shared/oshirase-mate-shared-<version>-win-x64.zip` に作ります。`.env` は含めず（ビルド後に `scripts/check-dist.mjs` が確認します）、セットアップ手順書（`セットアップ手順書.html`）を実行ファイルと同じフォルダに同梱します。
zip と一緒に [docs/shared-edition-setup.html](docs/shared-edition-setup.html) も渡してください（展開前にブラウザで読めるように）。

```bash
npm run dist:personal
```

個人版を `dist/personal/` に作ります。`.env` を `resources/.env` に同梱するため、**配布しないでください**。

NSIS インストーラーは使いません。未署名のインストーラーはスマート アプリ コントロールが有効な Windows で実行を止められ、electron-builder がビルド中にインストーラーを実行するため、そうした PC ではビルドもできないためです（要件定義書 9章#2・#8）。

コード署名はしていないため、ダウンロードした zip から展開すると初回の実行時に SmartScreen の警告が出ます（手順書に回避方法を記載）。アプリのアイコンは `build/resources/icon.png`（実行ファイル。256×256 以上）と `assets/icons/icon.png`（トレイ）に画像を置くと使われます（無ければ Electron の既定アイコンと黄色い丸）。配布版では、設定画面の「ショートカット」欄からデスクトップ・スタートメニューにショートカットを作れます。

## リリース手順（GitHub Releases）

配布するのは共有版だけです（個人版は `.env` を含むため、リリースに載せません）。ビルドは手元の Windows PC で行います。

1. `package.json` の version を上げます（タグを作らずに package-lock.json もそろえる）

   ```bash
   npm version <新しい版> --no-git-tag-version
   ```

2. テストを通します

   ```bash
   npm test
   ```

3. 共有版をビルドします（`check-dist` が `.env` が無いこと・セットアップ手順書と LICENSE.txt があることを確かめます）

   ```bash
   npm run dist:shared
   ```

4. version の変更をコミットして push してから、リリースを作ります（zip と、展開前に読めるようにセットアップ手順書を添付）

   ```bash
   gh release create v<新しい版> dist/shared/oshirase-mate-shared-<新しい版>-win-x64.zip docs/shared-edition-setup.html --title "v<新しい版>" --generate-notes
   ```

## キャラクターの取り込み（EmoteLab）

[EmoteLab](https://emotelab.app/) で作成したキャラクターをマスコットとして表示できます。

1. EmoteLab でモーションごとに **ImageSequence** 形式で書き出します
   - キャンバス：**400×400px**、透過PNG（RGBA）
   - ファイル名：`000.png` から始まる3桁の連番（欠番なし）
   - GIF / APNG / WebP には対応していません
2. マスコットを右クリック →「キャラクター変更」→「キャラクターを作成…」を開きます
3. キャラクター名を入力し、モーションごとに書き出したフォルダを選んで、fps（EmoteLab の書き出し設定と同じ値。既定30）を入力します
   - 必須：待機（`rest`）・通知（`notify`）
   - 任意：カレンダー（`notify.calendar`）・TODO（`notify.tasks`）・重要メール（`notify.gmail`）。未設定の場合は通知（`notify`）のモーションを使います
4. 必要なら **声**（VOICEVOX の話者・話速・音高。VOICEVOX の起動中に選べます）と **キャラクター設定**（性格・口調・一人称など。最大1000文字）を入力します
   - 声は、そのキャラクターを選んでいる間の通知・アイドルトーク・チャットの読み上げに使います（未指定なら `config.json` の `voicevox`）
   - キャラクター設定は、チャット（Gemini）でそのキャラクターとして話すために使います（会話のたびに Gemini へ送られます）
5. 「取り込む」を押すと、画像がアプリのデータフォルダ（`%APPDATA%\my-mascot-app\characters\`）にコピーされます
6. キャラクター選択画面で選ぶと、すぐにマスコットに反映されます（400×400px の画像は 200×200 の枠に縮小して表示します）

取り込んだキャラクターは、キャラクター選択画面の「編集」から名前・モーション（フォルダの差し替え・任意モーションの解除）・fps・声・キャラクター設定を変更できます。
組み込みのキャラクター（黄色い丸）も、声とキャラクター設定だけは変更できます。

## ライセンス

ソースコードは [MIT License](LICENSE) です。画像・音声などの素材はこの対象外のものがあり、条件は [assets/LICENSE.md](assets/LICENSE.md) に素材ごとに記載しています（アプリアイコンは MIT の対象外です）。

## クレジット

- **EmoteLab**：キャラクター画像は EmoteLab（https://emotelab.app/）とその内蔵アセットを使用して作成しています。
  EmoteLab 本体は本アプリに含まれず、再配布もしていません（[EmoteLab EULA](https://emotelab.app/eula/)）。
- **VOICEVOX**：読み上げ（通知・アイドルトーク・チャット。個人版・共有版とも）に VOICEVOX（https://voicevox.hiroshiba.jp/）を使用しています。VOICEVOX 本体は同梱していません（利用者が各自インストールします）。
  使用する音声ライブラリのクレジット（「VOICEVOX:話者名」）は設定画面のボイス欄に表示されます。各音声ライブラリの利用規約に従ってください。
