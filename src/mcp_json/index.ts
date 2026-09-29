import * as v from "valibot";
import type { ParseResult } from "../parse_result.ts";
import { HttpSchema, RootSchema, StdioSchema } from "./schema.ts";
import type { ServerIssue } from "./schema.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidField(
  name: string,
  issues: readonly ServerIssue[],
): string {
  const key = issues[0]?.path?.[0]?.key;
  switch (key) {
    case "timeout":
      return `mcpServers.${name}.timeout must be a positive integer in milliseconds`;
    case "url":
      return `mcpServers.${name}.url must be an absolute HTTP(S) URL`;
    case "headers":
      return `mcpServers.${name}.headers must contain only string values`;
    case "command":
      return `mcpServers.${name}.command must be a non-empty string`;
    case "args":
      return `mcpServers.${name}.args must be an array of strings`;
    case "env":
      return `mcpServers.${name}.env must contain only string values`;
    case "cwd":
      return `mcpServers.${name}.cwd must be a non-empty string`;
    default:
      return `mcpServers.${name}: invalid server definition`;
  }
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

export function parseMcpJson(
  text: string,
  options: {
    getEnv?: (name: string) => string | undefined;
    allowRemoteEnvExpansion?: boolean;
  } = {},
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
    result.diagnostics.push("mcpServers must be an object");
    return result;
  }

  for (const [name, value] of Object.entries(root.output.mcpServers)) {
    if (!isObject(value)) {
      result.diagnostics.push(`mcpServers.${name} must be an object`);
      continue;
    }
    if (
      value.type !== undefined && value.type !== "stdio" &&
      value.type !== "http" && value.type !== "streamable-http"
    ) {
      result.diagnostics.push(`mcpServers.${name}: unsupported type`);
      continue;
    }
    if (value.type === "http" || value.type === "streamable-http") {
      const parsed = v.safeParse(HttpSchema, value);
      if (!parsed.success) {
        result.diagnostics.push(invalidField(name, parsed.issues));
        continue;
      }
      const { url: rawUrl, headers, timeout: milliseconds } = parsed.output;
      const timeout = milliseconds === undefined
        ? {}
        : { timeout: { execution: Math.max(milliseconds, 1000) } };
      if (
        options.allowRemoteEnvExpansion !== true &&
        (rawUrl.includes("${") ||
          Object.values(headers ?? {}).some((header) => header.includes("${")))
      ) {
        result.diagnostics.push(
          `mcpServers.${name}: remote environment expansion requires allowMcpJsonRemoteEnvExpansion`,
        );
        continue;
      }
      const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
      const url = options.allowRemoteEnvExpansion === true
        ? expandValue(rawUrl, getEnv)
        : rawUrl;
      if (url === undefined) {
        result.diagnostics.push(
          `mcpServers.${name}: invalid or unresolved remote environment reference`,
        );
        continue;
      }
      if (!isHttpUrl(url)) {
        result.diagnostics.push(
          `mcpServers.${name}.url must be an absolute HTTP(S) URL`,
        );
        continue;
      }
      let expandedHeaders: Record<string, string> | undefined;
      if (headers !== undefined && options.allowRemoteEnvExpansion === true) {
        expandedHeaders = {};
        let invalid = false;
        for (const [key, header] of Object.entries(headers)) {
          const resolved = expandValue(header, getEnv);
          if (resolved === undefined) {
            invalid = true;
            break;
          }
          try {
            new Headers().set(key, resolved);
          } catch {
            invalid = true;
            break;
          }
          Object.defineProperty(expandedHeaders, key, {
            value: resolved,
            enumerable: true,
            writable: true,
          });
        }
        if (invalid) {
          result.diagnostics.push(
            `mcpServers.${name}: invalid or unresolved remote header`,
          );
          continue;
        }
      }
      result.servers.push({
        name,
        config: {
          type: "remote",
          url,
          ...(headers === undefined
            ? {}
            : { headers: expandedHeaders ?? headers }),
          ...timeout,
        },
      });
      continue;
    }
    if (value.url !== undefined) {
      result.diagnostics.push(
        `mcpServers.${name}: remote servers are not yet supported`,
      );
      continue;
    }
    const parsed = v.safeParse(StdioSchema, value);
    if (!parsed.success) {
      result.diagnostics.push(invalidField(name, parsed.issues));
      continue;
    }
    const { command, args, env, cwd, timeout: milliseconds } = parsed.output;
    const timeout = milliseconds === undefined
      ? {}
      : { timeout: { execution: Math.max(milliseconds, 1000) } };

    const expanded = expandStdio(
      {
        args: args ?? [],
        env: env ?? {},
      },
      options.getEnv ?? ((name) => process.env[name]),
    );
    if (!expanded) {
      result.diagnostics.push(
        `mcpServers.${name}: invalid or unresolved environment reference`,
      );
      continue;
    }
    result.servers.push({
      name,
      config: {
        type: "local",
        command: [command, ...expanded.args],
        ...(env === undefined ? {} : { environment: expanded.env }),
        ...(cwd === undefined ? {} : { cwd }),
        ...timeout,
      },
    });
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
