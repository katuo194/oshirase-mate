# 開発者向けの説明

利用者向けの説明は [README.md](../README.md)、要件は [要件定義書_v6.md](要件定義書_v6.md) を見てください。

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
| OAuth Client ID/Secret | `.env`（開発者のもの） | 設定画面の「Google 連携」タブで読み込む（暗号化して保存）。A：開発者が一人ずつ発行したものを貼り付ける（下の「クライアントを一人ずつ発行する」）／B：利用者が自分で作った JSON を読み込む |
| 配布 | 開発者本人のみ | GitHub Releases に zip ＋[セットアップ手順書（HTML）](setup-guide.html) |
| ソースからの起動 | `.env` に Client ID と Secret が入っているとき | `.env` が無い・空のとき（GitHub から取得したソースをそのまま起動したとき） |
| userData | `%APPDATA%\my-mascot-app` | `%APPDATA%\おしらせメイト` |

利用者に見せる画面・文書（設定画面・README・手順書）では「共有版」という言葉を使いません。

版は「`config.json` に保存された `edition`」→「ビルド時の既定値（配布パッケージの `package.json` の `mascotEdition`）」→「プロジェクト直下の `.env` に Client ID と Secret が両方入っていれば個人版、無ければ共有版」の順で決まります（要件定義書 2.5）。

GitHub から取得したソースを `.env` なしで `npm start` すると共有版として起動し、配布版の zip と同じく設定画面の「Google 連携」タブでクライアントを読み込めば連携できます。保存先も配布版と同じ `%APPDATA%\おしらせメイト` なので、配布版を起動している間は起動できません（二重起動として、起動中の配布版の設定画面が開きます）。`.env` の無い作業用の複製（`.claude/worktrees/` など）から起動するときも同じです。配布版のデータと分けたいときは、下の「共有版の動作確認」のように `--user-data-dir` を付けて起動してください。

### 個人版の `.env`

Google アカウント連携（個人版）には、プロジェクト直下の `.env` に OAuth クライアントの値が必要です（`.env.example` を参照。`.env` はリポジトリに含めません）。値が入っていて形式が誤っている `.env` は、共有版に切り替わらず個人版のまま起動し、設定画面にエラーを出します。

### 共有版の動作確認

