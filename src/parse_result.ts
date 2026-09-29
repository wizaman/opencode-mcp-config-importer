import type { Mcp } from "@opencode/plugin";

export interface ParsedServer {
  name: string;
  config: Mcp.ServerConfig;
}

export interface ParseResult {
  servers: ParsedServer[];
  diagnostics: string[];
}
