import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "../src/index.ts";

Deno.test("exports the OpenCode plugin", () => {
  if (plugin.id !== "opencode-mcp-json-adapter") {
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
