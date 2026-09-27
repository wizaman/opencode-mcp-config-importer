import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMcpJson } from "./mcp_json.ts";

export default Plugin.define({
  id: "opencode-mcp-json-adapter",
  async setup(ctx) {
    const path = join(ctx.location.project.directory, ".mcp.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      console.warn(`[opencode-mcp-json-adapter] ${path}: failed to read file`);
      return;
    }

    const { servers, diagnostics } = parseMcpJson(text);
    for (const diagnostic of diagnostics) {
      console.warn(`[opencode-mcp-json-adapter] ${path}: ${diagnostic}`);
    }
    if (servers.length === 0) return;

    await ctx.mcp.transform((editor) => {
      for (const { name, config } of servers) {
        if (editor.get(name) === undefined) editor.set(name, config);
      }
    });
  },
});

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}
