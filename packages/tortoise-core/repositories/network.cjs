// 全插件共用；只在实际启动远端命令时占位，本地读取不排队。
const waiting = [];
let active = 0;
function drain() {
  while (active < 2 && waiting.length) {
    const item = waiting.shift();
    item.signal?.removeEventListener("abort", item.abort);
    if (item.signal?.aborted) {
      item.reject(cancelled());
      continue;
    }
    active++;
    Promise.resolve()
      .then(item.job)
      .then(item.resolve, item.reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}
function cancelled() {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}
function runNetwork(job, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const item = {
      job,
      signal,
      resolve,
      reject,
      abort() {
        const index = waiting.indexOf(item);
        if (index >= 0) {
          waiting.splice(index, 1);
          reject(cancelled());
        }
      },
    };
    waiting.push(item);
    signal?.addEventListener("abort", item.abort, { once: true });
    drain();
  });
}
module.exports = { runNetwork };
