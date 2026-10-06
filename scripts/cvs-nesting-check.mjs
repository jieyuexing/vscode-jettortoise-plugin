import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  CvsAdapter,
  CvsProcess,
  checkout,
  findWorkingCopy,
} from "../src/cvs/core.mjs";

const execFile = promisify(execFileCallback);
const cvsExecutable = process.env.JETTORTOISE_TEST_CVS || "/opt/homebrew/bin/cvs";

async function makeRepository(base, name, contents = "initial\n") {
  const repository = path.join(base, `${name}-repo`);
  const seed = path.join(base, `${name}-seed`);
  const process = new CvsProcess(cvsExecutable);
  const root = `:local:${repository}`;
  await fs.mkdir(repository);
  await fs.mkdir(seed);
  await process.run(["-d", root, "init"], base);
  await fs.writeFile(path.join(seed, "ordinary.txt"), contents);
  await process.run(
    ["-d", root, "import", "-m", "initial", "demo", "vendor", "start"],
    seed,
  );
  return { process, root };
}

async function fixture() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "jettortoise-cvs-nesting-")),
  );
  const local = await makeRepository(base, "local");
  const wc = path.join(base, "parent");
  await checkout(local.process, local.root, "demo", wc);
  return { base, wc, ...local, parent: new CvsAdapter(wc, local.process) };
}

test("continuous CVS directories share the parent working copy", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.wc, "continuous"));
    await f.process.run(["add", "continuous"], f.wc);
    await fs.writeFile(path.join(f.wc, "continuous", "child.txt"), "child\n");
    await f.process.run(["add", "continuous/child.txt"], f.wc);
    await f.parent.commit(["continuous/child.txt"], "add continuous child");

    assert.equal(
      await findWorkingCopy(path.join(f.wc, "continuous", "child.txt")),
      f.wc,
    );
    assert.deepEqual(
      (await f.parent.inventory()).map((file) => file.newPath),
      ["continuous/child.txt", "ordinary.txt"],
    );
    assert.deepEqual(f.parent.getNestedBoundaries(), []);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("independent CVS and Git children are excluded and block parent-wide mutations", async () => {
  const f = await fixture();
  try {
    // A normal parent operation still works before child boundaries exist.
    await fs.writeFile(path.join(f.wc, "ordinary.txt"), "parent edit\n");
    await f.parent.commit(["ordinary.txt"], "parent-only commit");

    const sameRoot = path.join(f.wc, "same-root-child");
    await checkout(f.process, f.root, "demo", sameRoot);
    const foreign = await makeRepository(f.base, "foreign", "foreign\n");
    const foreignRoot = path.join(f.wc, "foreign-child");
    await checkout(foreign.process, foreign.root, "demo", foreignRoot);
    const gitChild = path.join(f.wc, "git-child");
    await fs.mkdir(gitChild);
    await execFile("git", ["init", "--quiet"], { cwd: gitChild });
    const sentinel = path.join(f.base, "outside-sentinel");
    await fs.writeFile(sentinel, "unchanged\n");

    assert.equal(await findWorkingCopy(path.join(sameRoot, "ordinary.txt")), sameRoot);
    assert.equal(
      await findWorkingCopy(path.join(foreignRoot, "ordinary.txt")),
      foreignRoot,
    );
    const inventory = await f.parent.inventory();
    assert.ok(inventory.every((file) => !file.newPath.includes("child/")));
    const boundaries = f.parent.getNestedBoundaries();
    assert.deepEqual(
      new Set(boundaries.map((boundary) => boundary.root)),
      new Set([sameRoot, foreignRoot, gitChild]),
    );

    await fs.writeFile(path.join(sameRoot, "ordinary.txt"), "child edit\n");
    const child = new CvsAdapter(sameRoot, f.process);
    await child.commit(["ordinary.txt"], "child-only commit");
    assert.equal(
      await fs.readFile(path.join(f.wc, "ordinary.txt"), "utf8"),
      "parent edit\n",
    );
    await assert.rejects(
      f.parent.commit(["same-root-child/ordinary.txt"], "forbidden"),
      { code: "NESTED_REPOSITORY" },
    );
    await assert.rejects(f.parent.rollback("foreign-child/ordinary.txt"), {
      code: "NESTED_REPOSITORY",
    });
    const noBroadCommand = new CvsAdapter(f.wc, {
      run: async () => assert.fail("nested preflight invoked CVS update"),
    });
    await assert.rejects(noBroadCommand.update(), {
      code: "NESTED_REPOSITORY",
    });
    assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged\n");
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});
