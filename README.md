# opencode-mcp-config-importer

[日本語](https://github.com/wizaman/opencode-mcp-config-importer/blob/main/README.ja.md)

This plugin imports MCP servers from the project root's `.mcp.json` into OpenCode V2. When explicitly enabled, it also reads `[mcp_servers]` from `.codex/config.toml` in the same project root. The MCP protocol and `.mcp.json`, a client-side configuration format, are different things. This plugin does not aim for full compatibility with Claude Code, Copilot CLI, or Codex.

## Using the development version

The package has not been published to npm yet. Place this repository locally and configure its plugin directory in OpenCode V2's `opencode.jsonc`. The `./src` example below applies when this repository is the OpenCode project root. From another project, adjust the path to where you placed the repository.

```jsonc
{
  "plugins": [{ "package": "./src" }]
}
```

By default, the plugin reads only `.mcp.json` directly under the project root. To import Codex MCP servers as well, opt in explicitly. If you enable Codex in a global plugin configuration, it will read Codex settings in every project where that configuration applies. This repository's `opencode.jsonc` enables both sources for development.

```jsonc
{
  "plugins": [{
    "package": "./src",
    "options": { "sources": ["mcp-json", "codex"] }
  }]
}
```

The plugin reads input files at startup; reload the plugin after changing them. Native OpenCode MCP definitions take precedence over imported definitions with the same name. Between import sources, the first valid definition in `sources` order wins. If a known field has an invalid type, the **entire input file** is rejected. After type validation, missing opt-ins, failed expansions, and unsupported authentication settings cause only the affected server to be skipped.

## Supported behavior and caveats

- The plugin supports stdio and Streamable HTTP. In `.mcp.json`, `type: "http"` and `type: "streamable-http"` both mean Streamable HTTP. Legacy HTTP+SSE transport (`type: "sse"`, for example), WebSocket (`type: "ws"`), and Copilot CLI-specific `type: "local"` are not supported. If even one server uses one of these types, the **entire `.mcp.json` file** is rejected rather than just that server. This does not prohibit SSE responses within Streamable HTTP.[^mcp-2026-07-28]
- For stdio servers in `.mcp.json`, `${VAR}` and `${VAR:-default}` are expanded in `args` and `env` values. Expansion reads the OpenCode process environment and the same server's `env`, with the latter taking precedence. An unresolved `${VAR}` or a cyclic reference causes the server to be skipped. `command` and `cwd` are not expanded. OpenCode controls which environment variables child processes inherit. Secrets expanded into `args` may be visible elsewhere.
- `.mcp.json` accepts a positive integer `timeout` in milliseconds, raising values below 1000 to 1000 before passing them to OpenCode's `timeout.execution`. If omitted, OpenCode uses its global setting, if present, or its default. Zero, negative, fractional, or incorrectly typed values reject the entire file. The plugin does not change `timeout.catalog`, so timeout behavior does not fully match other clients' discovery and execution timeouts.
- For Codex, only the top-level `[mcp_servers]` table is read. Supported fields include stdio `command` / `args` / `env` / `cwd`, Streamable HTTP `url` / `http_headers`, and `enabled_tools` / `disabled_tools` for either transport. Servers with `enabled = false` are not imported. Deny rules take precedence in tool filters, which do not apply to native OpenCode definitions. If normalized server names collide and a filter could affect another server, the affected Codex server is skipped. Filters do not retroactively change the tool snapshot of an in-flight model request or restrict other clients connecting directly to an MCP server.

> [!WARNING]
> Copilot CLI-specific fields in `.mcp.json`, such as `tools` (tool filtering), `oidc` (token injection), and OAuth settings including `oauthClientId` / `oauthScopes`, are ignored while the server is imported. The originating client's tool restrictions and authentication are not reproduced. Review the required restrictions and authentication separately in OpenCode.

> [!WARNING]
> Codex `default_tools_approval_mode`, per-tool `approval_mode`, and `scopes` / `oauth_resource` are **ignored while the server is imported**. Do not assume that Codex's approval or authentication constraints work the same way in OpenCode. A stdio server with `experimental_environment = "remote"` is also **started locally** by OpenCode. Codex trust decisions and other configuration layers are not inherited. Servers with unsupported authentication settings such as `auth` / `oauth` are not imported.

### Environment variables for remote servers

By default, a remote `.mcp.json` server whose `url` or `headers` contain `${VAR}` is **not imported at all**. Only after checking the destination and values, set `"allowMcpJsonRemoteEnvExpansion": true` in the plugin `options` if you need expansion. Values are expanded from the OpenCode process environment at startup; a remote server's `env` is not consulted. Unresolved variables or invalid expanded values cause the server to be skipped. Static URLs and headers do not require this opt-in.

Likewise, a Codex server with `env_http_headers` or `bearer_token_env_var` is **not imported at all** by default. `"allowCodexEnvHttpHeaders": true` is a separate opt-in: the former creates headers from environment variables; the latter creates `Authorization: Bearer <value>`. If a value in `env_http_headers` is missing, blank, or invalid as an HTTP header, only that header is omitted; a static value for the same header in `http_headers` remains. By contrast, if the Bearer value is missing, blank, or invalid, the server is not registered without authentication. This does not implement OAuth login or token refresh.

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
> Neither opt-in isolates secrets or guarantees that the destination is safe. Codex's `shell_environment_policy` and trust decisions are not inherited. The plugin and OpenCode handle process environment values at startup, and an agent may also be able to access those values through a shell it can run. Disabling these options does **not** isolate variables already provided to the OpenCode process. Global opt-ins apply across projects. If you need isolation, consider an external authentication proxy.

[^mcp-2026-07-28]: [MCP 2026-07-28 specification announcement (Deprecations)](https://redirect.github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)
