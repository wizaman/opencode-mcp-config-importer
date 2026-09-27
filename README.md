# opencode-mcp-json-adapter
プロジェクトルートの `.mcp.json` を OpenCode の MCP 設定に取り込むプラグインです。

## remote MCP のローカル動作確認

プロジェクトルートで `deno task smoke:remote` を実行します。この手動テストは `deno test` や CI の対象外です。Deno、OpenCode V2 の実行ファイル（`opencode2` を優先し、見つからない場合のみ V2 と確認できた `opencode` を使用）、Everything MCP の npm パッケージへのアクセスが必要です。ポート 3001 と 4097 は空けておいてください。

- `3001`: Everything MCP が Streamable HTTP で待ち受けるポートです。`.mcp.json` の `everything-remote` は `http://localhost:3001/mcp` に接続します。
- `4097`: このタスクが検証専用に起動する OpenCode V2 サーバーの API ポートです。手動検証で選んだ番号であり、OpenCode の既定ポートではありません。

このタスクは Everything を Streamable HTTP モードで起動し、検証専用の OpenCode V2 サーバーでプラグインが有効なことと、`everything-stdio`・`everything-remote` が両方とも `connected` になることを確認します。モデルや `echo` は呼び出しません。`.mcp.json` のサーバー名と URL `http://localhost:3001/mcp` は検証用の値を維持してください。終了時にはタスクが起動したプロセスだけを停止し、現在の OpenCode セッションは再起動しません。失敗した場合はエラーメッセージを確認し、原因を解消してから再実行してください。
