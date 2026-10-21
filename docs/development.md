# 開発者向けの説明

利用者向けの説明は [README.md](../README.md)、要件は [要件定義書_v5.md](要件定義書_v5.md) を見てください。

## 動かし方

Node.js 20 以降が必要です。

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` は開発用メニュー（テスト通知など）付きで起動します。通常起動は `npm start`、ユニットテストは `npm test` です（Google・VOICEVOX・Gemini の API は `mocks/` のスタブに対してテストします）。

## 個人版と共有版

違いは **OAuth 資格情報の提供元** と **配布形態** だけです（要件定義書 2.5）。VOICEVOX の読み上げは両版とも、VOICEVOX が起動していれば使えます。

| | 個人版（開発者用） | 共有版（配布するもの） |
|---|---|---|
| OAuth Client ID/Secret | `.env`（開発者のもの） | 利用者が自分で作成し、設定画面の「Google 連携の準備」で JSON を読み込む（または手入力。暗号化して保存） |
| 配布 | 開発者本人のみ | GitHub Releases に zip ＋[セットアップ手順書（HTML）](setup-guide.html) |
| userData | `%APPDATA%\my-mascot-app` | `%APPDATA%\おしらせメイト` |

利用者に見せる画面・文書（設定画面・README・手順書）では「共有版」という言葉を使いません。

版は「`config.json` に保存された `edition`」→「ビルド時の既定値（配布パッケージの `package.json` の `mascotEdition`）」→「個人版」の順で決まります。

### 個人版の `.env`

Google アカウント連携（個人版）には、プロジェクト直下の `.env` に OAuth クライアントの値が必要です（`.env.example` を参照。`.env` はリポジトリに含めません）。

### 共有版の動作確認

開発中に共有版の動きを確かめるときは、個人版のデータと混ざらないよう専用の userData で起動します（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\mascot-shared" | Out-Null
[IO.File]::WriteAllText("$env:TEMP\mascot-shared\config.json", '{"edition":"shared"}')  # BOM なしで書く
npx.cmd electron . --dev --user-data-dir="$env:TEMP\mascot-shared"  # npx.ps1 は実行ポリシーで止まることがあるため .cmd を使う
```

