/*
 * 测试用的 cvs 包装脚本（只在检查里使用）：记录每次调用的 argv，并可模拟两种服务器行为：
 * - recursing：`log -l` 对目录参数无效，每个目录参数（"." 除外）都被递归取 log。这是 0.6.22 在真实工程上
 *   观测到的现象：深层文件在输出里重复，次数约等于目录层数。本机 CVS 1.12.13（:local: 与 pserver）不会这样。
 * - stripCommitId：去掉 commitid 字段，模拟没有 commitid 的服务器。
 */
const fs = require("node:fs");

function shim(options) {
  const fs = require("node:fs");
  const cp = require("node:child_process");
  const args = process.argv.slice(2);
  if (options.argvLog) fs.appendFileSync(options.argvLog, `${JSON.stringify(args)}\n`);
  const run = (list) => cp.spawnSync(options.real, list, { maxBuffer: 1 << 28 });
  const log = args.indexOf("log");
  const results = [];
  if (options.recursing && log >= 0 && args.includes("-l")) {
    let index = log + 1;
    while (index < args.length) {
      if (args[index] === "-d") index += 2;
      else if (args[index].startsWith("-")) index += 1;
      else break;
    }
    const flags = args.slice(log + 1, index);
    for (const directory of args.slice(index))
      results.push(
        run([
          ...args.slice(0, log + 1),
          ...(directory === "." ? flags : flags.filter((flag) => flag !== "-l")),
          directory,
        ]),
      );
  } else results.push(run(args));
  let output = Buffer.concat(results.map((result) => result.stdout));
  if (options.stripCommitId)
    output = Buffer.from(output.toString("latin1").replace(/;  commitid: [^;\r\n]+;/g, ";"), "latin1");
  for (const result of results) process.stderr.write(result.stderr);
  process.stdout.write(output);
  process.exit(results.find((result) => result.status !== 0)?.status ?? 0);
}

/** 写出可执行的包装；real 是真实 cvs 的路径。 */
exports.writeShim = async (file, options) => {
  await fs.promises.writeFile(file, `#!${process.execPath}\n(${shim})(${JSON.stringify(options)});\n`, { mode: 0o755 });
  return file;
};
