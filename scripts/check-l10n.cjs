// 本地化资源合同：不启动窗口，不依赖 VS Code 运行时。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const manifest = read('package.json');
const en = read('package.nls.json');
const zh = read('package.nls.zh-cn.json');
const host = read('l10n/bundle.l10n.zh-cn.json');
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
function translation(source, target) {
  assert.equal(typeof target, 'string', `缺少译文：${source}`);
  assert.ok(target.trim(), `空译文：${source}`);
  assert.deepEqual(placeholders(source), placeholders(target), `占位符不一致：${source}`);
}
assert.equal(manifest.l10n, './l10n');
assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
for (const [key, value] of Object.entries(en)) translation(value, zh[key]);
for (const match of JSON.stringify(manifest).matchAll(/%([^%]+)%/g)) {
  assert.ok(Object.hasOwn(en, match[1]) && Object.hasOwn(zh, match[1]), `缺少清单键：${match[1]}`);
}
let calls = 0;
function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file, visit);
    else if (/\.tsx?$/.test(file) && !/\.test\.|\/test\//.test(file)) visit(file);
  }
}
walk(path.join(root, 'src'), file => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.l10n.t') {
      const key = node.arguments[0];
      assert.ok(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key), `扩展端翻译键必须为字面量：${file}`);
      translation(key.text, host[key.text]);
      calls++;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
});
assert.ok(calls > 0);
const localeFile = path.join(root, 'webview/src/shared/i18n/locales.ts');
const moduleValue = {exports:{}};
new Function('exports', 'module', ts.transpileModule(fs.readFileSync(localeFile, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(moduleValue.exports, moduleValue);
const {en: webEn, zhCn} = moduleValue.exports;
assert.deepEqual(Object.keys(webEn).sort(), Object.keys(zhCn).sort());
for (const [key, value] of Object.entries(webEn)) translation(value, zhCn[key]);
walk(path.join(root, 'webview/src'), file => {
  if (file.includes('/i18n/')) return;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
      assert.ok(ts.isStringLiteral(node.arguments[0]), `webview 翻译键必须为字面量：${file}`);
      assert.ok(Object.hasOwn(webEn, node.arguments[0].text), `未知 webview 键：${file} ${node.arguments[0].text}`);
    }
    if (ts.isJsxText(node)) assert.ok(!/[A-Za-z]{2}/.test(node.text.replace(/&[^;]+;/g, '').trim()), `未翻译 JSX：${file} ${node.text.trim()}`);
    if (ts.isJsxAttribute(node) && ['title','text','label','placeholder','aria-label','clearLabel'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer))
      assert.ok(!/[A-Za-z]{2}/.test(node.initializer.text), `未翻译属性：${file} ${node.initializer.text}`);
    if (ts.isPropertyAssignment(node) && ['title','label','confirmLabel','prompt','placeHolder'].includes(node.name.getText(source)) && ts.isStringLiteral(node.initializer))
      assert.ok(!/[A-Za-z]{2}/.test(node.initializer.text), `未翻译显示字段：${file} ${node.initializer.text}`);
    ts.forEachChild(node, visit);
  }
  visit(source);
});
console.log(`本地化覆盖通过：清单 ${Object.keys(en).length}，扩展调用 ${calls}，webview ${Object.keys(webEn).length}。`);

// 用实际翻译函数验证语言切换、中文计数、参数和缺键回落。
function load(file, requireModule) {
  const value = {exports:{}};
  const js = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('require','exports','module',js)(requireModule,value.exports,value);
  return value.exports;
}
const runtime = load('webview/src/shared/i18n/index.ts', name => {
  assert.equal(name, './locales');
  return moduleValue.exports;
});
for (const language of ['en','de','zh-tw',undefined]) {
  runtime.initializeI18n(language);
  assert.equal(runtime.t('Commit'), 'Commit');
  assert.equal(runtime.fileCount(1), '1 file');
  assert.equal(runtime.fileCount(2), '2 files');
}
runtime.initializeI18n('zh-cn');
assert.equal(runtime.t('Commit'), '提交');
for (const count of [0,1,2,2000]) assert.equal(runtime.fileCount(count), `${count} 个文件`);
assert.equal(runtime.t('Select {0}', 'src/中文 $&.ts'), '选择 src/中文 $&.ts');
const original = zhCn.Commit;
delete zhCn.Commit;
assert.equal(runtime.t('Commit'), 'Commit');
zhCn.Commit = original;
const vscode = {l10n:{t:(key,...args) => (host[key] || key).replace(/\{(\d+)\}/g, (_,n) => String(args[Number(n)]))}};
const {localizeError} = load('src/messages/errors.ts', name => {
  assert.equal(name, 'vscode');
  return vscode;
});
assert.equal(localizeError(new Error('Select files.')), '请选择文件。');
assert.equal(localizeError(Object.assign(new Error('Nested repositories block this operation: src/child, doc/中文 and 2 more.'), {boundaries: Array(5)})), '子仓库阻止此操作：src/child, doc/中文，以及另外 2 个。');
assert.equal(localizeError(Object.assign(new Error('Nested repositories block this operation: doc/name and 2 more.'), {boundaries: Array(1)})), '子仓库阻止此操作：doc/name and 2 more。');
const cliOutput = 'cvs update: conflict in src/中文.txt';
assert.equal(localizeError(new Error(cliOutput)), cliOutput);
console.log('语言回落、中文计数、参数、内核固定错误和 CLI 原文保留检查通过。');

// C2：组件目录尺寸合同；webview 无法继承产品根变量，镜像同名值。
const dimensions = {
  '--etech-row-height': '20px', '--etech-font-size': '12px',
  '--etech-panel-header-height': '28px', '--etech-editor-tabs-height': '30px',
  '--etech-bottom-tabs-height': '28px', '--etech-statusbar-height': '22px',
  '--etech-stripe-width': '34px', '--etech-tool-button': '22px',
  '--etech-vtool-width': '30px', '--etech-indent': '16px'
};
const variables = fs.readFileSync(path.join(root, 'webview/src/shared/theme/variables.css'), 'utf8');
for (const [name, value] of Object.entries(dimensions)) {
  assert.ok(variables.includes(`${name}: ${value};`), `${name} 必须与产品 tokens.css 同步`);
}
const changesCss = fs.readFileSync(path.join(root, 'webview/src/commit/commit.css'), 'utf8');
assert.match(changesCss, /height: var\(--etech-row-height\)/);
assert.match(changesCss, /font-size: var\(--etech-font-size\)/);
assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(changesCss), '本地更改颜色只由宿主提供');
console.log('C2 十个尺寸镜像、行高字号与宿主颜色合同通过。');
