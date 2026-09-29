import type { Mcp } from "@opencode/plugin";

export interface ParsedServer {
  name: string;
  config: Mcp.ServerConfig;
}

export interface ParseResult {
  servers: ParsedServer[];
  diagnostics: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) &&
    Object.values(value).every((item) => typeof item === "string");
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

  if (!isObject(input) || !isObject(input.mcpServers)) {
    result.diagnostics.push("mcpServers must be an object");
    return result;
  }

  for (const [name, value] of Object.entries(input.mcpServers)) {
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
    if (
      value.timeout !== undefined &&
      (typeof value.timeout !== "number" ||
        !Number.isSafeInteger(value.timeout) || value.timeout <= 0)
    ) {
      result.diagnostics.push(
        `mcpServers.${name}.timeout must be a positive integer in milliseconds`,
      );
      continue;
    }
    const timeout = value.timeout === undefined
      ? {}
      : { timeout: { execution: Math.max(value.timeout, 1000) } };
    if (value.type === "http" || value.type === "streamable-http") {
      if (typeof value.url !== "string") {
        result.diagnostics.push(
          `mcpServers.${name}.url must be an absolute HTTP(S) URL`,
        );
        continue;
      }
      if (value.headers !== undefined && !stringRecord(value.headers)) {
        result.diagnostics.push(
          `mcpServers.${name}.headers must contain only string values`,
        );
        continue;
      }
      const headers = value.headers as Record<string, string> | undefined;
      if (
        options.allowRemoteEnvExpansion !== true &&
        (value.url.includes("${") ||
          Object.values(headers ?? {}).some((header) => header.includes("${")))
      ) {
        result.diagnostics.push(
          `mcpServers.${name}: remote environment expansion requires allowMcpJsonRemoteEnvExpansion`,
        );
        continue;
      }
      const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
      const url = options.allowRemoteEnvExpansion === true
        ? expandValue(value.url, getEnv)
        : value.url;
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
    if (typeof value.command !== "string" || !value.command.trim()) {
      result.diagnostics.push(
        `mcpServers.${name}.command must be a non-empty string`,
      );
      continue;
    }
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) ||
        !value.args.every((arg: unknown) => typeof arg === "string"))
    ) {
      result.diagnostics.push(
        `mcpServers.${name}.args must be an array of strings`,
      );
      continue;
    }
    if (value.env !== undefined && !stringRecord(value.env)) {
      result.diagnostics.push(
        `mcpServers.${name}.env must contain only string values`,
      );
      continue;
    }
    if (
      value.cwd !== undefined &&
      (typeof value.cwd !== "string" || !value.cwd.trim())
    ) {
      result.diagnostics.push(
        `mcpServers.${name}.cwd must be a non-empty string`,
      );
      continue;
    }

    const expanded = expandStdio(
      {
        args: value.args ?? [],
        env: value.env ?? {},
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
        command: [value.command, ...expanded.args],
        ...(value.env === undefined ? {} : { environment: expanded.env }),
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
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
