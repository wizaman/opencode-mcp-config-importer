import type { Mcp } from "@opencode/plugin";
import { parse } from "smol-toml";
import * as v from "valibot";
import type { ParseResult } from "../parse_result.ts";
import {
  EnabledSchema,
  LocalSchema,
  RemoteSchema,
  RootSchema,
  TableSchema,
} from "./schema.ts";
import type { ServerIssue } from "./schema.ts";

function invalidField(field: string, issues: readonly ServerIssue[]): string {
  switch (issues[0]?.path?.[0]?.key) {
    case "url":
      return `${field}.url must be an absolute HTTP(S) URL`;
    case "http_headers":
      return `${field}.http_headers must contain only string values`;
    case "env_http_headers":
      return `${field}.env_http_headers must contain only string values`;
    case "bearer_token_env_var":
      return `${field}.bearer_token_env_var must be a non-empty string`;
    case "command":
      return `${field}.command must be a non-empty string`;
    case "args":
      return `${field}.args must be an array of strings`;
    case "env":
      return `${field}.env must contain only string values`;
    case "cwd":
      return `${field}.cwd must be a non-empty string`;
    default:
      return `${field}: invalid server definition`;
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
  if (
    v.is(TableSchema, input) && input.mcp_servers !== undefined &&
    !v.is(TableSchema, input.mcp_servers)
  ) {
    result.diagnostics.push("mcp_servers must be a table");
    return result;
  }
  const root = v.safeParse(RootSchema, input);
  if (!root.success) {
    result.diagnostics.push("mcp_servers must be a table");
    return result;
  }
  if (root.output.mcp_servers === undefined) return result;

  for (const [name, value] of Object.entries(root.output.mcp_servers)) {
    const field = `mcp_servers.${name}`;
    if (!v.is(TableSchema, value)) {
      result.diagnostics.push(`${field} must be a table`);
      continue;
    }
    const enabled = v.safeParse(EnabledSchema, value);
    if (!enabled.success) {
      result.diagnostics.push(`${field}.enabled must be a boolean`);
      continue;
    }
    if (enabled.output.enabled === false) continue;
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
      if (
        value.http_headers !== undefined &&
        !v.is(TableSchema, value.http_headers)
      ) {
        result.diagnostics.push(
          `${field}.http_headers must contain only string values`,
        );
        continue;
      }
      if (
        value.env_http_headers !== undefined &&
        !v.is(TableSchema, value.env_http_headers)
      ) {
        result.diagnostics.push(
          `${field}.env_http_headers must contain only string values`,
        );
        continue;
      }
      const parsed = v.safeParse(RemoteSchema, value);
      if (!parsed.success) {
        result.diagnostics.push(invalidField(field, parsed.issues));
        continue;
      }
      const { url, http_headers, env_http_headers, bearer_token_env_var } =
        parsed.output;
      const headers = { ...(http_headers ?? {}) };
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
      if (env_http_headers !== undefined) {
        for (const [name, variable] of Object.entries(env_http_headers)) {
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
      if (bearer_token_env_var !== undefined) {
        let token: string | undefined;
        try {
          token = getEnv(bearer_token_env_var);
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
        url,
        ...(http_headers === undefined &&
            env_http_headers === undefined &&
            bearer_token_env_var === undefined
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
    if (value.env !== undefined && !v.is(TableSchema, value.env)) {
      result.diagnostics.push(`${field}.env must contain only string values`);
      continue;
    }
    const parsed = v.safeParse(LocalSchema, value);
    if (!parsed.success) {
      result.diagnostics.push(invalidField(field, parsed.issues));
      continue;
    }
    const { command, args, env, cwd } = parsed.output;
    const config: Mcp.ServerConfig = {
      type: "local",
      command: [command, ...(args ?? [])],
      ...(env === undefined ? {} : { environment: { ...env } }),
      ...(cwd === undefined ? {} : { cwd }),
    };
    result.servers.push({ name, config });
  }
  return result;
}
