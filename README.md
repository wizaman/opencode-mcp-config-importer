# opencode-mcp-config-importer

[日本語](https://github.com/wizaman/opencode-mcp-config-importer/blob/main/README.ja.md)

This plugin imports MCP servers from the project root's `.mcp.json` into OpenCode V2. When explicitly enabled, it also imports `[mcp_servers]` from `.codex/config.toml` in the same project root.

## Why this plugin?

Reuse existing project-local MCP settings without duplicating them in OpenCode configuration. The plugin imports server definitions at startup without rewriting either the source files or OpenCode configuration. `.mcp.json` is a client-side configuration format, not part of the MCP protocol itself. Full compatibility with Claude Code, Copilot CLI, or Codex is not a goal.

## Installation

Add the plugin to OpenCode V2's `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-mcp-config-importer"]
}
```

By default, the plugin reads `.mcp.json` directly under the OpenCode project root. If configured globally, it reads from each project where the plugin applies. Reload the plugin to pick up changes to input files.

## Sources and options

To also import Codex MCP servers, explicitly include `"codex"` in `sources`. Include `"mcp-json"` to read both sources. If import sources define servers with the same name, the first valid definition in the array's source order wins:

```jsonc
{
  "plugins": [{
    "package": "opencode-mcp-config-importer",
    "options": { "sources": ["mcp-json", "codex"] }
  }]
}
```

### Environment variables for remote servers

By default, a remote `.mcp.json` server whose `url` or `headers` contain `${VAR}` is **not imported at all**. Only after checking the destination and values, set `"allowMcpJsonRemoteEnvExpansion": true` if you need expansion. Static URLs and headers do not require this opt-in.

Likewise, a Codex server with `env_http_headers` or `bearer_token_env_var` is **not imported at all** by default. To import it, set the independent opt-in `"allowCodexEnvHttpHeaders": true`. Here is an example enabling environment variables for both sources:

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

Only the boolean value `true` enables either option. Environment variables are read from the OpenCode process when the plugin loads. If an `env_http_headers` value is missing, blank, or invalid as an HTTP header, only that header is omitted; a static value for the same header in `http_headers` remains. By contrast, if a `bearer_token_env_var` value is missing, blank, or invalid, the entire server is skipped. Bearer credentials are sent as `Authorization: Bearer <value>`; this does not implement OAuth login or token refresh.

## Import behavior

- The plugin supports stdio and Streamable HTTP. In `.mcp.json`, `type: "http"` and `type: "streamable-http"` both mean Streamable HTTP. If even one server uses legacy HTTP+SSE transport (`type: "sse"`, for example), WebSocket (`type: "ws"`), or Copilot CLI-specific `type: "local"`, the **entire `.mcp.json` file** is rejected. This does not prohibit SSE responses within Streamable HTTP.[^mcp-2026-07-28]
- For stdio servers in `.mcp.json`, `${VAR}` and `${VAR:-default}` are expanded in `args` and `env` values. Expansion reads the OpenCode process environment and the same server's `env`, with the latter taking precedence. `command` and `cwd` are not expanded. Remote `url` and `headers` are expanded from the process environment only with the separate opt-in; a remote server's `env` is not consulted. Unresolved variables, invalid expanded values, or cyclic references cause the affected server to be skipped.
- `.mcp.json` accepts a positive integer `timeout` in milliseconds, raising values below 1000 to 1000 before passing them to OpenCode's `timeout.execution`. If omitted, OpenCode uses its global setting, if present, or its default. Zero, negative, fractional, or incorrectly typed values reject the entire file. The plugin does not change `timeout.catalog`, so timeout behavior does not fully match other clients.
- For Codex, only the top-level `[mcp_servers]` table is read. Supported fields include stdio `command` / `args` / `env` / `cwd`, Streamable HTTP `url` / `http_headers`, and `enabled_tools` / `disabled_tools` for either transport. Servers with `enabled = false` are not imported.

Native OpenCode MCP definitions take precedence over imported definitions with the same name. If a known field has an invalid type, the **entire input file** is rejected. After type validation, missing opt-ins, failed expansions, and unsupported authentication settings cause only the affected server to be skipped.

## Security and compatibility limits

> [!WARNING]
> Copilot CLI-specific fields in `.mcp.json`, such as `tools` (tool filtering), `oidc` (token injection), and OAuth settings including `oauthClientId` / `oauthScopes`, are ignored while the server is imported. The originating client's tool restrictions and authentication are not reproduced. Review the required restrictions and authentication separately in OpenCode.

> [!WARNING]
> Codex `default_tools_approval_mode`, per-tool `approval_mode`, and `scopes` / `oauth_resource` are **ignored while the server is imported**. Do not assume that Codex's approval or authentication constraints work the same way in OpenCode. A stdio server with `experimental_environment = "remote"` is also **started locally** by OpenCode. Codex trust decisions and other configuration layers are not inherited. Servers with unsupported authentication settings such as `auth` / `oauth` are not imported.

Codex tool filters prioritize denials and do not apply to native OpenCode definitions. If normalized server names collide and a filter could affect another server, the affected Codex server is skipped. Filters do not retroactively change the tool snapshot of an in-flight model request or restrict other clients connecting directly to an MCP server.

> [!WARNING]
> Opting in to remote environment variables does not isolate secrets or guarantee that the destination is safe. Codex's `shell_environment_policy` is not inherited. The plugin and OpenCode handle process environment values at startup, and an agent may also be able to access those values through a shell it can run. Disabling these options does **not** isolate variables already provided to the OpenCode process. Global opt-ins apply across projects. If you need isolation, consider an external authentication proxy. Secrets expanded into stdio `args` may be visible elsewhere; OpenCode controls which environment variables child processes inherit.

[^mcp-2026-07-28]: [MCP 2026-07-28 specification announcement (Deprecations)](https://redirect.github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-07-28-spec-ga/index.md)
