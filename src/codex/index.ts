import type { Mcp } from "@opencode/plugin";
import { parse } from "smol-toml";
import * as v from "valibot";
import type { ParseResult } from "../parse_result.ts";
import { RootSchema } from "./schema.ts";

type Server = NonNullable<
  v.InferOutput<typeof RootSchema>["mcp_servers"]
>[string];
type LocalServer = Extract<Server, { transport: "local" }>;
type RemoteServer = Extract<Server, { transport: "remote" }>;
type Conversion = { config?: Mcp.ServerConfig; diagnostics: string[] };

interface CodexOptions {
  allowEnvHttpHeaders?: boolean;
  getEnv?: (name: string) => string | undefined;
}

function resolveRemoteHeaders(
  name: string,
  value: RemoteServer,
  getEnv: (name: string) => string | undefined,
): { headers?: Record<string, string>; diagnostics: string[] } {
  const field = `mcp_servers.${name}`;
  const { http_headers, env_http_headers, bearer_token_env_var } = value;
  const headers = { ...(http_headers ?? {}) };
  const diagnostics: string[] = [];
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
        diagnostics.push(`${field}.env_http_headers has an invalid entry`);
        continue;
      }
      if (resolved === undefined || !resolved.trim()) continue;
      try {
        new Headers().set(name, resolved);
      } catch {
        // Never include the environment variable name or its value in logs.
        diagnostics.push(`${field}.env_http_headers has an invalid entry`);
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
      diagnostics.push(`${field}.bearer_token_env_var is not available`);
      return { diagnostics };
    }
    const authorization = `Bearer ${token}`;
    try {
      new Headers().set("Authorization", authorization);
    } catch {
      diagnostics.push(`${field}.bearer_token_env_var has an invalid value`);
      return { diagnostics };
    }
    setHeader("Authorization", authorization);
  }
  return {
    headers,
    diagnostics,
  };
}

function convertRemote(
  name: string,
  value: RemoteServer,
  getEnv: (name: string) => string | undefined,
): Conversion {
  const resolved = resolveRemoteHeaders(name, value, getEnv);
  if (resolved.headers === undefined) {
    return { diagnostics: resolved.diagnostics };
  }
  const { http_headers, env_http_headers, bearer_token_env_var } = value;
  return {
    config: {
      type: "remote",
      url: value.url,
      ...(http_headers === undefined &&
          env_http_headers === undefined &&
          bearer_token_env_var === undefined
        ? {}
        : { headers: resolved.headers }),
    },
    diagnostics: resolved.diagnostics,
  };
}

function convertLocal(name: string, value: LocalServer): Conversion {
  if (
    value.env_http_headers !== undefined ||
    value.bearer_token_env_var !== undefined
  ) {
    return {
      diagnostics: [
        `mcp_servers.${name}: environment-based HTTP headers require a remote server`,
      ],
    };
  }
  const { command, args, env, cwd } = value;
  return {
    config: {
      type: "local",
      command: [command, ...(args ?? [])],
      ...(env === undefined ? {} : { environment: { ...env } }),
      ...(cwd === undefined ? {} : { cwd }),
    },
    diagnostics: [],
  };
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
  const root = v.safeParse(RootSchema, input);
  if (!root.success) {
    result.diagnostics.push("invalid Codex MCP configuration");
    return result;
  }
  if (root.output.mcp_servers === undefined) return result;

  for (const [name, value] of Object.entries(root.output.mcp_servers)) {
    const field = `mcp_servers.${name}`;
    if (value.transport === "disabled" || value.enabled === false) continue;
    // Do not silently drop unsupported authentication settings.
    const unsupported = [
      "bearer_token",
      "http_headers_helper",
      "auth",
      "oauth",
      "env_vars",
    ].find((key) => Object.hasOwn(value, key));
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
    if (value.url !== undefined && value.command !== undefined) {
      result.diagnostics.push(`${field}: command and url cannot be combined`);
      continue;
    }
    const conversion = value.transport === "remote"
      ? convertRemote(
        name,
        value,
        options.getEnv ?? ((name) => process.env[name]),
      )
      : convertLocal(name, value);
    result.diagnostics.push(...conversion.diagnostics);
    if (conversion.config) {
      result.servers.push({
        name,
        config: conversion.config,
        ...(value.enabled_tools === undefined &&
            value.disabled_tools === undefined
          ? {}
          : {
            toolFilter: {
              ...(value.enabled_tools === undefined
                ? {}
                : { enabled: value.enabled_tools }),
              ...(value.disabled_tools === undefined
                ? {}
                : { disabled: value.disabled_tools }),
            },
          }),
      });
    }
  }
  return result;
}
