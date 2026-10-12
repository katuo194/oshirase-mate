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

設定画面の「Google 連携の準備」（手順 1〜5）の各ボタンが開く Console のページは `src/main/googleConsoleLinks.js`、JSON の解析は `src/main/oauthClientFile.js` にあります。Console の URL が変わったら、この表と手順書を直してください。

## 配布用のビルド（Windows・zip）

```bash
npm run dist:shared
```

共有版を `dist/shared/oshirase-mate-shared-<version>-win-x64.zip` に作ります。`.env` は含めず（ビルド後に `scripts/check-dist.mjs` が確認します）、セットアップ手順書（`docs/setup-guide.html` を `セットアップ手順書.html` という名前で）と `LICENSE.txt` を実行ファイルと同じフォルダに同梱します。

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

3. 共有版をビルドします（`check-dist` が `.env` が無いこと・セットアップ手順書と LICENSE.txt があることを確かめます）

   ```bash
   npm run dist:shared
   ```

4. version の変更をコミットして push してから、リリースを作ります（zip と、展開前に読めるようにセットアップ手順書を添付）

   ```bash
   gh release create v<新しい版> dist/shared/oshirase-mate-shared-<新しい版>-win-x64.zip docs/setup-guide.html --title "v<新しい版>" --generate-notes
   ```
