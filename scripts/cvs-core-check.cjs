const assert = require("node:assert/strict");

(async () => {
  const cvs = await import("../src/cvs/core.mjs");
  const protocol = await import("../src/cvs/protocol.mjs");
  for (const value of ["../outside", "CVS/Root", "/absolute", "a//b", "a\\b"]) {
    assert.throws(() => cvs.relativeFile(value), /path/);
  }
  assert.equal(cvs.relativeFile("src/file.txt"), "src/file.txt");
  assert.throws(() => cvs.revision("1.x"), /revision/);
  assert.equal(cvs.revision("1.2.3"), "1.2.3");
  assert.throws(() => protocol.validateMessage({ type: "commit", paths: ["ok"], message: "x", extra: true }, "workspace"), /message/);
  assert.throws(() => protocol.validateMessage({ type: "checkout" }, "other"), /message/);
  assert.deepEqual(protocol.validateMessage({ type: "history", path: "src/file.txt" }, "workspace"), { type: "history", path: "src/file.txt" });
  const log = cvs.parseLog("symbolic names:\n  release: 1.2\nkeyword substitution:\n----------------------------\nrevision 1.2\ndate: 2024/01/01 00:00:00;  author: tester;  state: Exp;\nsubject\nbody\n");
  assert.equal(log.length, 1);
  assert.equal(log[0].revisionId, "1.2");
  assert.equal(log[0].author.name, "tester");
  process.stdout.write("CVS core and protocol boundary checks passed.\n");
})().catch(error => { console.error(error); process.exitCode = 1; });
