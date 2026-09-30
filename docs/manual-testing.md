---
title: 手動動作確認
description: 開発者が OpenCode V2 と MCP サーバーを用いてローカルで行う実接続テストの手順と前提を記録する。
date: 2026-10-01
---

## 前提

以下のタスクは開発用です。`deno test` や CI には含まれません。Deno、Git、OpenCode V2 の実行ファイル（`opencode2` を優先し、見つからない場合のみ V2 と確認できた `opencode`）および必要な npm パッケージへのアクセスを用意してください。ポート 3001、4097（ツールフィルタではさらに 4098）は他のプロセスで使用しないでください。タスク同士を同時に実行しないでください。

## 自動起動する実接続テスト

プロジェクトルートから個別に実行します。タスクに応じてこのリポジトリの設定または固定 fixture・ダミー値を用い、検証専用の OpenCode V2 インスタンスと必要な MCP サーバーを起動します。終了時には各タスクが起動したプロセスだけを停止します。

| タスク | 確認内容 |
| --- | --- |
| `deno task smoke:remote` | `.mcp.json` の `everything-stdio` と `everything-remote` が `connected` になること。モデルや `echo` は呼び出さない。 |
| `deno task smoke:mcp-json-remote-env` | remote の変数展開が opt-in 無効時・変数未設定時には登録されず、有効時に URL とヘッダーが届くこと。既存の `.mcp.json` と OpenCode セッションは変更しない。 |
| `deno task smoke:codex-headers` | `.codex/config.toml` の静的ヘッダー `X-Test-Source: codex` が届くこと。モデルは使用しない。 |
| `deno task smoke:codex-env-headers` | Codex の環境変数由来ヘッダーと Bearer ヘッダーが届くこと。 |
| `deno task smoke:codex-tool-filter` | stdio・HTTP のツール制限、ダミーモデル経由の Code Mode での除外ツール呼び出し拒否、再接続後の維持、ネイティブ設定優先と名前衝突時の扱い。ポート 4098 も使う。実行前に `deno install --frozen-lockfile` でローカルの `node_modules/@opencode/plugin` を用意する。 |

`smoke:remote` はポート 3001 で Everything MCP の Streamable HTTP サーバーを、4097 で検証専用の OpenCode V2 API サーバーを起動します。`.mcp.json` の `everything-remote` は `http://localhost:3001/mcp` に接続します。4097 はテスト用の番号で、OpenCode の既定ポートではありません。`.mcp.json` の検証用サーバー名と URL を変更した場合はテスト側も確認してください。失敗時は表示されたエラーの原因を解消してから再実行します。

## 手動接続

Everything MCP の remote サーバーだけを起動する場合は、別のターミナルで `deno task remote:serve` を実行します。ポート 3001 の `.codex/config.toml` の `codex-remote` と `.mcp.json` の `everything-remote` に接続できます。前述のスモークテストと同時には実行しません。確認後はそのターミナルで Ctrl+C を押して停止します。

OAuth MCP の確認には別のターミナルで `deno task oauth:serve` を実行します。Deno、Git、Bun、OpenCode V2 が必要で、ポート 3232 を空けます。タスクは参照実装を `temp/example-remote-server` に未取得の場合のみ clone し、コミット `ca6133a4e63d22e2c035defa691d241ce22296a9` に固定します。既存 checkout のコミットが違う場合や追跡対象ファイルに変更がある場合は、上書きせず中断します。依存関係は Bun で導入し、元の `package-lock.json` から初回に生成した `bun.lock` を次回以降は固定して使用します。npm CLI は使いません。`temp/` は Git の対象外です。

サーバー起動後、OpenCode の `/mcps` で `example-oauth` を選び、ブラウザーで認証して `connected` になることを確認します。`.mcp.json` の `http://localhost:3232/mcp` は常設です。サーバー停止中は `example-oauth` だけ接続できません。認証フローは手動で行い、`smoke:remote` の合格条件にも含めません。確認後は起動したターミナルで Ctrl+C を押して停止します。
