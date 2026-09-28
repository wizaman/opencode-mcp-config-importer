// Manual, local-only check; excluded from deno test and CI. Uses no real secrets.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const mcpPort = 3001;
const apiPort = 4097;
const variable = "ADAPTER_ENV_HEADER_PROBE";
const bearerVariable = "ADAPTER_BEARER_HEADER_PROBE";
const marker = "dummy-env-header-value";
const decoder = new TextDecoder();

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
    if (!result.success) {
      throw new Error(`Could not stop process tree ${child.pid}`);
    }
  } else {
    child.kill("SIGTERM");
  }
  await child.status;
}

async function run(
  opencode: string,
  label: string,
  value: string | undefined,
  expected: { fallback: string; only: string | null },
) {
  const temp = Deno.build.os === "windows"
    ? join(Deno.env.get("LOCALAPPDATA")!, "Temp", "opencode")
    : undefined;
  const directory = await Deno.makeTempDir({ dir: temp, prefix: "mcp-env-" });
  let captured: { fallback: string | null; only: string | null } | undefined;
  let bearerCaptured: string | null | undefined;
  let server: Deno.HttpServer | undefined;
  let child: Deno.ChildProcess | undefined;
  try {
    await Deno.mkdir(join(directory, ".codex"));
    await Deno.writeTextFile(
      join(directory, ".codex", "config.toml"),
      await Deno.readTextFile(
        new URL(
          "../tests/fixtures/env-headers/.codex/config.toml",
          import.meta.url,
        ),
      ),
    );
    await Deno.writeTextFile(
      join(directory, "opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: [{
          package: join(root, "src"),
          options: { sources: ["codex"], allowCodexEnvHttpHeaders: true },
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
        if (new URL(request.url).pathname !== "/mcp") {
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
        if (message.method === "initialize") {
          if (request.headers.get("X-Probe") === "bearer") {
            bearerCaptured = request.headers.get("Authorization");
          } else {
            captured = {
              fallback: request.headers.get("X-Fallback"),
              only: request.headers.get("X-Only-Env"),
            };
          }
        }
        if (message.id === undefined) {
          return new Response(null, { status: 202 });
        }
        const result = message.method === "initialize"
          ? {
            protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "env-headers-check", version: "1.0.0" },
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
        ...(value === undefined ? {} : { [bearerVariable]: value }),
      },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const auth = { Authorization: `Basic ${btoa(`opencode:${password}`)}` };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      let response: Response;
      try {
        response = await fetch(`http://${host}:${apiPort}/api/mcp`, {
          headers: auth,
          signal: AbortSignal.timeout(2000),
        });
      } catch {
        // OpenCode has not started listening yet.
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      if (response.ok) {
        const mcpText = await response.text();
        assert(!mcpText.includes(marker), "dummy value exposed in MCP API");
        const mcp = JSON.parse(mcpText) as {
          data?: Array<{ name: string; status?: { status: string } }>;
        };
        const status = mcp.data?.find((item) => item.name === "env-probe")
          ?.status?.status;
        const bearerStatus = mcp.data?.find((item) =>
          item.name === "bearer-probe"
        )
          ?.status?.status;
        if (status === "failed") throw new Error("env-probe connection failed");
        if (bearerStatus === "failed") {
          throw new Error("bearer-probe connection failed");
        }
        if (
          status === "connected" && captured &&
          (value === undefined || !value.trim()
            ? bearerStatus === undefined
            : bearerStatus === "connected" && bearerCaptured !== undefined)
        ) {
          assert.deepEqual(
            captured,
            expected,
            `${label}: unexpected received headers`,
          );
          if (value !== undefined && value.trim()) {
            assert.equal(bearerCaptured, `Bearer ${value}`);
          }
          const config = await fetch(`http://${host}:${apiPort}/api/config`, {
            headers: auth,
            signal: AbortSignal.timeout(2000),
          });
          assert(config.ok, "OpenCode configuration API failed");
          assert(
            !(await config.text()).includes(marker),
            "dummy value exposed in config API",
          );
          console.log(`PASS: ${label}: env and bearer headers match`);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`${label}: timed out waiting for env-probe to connect`);
  } finally {
    if (child) await stop(child);
    if (server) await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}

try {
  if (
    Deno.env.get(variable) !== undefined ||
    Deno.env.get(bearerVariable) !== undefined
  ) {
    throw new Error(
      `A probe environment variable is already set; no existing environment was changed`,
    );
  }
  available(mcpPort);
  available(apiPort);
  const opencode = await executable();
  for (
    const [label, value, expected] of [
      ["missing", undefined, { fallback: "static-fallback", only: null }],
      ["empty", "", { fallback: "static-fallback", only: null }],
      ["whitespace", "  ", { fallback: "static-fallback", only: null }],
      ["populated", marker, { fallback: marker, only: marker }],
    ] as const
  ) await run(opencode, label, value, expected);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Env header smoke test failed",
  );
  Deno.exitCode = 1;
}
