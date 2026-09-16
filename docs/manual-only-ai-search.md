# 社内マニュアルに限定した回答への修正

## 接続の正本

- Worker: `ses-manual-chat-app`
- AI Search instance: `gec-ses-manual`（ユーザー提示のDashboard binding）
- binding名: `AI`、種類: `ai_search`。Workers AIの `ai` ではない。
- 呼び出し: `env.AI.chatCompletions()`。`AI.run()`へのフォールバックはない。
- UI: 既存の会社ロゴ・スマホ対応・同一originの `/api/chat` とSSEを維持。
- 既存Access、OTP、許可ドメイン、課金プラン、AI Searchインスタンス自体は変更しない。
- Public Endpointは使わない。インスタンスがdefault namespace以外なら配備前に確認する。

## 回答の制約

`src/grounding.ts` のサーバー側system promptで、日本語・検索資料のみ・正式な名称と条件の保持・不明部分の明示・推測禁止を指定する。
既存のインスタンス設定に依存しきらず、今回のアプリのリクエストにだけ適用する。モデルIDは固定せずインスタンスの生成モデルを利用する。

ブラウザーからのsystem/developer/toolメッセージを拒否する。古いassistant回答は根拠にできないので転送しない。直前3件のユーザー質問だけを話題の補助として扱う。

AI Searchから送られる `chunks` イベントをサーバーで検査してから回答トークンを転送する。空の検索結果、または本文・参照元を確認できないチャンクしかない場合は、生成文を転送せず「登録されているマニュアルからは確認できませんでした。」に固定する。
`chunks` イベント欠落・不正形式・検索失敗・途中切断はエラーとし、一般知識で埋めたり「資料にない」と断定したりしない。
チャンク本文やメタデータはブラウザーに転送しない。質問と回答もアプリログには出さない。

類似度キャッシュをこのアプリのリクエストに限り無効化し、以前の回答の流用を避ける。検索クエリの書き換えを有効化しているため、その処理の使用量はAI Search/モデル側で確認する。無料運用や生成中止による課金停止は保証しない。

**チャンクがあることは、全ての生成文が正しいことの証明ではない。** 関連語だけヒットした場合の拒否や、部分回答、矛盾する規程の扱いはプロンプトによる制約であり、実際のマニュアルで評価する必要がある。

## 回帰テスト

依存導入済みの環境で：

```sh
node --test test/grounding.test.mjs
```

既存開発依存のTypeScriptで対象バックエンドをstrictコンパイルし、一時ディレクトリのJSをNode標準テストで実行する。模擬文書・模擬SSEのみを使い、実LLMやCloudflareにはアクセスしない。
2026-09-17時点のローカル実行: 41/41 PASS。
対象: 接続指定、サーバー指示、古いAI回答の除外、0件拒否、検索エラー、ソース欠落、UTF-8/CRLF分割、ストリーミング維持、停止、入力/ロール/リクエストサイズ検証。

フロントエンド3ファイルは変更しない。現在のUIで受信可能な `choices[].delta.content` と `[DONE]` を返す。

## 配備と確認

1. 対象アカウントに `gec-ses-manual` があることを確認する。
2. 対象Worker全体を既存Accessで保護し、`/api/chat`や別のプレビューURLから認証を迂回できないことを確認する。
3. マージしたコミットを既存のCloudflare Git連携でビルドする。DashboardでAI bindingをWorkers AIに戻さない。
4. 手元のビルドでは `npx wrangler types` で生成型を更新してから `npm run check`。`src/types.ts`が今回使用するAI Searchの型を明示している。
5. ブラウザーで会話をクリアして再読み込みし、マニュアルに確実にある質問と、書かれていない質問を試す。
6. 成功した `/api/chat` のレスポンスヘッダー `x-manual-ai-version: manual-only-20260917` で本修正版を識別できる。

設定・ソースを同期する修正であり、これは新たにモデルを学習する処理ではない。登録済みPDFの検索結果を使う。
アプリ内の履歴非保存とCloudflare/AI Gateway側のログ・キャッシュ保存は別。後者の現状は未確認。

今回の作業環境では外部接続に制約があり、依存の新規取得、Wrangler実行、Cloudflareの配備状況・Access認証・実マニュアルでの回答試験は実施していない。テスト合格を本番動作の確認と同一視しない。

## 公式仕様

- https://developers.cloudflare.com/ai-search/api/search/workers-binding/
- https://developers.cloudflare.com/ai-search/configuration/retrieval/system-prompt/
- https://developers.cloudflare.com/ai-search/how-to/chunk-citations/
