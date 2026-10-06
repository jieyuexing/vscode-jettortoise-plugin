import { fail, relativeFile, revision } from "./core.mjs";

export const capabilities = Object.freeze({
  compareRevision: true,
  copyRevision: true,
  update: true,
  commit: true,
  rollback: true,
});

const schema = {
  ready: [],
  openRepositoryBoundary: ["boundaryId"],
  refresh: [],
  history: ["path"],
  compare: ["path", "revision"],
  diff: ["path"],
  rollback: ["path"],
  commit: ["paths", "message"],
  update: [],
  cancel: [],
  copy: ["revision"],
};
const surfaces = { workspace: new Set(Object.keys(schema)) };

export function validateMessage(input, surface) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !Object.hasOwn(schema, input.type) ||
    !surfaces[surface]?.has(input.type)
  )
    fail("message");
  const keys = schema[input.type];
  if (
    Object.keys(input).length !== keys.length + 1 ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    fail("message");
  if (
    keys.includes("boundaryId") &&
    (typeof input.boundaryId !== "string" ||
      !/^[0-9a-f]{64}$/.test(input.boundaryId))
  )
    fail("message");
  if (keys.includes("path")) relativeFile(input.path);
  if (keys.includes("revision")) revision(input.revision);
  if (keys.includes("paths")) {
    if (
      !Array.isArray(input.paths) ||
      !input.paths.length ||
      input.paths.length > 2000 ||
      new Set(input.paths).size !== input.paths.length
    )
      fail("message");
    input.paths.forEach(relativeFile);
    if (
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 16000 ||
      input.message.includes("\0")
    )
      fail("message");
  }
  const capability = {
    compare: "compareRevision",
    copy: "copyRevision",
    rollback: "rollback",
    commit: "commit",
    update: "update",
  }[input.type];
  if (capability && !capabilities[capability]) fail("capability");
  return input;
}
