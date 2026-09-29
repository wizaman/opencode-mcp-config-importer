import type { Mcp } from "@opencode/plugin";

export interface ParsedServer {
  name: string;
  config: Mcp.ServerConfig;
  toolFilter?: {
    enabled?: readonly string[];
    disabled?: readonly string[];
  };
}

export interface ParseResult {
  servers: ParsedServer[];
  diagnostics: string[];
}
