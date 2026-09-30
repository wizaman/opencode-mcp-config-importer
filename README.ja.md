# opencode-mcp-config-importer

[English](./README.md)

プロジェクトルートの `.mcp.json` にある MCP サーバーを OpenCode V2 に取り込むプラグインです。明示的に有効化した場合は、同じルートの `.codex/config.toml` の `[mcp_servers]` も取り込みます。

## 背景と目的

既存のプロジェクトローカルな MCP 設定を OpenCode 用に重複して書かずに利用するためのものです。元の設定ファイルや OpenCode の設定ファイルを書き換えず、起動時にサーバー定義を取り込みます。`.mcp.json` は MCP プロトコル自体の仕様ではなく、クライアント側の設定形式です。Claude Code、Copilot CLI、Codex 全体との完全互換は目指していません。

## 導入

OpenCode V2 の `opencode.jsonc` にプラグインを追加します。

```jsonc
{
  "plugins": ["opencode-mcp-config-importer"]
}
```

既定では、OpenCode のプロジェクトルート直下の `.mcp.json` を読みます。グローバルにプラグインを設定すると、適用先の各プロジェクトが読み込み対象になります。設定ファイルの変更を反映するには、プラグインを再読み込みしてください。

## 入力元とオプション

Codex の MCP サーバーも使う場合は、`sources` に `"codex"` を明示します。`"mcp-json"` と併記すれば両方を読みます。入力元同士に同名サーバーがある場合は、配列の先に書いた入力元の有効な定義を採用します。

```jsonc
{
  "plugins": [{
    "package": "opencode-mcp-config-importer",
    "options": { "sources": ["mcp-json", "codex"] }
  }]
}
```

### remote の環境変数

`.mcp.json` の remote の `url`・`headers` に `${VAR}` を含むサーバーは、既定では**定義全体を取り込みません**。送信先と値を確認し、必要な場合のみ `"allowMcpJsonRemoteEnvExpansion": true` を指定してください。静的な URL・ヘッダーにはこの opt-in は不要です。

Codex の `env_http_headers`・`bearer_token_env_var` を含むサーバーも、既定では**定義全体を取り込みません**。取り込むには、独立した opt-in である `"allowCodexEnvHttpHeaders": true` を指定します。両方の入力元で環境変数を使う場合の例:

```jsonc
{
  "plugins": [{
    "package": "opencode-mcp-config-importer",
    "options": {
      "sources": ["mcp-json", "codex"],
      "allowMcpJsonRemoteEnvExpansion": true,
      "allowCodexEnvHttpHeaders": true
    }
  }]
}
```

これらのオプションは真偽値の `true` でのみ有効です。環境変数は OpenCode プロセスからプラグイン読み込み時に取得します。Codex の `env_http_headers` の値が未設定・空白・HTTP ヘッダーとして不正なら、そのヘッダーだけを省略し、同名の静的な `http_headers` があれば残します。一方、`bearer_token_env_var` の値が未設定・空白・不正ならサーバー全体をスキップします。Bearer は `Authorization: Bearer <値>` として送りますが、OAuth のログイン・トークン更新ではありません。

## 取り込み時の動作

- 対応 transport は stdio と Streamable HTTP です。`.mcp.json` の `type: "http"` と `type: "streamable-http"` は同じ Streamable HTTP として扱います。旧式 HTTP+SSE transport（`type: "sse"` など）、WebSocket（`type: "ws"`）、Copilot CLI 専用 `type: "local"` が一つでもあれば、`.mcp.json` **全体を拒否**します。Streamable HTTP 内で使われる SSE レスポンスとは別の話です。[^mcp-2026-07-28]
- `.mcp.json` の stdio の `args`・`env` の値では `${VAR}` と `${VAR:-default}` を展開します。OpenCode プロセスの環境変数と同じサーバーの `env` を参照し、後者が優先です。`command`・`cwd` は展開しません。remote の `url`・`headers` は専用 opt-in 時のみプロセスの環境変数から展開し、remote の `env` は参照しません。未定義の変数や不正な展開結果、循環参照では該当サーバーをスキップします。
- `.mcp.json` の `timeout` は正の整数（ミリ秒）を受け付け、1000 未満は 1000 にして OpenCode の `timeout.execution` に渡します。未指定なら OpenCode のグローバル設定があればその値、なければ既定値を使います。0・負数・小数・型違いはファイル全体を拒否します。`timeout.catalog` は変更せず、他クライアントのタイムアウトとは完全には一致しません。
- Codex はトップレベルの `[mcp_servers]` のみを読みます。stdio の `command` / `args` / `env` / `cwd`、Streamable HTTP の `url` / `http_headers`、両形式の `enabled_tools` / `disabled_tools` に対応します。`enabled = false` のサーバーは取り込みません。

OpenCode ネイティブの同名 MCP 設定を優先します。既知のフィールドに型違反があれば、その**入力ファイル全体**を拒否します。型検証後の opt-in 不足・展開失敗・未対応認証などでは、該当サーバーだけをスキップします。

## 安全性と互換性の制限

> [!WARNING]
> `.mcp.json` の Copilot CLI 固有の `tools`（ツールの絞り込み）、`oidc`（トークンの注入）、`oauthClientId` / `oauthScopes` などの OAuth 設定は無視してサーバーを登録します。元のクライアントのツール制限や認証は再現されません。必要な制約や認証を OpenCode 側で別途確認してください。

> [!WARNING]
> Codex の `default_tools_approval_mode` やツール別 `approval_mode`、`scopes` / `oauth_resource` は**無視してサーバーを登録**します。Codex 側の承認・認証上の制約が OpenCode で同じように働くと考えないでください。`experimental_environment = "remote"` を指定した stdio サーバーも OpenCode では**ローカルで起動**します。Codex の trust 判定や設定の他レイヤーも引き継ぎません。`auth` / `oauth` など未対応の認証設定を持つサーバーは取り込みません。

Codex のツール制限は拒否を優先し、OpenCode ネイティブ設定には適用しません。正規化後のサーバー名が衝突して別サーバーへの誤適用があり得る場合は、対象 Codex サーバーをスキップします。制限は進行中のモデルリクエストが既に取得したツール一覧には遡及せず、他クライアントから MCP サーバーへ直接接続することも制限しません。

> [!WARNING]
> remote の環境変数の opt-in は、秘密値の隔離や送信先の安全性を保証しません。Codex の `shell_environment_policy` も引き継がれません。プラグインと OpenCode が起動時の環境変数を扱い、エージェントが実行できる shell 等からも参照可能な場合があります。opt-in を無効にしても OpenCode プロセスの環境変数を隔離する機能にはなりません。グローバル設定で有効にすると各プロジェクトに適用されます。隔離が必要な場合は外部の認証 proxy 等を検討してください。stdio の `args` に展開した秘密値が見える可能性にも注意してください。子プロセスへの環境変数の継承は OpenCode に従います。

[^mcp-2026-07-28]: [MCP 2026-07-28 仕様の発表（Deprecations）](https://redirect.github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)
