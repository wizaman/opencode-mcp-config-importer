import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../src/index.ts";

Deno.test("exports the OpenCode plugin", () => {
  if (plugin.id !== "opencode-mcp-config-importer") {
    throw new Error("unexpected plugin ID");
  }
});

Deno.test("committed fixtures honor opt-in, source order, and native precedence", async () => {
  const root = fileURLToPath(new URL("./fixtures/sources/", import.meta.url));
  async function run(sources?: string[]) {
    const definitions = new Map<string, unknown>([["codex-only", {
      type: "local",
      command: ["native-server"],
    }]]);
    const context = {
      options: sources === undefined ? {} : { sources },
      location: { project: { directory: root } },
      mcp: {
        transform: (callback: (editor: Editor) => void) => {
          callback({
            get: (name: string) => definitions.get(name),
            set: (name: string, config: unknown) =>
              definitions.set(name, config),
          } as unknown as Editor);
          return Promise.resolve();
        },
      },
    } as unknown as Context;
    await plugin.setup(context);
    return definitions;
  }

  const defaults = await run();
  assert.deepEqual(defaults.get("shared"), {
    type: "local",
    command: ["json-server"],
  });
  assert.equal(defaults.has("codex-remote"), false);

  const jsonFirst = await run(["mcp-json", "codex"]);
  assert.deepEqual(jsonFirst.get("shared"), defaults.get("shared"));
  assert.deepEqual(jsonFirst.get("codex-only"), {
    type: "local",
    command: ["native-server"],
  });
  assert.deepEqual(jsonFirst.get("codex-remote"), {
    type: "remote",
    url: "http://localhost:3001/mcp",
    headers: { "X-Test-Source": "codex" },
  });

  const codexFirst = await run(["codex", "mcp-json"]);
  assert.deepEqual(codexFirst.get("shared"), {
    type: "local",
    command: ["codex-server"],
  });
  assert.deepEqual(codexFirst.get("json-only"), {
    type: "local",
    command: ["json-only-server"],
  });
  assert.deepEqual(codexFirst.get("codex-only"), jsonFirst.get("codex-only"));
  const onlyCodex = await run(["codex"]);
  assert.equal(onlyCodex.has("json-only"), false);
});

Deno.test("env HTTP headers require an explicit boolean opt-in", async () => {
  const root = fileURLToPath(
    new URL("./fixtures/env-headers/", import.meta.url),
  );
  const variable = "ADAPTER_ENV_HEADER_PROBE";
  const original = Deno.env.get(variable);
  const bearerVariable = "ADAPTER_BEARER_HEADER_PROBE";
  const originalBearer = Deno.env.get(bearerVariable);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  async function definitions(options: Record<string, unknown>) {
    const servers = new Map<string, unknown>();
    const context = {
      options,
      location: { project: { directory: root } },
      mcp: {
        transform: (callback: (editor: Editor) => void) => {
          callback({
            get: (name: string) => servers.get(name),
            set: (name: string, config: unknown) => servers.set(name, config),
          } as unknown as Editor);
          return Promise.resolve();
        },
      },
    } as unknown as Context;
    await plugin.setup(context);
    return servers;
  }
  try {
    console.warn = (...args: unknown[]) =>
      warnings.push(args.map(String).join(" "));
    Deno.env.set(variable, "dummy-value");
    Deno.env.set(bearerVariable, "dummy-token");
    const disabled = await definitions({ sources: ["codex"] });
    assert.equal(disabled.has("env-probe"), false);
    assert.equal(disabled.has("bearer-probe"), false);
    const fallback = await definitions({ sources: ["codex", "mcp-json"] });
    assert.deepEqual(fallback.get("env-probe"), {
      type: "local",
      command: ["fallback-server"],
    });
    assert.deepEqual(fallback.get("bearer-probe"), fallback.get("env-probe"));
    const invalid = await definitions({
      sources: ["codex", "mcp-json"],
      allowCodexEnvHttpHeaders: "true",
    });
    assert.deepEqual(invalid.get("env-probe"), fallback.get("env-probe"));
    assert.deepEqual(invalid.get("bearer-probe"), fallback.get("bearer-probe"));
    const enabled = await definitions({
      sources: ["codex", "mcp-json"],
      allowCodexEnvHttpHeaders: true,
    });
    assert.deepEqual(enabled.get("env-probe"), {
      type: "remote",
      url: "http://localhost:3001/mcp",
      headers: { "x-fallback": "dummy-value", "X-Only-Env": "dummy-value" },
    });
    assert.deepEqual(enabled.get("bearer-probe"), {
      type: "remote",
      url: "http://localhost:3001/mcp",
      headers: { "X-Probe": "bearer", Authorization: "Bearer dummy-token" },
    });
    Deno.env.delete(bearerVariable);
    const missing = await definitions({
      sources: ["codex", "mcp-json"],
      allowCodexEnvHttpHeaders: true,
    });
    assert.deepEqual(missing.get("bearer-probe"), fallback.get("bearer-probe"));
    assert(
      warnings.some((message) => message.includes("allowCodexEnvHttpHeaders")),
    );
    assert(warnings.every((message) => !message.includes("dummy-value")));
  } finally {
    console.warn = originalWarn;
    if (original === undefined) Deno.env.delete(variable);
    else Deno.env.set(variable, original);
    if (originalBearer === undefined) Deno.env.delete(bearerVariable);
    else Deno.env.set(bearerVariable, originalBearer);
  }
});

