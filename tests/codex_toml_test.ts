import assert from "node:assert/strict";
import { parseCodexToml } from "../src/codex/index.ts";

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

Deno.test("rejects invalid schema for the entire Codex file without leaking values", () => {
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
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.diagnostics, ["invalid Codex MCP configuration"]);
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
    "invalid Codex MCP configuration",
  ]);
});

Deno.test("Valibot rejects the entire Codex file on field type violations", () => {
  const parsed = parseCodexToml(
    `
[mcp_servers.bad_enabled]
enabled = "no"
command = "server"
[mcp_servers.bad_env]
command = "server"
env = ["secret"]
[mcp_servers.bad_headers]
url = "https://example.com/mcp"
http_headers = ["secret"]
[mcp_servers.bad_env_headers]
url = "https://example.com/mcp"
env_http_headers = ["secret"]
[mcp_servers.good]
command = "server"
unknown = "ignored"
`,
    { allowEnvHttpHeaders: true },
  );
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.diagnostics, ["invalid Codex MCP configuration"]);
});

Deno.test("skips unsupported Codex auth but retains other valid servers", () => {
  const parsed = parseCodexToml(`
[mcp_servers.good]
command = "ok"
[mcp_servers.auth]
url = "https://example.com/mcp"
auth = { token = "secret" }
`);
  assert.deepEqual(parsed.servers, [{
    name: "good",
    config: { type: "local", command: ["ok"] },
  }]);
  assert.deepEqual(parsed.diagnostics, [
    "mcp_servers.auth.auth is not supported",
  ]);
});

Deno.test("rejects mixed transports without importing the mixed server", () => {
  const parsed = parseCodexToml(`
[mcp_servers.good]
command = "ok"
[mcp_servers.mixed]
command = "server"
url = "https://example.com/mcp"
`);
  assert.deepEqual(parsed.servers, [{
    name: "good",
    config: { type: "local", command: ["ok"] },
  }]);
  assert.deepEqual(parsed.diagnostics, [
    "mcp_servers.mixed: command and url cannot be combined",
  ]);
});

Deno.test("env HTTP headers are disabled by default without reading the environment", () => {
  const parsed = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Fallback" = "static-fallback" }
env_http_headers = { "X-Fallback" = "DUMMY_SECRET" }
`,
    {
      getEnv: () => {
        throw new Error("must not read environment");
      },
    },
  );
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.diagnostics, [
    "mcp_servers.remote.env_http_headers is not supported",
  ]);
});

Deno.test("opt-in omits absent and blank values but preserves static fallback", () => {
  const text = `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Fallback" = "static-fallback" }
env_http_headers = { "x-fallback" = "DUMMY_SECRET", "X-Only-Env" = "DUMMY_SECRET" }
`;
  for (const value of [undefined, "", "  \t  "]) {
    const parsed = parseCodexToml(text, {
      allowEnvHttpHeaders: true,
      getEnv: () => value,
    });
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(parsed.servers, [{
      name: "remote",
      config: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { "X-Fallback": "static-fallback" },
      },
    }]);
  }
});

Deno.test("opt-in overrides static headers case-insensitively without trimming nonblank values", () => {
  const parsed = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Fallback" = "static-fallback", "X-Other" = "other" }
env_http_headers = { "x-fallback" = "DUMMY_SECRET", "X-Only-Env" = "DUMMY_SECRET" }
`,
    { allowEnvHttpHeaders: true, getEnv: () => "  dummy-value  " },
  );
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.servers, [{
    name: "remote",
    config: {
      type: "remote",
      url: "https://example.com/mcp",
      headers: {
        "X-Other": "other",
        "x-fallback": "  dummy-value  ",
        "X-Only-Env": "  dummy-value  ",
      },
    },
  }]);
});

Deno.test("opt-in rejects malformed maps and skips invalid header values without exposing them", () => {
  const badMap = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
env_http_headers = { "X-Only-Env" = 123 }
`,
    { allowEnvHttpHeaders: true },
  );
  assert.deepEqual(badMap.servers, []);
  assert.equal(badMap.diagnostics.length, 1);

  const badValue = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { "X-Fallback" = "static-fallback" }
env_http_headers = { "X-Fallback" = "DUMMY_SECRET" }
`,
    { allowEnvHttpHeaders: true, getEnv: () => "secret\ninvalid" },
  );
  assert.deepEqual(badValue.servers, [{
    name: "remote",
    config: {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { "X-Fallback": "static-fallback" },
    },
  }]);
  assert.equal(badValue.diagnostics.join(" ").includes("secret"), false);
  assert.equal(badValue.diagnostics.length, 1);
});

Deno.test("bearer shorthand is disabled by default without reading the environment", () => {
  const parsed = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { Authorization = "static" }
bearer_token_env_var = "DUMMY_TOKEN"
`,
    {
      getEnv: () => {
        throw new Error("must not read environment");
      },
    },
  );
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.diagnostics, [
    "mcp_servers.remote.bearer_token_env_var is not supported",
  ]);
});

Deno.test("opt-in skips the whole bearer server when its token is absent or blank", () => {
  const text = `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { Authorization = "static" }
bearer_token_env_var = "DUMMY_TOKEN"
`;
  for (const value of [undefined, "", "  \t  "]) {
    const parsed = parseCodexToml(text, {
      allowEnvHttpHeaders: true,
      getEnv: () => value,
    });
    assert.deepEqual(parsed.servers, []);
    assert.deepEqual(parsed.diagnostics, [
      "mcp_servers.remote.bearer_token_env_var is not available",
    ]);
  }
});

Deno.test("bearer shorthand overrides static and env Authorization regardless of casing", () => {
  const parsed = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
http_headers = { authorization = "static", "X-Other" = "other" }
env_http_headers = { AUTHORIZATION = "DUMMY_HEADER" }
bearer_token_env_var = "DUMMY_TOKEN"
`,
    {
      allowEnvHttpHeaders: true,
      getEnv: (name) =>
        name === "DUMMY_TOKEN" ? "dummy-token" : "Bearer env-value",
    },
  );
  assert.deepEqual(parsed, {
    diagnostics: [],
    servers: [{
      name: "remote",
      config: {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { "X-Other": "other", Authorization: "Bearer dummy-token" },
      },
    }],
  });
});

Deno.test("invalid bearer configuration or token does not expose credentials", () => {
  const invalid = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = 123
`,
    { allowEnvHttpHeaders: true },
  );
  assert.deepEqual(invalid.servers, []);
  const badValue = parseCodexToml(
    `
[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "DUMMY_TOKEN"
`,
    { allowEnvHttpHeaders: true, getEnv: () => "secret\ninvalid" },
  );
  assert.deepEqual(badValue.servers, []);
  assert.equal(badValue.diagnostics.join(" ").includes("secret"), false);
});
