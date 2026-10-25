# 素材のライセンス

リポジトリ直下の `LICENSE`（MIT）はソースコードに適用します。素材（画像・音声）は、次のとおり素材ごとに条件が異なります。

| 素材 | 由来 | 条件 |
|---|---|---|
| `assets/sounds/notify_*.wav` | `scripts/generate-placeholder-sfx.mjs` で生成した仮の効果音 | MIT（リポジトリの `LICENSE`） |
| `assets/icons/icon.png`・`build/resources/icon.png` | Canva の AI 機能で生成し、背景を透過したもの | **MIT の対象外**。Canva の利用規約に従います。おしらせメイトのアイコンとして使う以外の利用（再配布・改変・別の作品での使用）は許諾していません。フォークして配布する場合は、別のアイコンに差し替えてください |
| `assets/characters/*/` の画像（`rest/`・`notify*/` の PNG） | 同梱キャラクターの画像。EmoteLab（https://emotelab.app/）とその内蔵アセットで作成し、ImageSequence で書き出したもの | **MIT の対象外**。[EmoteLab EULA](https://emotelab.app/eula/) に従います（利用には EmoteLab を使用した旨のクレジット表記が必要です）。EmoteLab 本体は含まれていません |
| `assets/characters/bundled-boy/voice/*.wav` | 同梱キャラクター（シアン）の固定ボイス。VOICEVOX で事前に合成したもの | **MIT の対象外**。VOICEVOX と音声ライブラリ「ずんだもん」の利用規約に従います。クレジットは「VOICEVOX:ずんだもん」 |
| `assets/characters/bundled-girl/voice/*.wav` | 同梱キャラクター（シトロン）の固定ボイス。VOICEVOX で事前に合成したもの | **MIT の対象外**。VOICEVOX と音声ライブラリ「四国めたん」の利用規約に従います。クレジットは「VOICEVOX:四国めたん」 |

`assets/characters/*/manifest.json`（名前・キャラクター設定・セリフなどの設定）は MIT です。

## 固定ボイス（録音）を再利用する場合

固定ボイスの WAV をおしらせメイトの外で使う（取り出して動画などに使う、フォークして配布する等）場合は、次の規約に従ってください。クレジット（「VOICEVOX:ずんだもん」「VOICEVOX:四国めたん」）の表記が必要です。

- [VOICEVOX 利用規約](https://voicevox.hiroshiba.jp/term/)
- [東北ずん子・ずんだもんプロジェクト 音源利用ガイドライン](https://zunko.jp/con_ongen_kiyaku.html)（「VOICEVOX ずんだもん、…四国めたん…音源利用規約」と「音源についての共通規約」）
