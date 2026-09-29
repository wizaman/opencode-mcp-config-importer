import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexToml } from "./codex/index.ts";
import { parseMcpJson } from "./mcp_json/index.ts";
import type { ParsedServer } from "./parse_result.ts";

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

function toolNamespace(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
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
    const allowRemoteEnvExpansion =
      ctx.options?.allowMcpJsonRemoteEnvExpansion === true;
    if (
      ctx.options?.allowMcpJsonRemoteEnvExpansion !== undefined &&
      typeof ctx.options.allowMcpJsonRemoteEnvExpansion !== "boolean"
    ) {
      console.warn(
        "[opencode-mcp-json-adapter] options.allowMcpJsonRemoteEnvExpansion must be a boolean; remote environment expansion stays disabled",
      );
    }
    const servers = new Map<string, ParsedServer>();
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
        ? parseMcpJson(text, { allowRemoteEnvExpansion })
        : parseCodexToml(text, { allowEnvHttpHeaders });
      for (const diagnostic of result.diagnostics) {
        console.warn(`[opencode-mcp-json-adapter] ${path}: ${diagnostic}`);
      }
      for (const server of result.servers) {
        if (!servers.has(server.name)) servers.set(server.name, server);
      }
    }
    if (servers.size === 0) return;

    let activeFilters = new Map<
      string,
      NonNullable<ParsedServer["toolFilter"]>
    >();
    await ctx.mcp.transform((editor) => {
      const filters = new Map<
        string,
        NonNullable<ParsedServer["toolFilter"]>
      >();
      const names = [...servers.values()].some((server) => server.toolFilter)
        ? [...editor.list().map(([name]) => name), ...servers.keys()]
        : [];
      for (const [name, server] of servers) {
        if (editor.get(name) !== undefined) continue;
        if (
          server.toolFilter &&
          names.some((other) =>
            other !== name && toolNamespace(other) === toolNamespace(name)
          )
        ) {
          // A normalized namespace collision could filter another server's tools.
          console.warn(
            `[opencode-mcp-json-adapter] ${name}: ambiguous MCP tool namespace; server skipped`,
          );
          continue;
        }
        editor.set(name, server.config);
        if (server.toolFilter) {
          filters.set(toolNamespace(name), server.toolFilter);
        }
      }
      activeFilters = filters;
    });
    if ([...servers.values()].some((server) => server.toolFilter)) {
      await ctx.tool.transform((editor) => {
        for (const tool of editor.list()) {
          const filter = activeFilters.get(tool.options?.namespace ?? "");
          if (!filter) continue;
          if (
            (filter.enabled !== undefined &&
              !filter.enabled.includes(tool.name)) ||
            filter.disabled?.includes(tool.name)
          ) editor.remove(tool.id);
        }
      });
    }
  },
});

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}