`--user-data-dir` を明示したときだけ、普段の保存先の固定（`src/main/pinUserDataDir.js`）をしません（要件定義書 v5.15）。起動ログの先頭が「起動（共有版）」になっていれば共有版です（ログは `$env:TEMP\mascot-shared\logs\`）。保存先が別なので、個人版を起動したままでも同時に起動できます。

設定画面のボタンで開く外部のページ（「Google 連携の準備」の手順 1〜3 の Console・VOICEVOX・Gemini API キー）は `src/main/externalLinks.js` の表、JSON の解析は `src/main/oauthClientFile.js` にあります。Console の URL が変わったら、この表と手順書を直してください。

設定画面の「ショートカット」欄は、ソースから起動しているときも使えます。作られるのは `おしらせメイト（開発）.lnk`（Electron 本体に、アプリのフォルダと、起動時に指定した `--user-data-dir` を渡すもの）で、配布版の `おしらせメイト.lnk` とは別です。上の手順で起動してから作れば、そのショートカットからも同じ保存先の共有版で起動できます。

## 同梱キャラクター（素材の作り方）

同梱キャラクター（要件定義書 F-23）は `assets/characters/<id>/` に置きます。id は `bundled-boy`（シアン・ずんだもんの声）と `bundled-girl`（シトロン・四国めたんの声）で、`src/main/characterImport.js` の `BUNDLED_CHARACTER_IDS` が一覧の順です。

```
assets/characters/bundled-boy/
├── manifest.json        … 名前・fps・声・クレジット表記・キャラクター設定・セリフ・件名なしの固定ボイスの文（fallbackLines）
├── rest/000.png …       … 待機（必須）。EmoteLab の ImageSequence（400×400・透過 PNG・000 から欠番のない3桁連番）
├── notify/000.png …     … 通知（必須）
├── notify-calendar/ …   … 任意（予定）。notify-tasks/（TODO）・notify-gmail/（メール）も同じ
└── voice/               … 固定ボイス（voices.json と WAV。bundle:voices が作る）
```

画像の枚数は manifest.json に書かず、起動時にフォルダの連番を数えます。必須のモーションの画像が無いあいだは、キャラクター選択画面に出ません。fps は manifest.json の `slots` に書きます（EmoteLab で書き出したときと同じ値）。任意のモーションは、フォルダが無ければ「通知」のモーションを使います。

手順：

1. 画像を上の形で置きます。
2. `npm run dev` で起動し、キャラクター選択画面で同梱キャラクターを選んで「編集」を開き、声（話者・話速・音高）とキャラクター設定を決め、「Gemini でセリフを作る」で作ったセリフを直して「保存」します（保存先は `%APPDATA%\my-mascot-app\characters\<id>-profile.json`）。
3. 保存した内容を manifest.json に書き戻します。

   ```bash
   npm run bundle:export -- bundled-boy
   ```

4. 件名なしの固定ボイスの文（VOICEVOX が無いときに通知で流す。種類ごとに1〜5文・差し込みなし・30文字以内）を manifest.json の `fallbackLines` に書きます。
5. VOICEVOX を起動して、録音しておく文（アイドルトーク・差し込みの無い通知のセリフ・件名なしの文）をすべて合成します。同じ文・同じ声の録音は作り直しません（`--force` で全部作り直す）。

   ```bash
   npm run bundle:voices -- bundled-boy
   ```

6. そろっているかを確かめます（共有版のビルド後の `check-dist` も同じことを確かめ、足りなければ止まります）。

   ```bash
   npm run bundle:check
   ```

セリフ・声を変えたら、手順 3〜6 をやり直します（録音を作り直し忘れると `npm test` の `test/bundledAssets.test.js` が失敗します）。手順 2 で保存した `<id>-profile.json` は書き戻した後も残るので、編集画面の「同梱の状態に戻す」で消しておくと、同梱の値どおりに動くかを確かめられます。

## 配布用のビルド（Windows・zip）

```bash
npm run dist:shared
```

共有版を `dist/shared/oshirase-mate-shared-<version>-win-x64.zip` に作ります。`.env` は含めず（ビルド後に `scripts/check-dist.mjs` が確認します）、セットアップ手順書（`docs/setup-guide.html` を `セットアップ手順書.html` という名前で）と `LICENSE.txt` を実行ファイルと同じフォルダに同梱します。同梱キャラクターの画像・固定ボイスは `assets/` ごと app.asar に入ります（素材がそろっていなければ `check-dist` が止めます）。

```bash
npm run dist:personal
```

個人版を `dist/personal/` に作ります。`.env` を `resources/.env` に同梱するため、**配布しないでください**。

NSIS インストーラーは使いません。未署名のインストーラーはスマート アプリ コントロールが有効な Windows で実行を止められ、electron-builder がビルド中にインストーラーを実行するため、そうした PC（開発PCを含む）ではビルドもできないためです（要件定義書 9章#2・#8）。

コード署名はしていないため、ダウンロードした zip から展開すると初回の実行時に SmartScreen の警告が出ます（手順書・README に回避方法を記載）。アプリのアイコンは `build/resources/icon.png`（実行ファイル。256×256 以上）と `assets/icons/icon.png`（トレイ）に画像を置くと使われます（無ければ Electron の既定アイコンと黄色い丸）。

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

3. 共有版をビルドします（`check-dist` が `.env` が無いこと・セットアップ手順書と LICENSE.txt があること・同梱キャラクターの素材がそろって入っていることを確かめます）

   ```bash
   npm run dist:shared
   ```

4. version の変更をコミットして push してから、リリースを作ります（zip と、展開前に読めるようにセットアップ手順書を添付）

   ```bash
   gh release create v<新しい版> dist/shared/oshirase-mate-shared-<新しい版>-win-x64.zip docs/setup-guide.html --title "v<新しい版>" --generate-notes
   ```
