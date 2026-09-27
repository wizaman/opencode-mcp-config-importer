// Manual OAuth fixture; not run by deno test or CI.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = join(root, "temp", "example-remote-server");
const repository =
  "https://github.com/modelcontextprotocol/example-remote-server.git";
const revision = "ca6133a4e63d22e2c035defa691d241ce22296a9";
const port = 3232;
const endpoint = `http://127.0.0.1:${port}`;
const decoder = new TextDecoder();

async function command(executable: string, args: string[], cwd = root) {
  const result = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${executable} ${args[0]} failed:\n${decoder.decode(result.stderr)}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

async function prepare() {
  try {
    await Deno.stat(checkout);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    await Deno.mkdir(dirname(checkout), { recursive: true });
    await command("git", ["clone", "--filter=blob:none", repository, checkout]);
    await command("git", ["switch", "--detach", revision], checkout);
  }

  const top = await command("git", ["rev-parse", "--show-toplevel"], checkout);
  if (resolve(top).toLowerCase() !== resolve(checkout).toLowerCase()) {
    throw new Error(
      "Existing fixture directory is not the expected Git checkout",
    );
  }
  const head = await command("git", ["rev-parse", "HEAD"], checkout);
  if (head !== revision) {
    throw new Error(
      `Fixture is at ${head}, expected ${revision}; refusing to change it`,
    );
  }
  const changes = await command(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    checkout,
  );
  if (changes) throw new Error("Fixture has tracked changes; refusing to run");

  // The first install migrates the pinned package-lock.json into bun.lock.
  const lock = join(checkout, "bun.lock");
  let frozen = false;
  try {
    await Deno.stat(lock);
    frozen = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  console.log(`Installing dependencies for ${revision.slice(0, 12)} with Bun`);
  const install = new Deno.Command("bun", {
    args: frozen ? ["install", "--frozen-lockfile"] : ["install"],
    cwd: checkout,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!(await install.output()).success) throw new Error("bun install failed");
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
  let listener: Deno.TcpListener;
  try {
    listener = Deno.listen({ hostname: "127.0.0.1", port });
  } catch {
    throw new Error(
      `Port ${port} is already in use; no existing process was stopped`,
    );
  }
  listener.close();
  await prepare();

  const child = new Deno.Command("bun", {
    args: ["run", "src/index.ts"],
    cwd: checkout,
    env: { AUTH_MODE: "internal" },
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  let running = true;
  const status = child.status.then((result) => {
    running = false;
    return result;
  });
  let interruptedFlag = false;
  let interrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => interrupt = resolve);
  const onInterrupt = () => {
    interruptedFlag = true;
    interrupt();
  };
  Deno.addSignalListener("SIGINT", onInterrupt);
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !interruptedFlag) {
      if (!running) throw new Error("OAuth server exited during startup");
      try {
        const response = await fetch(
          `${endpoint}/.well-known/oauth-authorization-server`,
          {
            signal: AbortSignal.timeout(1000),
          },
        );
        if (response.ok) {
          ready = true;
          break;
        }
      } catch { /* Server is still starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (interruptedFlag) return;
    if (!ready) throw new Error("OAuth server did not start within 30 seconds");
    console.log(`OAuth fixture ready at http://localhost:${port}/mcp`);
    console.log(
      "Authenticate in OpenCode via /mcps; press Ctrl+C to stop this server.",
    );
    const finished = await Promise.race([
      status.then((result) => ({ type: "exit" as const, status: result })),
      interrupted.then(() => ({ type: "interrupt" as const })),
    ]);
    if (finished.type === "exit") {
      if (!finished.status.success) {
        throw new Error("OAuth server exited unexpectedly");
      }
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onInterrupt);
    if (running) await stop(child);
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "OAuth fixture failed",
  );
  Deno.exitCode = 1;
}
