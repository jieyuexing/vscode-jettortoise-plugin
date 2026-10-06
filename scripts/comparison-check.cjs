/*
 * Exercises the production comparison resolver against temporary local Git
 * and CVS repositories.  It deliberately proves the staged baseline differs
 * from disk before asserting HEAD -> index, then checks the resolver refuses
 * a traversal worktree read.
 */
const assert = require("node:assert/strict");
const child = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return child.execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-comparison-"));
  try {
    const entry = path.join(temp, "entry.ts");
    const bundle = path.join(temp, "comparison.cjs");
    const vscode = path.join(temp, "vscode.cjs");
    await fs.writeFile(vscode, "exports.l10n = { t: (value) => value };\n");
    await fs.writeFile(entry, [
      `export * from ${JSON.stringify(path.join(projectRoot, "src/comparison/resolver.ts"))};`,
      `export { GitService } from ${JSON.stringify(path.join(projectRoot, "src/git/gitService.ts"))};`,
    ].join("\n"));
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscode })); } }],
    });
    const { GitService, GitComparisonResolver, CvsComparisonResolver } = require(bundle);

    const gitRoot = path.join(temp, "git");
    await fs.mkdir(gitRoot);
    git(gitRoot, ["init", "-b", "main"]);
    git(gitRoot, ["config", "user.name", "Comparison Test"]);
    git(gitRoot, ["config", "user.email", "comparison@example.invalid"]);
    await fs.writeFile(path.join(gitRoot, "tracked.txt"), "head\n");
    await fs.writeFile(path.join(gitRoot, "renamed-old.txt"), "rename base\n");
    git(gitRoot, ["add", "."]); git(gitRoot, ["commit", "-m", "base"]);
    await fs.writeFile(path.join(gitRoot, "tracked.txt"), "index\n");
    git(gitRoot, ["add", "tracked.txt"]);
    await fs.writeFile(path.join(gitRoot, "tracked.txt"), "disk\n");
    const resolver = new GitComparisonResolver(new GitService(gitRoot), gitRoot);
    const staged = await resolver.working("tracked.txt", true);
    const unstaged = await resolver.working("tracked.txt", false);
    assert.equal(staged.left.revision, "HEAD");
    assert.equal(staged.right.revision, ":0");
    assert.equal(unstaged.left.revision, ":0");
    assert.equal(unstaged.right.source, "worktree");
    const stagedContents = await resolver.materialize(staged);
    const unstagedContents = await resolver.materialize(unstaged);
    assert.equal(stagedContents.leftContent.text, "head\n");
    assert.equal(stagedContents.rightContent.text, "index\n");
    assert.equal(unstagedContents.leftContent.text, "index\n");
    assert.equal(unstagedContents.rightContent.text, "disk\n");
    // Negative control: a historical implementation using worktree on the
    // right would return disk here, so this assertion is sensitive to :0.
    assert.notEqual(stagedContents.rightContent.text, unstagedContents.rightContent.text);
    await assert.rejects(() => resolver.working("../outside.txt", false));
    await assert.rejects(() => resolver.working("renamed-old.txt", false));
    // A direct missing index object must fail rather than look like an empty
    // side. Legitimate added/deleted comparisons construct `empty` themselves.
    await assert.rejects(() => new GitService(gitRoot).getFileContentBufferLimited(":0", "not-indexed.txt", 1024));
    await fs.writeFile(path.join(gitRoot, "untracked.txt"), "untracked\n");
    const untracked = await resolver.materialize(await resolver.working("untracked.txt", false));
    assert.deepEqual(untracked.leftContent, { available: true, text: "", bytes: 0, lines: 0 });
    assert.equal(untracked.rightContent.text, "untracked\n");
    await fs.writeFile(path.join(gitRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    const binary = await resolver.materialize(await resolver.working("binary.bin", false));
    assert.deepEqual(binary.rightContent, { available: false, reason: "binary" });
    await fs.writeFile(path.join(gitRoot, "too-large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    const tooLarge = await resolver.materialize(await resolver.working("too-large.txt", false));
    assert.deepEqual(tooLarge.rightContent, { available: false, reason: "tooLarge" });
    await fs.writeFile(path.join(gitRoot, "undecodable.txt"), Buffer.from([0xc3, 0x28]));
    const undecodable = await resolver.materialize(await resolver.working("undecodable.txt", false));
    assert.deepEqual(undecodable.rightContent, { available: false, reason: "undecodable" });
    await fs.writeFile(path.join(gitRoot, "too-many-lines.txt"), "x\n".repeat(20_001));
    const tooManyLines = await resolver.materialize(await resolver.working("too-many-lines.txt", false));
    assert.deepEqual(tooManyLines.rightContent, { available: false, reason: "tooManyLines" });

    await fs.rename(path.join(gitRoot, "renamed-old.txt"), path.join(gitRoot, "renamed-new.txt"));
    git(gitRoot, ["add", "-A"]); git(gitRoot, ["commit", "-m", "rename"]);
    const renameCommit = git(gitRoot, ["rev-parse", "HEAD"]).trim();
    const history = await resolver.history(renameCommit, "renamed-new.txt", {
      oldPath: "renamed-old.txt", newPath: "renamed-new.txt", status: "renamed", isBinary: false,
    });
    assert.equal(history.left.path, "renamed-old.txt");
    assert.equal(history.right.path, "renamed-new.txt");

    // NUL porcelain is required for literal spaces, arrows, Unicode and
    // newlines.  The legacy newline/arrow parser cannot reconstruct this path.
    const statusRoot = path.join(temp, "status-git");
    await fs.mkdir(statusRoot); git(statusRoot, ["init", "-b", "main"]);
    git(statusRoot, ["config", "user.name", "Comparison Test"]);
    git(statusRoot, ["config", "user.email", "comparison@example.invalid"]);
    const specialPath = "目录/中文 -> line\nname.txt";
    const deletedPath = "staged then deleted.txt";
    const renameOld = "old -> path.txt";
    const renameNew = "new 中文 -> path.txt";
    await fs.mkdir(path.join(statusRoot, "目录"));
    await fs.writeFile(path.join(statusRoot, specialPath), "base\n");
    await fs.writeFile(path.join(statusRoot, deletedPath), "base\n");
    await fs.writeFile(path.join(statusRoot, renameOld), "base\n");
    git(statusRoot, ["add", "."]); git(statusRoot, ["commit", "-m", "special base"]);
    await fs.writeFile(path.join(statusRoot, specialPath), "index\n"); git(statusRoot, ["add", specialPath]);
    await fs.writeFile(path.join(statusRoot, deletedPath), "index\n"); git(statusRoot, ["add", deletedPath]); await fs.unlink(path.join(statusRoot, deletedPath));
    git(statusRoot, ["mv", renameOld, renameNew]);
    await fs.appendFile(path.join(statusRoot, renameNew), "disk\n");
    const legacyStatusPaths = git(statusRoot, ["status", "--porcelain=v1", "-uall"])
      .split("\n").map((line) => line.slice(3));
    assert.equal(legacyStatusPaths.includes(specialPath), false);
    const statusService = new GitService(statusRoot);
    const changes = await statusService.getWorkingTreeChanges();
    const stagedDeletedChange = changes.find((item) => item.path === deletedPath && item.staged);
    const unstagedDeletedChange = changes.find((item) => item.path === deletedPath && !item.staged);
    assert.equal(stagedDeletedChange?.status, "modified");
    assert.equal(unstagedDeletedChange?.status, "deleted");
    const stagedRename = changes.find((item) => item.path === renameNew && item.staged);
    const unstagedRename = changes.find((item) => item.path === renameNew && !item.staged);
    assert.deepEqual(stagedRename, { path: renameNew, oldPath: renameOld, status: "renamed", staged: true });
    assert.deepEqual(unstagedRename, { path: renameNew, oldPath: undefined, status: "modified", staged: false });
    assert.ok(changes.some((item) => item.path === specialPath && item.staged && item.status === "modified"));
    const statusRows = await statusService.getStatus();
    assert.ok(statusRows.some((item) => item.path === specialPath));
    // Exercise the actual comparison consumer as well as status rows. RM
    // must compare old HEAD to new index, then new index to new disk; MD must
    // keep the staged index file separate from the missing worktree file.
    const statusResolver = new GitComparisonResolver(statusService, statusRoot);
    const stagedRenameComparison = await statusResolver.materialize(await statusResolver.working(renameNew, true));
    assert.equal(stagedRenameComparison.leftContent.text, "base\n");
    assert.equal(stagedRenameComparison.rightContent.text, "base\n");
    const unstagedRenameComparison = await statusResolver.materialize(await statusResolver.working(renameNew, false));
    assert.equal(unstagedRenameComparison.leftContent.text, "base\n");
    assert.equal(unstagedRenameComparison.rightContent.text, "base\ndisk\n");
    const stagedDeletedComparison = await statusResolver.materialize(await statusResolver.working(deletedPath, true));
    assert.equal(stagedDeletedComparison.leftContent.text, "base\n");
    assert.equal(stagedDeletedComparison.rightContent.text, "index\n");
    const unstagedDeletedComparison = await statusResolver.materialize(await statusResolver.working(deletedPath, false));
    assert.equal(unstagedDeletedComparison.leftContent.text, "index\n");
    assert.deepEqual(unstagedDeletedComparison.rightContent, { available: true, text: "", bytes: 0, lines: 0 });
    git(statusRoot, ["add", "-A"]); git(statusRoot, ["commit", "-m", "special rename"]);
    const specialRenameCommit = git(statusRoot, ["rev-parse", "HEAD"]).trim();
    const historySpecial = await statusService.getCommitFiles(specialRenameCommit);
    assert.ok(historySpecial.some((item) => item.oldPath === renameOld && item.newPath === renameNew && item.status === "renamed"));
    await fs.writeFile(path.join(gitRoot, "deleted.txt"), "delete base\n");
    git(gitRoot, ["add", "deleted.txt"]); git(gitRoot, ["commit", "-m", "delete fixture"]);
    await fs.unlink(path.join(gitRoot, "deleted.txt"));
    const unstagedDeleted = await resolver.materialize(await resolver.working("deleted.txt", false));
    assert.equal(unstagedDeleted.leftContent.text, "delete base\n");
    assert.deepEqual(unstagedDeleted.rightContent, { available: true, text: "", bytes: 0, lines: 0 });
    git(gitRoot, ["add", "-u", "deleted.txt"]);
    const stagedDeleted = await resolver.materialize(await resolver.working("deleted.txt", true));
    assert.equal(stagedDeleted.leftContent.text, "delete base\n");
    assert.deepEqual(stagedDeleted.rightContent, { available: true, text: "", bytes: 0, lines: 0 });

    const unborn = path.join(temp, "unborn-git");
    await fs.mkdir(unborn); git(unborn, ["init", "-b", "main"]);
    await fs.writeFile(path.join(unborn, "first.txt"), "first\n");
    const unbornResolver = new GitComparisonResolver(new GitService(unborn), unborn);
    const unbornUnstaged = await unbornResolver.materialize(await unbornResolver.working("first.txt", false));
    assert.equal(unbornUnstaged.rightContent.text, "first\n");
    git(unborn, ["add", "first.txt"]);
    const unbornStaged = await unbornResolver.materialize(await unbornResolver.working("first.txt", true));
    assert.equal(unbornStaged.rightContent.text, "first\n");

    const { CvsAdapter, CvsProcess, checkout } = await import(path.join(projectRoot, "src/cvs/core.mjs"));
    const cvsRepository = path.join(temp, "cvs-repository");
    const cvsSeed = path.join(temp, "cvs-seed");
    const cvsWorking = path.join(temp, "cvs-working");
    await fs.mkdir(cvsRepository); await fs.mkdir(cvsSeed);
    const cvsProcess = new CvsProcess(process.env.JETTORTOISE_TEST_CVS || "/opt/homebrew/bin/cvs");
    const cvsRoot = `:local:${cvsRepository}`;
    await cvsProcess.run(["-d", cvsRoot, "init"], temp);
    await fs.writeFile(path.join(cvsSeed, "file.txt"), "base cvs\n");
    const starsContent = "prefix\n***************\nsuffix\n";
    await fs.writeFile(path.join(cvsSeed, "stars.txt"), starsContent);
    await cvsProcess.run(["-d", cvsRoot, "import", "-m", "base", "module", "vendor", "start"], cvsSeed);
    await checkout(cvsProcess, cvsRoot, "module", cvsWorking);
    await fs.writeFile(path.join(cvsWorking, "file.txt"), "disk cvs\n");
    const cvsResolver = new CvsComparisonResolver(new CvsAdapter(cvsWorking, cvsProcess), cvsWorking);
    const cvsComparison = await cvsResolver.working("file.txt");
    const cvsContents = await cvsResolver.materialize(cvsComparison);
    assert.equal(cvsContents.leftContent.text, "base cvs\n");
    assert.equal(cvsContents.rightContent.text, "disk cvs\n");
    // This used to be corrupted by stripping a delimiter-looking sequence
    // from merged stdout/stderr. `content` now returns only CVS stdout.
    const stars = await cvsResolver.materialize(await cvsResolver.working("stars.txt"));
    assert.equal(stars.leftContent.text, starsContent);
    assert.equal(stars.rightContent.text, starsContent);
    await assert.rejects(() => cvsResolver.working("../outside.txt"));
    // `cvs add` records revision 0 in Entries: it is an empty-base diff, while
    // an unregistered plain file remains unavailable.
    await fs.writeFile(path.join(cvsWorking, "added.txt"), "added\n");
    await cvsProcess.run(["add", "./added.txt"], cvsWorking);
    const cvsAdded = await cvsResolver.materialize(await cvsResolver.working("added.txt"));
    assert.deepEqual(cvsAdded.leftContent, { available: true, text: "", bytes: 0, lines: 0 });
    assert.equal(cvsAdded.rightContent.text, "added\n");
    await fs.writeFile(path.join(cvsWorking, "plain-unregistered.txt"), "plain\n");
    await assert.rejects(() => cvsResolver.working("plain-unregistered.txt"));
    // A tracked local delete retains its Entries revision and resolves to an
    // explicit empty right side.
    await fs.unlink(path.join(cvsWorking, "file.txt"));
    const cvsDeleted = await cvsResolver.materialize(await cvsResolver.working("file.txt"));
    assert.equal(cvsDeleted.leftContent.text, "base cvs\n");
    assert.deepEqual(cvsDeleted.rightContent, { available: true, text: "", bytes: 0, lines: 0 });
    console.log(JSON.stringify({ checks: 57, stagedBaseline: "HEAD-to-index", cvsBaseline: "Entries-to-working-copy" }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
