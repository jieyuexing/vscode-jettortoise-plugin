// VS Code loads locale-specific resources. Maintain only the zh-cn sources.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
for (const locale of ["zh", "zh-tw"]) {
  for (const [source, target] of [
    ["package.nls.zh-cn.json", `package.nls.${locale}.json`],
    ["l10n/bundle.l10n.zh-cn.json", `l10n/bundle.l10n.${locale}.json`],
  ]) {
    const content = fs.readFileSync(path.join(root, source));
    const destination = path.join(root, target);
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(content)) {
      fs.writeFileSync(destination, content);
    }
  }
}
