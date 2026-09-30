// Manual, local-only integration check. Deliberately not discovered by deno test.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const mcpPort = 3001;
const apiPort = 4097;
const api = `http://${host}:${apiPort}`;
const pluginID = "opencode-mcp-config-importer";
const decoder = new TextDecoder();
const children: Deno.ChildProcess[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function available(port: number): void {
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
  throw new Error(
    "OpenCode V2 executable not found (tried opencode2, then opencode)",
  );
}

function start(
  command: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const child = new Deno.Command(command, {
    args,
    cwd: root,
    env,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  children.push(child);
  return child;
}

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function get(path: string, password: string): Promise<unknown> {
  const response = await fetch(`${api}${path}`, {
    headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}` },
    signal: AbortSignal.timeout(2000),
  });
  assert(response.ok, `OpenCode ${path} returned HTTP ${response.status}`);
  return response.json();
}

async function stop(child: Deno.ChildProcess) {
  if (Deno.build.os === "windows") {
    // Windows shims (including opencode2 and deno) can spawn another process.
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

try {
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../.mcp.json", import.meta.url)),
  );
  assert(
    config.mcpServers?.["everything-remote"]?.url ===
      `http://localhost:${mcpPort}/mcp`,
    `.mcp.json must define everything-remote at http://localhost:${mcpPort}/mcp`,
  );
  assert(
    config.mcpServers?.["everything-stdio"]?.command,
    "everything-stdio is missing",
  );
  const opencode = await executable();
  available(mcpPort);
  available(apiPort);
  start("deno", [
    "run",
    "-A",
    "--no-config",
    "--node-modules-dir=none",
    "npm:@modelcontextprotocol/server-everything/dist/index.js",
    "streamableHttp",
  ]);
  await waitFor(async () => {
    try {
      const response = await fetch(`http://${host}:${mcpPort}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(1000),
      });
      return response.status !== 404;
    } catch {
      return false;
    }
  }, "Everything HTTP server");

  const password = crypto.randomUUID();
  start(opencode, ["serve", "--hostname", host, "--port", String(apiPort)], {
    OPENCODE_PASSWORD: password,
  });
  await waitFor(async () => {
    try {
      const location = await get("/api/location", password) as {
        directory?: string;
      };
      assert(
        location.directory?.toLowerCase() ===
          root.replace(/\/$/, "").toLowerCase(),
        "OpenCode loaded a different project directory",
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error && error.message.includes("different project")
      ) throw error;
      return false;
    }
  }, "OpenCode V2");

  await waitFor(async () => {
    const mcp = await get("/api/mcp", password) as {
      data?: Array<{ name: string; status?: { status: string } }>;
    };
    const servers = new Map(
      mcp.data?.map((item) => [item.name, item.status?.status]),
    );
    if (!servers.has("everything-remote") || !servers.has("everything-stdio")) {
      return false;
    }
    const plugins = await get("/api/plugin", password) as {
      data?: Array<{ id: string; state?: { status: string } }>;
    };
    const plugin = plugins.data?.find((item) => item.id === pluginID);
    if (plugin?.state?.status !== "active") return false;
    if (servers.get("everything-remote") === "failed") {
      throw new Error("everything-remote connection failed");
    }
    return servers.get("everything-remote") === "connected" &&
      servers.get("everything-stdio") === "connected";
  }, "both Everything servers to connect");
  console.log(
    `PASS: ${pluginID} active; everything-stdio and everything-remote connected`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Smoke test failed");
  Deno.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    try {
      await stop(child);
    } catch {
      console.error(
        `Could not stop started process ${child.pid}; check it manually`,
      );
      Deno.exitCode = 1;
    }
  }
}
