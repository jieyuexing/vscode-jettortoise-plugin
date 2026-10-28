/*
 * Real, disposable nested-worktree checks for the production GitService.
 * This never opens VS Code, configures a remote, or touches a user checkout.
 */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function rejectsNested(action, label) {
  try {
    await action();
  } catch (error) {
    assert.equal(error?.code, "NESTED_REPOSITORY", `${label} error code`);
    assert.ok(Array.isArray(error?.boundaries), `${label} boundaries`);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function createGitRepository(root, email) {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Nested Check"]);
  git(root, ["config", "user.email", email]);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-git-nesting-"));
  try {
    const parent = path.join(tempRoot, "parent");
    const child = path.join(parent, "child");
    await createGitRepository(parent, "parent@example.invalid");
    git(parent, ["config", "advice.addEmbeddedRepo", "false"]);
    await fs.writeFile(path.join(parent, "parent.txt"), "initial parent\n");
    git(parent, ["add", "parent.txt"]);
    git(parent, ["commit", "-m", "parent initial"]);
    await createGitRepository(child, "child@example.invalid");
    await fs.writeFile(path.join(child, "child.txt"), "initial child\n");
    await fs.writeFile(path.join(child, "sentinel.txt"), "do not delete\n");
    git(child, ["add", "child.txt", "sentinel.txt"]);
    git(child, ["commit", "-m", "child initial"]);

    const legacy = path.join(parent, "legacy");
    await fs.mkdir(path.join(legacy, "CVS"), { recursive: true });
    await fs.writeFile(path.join(legacy, "CVS", "Root"), ":local:/fixture\n");
    await fs.writeFile(path.join(legacy, "CVS", "Repository"), "legacy\n");
    await fs.writeFile(path.join(legacy, "CVS", "Entries"), "/legacy.txt/1.1///\n");
    await fs.writeFile(path.join(legacy, "legacy.txt"), "legacy\n");

    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "git-service.cjs");
    const vscodeStub = path.join(tempRoot, "vscode-stub.cjs");
    await fs.writeFile(vscodeStub, "exports.l10n = { t: (message) => message };\n");
    await fs.writeFile(entry, `export { GitService } from ${JSON.stringify(path.join(projectRoot, "src/git/gitService.ts"))};\nexport { resolveShelfEntry } from ${JSON.stringify(path.join(projectRoot, "src/git/security.ts"))};\n`);
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub })); } }],
    });
    const { GitService, resolveShelfEntry } = require(bundle);
    const selected = path.join(tempRoot,"selected");
    await createGitRepository(selected,"selected@example.invalid");
    for(const name of ["partial.txt","deleted.txt","old.txt","deferred.txt"]) await fs.writeFile(path.join(selected,name),"base\n");
    git(selected,["add","."]);git(selected,["commit","-m","base"]);
    await fs.writeFile(path.join(selected,"partial.txt"),"staged\n");git(selected,["add","partial.txt"]);
    await fs.writeFile(path.join(selected,"partial.txt"),"worktree\n");
    await fs.writeFile(path.join(selected,"deferred.txt"),"excluded staged\n");git(selected,["add","deferred.txt"]);
    await fs.rm(path.join(selected,"deleted.txt"));git(selected,["mv","old.txt","new.txt"]);
    await new GitService(selected).commitPaths("selected paths",["partial.txt","deleted.txt","old.txt","new.txt"]);
    assert.equal(git(selected,["show","HEAD:partial.txt"]),"worktree\n");
    assert.equal(git(selected,["show","HEAD:deferred.txt"]),"base\n");
    assert.equal(git(selected,["diff","--cached","--name-only"]).trim(),"deferred.txt");
    assert.equal(git(selected,["ls-tree","--name-only","HEAD"]).includes("deleted.txt"),false);
    assert.equal(git(selected,["ls-tree","--name-only","HEAD"]).includes("old.txt"),false);
    const parentService = new GitService(parent);
    const childService = new GitService(child);

    // The former `git add -A` behavior staged an embedded repository.
    await fs.writeFile(path.join(parent,"ordinary-new.txt"),"parent only\n");
    await parentService.stageAll();
    assert.equal(git(parent, ["diff", "--cached", "--name-only"]).trim(), "ordinary-new.txt");
    git(parent,["reset","HEAD","--","ordinary-new.txt"]);
    await parentService.getWorkingTreeChanges();
    const realChild = await fs.realpath(child);
    assert.ok(
      parentService.getNestedBoundaries().some(
        (boundary) => boundary.kind === "git" && boundary.root === realChild,
      ),
      "status snapshot identifies the unregistered child without a global scan",
    );

    // Explicit ordinary parent paths remain usable while a child repository exists.
    await parentService.saveMergedContent("parent.txt", "parent update\n");
    await parentService.stageFile("parent.txt");
    await parentService.commit("parent-only change");
    assert.equal(git(parent, ["log", "-1", "--format=%s"]).trim(), "parent-only change");

    // The child owns and can independently commit its own files.
    await childService.saveMergedContent("child.txt", "child update\n");
    await childService.stageFile("child.txt");
    await childService.commit("child-only change");
    assert.equal(git(child, ["log", "-1", "--format=%s"]).trim(), "child-only change");

    // A terminal-prestaged embedded repository cannot be committed through the parent.
    childProcess.execFileSync("git", ["add", "child"], {
      cwd: parent,
      stdio: "ignore",
    });
    await rejectsNested(() => parentService.commit("must not commit child"), "pre-staged child commit");
    assert.equal(git(parent, ["diff", "--cached", "--name-only"]).trim(), "child");
    git(parent, ["reset", "HEAD", "--", "child"]);

    await rejectsNested(() => parentService.stageFile("legacy/legacy.txt"), "nested CVS marker");
    await rejectsNested(() => parentService.saveMergedContent("child/sentinel.txt", "changed\n"), "direct child write");
    await rejectsNested(() => parentService.rollbackFile("child/sentinel.txt"), "child delete/rollback");
    assert.equal(await fs.readFile(path.join(child, "sentinel.txt"), "utf8"), "do not delete\n");

    // A selected IDEA shelf is a parent-local operation and may preserve a child untouched.
    await parentService.saveMergedContent("shelf-source.txt", "shelve parent only\n");
    await parentService.ideaShelveChanges("parent shelf", ["shelf-source.txt"]);
    assert.equal(await fs.access(path.join(parent, "shelf-source.txt")).then(() => true).catch(() => false), false);
    assert.ok((await parentService.getIdeaShelves()).some((entry) => entry.name === "parent_shelf"));
    assert.equal(await fs.readFile(path.join(child, "sentinel.txt"), "utf8"), "do not delete\n");

    await rejectsNested(() => parentService.checkout("main"), "whole worktree checkout");
    assert.equal(await fs.readFile(path.join(child, "sentinel.txt"), "utf8"), "do not delete\n");

    const shelfChild = path.join(parent, '.idea', 'shelf', 'parent_shelf');
    const shelfBefore = await fs.readFile(path.join(shelfChild, 'shelved.patch'), 'utf8');
    await createGitRepository(shelfChild, 'shelf-child@example.invalid');
    await rejectsNested(() => resolveShelfEntry(parent, 'parent_shelf'), 'shelf read/export child boundary');
    await rejectsNested(() => parentService.deleteIdeaShelf('parent_shelf'), 'shelf delete child boundary');
    assert.deepEqual(await parentService.getIdeaShelves(), []);
    assert.equal(await fs.readFile(path.join(shelfChild, 'shelved.patch'),'utf8'), shelfBefore);

    // Lexical ownership still matters when a link inside a child points back
    // into the parent: rollback must not remove that child-owned link.
    await fs.symlink(path.join(parent, "parent.txt"), path.join(child, "parent-link"));
    await rejectsNested(() => parentService.rollbackFile("child/parent-link"), "child link targeting parent");
    assert.equal((await fs.lstat(path.join(child, "parent-link"))).isSymbolicLink(), true);

    // The complete index includes unchanged entries, not just --cached diff.
    const overlap = path.join(parent, "overlap");
    await fs.mkdir(overlap);
    await fs.writeFile(path.join(overlap, "tracked.txt"), "parent once tracked this\n");
    git(parent, ["add", "overlap/tracked.txt"]);
    git(parent, ["commit", "-m", "track future child"]);
    await createGitRepository(overlap, "overlap@example.invalid");
    await fs.writeFile(path.join(parent, "parent.txt"), "another parent update\n");
    await parentService.stageFile("parent.txt");
    const beforeIndex = git(parent, ["ls-files", "--stage", "-z"]);
    await rejectsNested(() => parentService.commit("unchanged child must still block"), "full index overlap");
    await rejectsNested(() => parentService.shelveChanges("no reset", ["parent.txt"]), "selected stash index overlap");
    assert.equal(git(parent, ["ls-files", "--stage", "-z"]), beforeIndex);
    assert.equal(await fs.readFile(path.join(overlap, "tracked.txt"), "utf8"), "parent once tracked this\n");

    console.log(JSON.stringify({
      checks: 15,
      stageAllSkipsNestedCandidates: true,
      preStagedChildPreserved: true,
      parentAndChildCommitsIndependent: true,
      mixedCvsBoundaryRejected: true,
      statusBoundarySnapshotAvailable: true,
      parentShelfPreservedChild: true,
      sentinelUnchanged: true,
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