Deno.test("remote .mcp.json expansion requires its own boolean opt-in", async () => {
  const root = fileURLToPath(
    new URL("./fixtures/remote-env/", import.meta.url),
  );
  const variable = "ADAPTER_ENV_HEADER_PROBE";
  const original = Deno.env.get(variable);
  const originalWarn = console.warn;
  const warnings: string[] = [];
  async function definitions(options: Record<string, unknown>) {
    const servers = new Map<string, unknown>();
    const context = {
      options,
      location: { project: { directory: root } },
      mcp: {
        transform: (callback: (editor: Editor) => void) => {
          callback({
            get: (name: string) => servers.get(name),
            set: (name: string, config: unknown) => servers.set(name, config),
          } as unknown as Editor);
          return Promise.resolve();
        },
      },
    } as unknown as Context;
    await plugin.setup(context);
    return servers;
  }
  try {
    console.warn = (...args: unknown[]) =>
      warnings.push(args.map(String).join(" "));
    Deno.env.set(variable, "dummy-value");
    for (
      const options of [
        {},
        { allowCodexEnvHttpHeaders: true },
        { allowMcpJsonRemoteEnvExpansion: "true" },
      ]
    ) {
      const disabled = await definitions(options);
      assert.equal(disabled.has("dynamic"), false);
      assert.deepEqual(disabled.get("static"), {
        type: "remote",
        url: "http://localhost:3001/mcp",
      });
    }
    const fallback = await definitions({ sources: ["mcp-json", "codex"] });
    assert.deepEqual(fallback.get("dynamic"), {
      type: "remote",
      url: "http://localhost:3001/fallback",
    });
    const enabled = await definitions({ allowMcpJsonRemoteEnvExpansion: true });
    assert.deepEqual(enabled.get("dynamic"), {
      type: "remote",
      url: "http://localhost:3001/dummy-value",
      headers: { Authorization: "Bearer dummy-value", "X-Static": "static" },
    });
    assert(
      warnings.some((message) =>
        message.includes("allowMcpJsonRemoteEnvExpansion")
      ),
    );
    assert(warnings.every((message) => !message.includes("dummy-value")));
  } finally {
    console.warn = originalWarn;
    if (original === undefined) Deno.env.delete(variable);
    else Deno.env.set(variable, original);
  }
});

type Context = Parameters<typeof plugin.setup>[0];
type Editor = Parameters<Parameters<Context["mcp"]["transform"]>[0]>[0];

