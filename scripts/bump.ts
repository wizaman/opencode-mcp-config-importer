// Bump is a version-editing task, not a publication operation.
const kind = Deno.args[0];
if (Deno.args.length !== 1 || !["patch", "minor", "major"].includes(kind)) {
  throw new Error("Usage: deno task bump <patch|minor|major>");
}

async function git(...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args[0]} failed: ${
        new TextDecoder().decode(result.stderr).trim()
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

if (await git("status", "--porcelain", "--untracked-files=all")) {
  throw new Error("Working tree must be clean");
}
if (await git("branch", "--show-current") !== "main") {
  throw new Error("Run bump from main");
}
await git("fetch", "origin", "main");
if (
  await git("rev-parse", "HEAD") !==
    await git("rev-parse", "refs/remotes/origin/main")
) {
  throw new Error("main must be synchronized with origin/main");
}

const packageText = await Deno.readTextFile("package.json");
const { version } = JSON.parse(packageText);
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z.-]+)?$/.exec(
  version,
);
if (!match) throw new Error(`Unsupported version: ${version}`);
const [major, minor, patch] = match.slice(1, 4).map(Number);
const prerelease = version.includes("-");
const next = kind === "major"
  ? `${prerelease && minor === 0 && patch === 0 ? major : major + 1}.0.0`
  : kind === "minor"
  ? `${major}.${prerelease && patch === 0 ? minor : minor + 1}.0`
  : `${major}.${minor}.${prerelease ? patch : patch + 1}`;
const branch = `chore/bump-v${next}`;
if (await git("branch", "--list", branch)) {
  throw new Error(`Branch already exists: ${branch}`);
}

await git("switch", "-c", branch);
const updated = packageText.replace(
  /("version"\s*:\s*")[^"]+(?=")/,
  (_match, prefix: string) => `${prefix}${next}`,
);
await Deno.writeTextFile("package.json", updated);
await git("add", "--", "package.json");
await git("commit", "-m", `chore: bump version to v${next}`);
console.log(`${branch} created. Push it and open a PR to main.`);
