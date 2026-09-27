import assert from "node:assert/strict";
import { join } from "node:path";
import plugin from "../src/index.ts";

Deno.test("exports the OpenCode plugin", () => {
  if (plugin.id !== "opencode-mcp-json-adapter") {
    throw new Error("unexpected plugin ID");
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
