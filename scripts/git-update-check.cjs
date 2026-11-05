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
  await fs.writeFile(vscode, "exports.l10n = { t: (value, ...args) => value.replace(/\\{(\\d+)\\}/g, (_, index) => String(args[index])) };\n");
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
      await addRemoteCommit(f);
      await fs.mkdir(path.join(f.target, ".idea/shelf"), { recursive: true });
      await fs.writeFile(path.join(f.target, ".idea/shelf/local.patch"), "shelved\n");
      await new GitService(f.target).updateFastForward();
      assert.equal(await fs.readFile(path.join(f.target, "tracked.txt"), "utf8"), "remote\n");
      assert.equal(await fs.readFile(path.join(f.target, ".idea/shelf/local.patch"), "utf8"), "shelved\n");
      checks += 2;
    });
    await withFixture(temporary, async (f) => {
      git(f.target, ["checkout", "--detach", "HEAD"]);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    await withFixture(temporary, async (f) => {
      git(f.target, ["branch", "--unset-upstream"]);
      await assert.rejects(() => new GitService(f.target).updateFastForward()); checks += 1;
    });
    // 分叉不能快进：不抛 git 英文原文，返回两侧提交数，由宿主询问合并或变基。
    const diverged = async (f) => {
      await fs.writeFile(path.join(f.target, "local.txt"), "local\n");
      git(f.target, ["add", "local.txt"]); git(f.target, ["commit", "-m", "local"]);
      await addRemoteCommit(f);
      const head = git(f.target, ["rev-parse", "HEAD"]);
      assert.deepEqual(await new GitService(f.target).updateFastForward(), { upstream: "origin/main", ahead: 1, behind: 1 });
      assert.equal(git(f.target, ["rev-parse", "HEAD"]), head);
      checks += 2;
    };
    await withFixture(temporary, async (f) => {
      await diverged(f);
      assert.equal(await new GitService(f.target).integrateUpstream("merge"), 0);
      assert.equal(git(f.target, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length, 3);
      assert.equal(await fs.readFile(path.join(f.target, "tracked.txt"), "utf8"), "remote\n");
      checks += 2;
    });
    await withFixture(temporary, async (f) => {
      await diverged(f);
      assert.equal(await new GitService(f.target).integrateUpstream("rebase"), 0);
      assert.equal(git(f.target, ["rev-parse", "HEAD~1"]), git(f.target, ["rev-parse", "origin/main"]));
      assert.equal(git(f.target, ["log", "-1", "--format=%s"]).trim(), "local");
      checks += 2;
    });
    // 两侧改同一文件：合并留下冲突状态并返回冲突数，交给合并冲突分组处理。
    await withFixture(temporary, async (f) => {
      await addRemoteCommit(f);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local\n");
      git(f.target, ["commit", "-am", "local"]);
      await new GitService(f.target).updateFastForward();
      assert.equal(await new GitService(f.target).integrateUpstream("merge"), 1);
      git(f.target, ["rev-parse", "--verify", "MERGE_HEAD"]);
      assert.match(await fs.readFile(path.join(f.target, "tracked.txt"), "utf8"), /^>>>>>>> origin\/main$/m);
      checks += 3;
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
    // 编辑器里手工合并后“标记已解决”（暂存）即可继续合并，提交说明不留 # Conflicts: 注释。
    await withFixture(temporary, async (f) => {
      await addRemoteCommit(f);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local\n");
      git(f.target, ["commit", "-am", "local"]); git(f.target, ["fetch"]);
      assert.throws(() => git(f.target, ["merge", "origin/main"]));
      const service = new GitService(f.target);
      assert.deepEqual(await service.getConflictFiles(), ["tracked.txt"]);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local and remote\n");
      await service.stageFile("tracked.txt");
      assert.deepEqual(await service.getConflictFiles(), []);
      await service.mergeContinue();
      const message = git(f.target, ["log", "-1", "--format=%B"]);
      assert.match(message, /^Merge remote-tracking branch 'origin\/main'/);
      assert.doesNotMatch(message, /#|Conflicts/);
      assert.equal(git(f.target, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length, 3);
      checks += 4;
    });
    // 合并、cherry-pick、revert 进行中，提交区按所选路径提交也要生成完整的继续提交，并采用填写的说明。
    const conflicted = async (f, start) => {
      await addRemoteCommit(f);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local\n");
      git(f.target, ["commit", "-am", "local"]); git(f.target, ["fetch"]);
      assert.throws(() => git(f.target, start));
      await fs.writeFile(path.join(f.target, "tracked.txt"), "resolved\n");
      const service = new GitService(f.target);
      await service.stageFile("tracked.txt");
      return service;
    };
    for (const [start, marker, parents] of [
      [["merge", "origin/main"], "MERGE_HEAD", 3],
      [["cherry-pick", "origin/main"], "CHERRY_PICK_HEAD", 2],
    ]) {
      await withFixture(temporary, async (f) => {
        const service = await conflicted(f, start);
        await fs.writeFile(path.join(f.target, "tracked.txt"), "resolved again\n");
        await service.commitPaths("合并说明：采用双方修改", ["tracked.txt"]);
        assert.equal(git(f.target, ["log", "-1", "--format=%B"]).trim(), "合并说明：采用双方修改");
        assert.equal(git(f.target, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length, parents);
        assert.equal(git(f.target, ["show", "HEAD:tracked.txt"]), "resolved again\n");
        assert.throws(() => git(f.target, ["rev-parse", "--verify", "--quiet", marker]));
        checks += 4;
      });
    }
    await withFixture(temporary, async (f) => {
      const service = await conflicted(f, ["merge", "origin/main"]);
      await service.commitPaths("", ["tracked.txt"]);
      const message = git(f.target, ["log", "-1", "--format=%B"]);
      assert.match(message, /^Merge remote-tracking branch 'origin\/main'/);
      assert.doesNotMatch(message, /#|Conflicts/);
      checks += 2;
    });
    await withFixture(temporary, async (f) => {
      await fs.writeFile(path.join(f.target, "tracked.txt"), "plain\n");
      await assert.rejects(() => new GitService(f.target).commitPaths(" ", ["tracked.txt"]));
      checks += 1;
    });
    // 解决结果与本地相同：暂存后没有可选文件，提交区不选文件也能完成合并。
    await withFixture(temporary, async (f) => {
      const service = await conflicted(f, ["merge", "origin/main"]);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local\n");
      await service.stageFile("tracked.txt");
      assert.equal(git(f.target, ["status", "--porcelain"]), "");
      assert.equal(await service.mergeInProgress(), true);
      await service.commitPaths("", []);
      assert.equal(git(f.target, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length, 3);
      assert.equal(await service.mergeInProgress(), false);
      await assert.rejects(() => service.commitPaths("", []), /select changed files/);
      checks += 4;
    });
    // 合并／变基／更新失败：报冲突文件数与首个文件，或 git 的原因行，不带“Command failed”原文。
    await withFixture(temporary, async (f) => {
      await addRemoteCommit(f);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "local\n");
      git(f.target, ["commit", "-am", "local"]); git(f.target, ["fetch"]);
      await assert.rejects(() => new GitService(f.target).merge("origin/main"), { message: "Merge failed: 1 file(s) have conflicts, first: tracked.txt" });
      git(f.target, ["merge", "--abort"]);
      await fs.writeFile(path.join(f.target, "tracked.txt"), "dirty\n");
      await assert.rejects(() => new GitService(f.target).rebase("origin/main"), (error) => /^Rebase failed: cannot rebase: You have unstaged changes\.$/.test(error.message));
      git(f.target, ["reset", "--hard", "origin/main"]);
      git(f.target, ["remote", "set-url", "origin", path.join(temporary, "missing.git")]);
      await assert.rejects(() => new GitService(f.target).updateFastForward(), (error) => /^Update Project failed: '.*missing\.git' does not appear to be a git repository$/.test(error.message));
      checks += 3;
    });
    // 大批量：12000 个路径经标准输入一次交给 git，提交与回滚都不受命令行长度限制。
    await withFixture(temporary, async (f) => {
      const names = Array.from({ length: 12000 }, (_, index) => `bulk/dir${index % 40}/F${String(index).padStart(5, "0")}.txt`);
      for (let index = 0; index < 40; index++) await fs.mkdir(path.join(f.target, `bulk/dir${index}`), { recursive: true });
      await Promise.all(names.map((name) => fs.writeFile(path.join(f.target, name), "v1\n")));
      const service = new GitService(f.target);
      let started = Date.now();
      await service.stageFiles(names);
      const stageMs = Date.now() - started;
      started = Date.now();
      await service.commitPaths("bulk add", names);
      const commitMs = Date.now() - started;
      assert.equal(git(f.target, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").length, 12000);
      await Promise.all(names.map((name) => fs.writeFile(path.join(f.target, name), "v2\n")));
      await fs.writeFile(path.join(f.target, "bulk/new.txt"), "new\n");
      git(f.target, ["add", "bulk/new.txt"]);
      started = Date.now();
      await service.rollbackFiles([...names, "bulk/new.txt"]);
      const rollbackMs = Date.now() - started;
      assert.equal(git(f.target, ["status", "--porcelain"]), "");
      await assert.rejects(fs.access(path.join(f.target, "bulk/new.txt")));
      console.log(JSON.stringify({ benchmark: "gitBulk", files: 12000, stageMs, commitMs, rollbackMs }));
      checks += 3;
    });
    console.log(JSON.stringify({ checks, command: "pull --ff-only --no-rebase --no-autostash --no-recurse-submodules" }));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
