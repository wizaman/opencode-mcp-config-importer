# opencode-mcp-json-adapter

プロジェクトルートの `.mcp.json` にある MCP サーバーを OpenCode V2 に取り込むプラグインです。明示的に有効化した場合は、同じルートの `.codex/config.toml` の `[mcp_servers]` も読みます。MCP プロトコルと `.mcp.json` というクライアント側の設定形式は別物です。Claude Code、Copilot CLI、Codex 全体との完全互換は目指していません。

## 現在の利用方法

npm 公開前の開発版です。リポジトリをローカルに配置し、OpenCode V2 の `opencode.jsonc` からプラグインのディレクトリを指定します。以下の `./src` は、このリポジトリを OpenCode のプロジェクトルートとして使う場合の例です。別のプロジェクトから使う場合は、実際の配置に合わせてパスを変えてください。

```jsonc
{
  "plugins": [{ "package": "./src" }]
}
```

既定ではプロジェクトルート直下の `.mcp.json` だけを読みます。Codex の MCP サーバーも取り込む場合は次のように明示します。グローバルなプラグイン設定に指定した場合、適用先の各プロジェクトで Codex 設定を読みます。このリポジトリの `opencode.jsonc` は開発用に両方を有効にしています。

```jsonc
{
  "plugins": [{
    "package": "./src",
    "options": { "sources": ["mcp-json", "codex"] }
  }]
}
```

入力ファイルは起動時に読み、変更後はプラグインの再読み込みが必要です。OpenCode ネイティブの同名 MCP 設定を優先し、入力元同士の同名定義では `sources` の先に書いた入力元の有効な定義を採用します。既知のフィールドに型違反がある場合は、その**入力ファイル全体**を取り込みません。型検証を通過した後の opt-in 不足・展開失敗・未対応認証などは、該当サーバー単位でスキップします。

## 対応範囲と注意点

- stdio と Streamable HTTP を取り込みます。`.mcp.json` の `type: "http"` と `type: "streamable-http"` は同じ Streamable HTTP として扱います。旧式 HTTP+SSE transport（`type: "sse"` など）、WebSocket（`type: "ws"`）、Copilot CLI 専用 `type: "local"` は対象外です。これらの `type` を一つでも含む場合は、サーバー単位ではなく `.mcp.json` 全体を拒否します。Streamable HTTP の SSE レスポンスを拒否する意味ではありません。[^mcp-2026-07-28]
- `.mcp.json` の stdio の `args`・`env` の値では `${VAR}` と `${VAR:-default}` を展開します。OpenCode プロセスの環境変数と同じサーバーの `env` を参照し、後者が優先です。未定義の `${VAR}` や循環参照ではサーバーをスキップします。`command`・`cwd` は展開しません。子プロセスへの環境変数の継承は OpenCode に従います。秘密値を `args` に渡すと見える可能性があります。
- `.mcp.json` の `timeout` は正の整数（ミリ秒）を受け付け、1000 未満は 1000 にして OpenCode の `timeout.execution` に渡します。未指定なら OpenCode のグローバル設定があればその値、なければ既定値を使います。0・負数・小数・型違いはファイル全体を拒否します。`timeout.catalog` は変更しません。他クライアントの発見・呼び出しタイムアウトとは完全には一致しません。
- Codex はトップレベルの `[mcp_servers]` のみが対象です。stdio の `command` / `args` / `env` / `cwd`、Streamable HTTP の `url` / `http_headers`、両形式の `enabled_tools` / `disabled_tools` に対応します。`enabled = false` のサーバーは取り込みません。ツール制限は拒否を優先し、OpenCode ネイティブ設定には適用しません。正規化後のサーバー名が衝突し、別サーバーへの誤適用があり得る場合は対象 Codex サーバーをスキップします。進行中のモデルリクエストが既に取得したツール一覧には遡及せず、別クライアントから MCP サーバーへ直接接続することも制限しません。

> [!WARNING]
> `.mcp.json` の Copilot CLI 固有の `tools`（ツールの絞り込み）、`oidc`（トークンの注入）、`oauthClientId` / `oauthScopes` などの OAuth 設定は無視してサーバーを登録します。元のクライアントのツール制限や認証は再現されません。必要な制約や認証を OpenCode 側で別途確認してください。

> [!WARNING]
> Codex の `default_tools_approval_mode` やツール別 `approval_mode`、`scopes` / `oauth_resource` は**無視してサーバーを登録**します。Codex 側の承認・認証上の制約が OpenCode で同じように働くと考えないでください。`experimental_environment = "remote"` を指定した stdio サーバーも OpenCode では**ローカルで起動**します。Codex の trust 判定や設定の他レイヤーも引き継ぎません。`auth` / `oauth` など未対応の認証設定を持つサーバーは取り込みません。

### remote の環境変数を使う場合

`.mcp.json` の remote の `url`・`headers` に `${VAR}` を含むサーバーは、既定では**定義全体を取り込みません**。送信先と値を確認したうえで、必要な場合のみ `options` に `"allowMcpJsonRemoteEnvExpansion": true` を指定してください。OpenCode プロセスの環境変数から起動時に展開します。remote の `env` は参照せず、未定義の変数や不正な展開結果ではサーバーをスキップします。静的な URL・ヘッダーには opt-in は不要です。

Codex の `env_http_headers`・`bearer_token_env_var` を含むサーバーも、既定では**定義全体を取り込みません**。`"allowCodexEnvHttpHeaders": true` は別の opt-in で、前者は環境変数からヘッダーを作り、後者は `Authorization: Bearer <値>` を作ります。`env_http_headers` の値が未設定・空白・HTTP ヘッダーとして不正なら、そのヘッダーだけを追加せず、同名の静的な `http_headers` があれば残します。一方、Bearer の値が未設定・空白・不正なら認証なしではサーバーを登録しません。OAuth のログイン・更新ではありません。

```jsonc
{
  "plugins": [{
    "package": "./src",
    "options": {
      "sources": ["mcp-json", "codex"],
      "allowMcpJsonRemoteEnvExpansion": true,
      "allowCodexEnvHttpHeaders": true
    }
  }]
}
```

> [!WARNING]
> どちらの opt-in も秘密値の隔離や送信先の安全性を保証しません。Codex の `shell_environment_policy` や trust 判定は引き継がれません。プラグインと OpenCode が起動時の環境変数を扱い、OpenCode プロセスの環境変数はエージェントが実行できる shell 等からも参照可能な場合があります。opt-in を無効にしても OpenCode プロセスの環境変数を隔離する機能にはなりません。グローバル設定で opt-in すると各プロジェクトに適用されます。隔離が必要な場合は外部の認証 proxy 等を検討してください。

[^mcp-2026-07-28]: [MCP 2026-07-28 仕様の発表（Deprecations）](https://redirect.github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)
