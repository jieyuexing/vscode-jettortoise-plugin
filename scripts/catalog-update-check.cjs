/*
 * Headless catalog-update guard coverage. Every remote below is a temporary
 * local bare repository; the check never contacts a network host or VS Code.
 */
const assert = require("node:assert/strict");
const child = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return child.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function bundleService(projectRoot, temporary) {
  const entry = path.join(temporary, "entry.ts");
  const output = path.join(temporary, "service.cjs");
  const vscode = path.join(temporary, "vscode.cjs");
  await fs.writeFile(vscode, "exports.l10n = { t: (value) => value };\n");
  await fs.writeFile(entry, `export { GitService } from ${JSON.stringify(path.join(projectRoot, "src/git/gitService.ts"))};\n`);
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: output,
    plugins: [{ name: "vscode", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscode })); } }],
  });
  return require(output).GitService;
}

async function fixture(base) {
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const target = path.join(base, "target");
  const writer = path.join(base, "writer");
  await fs.mkdir(seed);
  git(base, ["init", "--bare", remote]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Catalog Update"]);
  git(seed, ["config", "user.email", "catalog-update@example.invalid"]);
  await fs.writeFile(path.join(seed, "tracked.txt"), "base\n");
  git(seed, ["add", "tracked.txt"]); git(seed, ["commit", "-m", "base"]);
  git(seed, ["remote", "add", "origin", remote]); git(seed, ["push", "-u", "origin", "main"]);
  git(base, ["clone", remote, target]); git(base, ["clone", remote, writer]);
  for (const root of [target, writer]) {
    git(root, ["config", "user.name", "Catalog Update"]);
    git(root, ["config", "user.email", "catalog-update@example.invalid"]);
  }
  return { remote, target, writer };
}

async function addRemoteCommit(f) {
  await fs.writeFile(path.join(f.writer, "tracked.txt"), "remote\n");
  git(f.writer, ["add", "tracked.txt"]); git(f.writer, ["commit", "-m", "remote"]); git(f.writer, ["push"]);
}

async function withFixture(base, fn) {
  const directory = await fs.mkdtemp(path.join(base, "case-"));
  try { return await fn(await fixture(directory)); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-catalog-update-"));
  try {
    const GitService = await bundleService(projectRoot, temporary);
    let checks = 0;

    await withFixture(temporary, async (f) => {
      await addRemoteCommit(f);
      const otherBefore = await fs.readFile(path.join(f.writer, "tracked.txt"), "utf8");
      await new GitService(f.target).updateFastForward();
      assert.equal(await fs.readFile(path.join(f.target, "tracked.txt"), "utf8"), "remote\n");
      assert.equal(await fs.readFile(path.join(f.writer, "tracked.txt"), "utf8"), otherBefore);
      checks += 2;
    });

    for (const change of [
      async (root) => fs.writeFile(path.join(root, "tracked.txt"), "unstaged\n"),
      async (root) => { await fs.writeFile(path.join(root, "tracked.txt"), "staged\n"); git(root, ["add", "tracked.txt"]); },
      async (root) => fs.writeFile(path.join(root, "untracked.txt"), "untracked\n"),
    ]) {
      await withFixture(temporary, async (f) => {
        await addRemoteCommit(f); await change(f.target);
        await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
      });
    }

    await withFixture(temporary, async (f) => {
      git(f.target, ["checkout", "--detach", "HEAD"]);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      git(f.target, ["branch", "--unset-upstream"]);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      await fs.writeFile(path.join(f.target, "local.txt"), "local\n");
      git(f.target, ["add", "local.txt"]); git(f.target, ["commit", "-m", "local"]);
      await addRemoteCommit(f);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      const marker = git(f.target, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
      await fs.writeFile(path.resolve(f.target, marker), "deadbeef\n");
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      const childRoot = path.join(f.target, "nested");
      await fs.mkdir(childRoot); git(childRoot, ["init", "-b", "main"]);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      let calls = 0;
      await assert.rejects(() => new GitService(f.target).updateFastForward(async () => {
        calls += 1;
        if (calls === 2) throw new Error("repository root changed while queued");
      }));
      assert.equal(calls, 2); checks += 2;
    });
    await withFixture(temporary, async (f) => {
      await addRemoteCommit(f);
      const controller = new AbortController(); controller.abort();
      await assert.rejects(() => new GitService(f.target).updateFastForward(undefined, controller.signal));
      assert.equal(await fs.readFile(path.join(f.target, "tracked.txt"), "utf8"), "base\n"); checks += 2;
    });
    console.log(JSON.stringify({ checks, command: "pull --ff-only --no-rebase --no-autostash --no-recurse-submodules" }));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
