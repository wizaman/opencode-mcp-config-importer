import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexToml } from "./codex_toml.ts";
import { parseMcpJson } from "./mcp_json.ts";

type Source = "mcp-json" | "codex";
const sourceFiles: Record<Source, string> = {
  "mcp-json": ".mcp.json",
  codex: join(".codex", "config.toml"),
};

function sources(value: unknown): Source[] | undefined {
  if (value === undefined) return ["mcp-json"];
  if (
    !Array.isArray(value) ||
    !value.every((source) => source === "mcp-json" || source === "codex")
  ) return;
  return [...new Set(value)];
}

export default Plugin.define({
  id: "opencode-mcp-json-adapter",
  async setup(ctx) {
    const selected = sources(ctx.options?.sources);
    if (!selected) {
      console.warn(
        "[opencode-mcp-json-adapter] options.sources must be an array of mcp-json and/or codex",
      );
      return;
    }
    const allowEnvHttpHeaders = ctx.options?.allowCodexEnvHttpHeaders === true;
    if (
      ctx.options?.allowCodexEnvHttpHeaders !== undefined &&
      typeof ctx.options.allowCodexEnvHttpHeaders !== "boolean"
    ) {
      console.warn(
        "[opencode-mcp-json-adapter] options.allowCodexEnvHttpHeaders must be a boolean; env_http_headers stays disabled",
      );
    }
    const servers = new Map<
      string,
      ReturnType<typeof parseMcpJson>["servers"][number]["config"]
    >();
    for (const source of selected) {
      const path = join(ctx.location.project.directory, sourceFiles[source]);
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isNotFound(error)) continue;
        console.warn(
          `[opencode-mcp-json-adapter] ${path}: failed to read file`,
        );
        continue;
      }

      const result = source === "mcp-json"
        ? parseMcpJson(text)
        : parseCodexToml(text, { allowEnvHttpHeaders });
      for (const diagnostic of result.diagnostics) {
        console.warn(`[opencode-mcp-json-adapter] ${path}: ${diagnostic}`);
      }
      for (const { name, config } of result.servers) {
        if (!servers.has(name)) servers.set(name, config);
      }
    }
    if (servers.size === 0) return;

    await ctx.mcp.transform((editor) => {
      for (const [name, config] of servers) {
        if (editor.get(name) === undefined) editor.set(name, config);
      }
    });
  },
});

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}
