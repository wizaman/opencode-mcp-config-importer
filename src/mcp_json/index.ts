import type { Mcp } from "@opencode/plugin";
import * as v from "valibot";
import type { ParseResult } from "../parse_result.ts";
import { RootSchema } from "./schema.ts";

type Server = v.InferOutput<typeof RootSchema>["mcpServers"][string];
type HttpServer = Extract<Server, { type: "http" | "streamable-http" }>;
type StdioServer = Extract<Server, { command: string }>;
type Conversion = Mcp.ServerConfig | { diagnostic: string };

interface McpJsonOptions {
  getEnv?: (name: string) => string | undefined;
  allowRemoteEnvExpansion?: boolean;
}

function expandValue(
  text: string,
  resolve: (name: string) => string | undefined,
  isCyclic: () => boolean = () => false,
): string | undefined {
  let output = "";
  let end = 0;
  for (const match of text.matchAll(/\$\{([^}]*)\}/g)) {
    const start = match.index;
    const prefix = text.slice(end, start);
    if (prefix.includes("${")) return;
    const [, expression] = match;
    const separator = expression.indexOf(":-");
    const name = separator < 0 ? expression : expression.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    const fallback = separator < 0
      ? undefined
      : expression.slice(separator + 2);
    if (fallback?.includes("${")) return;
    let value: string | undefined;
    try {
      value = resolve(name);
    } catch {
      return;
    }
    if (isCyclic() || (value === undefined && fallback === undefined)) return;
    output += prefix +
      ((value === undefined || value === "") && fallback !== undefined
        ? fallback
        : value);
    end = start + match[0].length;
  }
  const suffix = text.slice(end);
  if (suffix.includes("${")) return;
  return output + suffix;
}

function expandStdio(
  config: { args: string[]; env: Record<string, string> },
  getEnv: (name: string) => string | undefined,
): { args: string[]; env: Record<string, string> } | undefined {
  const resolved = new Map<string, string>();
  const resolving = new Set<string>();
  let cyclic = false;

  function resolve(name: string): string | undefined {
    if (resolved.has(name)) return resolved.get(name);
    if (Object.hasOwn(config.env, name)) {
      if (resolving.has(name)) {
        cyclic = true;
        return;
      }
      resolving.add(name);
      const value = expandValue(config.env[name], resolve, () => cyclic);
      resolving.delete(name);
      if (value === undefined || cyclic) return;
      resolved.set(name, value);
      return value;
    }
    return getEnv(name);
  }

  const env: Record<string, string> = {};
  for (const name of Object.keys(config.env)) {
    const value = resolve(name);
    if (value === undefined) return;
    Object.defineProperty(env, name, {
      value,
      enumerable: true,
      writable: true,
    });
  }
  const args: string[] = [];
  for (const arg of config.args) {
    const value = expandValue(arg, resolve, () => cyclic);
    if (value === undefined) return;
    args.push(value);
  }
  return { args, env };
}

function convertHttp(
  name: string,
  value: HttpServer,
  getEnv: (name: string) => string | undefined,
  allowRemoteEnvExpansion: boolean,
): Conversion {
  const { url: rawUrl, headers, timeout: milliseconds } = value;
  const timeout = milliseconds === undefined
    ? {}
    : { timeout: { execution: Math.max(milliseconds, 1000) } };
  if (
    !allowRemoteEnvExpansion &&
    (rawUrl.includes("${") ||
      Object.values(headers ?? {}).some((header) => header.includes("${")))
  ) {
    return {
      diagnostic:
        `mcpServers.${name}: remote environment expansion requires allowMcpJsonRemoteEnvExpansion`,
    };
  }
  const url = allowRemoteEnvExpansion ? expandValue(rawUrl, getEnv) : rawUrl;
  if (url === undefined) {
    return {
      diagnostic:
        `mcpServers.${name}: invalid or unresolved remote environment reference`,
    };
  }
  if (!isHttpUrl(url)) {
    return {
      diagnostic: `mcpServers.${name}.url must be an absolute HTTP(S) URL`,
    };
  }
  let expandedHeaders: Record<string, string> | undefined;
  if (headers !== undefined && allowRemoteEnvExpansion) {
    expandedHeaders = {};
    for (const [key, header] of Object.entries(headers)) {
      const resolved = expandValue(header, getEnv);
      if (resolved === undefined) {
        return {
          diagnostic: `mcpServers.${name}: invalid or unresolved remote header`,
        };
      }
      try {
        new Headers().set(key, resolved);
      } catch {
        return {
          diagnostic: `mcpServers.${name}: invalid or unresolved remote header`,
        };
      }
      Object.defineProperty(expandedHeaders, key, {
        value: resolved,
        enumerable: true,
        writable: true,
      });
    }
  }
  return {
    type: "remote",
    url,
    ...(headers === undefined ? {} : { headers: expandedHeaders ?? headers }),
    ...timeout,
  };
}

function convertStdio(
  name: string,
  value: StdioServer,
  getEnv: (name: string) => string | undefined,
): Conversion {
  if ("url" in value && value.url !== undefined) {
    return {
      diagnostic: `mcpServers.${name}: remote servers are not yet supported`,
    };
  }
  const { command, args, env, cwd, timeout: milliseconds } = value;
  const timeout = milliseconds === undefined
    ? {}
    : { timeout: { execution: Math.max(milliseconds, 1000) } };
  const expanded = expandStdio({ args: args ?? [], env: env ?? {} }, getEnv);
  if (!expanded) {
    return {
      diagnostic:
        `mcpServers.${name}: invalid or unresolved environment reference`,
    };
  }
  return {
    type: "local",
    command: [command, ...expanded.args],
    ...(env === undefined ? {} : { environment: expanded.env }),
    ...(cwd === undefined ? {} : { cwd }),
    ...timeout,
  };
}

export function parseMcpJson(
  text: string,
  options: McpJsonOptions = {},
): ParseResult {
  const result: ParseResult = { servers: [], diagnostics: [] };
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    // SyntaxError messages can include a fragment of the input (including secrets).
    result.diagnostics.push("invalid JSON");
    return result;
  }

  const root = v.safeParse(RootSchema, input);
  if (!root.success) {
    result.diagnostics.push("invalid .mcp.json configuration");
    return result;
  }

  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
  for (const [name, value] of Object.entries(root.output.mcpServers)) {
    // A validated stdio entry always has command; HTTP entries omit it.
    const conversion = "command" in value
      ? convertStdio(name, value, getEnv)
      : convertHttp(
        name,
        value,
        getEnv,
        options.allowRemoteEnvExpansion === true,
      );
    if ("diagnostic" in conversion) {
      result.diagnostics.push(conversion.diagnostic);
    } else result.servers.push({ name, config: conversion });
  }

  return result;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
