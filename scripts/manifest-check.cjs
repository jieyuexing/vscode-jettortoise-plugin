const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contributes, activationEvents = [] } = require("../package.json");
// VS Code 拒绝含点号的容器 ID，并把其视图塞进资源管理器
for (const containers of Object.values(contributes.viewsContainers))
  for (const { id } of containers) assert.match(id, /^[A-Za-z0-9_-]+$/, `视图容器 ID 不合法：${id}`);
const containerIds = Object.values(contributes.viewsContainers).flat().map((c) => c.id);
for (const id of Object.keys(contributes.views)) assert.ok(containerIds.includes(id), `视图挂在不存在的容器：${id}`);
function checkSchemes(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) checkSchemes(file);
    else if (file.endsWith('.ts')) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/register(?:TextDocumentContent|FileSystem)Provider\(\s*["']([^"']+)["']/g))
        assert.ok(activationEvents.includes(`onFileSystem:${match[1]}`), `内容 scheme 缺少恢复激活事件：${match[1]}`);
    }
  }
}
assert.ok(!activationEvents.includes('*'), '禁止无条件激活');
checkSchemes(path.join(__dirname, '../src'));
console.log("manifest ok");
