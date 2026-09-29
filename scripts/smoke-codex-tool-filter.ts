// Manual, local-only OpenCode V2 integration check. Uses an isolated Codex config.
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const port = 4097;
const mcpPort = 3001;
const modelPort = 4098;
const decoder = new TextDecoder();

async function executable() {
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
    child.kill("SIGTERM");
  }
  await child.status;
}

const listener = Deno.listen({ hostname: host, port });
listener.close();
const mcpListener = Deno.listen({ hostname: host, port: mcpPort });
mcpListener.close();
const modelListener = Deno.listen({ hostname: host, port: modelPort });
modelListener.close();
const opencode = await executable();
const directory = await Deno.makeTempDir({ prefix: "codex-tool-filter-" });
let child: Deno.ChildProcess | undefined;
let remote: Deno.ChildProcess | undefined;
let modelServer: Deno.HttpServer | undefined;
try {
  const snapshot = join(directory, "tools.json");
  const rebuilds = join(directory, "rebuilds.txt");
  const pluginModule = pathToFileURL(join(
    root,
    "node_modules/@opencode/plugin/dist/promise/index.js",
  )).href;
  const serverArgs = [
    "run",
    "-A",
    "--no-config",
    "--node-modules-dir=none",
    "npm:@modelcontextprotocol/server-everything/dist/index.js",
  ];
  await Deno.mkdir(join(directory, ".codex"));
  await Deno.writeTextFile(
    join(directory, ".codex", "config.toml"),
    `
[mcp_servers.filter-stdio]
command = "deno"
args = ${JSON.stringify(serverArgs)}
enabled_tools = ["echo", "get-tiny-image"]
disabled_tools = ["get-tiny-image"]
[mcp_servers.filter-remote]
url = "http://${host}:${mcpPort}/mcp"
enabled_tools = ["echo", "get-tiny-image"]
disabled_tools = ["get-tiny-image"]
[mcp_servers.baseline-stdio]
command = "deno"
args = ${JSON.stringify(serverArgs)}
[mcp_servers.native]
command = "codex-would-override"
disabled_tools = ["echo"]
[mcp_servers."collision.one"]
command = "codex-would-collide"
disabled_tools = ["echo"]
`,
  );
  await Deno.mkdir(join(directory, "probe"));
  await Deno.writeTextFile(
    join(directory, "probe", "index.mjs"),
    `
import { Plugin } from ${JSON.stringify(pluginModule)};
import { writeFileSync } from "node:fs";
export default Plugin.define({
  id: "codex-tool-filter-observer",
  async setup(ctx) {
    let rebuilds = 0;
    await ctx.tool.transform(() => {
      writeFileSync(${JSON.stringify(rebuilds)}, String(++rebuilds));
    });
    const timer = setInterval(() => {
      void ctx.tool.list().then((tools) => {
        writeFileSync(${
      JSON.stringify(snapshot)
    }, JSON.stringify(tools.map((tool) => tool.id)));
      });
    }, 250);
    return () => clearInterval(timer);
  },
});
`,
  );
  await Deno.writeTextFile(
    join(directory, "opencode.jsonc"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugins: [
        { package: join(root, "src"), options: { sources: ["codex"] } },
        { package: join(directory, "probe") },
      ],
      mcp: {
        servers: {
          native: { type: "local", command: ["deno", ...serverArgs] },
          collision_one: { type: "local", command: ["deno", ...serverArgs] },
        },
      },
      model: "probe/model",
      providers: {
        probe: {
          name: "Local probe",
          env: ["ADAPTER_FAKE_MODEL_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://${host}:${modelPort}/v1` },
          models: { model: { name: "Local probe" } },
        },
      },
    }),
  );
  const git = await new Deno.Command("git", {
    args: ["init", "--quiet"],
    cwd: directory,
    stdout: "null",
    stderr: "null",
  }).output();
  assert(git.success);
  const requests: Array<{ tools: string[]; messages: unknown[] }> = [];
  modelServer = Deno.serve(
    { hostname: host, port: modelPort, onListen() {} },
    async (request) => {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response(null, { status: 404 });
      }
      const input = await request.json() as {
        tools?: Array<{ function?: { name?: string } }>;
        messages?: unknown[];
      };
      requests.push({
        tools: input.tools?.map((item) => item.function?.name ?? "") ?? [],
        messages: input.messages ?? [],
      });
      const toolCalls = requests.filter((item) =>
        item.tools.includes("execute")
      )
        .length;
      const attempting = requests.at(-1)?.tools.includes("execute") &&
        toolCalls <= 2;
      const target = toolCalls === 1 ? "filter-stdio" : "filter-remote";
      const delta = attempting
        ? {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: `call_probe_${toolCalls}`,
            type: "function",
            function: {
              name: "execute",
              arguments: JSON.stringify({
                code: `return await tools[${
                  JSON.stringify(target)
                }]["get-tiny-image"]()`,
              }),
            },
          }],
        }
        : { role: "assistant", content: "probe finished" };
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${
          JSON.stringify({
            id: "chatcmpl-probe",
            object: "chat.completion.chunk",
            created: 1,
            model: "model",
            choices: [{ index: 0, delta, finish_reason }],
          })
        }\n\n`;
      return new Response(
        `${chunk(delta, null)}${
          chunk({}, attempting ? "tool_calls" : "stop")
        }data: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  remote = new Deno.Command("deno", {
    args: [...serverArgs, "streamableHttp"],
    cwd: root,
    stdin: "null",
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const password = crypto.randomUUID();
  child = new Deno.Command(opencode, {
    args: ["serve", "--hostname", host, "--port", String(port)],
    cwd: directory,
    env: {
      OPENCODE_PASSWORD: password,
      ADAPTER_FAKE_MODEL_KEY: "dummy-local-probe",
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
    },
    stdin: "null",
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const auth = { Authorization: `Basic ${btoa(`opencode:${password}`)}` };
  const getStatus = async () => {
    const response = await fetch(`http://${host}:${port}/api/mcp`, {
      headers: auth,
      signal: AbortSignal.timeout(2000),
    });
    assert(response.ok, `MCP API failed: ${response.status}`);
    const mcp = await response.json() as {
      data?: Array<{ name: string; status?: { status: string } }>;
    };
    return new Map(mcp.data?.map((item) => [item.name, item.status?.status]));
  };
  const deadline = Date.now() + 60_000;
  let lastStatus = "no response";
  while (Date.now() < deadline) {
    try {
      const status = await getStatus();
      {
        lastStatus = JSON.stringify([...status]);
        if (!status.size) {
          const plugins = await fetch(`http://${host}:${port}/api/plugin`, {
            headers: auth,
          });
          const info = await plugins.json() as {
            data?: Array<{ id: string; state?: { status: string } }>;
          };
          lastStatus += ` observer=${
            JSON.stringify(
              info.data?.find((item) =>
                item.id === "codex-tool-filter-observer"
              ),
            )
          }`;
        }
        if ([...status.values()].includes("failed")) {
          throw new Error(
            `MCP connection failed: ${JSON.stringify([...status])}`,
          );
        }
        if (
          status.get("filter-stdio") === "connected" &&
          status.get("filter-remote") === "connected" &&
          status.get("baseline-stdio") === "connected" &&
          status.get("native") === "connected" &&
          status.get("collision_one") === "connected"
        ) {
          const tools = JSON.parse(
            await Deno.readTextFile(snapshot),
          ) as string[];
          const stdio = tools.filter((id) => id.startsWith("filter-stdio_"));
          const http = tools.filter((id) => id.startsWith("filter-remote_"));
          const baseline = tools.filter((id) =>
            id.startsWith("baseline-stdio_")
          );
          const native = tools.filter((id) => id.startsWith("native_"));
          const collision = tools.filter((id) =>
            id.startsWith("collision_one_")
          );
          if (
            !stdio.length || !http.length || !baseline.length ||
            !native.length || !collision.length
          ) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          assert.deepEqual(stdio, ["filter-stdio_echo"]);
          assert.deepEqual(http, ["filter-remote_echo"]);
          assert(baseline.length > 1, "Unfiltered baseline was lost");
          assert(native.length > 1 && native.includes("native_echo"));
          assert(
            collision.length > 1 && collision.includes("collision_one_echo"),
          );
          assert.equal(status.has("collision.one"), false);
          console.log(
            "PASS: stdio/HTTP retain only echo; native and colliding servers unchanged",
          );
          break;
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("MCP connection failed") ||
          error instanceof assert.AssertionError)
      ) throw error;
      lastStatus = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out waiting for MCP tools: ${lastStatus}`);
  }
  const sessionResponse = await fetch(`http://${host}:${port}/api/session`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: { providerID: "probe", id: "model" } }),
  });
  if (!sessionResponse.ok) {
    throw new Error(
      `Could not create probe session: ${await sessionResponse.text()}`,
    );
  }
  const session = await sessionResponse.json() as { data: { id: string } };
  const promptResponse = await fetch(
    `http://${host}:${port}/api/session/${session.data.id}/prompt`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Check the isolated MCP tool registry." }),
    },
  );
  if (!promptResponse.ok) {
    throw new Error(`Probe prompt failed: ${await promptResponse.text()}`);
  }
  const modelDeadline = Date.now() + 30_000;
  while (
    !requests.some((request) =>
      request.messages.some((message) =>
        JSON.stringify(message).includes("call_probe_2") &&
        JSON.stringify(message).includes("Unknown tool")
      )
    ) && Date.now() < modelDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(
    requests.length >= 2,
    "Code Mode tool call did not return to local model",
  );
  assert(
    requests.some((request) => request.tools.includes("execute")),
    `Code Mode was not available: ${
      JSON.stringify(requests.map((request) => request.tools))
    }`,
  );
  const codeRequest = requests.find((request) =>
    request.tools.includes("execute")
  );
  assert(codeRequest);
  assert(
    !codeRequest.tools.includes("filter-stdio_get-tiny-image"),
    "Excluded tool was sent to model",
  );
  const continuation = requests.at(-1)?.messages ?? [];
  for (const server of ["filter-stdio", "filter-remote"]) {
    assert(
      continuation.some((message) => {
        const tool = message as { role?: string; content?: string };
        return tool.role === "tool" &&
          tool.content?.includes(`Unknown tool '${server}.get-tiny-image'`);
      }),
      `${server} excluded tool was not rejected by Code Mode`,
    );
  }
  console.log("PASS: Code Mode rejects excluded stdio and HTTP tools");
  for (const server of ["filter-stdio", "filter-remote"]) {
    const previousBuilds = Number(await Deno.readTextFile(rebuilds));
    for (const action of ["disconnect", "connect"]) {
      const response = await fetch(
        `http://${host}:${port}/api/experimental/mcp/${server}/${action}`,
        { method: "POST", headers: auth, signal: AbortSignal.timeout(15000) },
      );
      assert(response.ok, `${server} ${action} failed: ${response.status}`);
    }
    const until = Date.now() + 30_000;
    let refreshed = false;
    while (Date.now() < until) {
      const status = await getStatus();
      if (status.get(server) === "failed") {
        throw new Error(`${server} failed to reconnect`);
      }
      const builds = Number(await Deno.readTextFile(rebuilds));
      const tools = JSON.parse(await Deno.readTextFile(snapshot)) as string[];
      const serverTools = tools.filter((id) => id.startsWith(`${server}_`));
      if (
        status.get(server) === "connected" && builds > previousBuilds &&
        serverTools.length
      ) {
        assert.deepEqual(serverTools, [
          `${server}_echo`,
        ]);
        refreshed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert(refreshed, `${server} did not refresh its filtered catalog`);
    console.log(`PASS: ${server} reconnect retained tool filter`);
  }
} catch (error) {
  console.error("Probe failed:", error);
  throw error;
} finally {
  if (child) {
    try {
      await stop(child);
    } catch (error) {
      console.error("Could not stop OpenCode process:", error);
      Deno.exitCode = 1;
    }
  }
  if (remote) await stop(remote);
  if (modelServer) await modelServer.shutdown();
  await Deno.remove(directory, { recursive: true });
}