開発中に共有版の動きを確かめるときは、個人版のデータと混ざらないよう専用の userData で起動します（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:TEMP\mascot-shared" | Out-Null
[IO.File]::WriteAllText("$env:TEMP\mascot-shared\config.json", '{"edition":"shared"}')  # BOM なしで書く
npx.cmd electron . --dev --user-data-dir="$env:TEMP\mascot-shared"  # npx.ps1 は実行ポリシーで止まることがあるため .cmd を使う
```

`--user-data-dir` を明示したときだけ、普段の保存先の固定（`src/main/pinUserDataDir.js`）をしません（要件定義書 2.5）。起動ログの先頭が「起動（共有版）」になっていれば共有版です（ログは `$env:TEMP\mascot-shared\logs\`）。保存先が別なので、個人版を起動したままでも同時に起動できます。

設定画面のボタンで開く外部のページ（「Google 連携」タブの B の手順 1-a〜3 の Console・VOICEVOX・Gemini API キー）は `src/main/externalLinks.js` の表、JSON の解析は `src/main/oauthClientFile.js` にあります。Console の URL・画面が変わったら、この表と手順書（`docs/setup-guide.html` と写真の `docs/setup-guide-images/`）を直してください。写真を撮り直すときは、メールアドレス・プロジェクトの ID と番号・右上のアカウントのアイコンを隠してください。

`--dev` で起動すると、右クリックメニューの「[開発] テスト通知」に「Google 連携の期限の予告」「Google 連携切れ」が加わり、連携の期限のお知らせの見た目を確かめられます（連携の状態や右クリックメニューは変わりません）。

### クライアントを一人ずつ発行する（知人に配る）

開発者のクライアントはアプリに入れず、配布専用の Google Cloud プロジェクトにクライアントを **一人に 1 つずつ** 作って渡します（要件定義書 2.4・付録 A-34）。漏れたら、その人のクライアントだけを削除できます。

**最初に一度だけ（配布専用のプロジェクト）**

1. 手順書の 2-B の手順 1-a〜2 と同じように、プロジェクトを作り、3 つの API を有効にし、Google Auth Platform を設定する（対象は「外部」）。
2. 「ブランディング」で、アプリのホームページとプライバシーポリシーの URL を入れる（本番環境に公開するのに必要）。
3. 「対象」で「アプリを公開」を押して **本番環境** にする（テストのままだと、受け取った人の連携も 7 日で切れる）。審査は受けない。

**一人ごとに**

1. 「クライアント」→「クライアントを作成」で、種類「デスクトップ アプリ」、名前は誰に渡したか分かるもの（例：`friend-<名前>`）にして作る。
2. 作成直後の画面で Client ID と Client Secret をコピーする（または JSON をダウンロードする。Secret はこの画面でしか見られない）。
3. 2 つの値を、1 回だけ開ける URL（One-Time Secret など）で渡す。チャットやメールに直接貼らない。誰にどのクライアントを渡したかは、リポジトリの外に控えておく。
4. 受け取った人は「Google 連携」タブの A に貼り付けて「保存」→「連携する」。

**運用**

- **漏れた・使わなくなった**：その人のクライアントを Console で削除する（その人の連携は切れ、「クライアントが Google に受け付けられませんでした」と出る）。クライアントを削除・Secret を差し替えると、その人は値を受け取り直す必要がある。
- **人数の上限**：審査を受けていないプロジェクトは、許可したユーザーが**累計 100 人**まで（テストユーザーも含む。減らせない）。「対象」の「OAuth ユーザー数の上限」で数を見張る。上限に近づいたら、審査（`gmail.readonly` は制限付きのスコープなので、毎年のセキュリティ評価〔CASA〕が要る）か、自分で作る道（B）への切り替えを検討する。
- **クライアントの数**：Console から作れる OAuth クライアントは **1 つのプロジェクトにつき 36 個まで**（gcloud・API からは 500 個までだが、その API は廃止予定。Google Cloud の IAP の文書 https://cloud.google.com/iap/docs/oauth-client-creation による。デスクトップ アプリのクライアントにも同じ数がかかるとは明記されていない）。一人 1 つずつ配ると、人数の上限（100 人）より先にこちらに当たる。36 人を超えそうなら、2 つ目の配布用プロジェクトを作る（人数の上限もプロジェクトごと）。何人かで 1 つのクライアントを共有することもできるが、漏れたときに止まる範囲がそのグループ全員に広がる。
- **リフレッシュトークンの数**：1 つの Google アカウントが 1 つのクライアントで持てるのは 100 個までで、超えると古いものから無効になる。アプリは最新のトークンだけを使うので、7 日ごとに連携し直しても困らない。半年使わなかったとき、Gmail の権限のままパスワードを変えたときにも無効になるが、そのときはアプリが「連携が切れた」と知らせる。

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

共有版を `dist/shared/oshirase-mate-shared-<version>-win-x64.zip` に作ります。`.env` は含めず（ビルド後に `scripts/check-dist.mjs` が確認します）、セットアップ手順書（`docs/setup-guide.html` を `セットアップ手順書.html` という名前で）とその写真（`docs/setup-guide-images/` を `setup-guide-images/` として）と `LICENSE.txt` を実行ファイルと同じフォルダに同梱します。同梱キャラクターの画像・固定ボイスは `assets/` ごと app.asar に入ります（素材がそろっていなければ `check-dist` が止めます）。Chromium の言語ファイル（`locales/`）は日本語と英語だけを入れます（`build/electron-builder.base.cjs` の `electronLanguages`。`check-dist` が確かめます）。

ソースを変えたら、配布する前に必ずビルドし直してください（`dist/` の zip はビルドした時点のソースのままです）。

```bash
npm run dist:personal
```

個人版を `dist/personal/` に作ります。`.env` を `resources/.env` に同梱するため、**配布しないでください**。

NSIS インストーラーは使いません。未署名のインストーラーはスマート アプリ コントロールが有効な Windows で実行を止められ、electron-builder がビルド中にインストーラーを実行するため、そうした PC（開発PCを含む）ではビルドもできないためです（要件定義書 8.1・付録 A-13）。

コード署名はしていないため、ダウンロードした zip から展開すると初回の実行時に SmartScreen の警告が出ます（手順書・README に回避方法を記載）。アプリのアイコンは `build/resources/icon.png`（実行ファイル。256×256 以上）と `assets/icons/icon.png`（トレイ）に画像を置くと使われます（無ければ Electron の既定アイコンと黄色い丸）。

## リリース手順（GitHub Releases）

配布するのは共有版だけです（個人版は `.env` を含むため、リリースに載せません）。ビルドは手元の Windows PC で行います。

1. `package.json` の version を上げます（タグを作らずに package-lock.json もそろえる）。最初のリリース（v0.1.0）は、package.json がすでに 0.1.0 なので上げません。

   ```bash
   npm version <新しい版> --no-git-tag-version
   ```

2. テストを通します

   ```bash
   npm test
   ```

3. main を最新にした状態で、共有版をビルドします（`check-dist` が `.env` が無いこと・セットアップ手順書と LICENSE.txt があること・同梱キャラクターの素材がそろって入っていること・言語ファイルを確かめます）。ビルドの途中で止めると壊れた zip が残るので、最後の `check-dist` の OK まで待ちます。

   ```bash
   npm run dist:shared
   ```

4. zip を別の場所に展開して起動し、動くことを確かめます（同梱キャラクターが VOICEVOX なしで話す・手順書が開く・LICENSE.txt がある）。

5. リリースノートを `docs/release-notes/v<新しい版>.md` に書き、version の変更と一緒にコミットして main に入れます。

6. **下書き**のリリースを作ります（zip と、展開前に読めるようにセットアップ手順書を添付）。下書きはリポジトリの管理者にしか見えません。GitHub のリリースの画面で、添付したファイルと本文を確かめます。

   ```bash
   gh release create v<新しい版> dist/shared/oshirase-mate-shared-<新しい版>-win-x64.zip docs/setup-guide.html --draft --title "v<新しい版>" --notes-file docs/release-notes/v<新しい版>.md
   ```

7. 下書きを公開します（このとき main の先頭にタグ `v<新しい版>` が作られます）。

   ```bash
   gh release edit v<新しい版> --draft=false
   ```

8. 公開したリリースから zip をダウンロードし、展開して起動できることを確かめます。

## 公開リポジトリでの注意

- **Push protection が有効です。** 本物の形をした API キー・Client Secret（`AIza` で始まる 39 文字、`GOCSPX-` で始まる値など）を含むコミットは push で止められます。テストのダミーの値は、本物の形に一致しないものにします（例：`fake-gemini-key-for-tests-0123456789`）。
- **コミットの作成者は `katuo194 <259521388+katuo194@users.noreply.github.com>` です。** GitHub の画面で PR をマージすると、マージコミットの作成者には GitHub のプロフィールの名前（Settings → Public profile → Name）が入ります。プロフィールの名前に実名を入れないでください。
- 書き換える前の履歴（Phase 16 で作成者名を書き換えた。要件定義書 8.4）のコミットを指すブランチは、push しないでください（旧リポジトリは `oshirase-mate-archive` として非公開で残しています）。
