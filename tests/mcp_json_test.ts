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

Deno.test("skips invalid or unsupported servers but keeps valid ones", () => {
  const parsed = parseMcpJson(JSON.stringify({
    mcpServers: {
      valid: { command: "server", env: { TOKEN: "secret" } },
      invalid: { command: "server", env: { TOKEN: 123 } },
      remote: { type: "http", url: "https://example.com/mcp" },
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
