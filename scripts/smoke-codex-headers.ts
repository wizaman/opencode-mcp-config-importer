// Manual end-to-end check; deliberately excluded from deno test and CI.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const mcpPort = 3001;
const apiPort = 4097;
const decoder = new TextDecoder();

async function executable(): Promise<string> {
  for (const name of ["opencode2", "opencode"]) {
    try {
      const result = await new Deno.Command(name, {
        args: ["--version"],
        stdout: "piped",
        stderr: "null",
      }).output();
      if (result.success && /\bv2\./.test(decoder.decode(result.stdout))) {
        return name;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new Error("OpenCode V2 executable not found");
}

function available(port: number) {
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: host, port });
  } catch {
    throw new Error(
      `Port ${port} is already in use; no existing process was stopped`,
    );
  }
  listener.close();
}

async function stop(child: Deno.ChildProcess) {
  if (Deno.build.os === "windows") {
    const result = await new Deno.Command("taskkill", {
      args: ["/PID", String(child.pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!result.success) {
      throw new Error(`Could not stop process tree ${child.pid}`);
    }
  } else {
    child.kill("SIGTERM");
  }
  await child.status;
}

async function main() {
  available(mcpPort);
  available(apiPort);
  const opencode = await executable();
  let receivedHeader = false;
  // A minimal Streamable HTTP MCP endpoint: observe the actual HTTP request,
  // not merely the transformed configuration or the connected status.
  const server = Deno.serve(
    { hostname: host, port: mcpPort, onListen() {} },
    async (request) => {
      if (new URL(request.url).pathname !== "/mcp") {
        return new Response(null, {
          status: 404,
        });
      }
      if (request.headers.get("X-Test-Source") !== "codex") {
        return new Response(null, { status: 403 });
      }
      receivedHeader = true;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      let message: {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      try {
        message = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize"
        ? {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "codex-headers-check", version: "1.0.0" },
        }
        : message.method === "tools/list"
        ? { tools: [] }
        : undefined;
      return Response.json(
        result === undefined
          ? {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }
          : { jsonrpc: "2.0", id: message.id, result },
      );
    },
  );

  let child: Deno.ChildProcess | undefined;
  const password = crypto.randomUUID();
  try {
    child = new Deno.Command(opencode, {
      args: ["serve", "--hostname", host, "--port", String(apiPort)],
      cwd: root,
      env: { OPENCODE_PASSWORD: password },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${host}:${apiPort}/api/mcp`, {
          headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const mcp = await response.json() as {
            data?: Array<{ name: string; status?: { status: string } }>;
          };
          const status = mcp.data?.find((item) => item.name === "codex-remote")
            ?.status?.status;
          if (status === "failed") {
            throw new Error("codex-remote connection failed");
          }
          if (status === "connected" && receivedHeader) {
            console.log(
              "PASS: codex-remote connected; received X-Test-Source: codex",
            );
            return;
          }
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "codex-remote connection failed"
        ) throw error;
        // OpenCode has not started listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      "Timed out waiting for codex-remote and X-Test-Source header",
    );
  } finally {
    if (child) await stop(child);
    await server.shutdown();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Header smoke test failed",
  );
  Deno.exitCode = 1;
}
