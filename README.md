# opencode-mcp-json-adapter
プロジェクトルートの `.mcp.json` を OpenCode の MCP 設定に取り込むプラグインです。

## remote MCP のローカル動作確認

プロジェクトルートで `deno task smoke:remote` を実行します。この手動テストは `deno test` や CI の対象外です。Deno、OpenCode V2 の実行ファイル（`opencode2` を優先し、見つからない場合のみ V2 と確認できた `opencode` を使用）、Everything MCP の npm パッケージへのアクセスが必要です。ポート 3001 と 4097 は空けておいてください。

- `3001`: Everything MCP が Streamable HTTP で待ち受けるポートです。`.mcp.json` の `everything-remote` は `http://localhost:3001/mcp` に接続します。
- `4097`: このタスクが検証専用に起動する OpenCode V2 サーバーの API ポートです。手動検証で選んだ番号であり、OpenCode の既定ポートではありません。

このタスクは Everything を Streamable HTTP モードで起動し、検証専用の OpenCode V2 サーバーでプラグインが有効なことと、`everything-stdio`・`everything-remote` が両方とも `connected` になることを確認します。モデルや `echo` は呼び出しません。`.mcp.json` のサーバー名と URL `http://localhost:3001/mcp` は検証用の値を維持してください。終了時にはタスクが起動したプロセスだけを停止し、現在の OpenCode セッションは再起動しません。失敗した場合はエラーメッセージを確認し、原因を解消してから再実行してください。

## OAuth MCP の手動動作確認

別のターミナルで `deno task oauth:serve` を実行します。Deno、Git、Bun、OpenCode V2 が必要で、ポート 3232 を空けておいてください。タスクは参照実装を `temp/example-remote-server` に未取得の場合のみ clone し、コミット `ca6133a4e63d22e2c035defa691d241ce22296a9` に固定します。既存の checkout のコミットが違う場合や追跡対象ファイルに変更がある場合は、勝手に上書きせず中断します。依存関係は Bun で導入し、元の `package-lock.json` から初回に生成した `bun.lock` を次回以降は固定して使用します。npm CLI は使いません。`temp/` は Git の対象外です。

サーバーが起動したら、OpenCode の `/mcps` で `example-oauth` を選び、ブラウザーで認証して `connected` になることを確認してください。`.mcp.json` の `http://localhost:3232/mcp` は常設です。サーバー停止中は `example-oauth` だけ接続できません。認証フローは手動で行い、`deno test` や CI、既存の `smoke:remote` の合格条件には含めません。検証後は起動したターミナルで Ctrl+C を押すと、タスクが起動したサーバーを停止します。
