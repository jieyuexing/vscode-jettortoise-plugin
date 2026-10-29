/*
 * Disposable GitService boundary checks. This bundles the real service and
 * exercises only a temporary local repository; it never opens VS Code or a
 * network remote.
 */
const childProcess = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}
function gitObject(cwd, content) {
  return childProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: content, encoding: "utf8" }).trim();
}

let negativeControls = 0;
async function rejects(action, label) {
  try {
    await action();
  } catch {
    negativeControls += 1;
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-git-security-"));
  try {
    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "git-service.cjs");
    const vscodeStub = path.join(tempRoot, "vscode-stub.cjs");
    await fs.writeFile(vscodeStub, "exports.l10n = { t: (message) => message };\n");
    await fs.writeFile(entry, `export { GitService } from ${JSON.stringify(path.join(projectRoot, "src/git/gitService.ts"))};\n`);
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub })); } }],
    });
    const { GitService } = require(bundle);
    const workspace = path.join(tempRoot, "workspace");
    const remote = path.join(tempRoot, "remote.git");
    await fs.mkdir(workspace);
    git(workspace, ["init", "-b", "main"]);
    git(workspace, ["config", "user.name", "Security Check"]);
    git(workspace, ["config", "user.email", "security-check@example.invalid"]);
    await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial"]);
    git(tempRoot, ["init", "--bare", remote]);
    git(workspace, ["remote", "add", "origin", remote]);
    git(workspace, ["push", "-u", "origin", "main"]);

    const service = new GitService(workspace);
    const base = gitObject(workspace, "base stage\n");
    const ours = gitObject(workspace, "ours stage\n");
    const theirs = gitObject(workspace, "theirs stage\n");
    childProcess.execFileSync("git", ["update-index", "--index-info"], {
      cwd: workspace,
      input: `100644 ${base} 1\tconflicted.txt\n100644 ${ours} 2\tconflicted.txt\n100644 ${theirs} 3\tconflicted.txt\n`,
      encoding: "utf8",
    });
    assert.deepEqual(await service.getFileVersions("conflicted.txt"), { base: "base stage\n", ours: "ours stage\n", theirs: "theirs stage\n" });
    git(workspace, ["update-index", "--force-remove", "conflicted.txt"]);
    const outsideWrite = path.join(tempRoot, "outside-write.txt");
    const outsideDelete = path.join(tempRoot, "outside-delete.txt");
    await fs.writeFile(outsideWrite, "before\n");
    await fs.writeFile(outsideDelete, "keep\n");
    await fs.symlink(tempRoot, path.join(workspace, "escape"));
    await fs.symlink(".git", path.join(workspace, "metadata-alias"));
    await fs.symlink(path.join(tempRoot, "missing-outside.txt"), path.join(workspace, "dangling-escape"));
    await fs.symlink(path.join(tempRoot, "missing-outside-dir"), path.join(workspace, "dangling-parent"));
    const shelfDir = path.join(workspace, ".idea", "shelf");
    await fs.mkdir(path.join(workspace, ".idea"));
    await fs.mkdir(path.join(workspace, "shelf-storage"));
    await fs.symlink("../shelf-storage", shelfDir);
    await fs.mkdir(path.join(shelfDir, "external"), { recursive: true });
    await fs.writeFile(path.join(shelfDir, "external", "shelved.patch"), "diff --git a/a b/a\n");
    await fs.writeFile(
      path.join(shelfDir, "external.xml"),
      `<changelist name="external"><option name="PATH" value="${outsideWrite}" /></changelist>`,
    );

    await rejects(() => service.saveMergedContent("../outside-write.txt", "changed\n"), "traversal write");
    await rejects(() => service.saveMergedContent(".git/config", "changed\n"), "Git metadata write");
    await rejects(() => service.saveMergedContent("metadata-alias/config", "changed\n"), "Git metadata alias write");
    await rejects(() => service.saveMergedContent("metadata-alias/new-config", "changed\n"), "Git metadata alias creation");
    await rejects(() => service.saveMergedContent("dangling-escape", "changed\n"), "dangling external symlink write");
    await rejects(() => service.saveMergedContent("dangling-parent/child.txt", "changed\n"), "dangling parent symlink write");
    assert.equal(await fs.access(path.join(tempRoot, "missing-outside.txt")).then(() => true).catch(() => false), false);
    assert.equal(await fs.access(path.join(tempRoot, "missing-outside-dir")).then(() => true).catch(() => false), false);
    await rejects(() => service.rollbackFile("../outside-delete.txt"), "traversal delete");
    await rejects(() => service.saveMergedContent("escape/outside-write.txt", "changed\n"), "symlink write");
    await rejects(() => service.checkoutFileFromParent("deadbeef", "../outside-delete.txt", "added"), "parent checkout traversal");
    await rejects(() => service.stageFile("--intent-to-add"), "path option injection");
    await rejects(() => service.createBranch("--upload-pack=bad", "HEAD"), "branch option injection");
    await rejects(() => service.fetch("--upload-pack=bad"), "remote option injection");
    await rejects(() => service.deleteIdeaShelf("../outside-delete.txt"), "shelf traversal delete");
    await rejects(() => service.unshelveChanges("stash@{99}"), "unknown stash entry");
    const xmlExternalShelf = (await service.getIdeaShelves()).find((entry) => entry.name === "external");
    if (!xmlExternalShelf || xmlExternalShelf.patchPath === outsideWrite) {
      throw new Error("Shelf XML external patch path was accepted");
    }
    await service.deleteIdeaShelf("external");
    await fs.writeFile(path.join(workspace, "link-target.txt"), "preserve target\n");
    await fs.symlink("link-target.txt", path.join(workspace, "internal-link"));
    await service.rollbackFile("internal-link");
    assert.equal(await fs.readFile(path.join(workspace, "link-target.txt"), "utf8"), "preserve target\n");
    assert.equal(await fs.lstat(path.join(workspace, "internal-link")).then(() => true).catch(() => false), false);

    const unicodePath = "目录/with space-文件.txt";
    await fs.mkdir(path.join(workspace, "目录"));
    await service.saveMergedContent(unicodePath, "safe\n");
    await service.stageFile(unicodePath);
    const staged = git(workspace, ["diff", "--cached", "--name-only"]).trim();
    if (!staged.split("\n").includes(unicodePath)) throw new Error("Valid Unicode path was not staged");
    await service.importPatchAsShelf("Safe shelf", "diff --git a/a.txt b/a.txt\n");
    if (!(await service.getIdeaShelves()).some((entry) => entry.name === "Safe_shelf")) {
      throw new Error("Valid shelf was not readable");
    }
    await service.deleteIdeaShelf("Safe_shelf");
    if ((await service.getIdeaShelves()).some((entry) => entry.name === "Safe_shelf")) {
      throw new Error("Valid shelf was not deleted");
    }
    const dashPath = "--legal-file.txt";
    await service.saveMergedContent(dashPath, "dash\n");
    await service.ideaShelveChanges("dash", [dashPath]);
    if (await fs.access(path.join(workspace, dashPath)).then(() => true).catch(() => false)) {
      throw new Error("Leading-dash file was not safely reverted into shelf");
    }
    git(workspace, ["commit", "-m", "second"]);
    await service.getDiff("HEAD~1", "HEAD");
    await service.getDiff("refs/remotes/origin/main", "HEAD");
    await fs.writeFile(path.join(workspace, "tracked.txt"), "changed\n");
    git(workspace, ["stash", "push", "-m", "revision-check"]);
    await service.getDiff("stash^", "stash");
    await fs.unlink(shelfDir);
    const externalShelf = path.join(tempRoot, "external-shelves");
    await fs.mkdir(externalShelf);
    await fs.symlink(externalShelf, shelfDir);
    await rejects(() => service.importPatchAsShelf("outside", "patch"), "external shelf root");
    await service.fetch("origin");

    const result = {
      negativeControls,
      internalSymlinkUnlinkedWithoutDeletingTarget: true,
      outsideWrite: await fs.readFile(outsideWrite, "utf8"),
      outsideDelete: await fs.readFile(outsideDelete, "utf8"),
      unicodePathStaged: staged,
      localRemoteOnly: remote,
    };
    if (result.outsideWrite !== "before\n" || result.outsideDelete !== "keep\n") {
      throw new Error("External sentinel changed");
    }
    console.log(JSON.stringify(result));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
