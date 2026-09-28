# opencode-mcp-json-adapter
プロジェクトルートの `.mcp.json` を OpenCode V2 の MCP 設定に取り込むプラグインです。明示的に有効化した場合は `.codex/config.toml` の `[mcp_servers]` も取り込みます。

対応する transport は stdio と Streamable HTTP です。旧式の HTTP+SSE transport（`.mcp.json` の `type: "sse"` など）は意図的に取り込みません。MCP 2026-07-28 仕様で旧式の HTTP+SSE transport が非推奨となったためです。Streamable HTTP 内で使われる SSE レスポンスとは別の話です。[^mcp-2026-07-28]

[^mcp-2026-07-28]: [MCP 2026-07-28 仕様の発表（Deprecations）](https://redirect.github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)

## Codex 設定の取り込み

既定では `.mcp.json` のみを読みます。Codex 設定を併用する場合は OpenCode V2 の `opencode.jsonc` で次のように指定します。このリポジトリの `opencode.jsonc` は動作確認のため両方を有効化済みです。

```jsonc
{
  "plugins": [
    {
      "package": "./src",
      "options": { "sources": ["mcp-json", "codex"] }
    }
  ]
}
```

`codex` はプロジェクトルート直下の `.codex/config.toml` のトップレベルの `[mcp_servers]` だけを読みます。対応項目は stdio の `command` / `args` / `env` / `cwd`、Streamable HTTP の `url` / `http_headers` です。`enabled = false` のサーバーは取り込みません。Codex 固有の認証設定を持つサーバーは取り込みません。Codex の trust 判定や他の設定レイヤーは再現しません。OpenCode ネイティブの同名設定を優先し、入力元同士の衝突では `sources` の先に書いた入力元の有効な定義を採用します。通常は衝突を警告しません。

### 環境変数由来の HTTP ヘッダー

Codex の `env_http_headers` を含むサーバーは、既定では**サーバー定義全体を取り込みません**。静的ヘッダーだけを使って接続することはありません。リスクを理解して利用する場合のみ、OpenCode のプラグイン設定に `"allowCodexEnvHttpHeaders": true` を追加します。`true` 以外の値では有効になりません。

```jsonc
{
  "plugins": [
    {
      "package": "./src",
      "options": {
        "sources": ["mcp-json", "codex"],
        "allowCodexEnvHttpHeaders": true
      }
    }
  ]
}
```

例えば `env_http_headers = { "X-API-Key" = "MY_MCP_API_KEY" }` なら、プラグインは**起動時に** OpenCode プロセスの `MY_MCP_API_KEY` を読み、ヘッダーとして OpenCode に渡します。未設定または空白だけの場合はそのヘッダーを追加せず、同名の `http_headers` があれば静的値を残します。値がある場合は、大文字・小文字を区別せず静的ヘッダーを上書きします。変更後の環境変数を使うにはプラグインを再読み込みする必要があります。秘密値そのものをログや診断には出しません。

> [!WARNING]
> Codex の `shell_environment_policy` やプロジェクトの trust 判定は OpenCode に引き継がれません。opt-in 時にはプラグインと OpenCode の MCP 登録処理が秘密値を扱い、エージェントからの秘密値隔離は保証されません。OpenCode に渡した環境変数は、エージェントが実行できる shell 等からも参照可能な場合があります。**オプションを無効にしても、OpenCode プロセス自体に渡した環境変数を隔離する機能にはなりません。** グローバルなプラグイン設定で有効にすると、適用先の各プロジェクトでこの処理が有効になります。まずは利用するプロジェクトだけで有効化し、隔離が必要な秘密情報には外部の認証 proxy 等を検討してください。

`deno task smoke:codex-env-headers` は、固定 fixture とダミー値を使い OpenCode V2 の別インスタンスで実際の受信ヘッダーを検査する手動テストです。ポート 3001・4097 を空けて実行してください。`deno test` と CI には含まれず、検証後は自身が起動したプロセスだけを停止します。

ヘッダーの実送信は、ポート 3001・4097 が空いている状態で `deno task smoke:codex-headers` を実行すると確認できます。この手動テストは OpenCode V2 の別インスタンスと受信用 MCP サーバーを起動し、`.codex/config.toml` の `X-Test-Source: codex` が届くことを確認して、起動したプロセスだけを停止します。モデルは使用せず、`deno test` や CI には含めません。

## remote MCP のローカル動作確認

Codex や OpenCode から手動で接続する場合は、別のターミナルで `deno task remote:serve` を実行してください。Everything MCP の Streamable HTTP サーバーだけをポート 3001 で起動し、`.codex/config.toml` の `codex-remote` と `.mcp.json` の `everything-remote` が接続できます。確認後はそのターミナルで Ctrl+C を押して停止します。ポート 3001 が使用中なら起動できないため、次の `smoke:remote` とは同時に実行しないでください。このタスクは `deno test` や CI では実行しません。

プロジェクトルートで `deno task smoke:remote` を実行します。この手動テストは `deno test` や CI の対象外です。Deno、OpenCode V2 の実行ファイル（`opencode2` を優先し、見つからない場合のみ V2 と確認できた `opencode` を使用）、Everything MCP の npm パッケージへのアクセスが必要です。ポート 3001 と 4097 は空けておいてください。

- `3001`: Everything MCP が Streamable HTTP で待ち受けるポートです。`.mcp.json` の `everything-remote` は `http://localhost:3001/mcp` に接続します。
- `4097`: このタスクが検証専用に起動する OpenCode V2 サーバーの API ポートです。手動検証で選んだ番号であり、OpenCode の既定ポートではありません。

このタスクは Everything を Streamable HTTP モードで起動し、検証専用の OpenCode V2 サーバーでプラグインが有効なことと、`everything-stdio`・`everything-remote` が両方とも `connected` になることを確認します。モデルや `echo` は呼び出しません。`.mcp.json` のサーバー名と URL `http://localhost:3001/mcp` は検証用の値を維持してください。終了時にはタスクが起動したプロセスだけを停止し、現在の OpenCode セッションは再起動しません。失敗した場合はエラーメッセージを確認し、原因を解消してから再実行してください。

## OAuth MCP の手動動作確認

別のターミナルで `deno task oauth:serve` を実行します。Deno、Git、Bun、OpenCode V2 が必要で、ポート 3232 を空けておいてください。タスクは参照実装を `temp/example-remote-server` に未取得の場合のみ clone し、コミット `ca6133a4e63d22e2c035defa691d241ce22296a9` に固定します。既存の checkout のコミットが違う場合や追跡対象ファイルに変更がある場合は、勝手に上書きせず中断します。依存関係は Bun で導入し、元の `package-lock.json` から初回に生成した `bun.lock` を次回以降は固定して使用します。npm CLI は使いません。`temp/` は Git の対象外です。

サーバーが起動したら、OpenCode の `/mcps` で `example-oauth` を選び、ブラウザーで認証して `connected` になることを確認してください。`.mcp.json` の `http://localhost:3232/mcp` は常設です。サーバー停止中は `example-oauth` だけ接続できません。認証フローは手動で行い、`deno test` や CI、既存の `smoke:remote` の合格条件には含めません。検証後は起動したターミナルで Ctrl+C を押すと、タスクが起動したサーバーを停止します。
