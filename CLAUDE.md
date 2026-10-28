# プロジェクト概要
デスクトップマスコット通知アプリ（Electron）。要件定義書: docs/要件定義書_v6.md

# 技術スタック（厳守）
- Node.js 20 / Electron 30以降。Pythonは使用しない
- 音声合成: VOICEVOX（localhost:50021）
- Google API: @googleapis/calendar・@googleapis/tasks・@googleapis/gmail（googleapis 全体はメモリが約100MB増えるため使わない）。OAuth 2.0 Loopback + PKCE
- 設定永続化: electron-store

# 絶対にしないこと
- OS標準のToast通知は使わない（独自の透過ウィンドウのみ）
- Pub/Subなどのプッシュ通知は使わない。ポーリングで統一する
- OAuth Client Secretやgemini APIキーをコードにハードコードしない

# 開発方針
- 各Phaseの実装前に必ず計画を提示し、私の承認を得てから着手する
- Google/VOICEVOX APIはmocks/ 以下のスタブに対してユニットテストを書く
- GUI・音声が絡む変更は「実機で確認してください」と私に一言添えて終わる