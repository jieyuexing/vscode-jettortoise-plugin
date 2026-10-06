/* Metadata-only recursive catalog discovery and v1/v2 persistence checks. */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) { return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }); }
async function gitRoot(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]); git(root, ["config", "user.name", "Fixture"]); git(root, ["config", "user.email", "fixture@example.invalid"]);
  return fs.realpath(root);
}
async function main() {
  const project = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-catalog-"));
  try {
    const outer = await gitRoot(path.join(temp, "platform"));
    const nested = await gitRoot(path.join(outer, "ignored-looking", "node_modules", "child"));
    const worktree = path.join(outer, "worktree-pointer");
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(path.join(temp, "pointer-store"), { recursive: true });
    await fs.mkdir(path.join(temp, "pointer-store", "objects"));
    await fs.writeFile(path.join(temp, "pointer-store", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, path.join(temp, "pointer-store"))}\n`);
    const cvsRoot = path.join(outer, "legacy");
    const cvsChild = path.join(cvsRoot, "same-copy");
    for (const [dir, repository, entries] of [[cvsRoot, "legacy", "D/same-copy////\n"], [cvsChild, "legacy/same-copy", ""]]) {
      await fs.mkdir(path.join(dir, "CVS"), { recursive: true });
      await fs.writeFile(path.join(dir, "CVS", "Root"), ":local:/fixture\n");
      await fs.writeFile(path.join(dir, "CVS", "Repository"), `${repository}\n`);
      await fs.writeFile(path.join(dir, "CVS", "Entries"), entries);
      if (dir === cvsRoot) await fs.writeFile(path.join(dir, "CVS", "Tag"), "Trelease-1\n");
    }
    const independent = path.join(outer, "other-copy");
    await fs.mkdir(path.join(independent, "CVS"), { recursive: true });
    await fs.writeFile(path.join(independent, "CVS", "Root"), ":local:/other\n");
    await fs.writeFile(path.join(independent, "CVS", "Repository"), "other\n");
    await fs.writeFile(path.join(independent, "CVS", "Entries"), "");
    await fs.symlink(temp, path.join(outer, "loop"));
    const alias = path.join(temp, "platform-alias");
    await fs.symlink(outer, alias);

    const bundle = path.join(temp, "discovery.cjs");
    const source = await fs.readFile(path.join(project, "src/repositories/discovery.ts"), "utf8");
    assert(!/child_process|execFile|git\s+-C/.test(source), "discovery shell process was introduced");
    await esbuild.build({ entryPoints: [path.join(project, "src/repositories/discovery.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle });
    const { discoverRepositoryRoots } = require(bundle);
    const result = await discoverRepositoryRoots(outer, { concurrency: 3 });
    const discovered = new Set(result.roots.map((item) => `${item.kind}:${item.root}`));
    assert(discovered.has(`git:${outer}`));
    assert(discovered.has(`git:${nested}`));
    assert(discovered.has(`git:${await fs.realpath(worktree)}`));
    assert(discovered.has(`cvs:${await fs.realpath(cvsRoot)}`));
    assert(discovered.has(`cvs:${await fs.realpath(independent)}`));
    assert(!discovered.has(`cvs:${await fs.realpath(cvsChild)}`), "continuous CVS directory became an independent root");
    assert.equal(result.incomplete, false);
    const refs = new Map(result.roots.map((item) => [`${item.kind}:${item.root}`, item.ref]));
    assert.equal(refs.get(`git:${outer}`), "main");
    assert.equal(refs.get(`cvs:${await fs.realpath(cvsRoot)}`), "Trelease-1");
    const aliasResult = await discoverRepositoryRoots(alias, { concurrency: 2 });
    assert.deepEqual(
      new Set(aliasResult.roots.map((item) => `${item.kind}:${item.root}`)),
      discovered,
      "workspace symlink alias produced different canonical roots",
    );

    const controller = new AbortController(); controller.abort();
    const cancelled = await discoverRepositoryRoots(outer, { signal: controller.signal });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.incomplete, true);
    const fsPromises = require("node:fs/promises");
    const originalLstat = fsPromises.lstat;
    fsPromises.lstat = async (target, ...args) => {
      if (target === path.join(outer, ".git", "HEAD")) {
        const error = new Error("permission denied"); error.code = "EACCES"; throw error;
      }
      return originalLstat(target, ...args);
    };
    try {
      const denied = await discoverRepositoryRoots(outer);
      assert.equal(denied.incomplete, true, "metadata permission failure was treated as an absent repository");
      assert(denied.errors.some((item) => item.includes(outer)), "permission failure did not identify its unreadable subtree");
    } finally { fsPromises.lstat = originalLstat; }
    console.log(JSON.stringify({ checks: 14, roots: result.roots.length, metadataOnly: true, cancellation: true, permissionIncomplete: true }));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
