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

export function parseMcpJson(text: string): ParseResult {
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
      if (typeof value.url !== "string" || !isHttpUrl(value.url)) {
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
      result.servers.push({
        name,
        config: {
          type: "remote",
          url: value.url,
          ...(value.headers === undefined ? {} : { headers: value.headers }),
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

    result.servers.push({
      name,
      config: {
        type: "local",
        command: [value.command, ...(value.args ?? [])],
        ...(value.env === undefined ? {} : { environment: value.env }),
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
