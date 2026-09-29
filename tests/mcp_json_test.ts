import assert from "node:assert/strict";
import { parseMcpJson } from "../src/mcp_json.ts";

Deno.test("parses an empty server list", () => {
  assert.deepEqual(parseMcpJson('{"mcpServers":{}}'), {
    servers: [],
    diagnostics: [],
  });
});

Deno.test("converts stdio command, args, env and cwd", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      everything: {
        type: "stdio",
        command: "deno",
        args: ["x", "-A", "npm:@modelcontextprotocol/server-everything"],
        env: { TOKEN: "secret" },
        cwd: "./tools",
        unknown: true,
      },
    },
  }));
  assert.deepEqual(parsed, {
    servers: [{
      name: "everything",
      config: {
        type: "local",
        command: [
          "deno",
          "x",
          "-A",
          "npm:@modelcontextprotocol/server-everything",
        ],
        environment: { TOKEN: "secret" },
        cwd: "./tools",
      },
    }],
    diagnostics: [],
  });
});

Deno.test("converts commands without optional fields and preserves platform paths", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      windows: { command: "C:\\Program Files\\server.exe" },
      unix: { command: "/usr/local/bin/server", args: ["--path", "/tmp/test"] },
    },
  }));
  assert.deepEqual(
    parsed.servers.map(({ name, config }) => {
      if (config.type !== "local") throw new Error("expected local server");
      return [name, config.command];
    }),
    [
      ["windows", ["C:\\Program Files\\server.exe"]],
      ["unix", ["/usr/local/bin/server", "--path", "/tmp/test"]],
    ],
  );
  assert.deepEqual(parsed.diagnostics, []);
});

Deno.test("rejects malformed JSON without revealing contents", () => {
  const parsed = parseMcpJson('{"mcpServers":{"key":"secret"');
  assert.deepEqual(parsed.servers, []);
  assert.deepEqual(parsed.diagnostics, ["invalid JSON"]);
});

Deno.test("converts a Streamable HTTP server and headers", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      remote: {
        type: "http",
        url: "http://localhost:3001/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    },
  }));
  assert.deepEqual(parsed, {
    servers: [{
      name: "remote",
      config: {
        type: "remote",
        url: "http://localhost:3001/mcp",
        headers: { Authorization: "Bearer secret" },
      },
    }],
    diagnostics: [],
  });
});

Deno.test("accepts the Streamable HTTP alias and maps timeouts for local and remote servers", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      local: { command: "server", timeout: 2500 },
      remote: {
        type: "streamable-http",
        url: "https://example.com/mcp",
        timeout: 6000,
      },
      tooShort: { command: "server", timeout: 999 },
    },
  }));
  assert.deepEqual(parsed, {
    servers: [
      {
        name: "local",
        config: {
          type: "local",
          command: ["server"],
          timeout: { execution: 2500 },
        },
      },
      {
        name: "remote",
        config: {
          type: "remote",
          url: "https://example.com/mcp",
          timeout: { execution: 6000 },
        },
      },
      { name: "tooShort", config: { type: "local", command: ["server"] } },
    ],
    diagnostics: [],
  });
});

Deno.test("skips WebSocket and malformed timeouts without dropping valid servers", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      websocket: { type: "ws", url: "wss://example.com/mcp" },
      wrongType: { command: "server", timeout: "secret" },
      fraction: {
        type: "http",
        url: "https://example.com/mcp",
        timeout: 1500.5,
      },
      unsafe: { command: "server", timeout: Number.MAX_SAFE_INTEGER + 1 },
      valid: { type: "http", url: "https://example.com/mcp", timeout: 1000 },
    },
  }));
  assert.deepEqual(parsed.servers, [{
    name: "valid",
    config: {
      type: "remote",
      url: "https://example.com/mcp",
      timeout: { execution: 1000 },
    },
  }]);
  assert.equal(parsed.diagnostics.length, 4);
  assert(
    parsed.diagnostics.some((message) => message.includes("unsupported type")),
  );
  assert.equal(parsed.diagnostics.join(" ").includes("secret"), false);
});

Deno.test("skips invalid remote definitions without logging header values", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      good: { type: "http", url: "https://example.com/mcp" },
      relative: { type: "http", url: "/mcp" },
      wrongScheme: { type: "http", url: "file:///mcp" },
      badHeaders: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: 123, Secret: "secret" },
      },
    },
  }));
  assert.deepEqual(parsed.servers, [{
    name: "good",
    config: { type: "remote", url: "https://example.com/mcp" },
  }]);
  assert.equal(parsed.diagnostics.length, 3);
  assert.equal(parsed.diagnostics.join(" ").includes("secret"), false);
});

Deno.test("skips invalid or unsupported servers but keeps valid ones", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      valid: { command: "server", env: { TOKEN: "secret" } },
      invalid: { command: "server", env: { TOKEN: 123 } },
      unsupported: { type: "sse", url: "https://example.com/sse" },
      missing: { args: ["--help"] },
    },
  }));
  assert.deepEqual(parsed.servers.map(({ name }) => name), ["valid"]);
  assert.equal(parsed.diagnostics.length, 3);
  assert.equal(parsed.diagnostics.join(" ").includes("secret"), false);
});

Deno.test("rejects invalid root and argument shapes", () => {
  assert.deepEqual(parseMcpJson("[]").diagnostics, [
    "mcpServers must be an object",
  ]);
  assert.deepEqual(parseMcpJson('{"mcpServers":[]}').diagnostics, [
    "mcpServers must be an object",
  ]);
  assert.deepEqual(
    parseMcpJson('{"mcpServers":{"bad":{"command":"cmd","args":[1]}}}')
      .servers,
    [],
  );
});
