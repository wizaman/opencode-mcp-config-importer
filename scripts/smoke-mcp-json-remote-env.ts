// Manual, local-only integration check; excluded from deno test and CI.
// Uses a fixed fixture and a dummy value, never a real credential.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const mcpPort = 3001;
const apiPort = 4097;
const variable = "ADAPTER_ENV_HEADER_PROBE";
const marker = "dummy-remote-env-value";
const decoder = new TextDecoder();

function available(port: number) {
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: host, port });
  } catch {
    throw new Error(`Port ${port} is already in use; no process was stopped`);
  }
  listener.close();
}

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

async function stop(child: Deno.ChildProcess) {
  if (Deno.build.os === "windows") {
    const result = await new Deno.Command("taskkill", {
      args: ["/PID", String(child.pid), "/T", "/F"],
      stdout: "null",
      stderr: "null",
    }).output();
    assert(result.success, `Could not stop process tree ${child.pid}`);
  } else {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await child.status;
}

async function run(
  opencode: string,
  label: string,
  optIn: boolean,
  value: string | undefined,
) {
  const temp = Deno.build.os === "windows"
    ? join(Deno.env.get("LOCALAPPDATA")!, "Temp", "opencode")
    : undefined;
  const directory = await Deno.makeTempDir({
    dir: temp,
    prefix: "mcp-json-remote-env-",
  });
  let captured: {
    path: string;
    authorization: string | null;
    static: string | null;
  } | undefined;
  let lastStatuses = "no API response";
  let dynamicRequests = 0;
  let server: Deno.HttpServer | undefined;
  let child: Deno.ChildProcess | undefined;
  try {
    await Deno.writeTextFile(
      join(directory, ".mcp.json"),
      await Deno.readTextFile(
        new URL("../tests/fixtures/remote-env/.mcp.json", import.meta.url),
      ),
    );
    await Deno.writeTextFile(
      join(directory, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: [{
          package: join(root, "src"),
          options: {
            sources: ["mcp-json"],
            allowMcpJsonRemoteEnvExpansion: optIn,
          },
        }],
      }),
    );
    const git = await new Deno.Command("git", {
      args: ["init", "--quiet"],
      cwd: directory,
      stdout: "null",
      stderr: "null",
    }).output();
    assert(git.success, "Could not initialize the isolated test project");

    server = Deno.serve(
      { hostname: host, port: mcpPort, onListen() {} },
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path === `/${marker}`) dynamicRequests++;
        if (path !== "/mcp" && path !== `/${marker}`) {
          return new Response(null, { status: 404 });
        }
        if (request.method !== "POST") {
          return new Response(null, { status: 405 });
        }
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
        if (path === `/${marker}` && message.method === "initialize") {
          captured = {
            path,
            authorization: request.headers.get("Authorization"),
            static: request.headers.get("X-Static"),
          };
        }
        if (message.id === undefined) {
          return new Response(null, { status: 202 });
        }
        const result = message.method === "initialize"
          ? {
            protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "remote-env-check", version: "1.0.0" },
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

    const password = crypto.randomUUID();
    child = new Deno.Command(opencode, {
      args: ["serve", "--hostname", host, "--port", String(apiPort)],
      cwd: directory,
      env: {
        OPENCODE_PASSWORD: password,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        ...(value === undefined ? {} : { [variable]: value }),
      },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const auth = { Authorization: `Basic ${btoa(`opencode:${password}`)}` };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${host}:${apiPort}/api/mcp`, {
          headers: auth,
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const mcp = await response.json() as {
            data?: Array<{ name: string; status?: { status: string } }>;
          };
          const status = (name: string) =>
            mcp.data?.find((item) => item.name === name)?.status?.status;
          lastStatuses = `static=${status("static") ?? "absent"}, dynamic=${
            status("dynamic") ?? "absent"
          }`;
          if (status("static") === "failed" || status("dynamic") === "failed") {
            throw new Error(`${label}: MCP connection failed`);
          }
          if (status("static") === "connected") {
            if (optIn && value !== undefined) {
              if (status("dynamic") === "connected" && captured) {
                assert.deepEqual(captured, {
                  path: `/${marker}`,
                  authorization: `Bearer ${marker}`,
                  static: "static",
                });
                console.log(`PASS: ${label}: remote URL and headers received`);
                return;
              }
            } else {
              assert.equal(status("dynamic"), undefined);
              assert.equal(dynamicRequests, 0);
              assert.equal(captured, undefined);
              console.log(`PASS: ${label}: dynamic server was not registered`);
              return;
            }
          }
        }
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException)) {
          throw error;
        }
        // OpenCode has not started listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(
      `${label}: timed out (${lastStatuses}, dynamic requests=${dynamicRequests}, initialize captured=${
        captured !== undefined
      })`,
    );
  } finally {
    try {
      if (child) await stop(child);
    } finally {
      try {
        if (server) await server.shutdown();
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }
  }
}

try {
  if (Deno.env.get(variable) !== undefined) {
    throw new Error(
      "Probe variable is already set; no environment was changed",
    );
  }
  available(mcpPort);
  available(apiPort);
  const opencode = await executable();
  await run(opencode, "opt-in disabled", false, marker);
  await run(opencode, "opt-in enabled with missing variable", true, undefined);
  await run(opencode, "opt-in enabled with dummy variable", true, marker);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Remote env smoke test failed",
  );
  Deno.exitCode = 1;
}
