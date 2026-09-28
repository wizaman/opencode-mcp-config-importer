import type { Mcp } from "@opencode/plugin";
import { parse } from "smol-toml";
import type { ParseResult } from "./mcp_json.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

interface CodexOptions {
  allowEnvHttpHeaders?: boolean;
  getEnv?: (name: string) => string | undefined;
}

export function parseCodexToml(
  text: string,
  options: CodexOptions = {},
): ParseResult {
  const result: ParseResult = { servers: [], diagnostics: [] };
  let input: unknown;
  try {
    input = parse(text);
  } catch {
    // TOML syntax errors may contain input fragments, including credentials.
    result.diagnostics.push("invalid TOML");
    return result;
  }
  if (isObject(input) && input.mcp_servers === undefined) return result;
  if (!isObject(input) || !isObject(input.mcp_servers)) {
    result.diagnostics.push("mcp_servers must be a table");
    return result;
  }

  for (const [name, value] of Object.entries(input.mcp_servers)) {
    const field = `mcp_servers.${name}`;
    if (!isObject(value)) {
      result.diagnostics.push(`${field} must be a table`);
      continue;
    }
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      result.diagnostics.push(`${field}.enabled must be a boolean`);
      continue;
    }
    if (value.enabled === false) continue;
    // Do not silently drop unsupported authentication settings.
    const unsupported = [
      "bearer_token",
      "http_headers_helper",
      "auth",
      "oauth",
      "env_vars",
    ].find((key) => value[key] !== undefined);
    if (unsupported) {
      result.diagnostics.push(`${field}.${unsupported} is not supported`);
      continue;
    }
    if (
      (value.env_http_headers !== undefined ||
        value.bearer_token_env_var !== undefined) &&
      options.allowEnvHttpHeaders !== true
    ) {
      const key = value.bearer_token_env_var !== undefined
        ? "bearer_token_env_var"
        : "env_http_headers";
      result.diagnostics.push(`${field}.${key} is not supported`);
      continue;
    }
    if (value.url !== undefined) {
      if (value.command !== undefined) {
        result.diagnostics.push(`${field}: command and url cannot be combined`);
        continue;
      }
      if (typeof value.url !== "string" || !isHttpUrl(value.url)) {
        result.diagnostics.push(`${field}.url must be an absolute HTTP(S) URL`);
        continue;
      }
      if (
        value.http_headers !== undefined && !stringRecord(value.http_headers)
      ) {
        result.diagnostics.push(
          `${field}.http_headers must contain only string values`,
        );
        continue;
      }
      if (
        value.env_http_headers !== undefined &&
        !stringRecord(value.env_http_headers)
      ) {
        result.diagnostics.push(
          `${field}.env_http_headers must contain only string values`,
        );
        continue;
      }
      if (
        value.bearer_token_env_var !== undefined &&
        (typeof value.bearer_token_env_var !== "string" ||
          !value.bearer_token_env_var.trim())
      ) {
        result.diagnostics.push(
          `${field}.bearer_token_env_var must be a non-empty string`,
        );
        continue;
      }
      const headers = { ...(value.http_headers ?? {}) };
      const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
      const setHeader = (name: string, resolved: string) => {
        for (const existing of Object.keys(headers)) {
          if (existing.toLowerCase() === name.toLowerCase()) {
            delete headers[existing];
          }
        }
        Object.defineProperty(headers, name, {
          value: resolved,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      };
      if (value.env_http_headers !== undefined) {
        for (const [name, variable] of Object.entries(value.env_http_headers)) {
          let resolved: string | undefined;
          try {
            resolved = getEnv(variable);
          } catch {
            result.diagnostics.push(
              `${field}.env_http_headers has an invalid entry`,
            );
            continue;
          }
          if (resolved === undefined || !resolved.trim()) continue;
          try {
            new Headers().set(name, resolved);
          } catch {
            // Never include the environment variable name or its value in logs.
            result.diagnostics.push(
              `${field}.env_http_headers has an invalid entry`,
            );
            continue;
          }
          setHeader(name, resolved);
        }
      }
      if (value.bearer_token_env_var !== undefined) {
        let token: string | undefined;
        try {
          token = getEnv(value.bearer_token_env_var);
        } catch {
          // Codex fails the connection when its configured bearer credential is missing.
        }
        if (token === undefined || !token.trim()) {
          result.diagnostics.push(
            `${field}.bearer_token_env_var is not available`,
          );
          continue;
        }
        const authorization = `Bearer ${token}`;
        try {
          new Headers().set("Authorization", authorization);
        } catch {
          result.diagnostics.push(
            `${field}.bearer_token_env_var has an invalid value`,
          );
          continue;
        }
        setHeader("Authorization", authorization);
      }
      const config: Mcp.ServerConfig = {
        type: "remote",
        url: value.url,
        ...(value.http_headers === undefined &&
            value.env_http_headers === undefined &&
            value.bearer_token_env_var === undefined
          ? {}
          : { headers }),
      };
      result.servers.push({ name, config });
      continue;
    }
    if (
      value.env_http_headers !== undefined ||
      value.bearer_token_env_var !== undefined
    ) {
      result.diagnostics.push(
        `${field}: environment-based HTTP headers require a remote server`,
      );
      continue;
    }
    if (typeof value.command !== "string" || !value.command.trim()) {
      result.diagnostics.push(`${field}.command must be a non-empty string`);
      continue;
    }
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) ||
        !value.args.every((arg: unknown) => typeof arg === "string"))
    ) {
      result.diagnostics.push(`${field}.args must be an array of strings`);
      continue;
    }
    if (value.env !== undefined && !stringRecord(value.env)) {
      result.diagnostics.push(`${field}.env must contain only string values`);
      continue;
    }
    if (
      value.cwd !== undefined &&
      (typeof value.cwd !== "string" || !value.cwd.trim())
    ) {
      result.diagnostics.push(`${field}.cwd must be a non-empty string`);
      continue;
    }
    const config: Mcp.ServerConfig = {
      type: "local",
      command: [value.command, ...(value.args ?? [])],
      ...(value.env === undefined ? {} : { environment: { ...value.env } }),
      ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    };
    result.servers.push({ name, config });
  }
  return result;
}