Deno.test("uses only the project root and preserves native MCP definitions", async () => {
  const root = await Deno.makeTempDir();
  const nested = join(root, "nested");
  const definitions = new Map<string, unknown>([["existing", {
    type: "local",
    command: ["native"],
  }]]);
  let transforms = 0;
  try {
    await Deno.mkdir(nested);
    await Deno.writeTextFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          existing: { command: "imported" },
          added: { command: "deno", args: ["x", "-A"] },
          remote: { type: "http", url: "http://localhost:3001/mcp" },
        },
      }),
    );
    await Deno.writeTextFile(
      join(nested, ".mcp.json"),
      JSON.stringify({
        mcpServers: { nested: { command: "nested" } },
      }),
    );

    const context = {
      location: {
        directory: nested,
        project: { directory: root, canonical: root },
      },
      mcp: {
        transform: (callback: (editor: Editor) => void) => {
          transforms++;
          callback({
            get: (name: string) => definitions.get(name),
            set: (name: string, config: unknown) =>
              definitions.set(name, config),
          } as unknown as Editor);
          return Promise.resolve();
        },
      },
    } as unknown as Context;

    await plugin.setup(context);
    assert.equal(transforms, 1);
    assert.deepEqual(definitions.get("existing"), {
      type: "local",
      command: ["native"],
    });
    assert.deepEqual(definitions.get("added"), {
      type: "local",
      command: ["deno", "x", "-A"],
    });
    assert.deepEqual(definitions.get("remote"), {
      type: "remote",
      url: "http://localhost:3001/mcp",
    });
    assert.equal(definitions.has("nested"), false);

    await Deno.remove(join(root, ".mcp.json"));
    await plugin.setup(context);
    assert.equal(transforms, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("filters only imported Codex tools after catalog updates", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, ".codex"));
    await Deno.writeTextFile(
      join(root, ".codex", "config.toml"),
      `
[mcp_servers.limited]
command = "server"
enabled_tools = ["echo", "image"]
disabled_tools = ["image"]
[mcp_servers.empty]
url = "https://example.com/mcp"
enabled_tools = []
[mcp_servers.native]
command = "codex"
disabled_tools = ["echo"]
[mcp_servers."collide.one"]
command = "codex"
disabled_tools = ["echo"]
`,
    );
    const definitions = new Map<string, unknown>([
      ["native", { type: "local", command: ["native"] }],
      ["collide_one", { type: "local", command: ["native"] }],
    ]);
    let toolTransform: ((editor: ToolEditor) => void) | undefined;
    const context = {
      options: { sources: ["codex"] },
      location: { project: { directory: root } },
      mcp: {
        transform: (callback: (editor: Editor) => void) => {
          callback({
            get: (name: string) => definitions.get(name),
            set: (name: string, config: unknown) =>
              definitions.set(name, config),
            list: () => [...definitions.entries()],
          } as unknown as Editor);
          return Promise.resolve();
        },
      },
      tool: {
        transform: (callback: (editor: ToolEditor) => void) => {
          toolTransform = callback;
          return Promise.resolve();
        },
      },
    } as unknown as Context;
    const originalWarn = console.warn;
    try {
      console.warn = () => {};
      await plugin.setup(context);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(definitions.has("collide.one"), false);
    assert.deepEqual(definitions.get("native"), {
      type: "local",
      command: ["native"],
    });
    assert.deepEqual(definitions.get("limited"), {
      type: "local",
      command: ["server"],
    });
    assert(toolTransform);
    const filter = (
      tools: { id: string; name: string; namespace: string }[],
    ) => {
      const removed: string[] = [];
      toolTransform!({
        list: () =>
          tools.map((tool) => ({
            ...tool,
            options: { namespace: tool.namespace },
          })),
        remove: (id: string) => removed.push(id),
      } as unknown as ToolEditor);
      return removed;
    };
    assert.deepEqual(filter([]), []); // Before connection.
    const tools = [
      { id: "limited_echo", name: "echo", namespace: "limited" },
      { id: "limited_image", name: "image", namespace: "limited" },
      { id: "limited_other", name: "other", namespace: "limited" },
      { id: "empty_echo", name: "echo", namespace: "empty" },
      { id: "native_echo", name: "echo", namespace: "native" },
      { id: "collide_one_echo", name: "echo", namespace: "collide_one" },
    ];
    assert.deepEqual(filter(tools), [
      "limited_image",
      "limited_other",
      "empty_echo",
    ]);
    assert.deepEqual(filter(tools), [
      "limited_image",
      "limited_other",
      "empty_echo",
    ]); // Catalog refresh reapplies the same filter.
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

type ToolEditor = Parameters<Parameters<Context["tool"]["transform"]>[0]>[0];
