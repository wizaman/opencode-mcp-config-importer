import assert from "node:assert/strict";
import { parseCodexToml } from "../src/codex_toml.ts";

Deno.test("converts Codex stdio and static HTTP headers, ignoring other settings", () => {
  const parsed = parseCodexToml(`
model = "other"
[mcp_servers.local]
command = "deno"
args = ["run", "server.ts"]
cwd = "./tools"
env = { KEY = "value" }
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Test-Source" = "codex" }
`);
  assert.deepEqual(parsed, {
    servers: [
      {
        name: "local",
        config: {
          type: "local",
          command: ["deno", "run", "server.ts"],
          cwd: "./tools",
          environment: { KEY: "value" },
        },
      },
      {
        name: "remote",
        config: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { "X-Test-Source": "codex" },
        },
      },
    ],
    diagnostics: [],
  });
});

Deno.test("skips bad servers and unsupported auth without leaking header values", () => {
  const parsed = parseCodexToml(`
[mcp_servers.good]
command = "ok"
[mcp_servers.disabled]
command = "disabled-server"
enabled = false
[mcp_servers.invalid]
url = "/mcp"
[mcp_servers.auth]
url = "https://example.com/mcp"
env_http_headers = { Authorization = "SECRET_ENV" }
[mcp_servers.bad_header]
url = "https://example.com/mcp"
http_headers = { Authorization = 123, Secret = "secret" }
`);
  assert.deepEqual(parsed.servers, [{
    name: "good",
    config: { type: "local", command: ["ok"] },
  }]);
  assert.equal(parsed.diagnostics.length, 3);
  assert.equal(parsed.diagnostics.join(" ").includes("secret"), false);
  assert.equal(parsed.diagnostics.join(" ").includes("SECRET_ENV"), false);
});

Deno.test("rejects malformed TOML without showing input", () => {
  const parsed = parseCodexToml('[mcp_servers] password = "secret" \n bad = ');
  assert.deepEqual(parsed, { servers: [], diagnostics: ["invalid TOML"] });
  assert.deepEqual(parseCodexToml("model = 'foo'"), {
    servers: [],
    diagnostics: [],
  });
  assert.deepEqual(parseCodexToml("mcp_servers = []").diagnostics, [
    "mcp_servers must be a table",
  ]);
});
