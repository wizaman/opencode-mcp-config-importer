import plugin from "../src/index.ts";

Deno.test("exports the OpenCode plugin", () => {
  if (plugin.id !== "opencode-mcp-json-adapter") {
    throw new Error("unexpected plugin ID");
  }
});
