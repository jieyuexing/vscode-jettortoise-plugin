const assert = require("node:assert/strict");
const { contributes } = require("../package.json");
// VS Code 拒绝含点号的容器 ID，并把其视图塞进资源管理器
for (const containers of Object.values(contributes.viewsContainers))
  for (const { id } of containers) assert.match(id, /^[A-Za-z0-9_-]+$/, `视图容器 ID 不合法：${id}`);
const containerIds = Object.values(contributes.viewsContainers).flat().map((c) => c.id);
for (const id of Object.keys(contributes.views)) assert.ok(containerIds.includes(id), `视图挂在不存在的容器：${id}`);
console.log("manifest ok");
