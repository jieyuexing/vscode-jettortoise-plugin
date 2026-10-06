// Validate the resource contracts without changing source files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const manifest = read('package.json');
const en = read('package.nls.json');
const zh = read('package.nls.zh-cn.json');
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
for (const [base, translation] of [[en, zh], [read('l10n/bundle.l10n.json'), read('l10n/bundle.l10n.zh-cn.json')]]) {
  assert.deepEqual(Object.keys(base).sort(), Object.keys(translation).sort(), 'Translation key mismatch');
  for (const key of Object.keys(base)) {
    const source = typeof base[key] === 'string' ? base[key] : base[key].message;
    const target = typeof translation[key] === 'string' ? translation[key] : translation[key].message;
    assert.ok(target.trim(), `Empty translation: ${key}`);
    assert.deepEqual(placeholders(source), placeholders(target), `Placeholder mismatch: ${key}`);
  }
}
for (const match of JSON.stringify(manifest.contributes).matchAll(/%([^%]+)%/g)) {
  assert.ok(en[match[1]] && zh[match[1]], `Missing manifest key: ${match[1]}`);
}
const bundle = read('l10n/bundle.l10n.json');
let calls = 0;
function visitFile(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.l10n.t') {
      calls++;
      const first = node.arguments[0];
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
        assert.ok(Object.hasOwn(bundle, first.text), `Unbundled host text in ${file}: ${first.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) walk(file);
    else if (file.endsWith('.ts') && !file.includes(`${path.sep}test${path.sep}`)) visitFile(file);
  }
}
walk(path.join(root, 'src'));
for (const locale of ['zh', 'zh-tw']) {
  assert.deepEqual(read(`package.nls.${locale}.json`), zh);
  assert.deepEqual(read(`l10n/bundle.l10n.${locale}.json`), read('l10n/bundle.l10n.zh-cn.json'));
}
console.log(`Manifest keys: ${Object.keys(en).length}; host l10n calls: ${calls}; resource checks passed.`);

const localeFile = path.join(root, 'webview/src/shared/i18n/locales.ts');
const localeModule = {exports: {}};
// Load this project's literal dictionaries through its existing TypeScript toolchain.
new Function('exports', 'module', ts.transpileModule(fs.readFileSync(localeFile, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText)(localeModule.exports, localeModule);
const webEn = localeModule.exports.en;
const webZh = localeModule.exports.zhCn;
assert.deepEqual(Object.keys(webEn).sort(), Object.keys(webZh).sort());
for (const key of Object.keys(webEn)) {
  assert.ok(webZh[key].trim(), `Empty webview translation: ${key}`);
  // English plural suffixes are intentionally absent from Chinese grammar.
  assert.deepEqual(placeholders(webEn[key]).filter(x => x !== 'plural'), placeholders(webZh[key]).filter(x => x !== 'plural'), `Webview placeholder mismatch: ${key}`);
}
let webCalls = 0;
function checkWeb(dir) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) { checkWeb(file); continue; }
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file) || file === localeFile) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) {
        webCalls++;
        assert.ok(Object.hasOwn(webEn, node.arguments[0].text), `Unknown webview key: ${node.arguments[0].text}`);
      }
      if (ts.isJsxText(node)) assert.ok(!/[A-Za-z]{2}/.test(node.text.replace(/&[^;]+;/g, '').trim()), `Untranslated JSX in ${file}: ${node.text.trim()}`);
      if (ts.isJsxAttribute(node) && ['title', 'text', 'label', 'placeholder', 'clearLabel', 'aria-label'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        assert.ok(!/[A-Za-z]{2}/.test(node.initializer.text), `Untranslated attribute in ${file}: ${node.initializer.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
checkWeb(path.join(root, 'webview/src'));
console.log(`Webview keys: ${Object.keys(webEn).length}; static t calls: ${webCalls}; JSX/attribute coverage passed.`);

const cvsModule = {exports: {}};
new Function('exports','module',ts.transpileModule(fs.readFileSync(path.join(root,'webview/src/cvs/i18n.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(cvsModule.exports,cvsModule);
const {cvsEn,cvsZhCn,cvsT} = cvsModule.exports;
assert.deepEqual(Object.keys(cvsEn).sort(),Object.keys(cvsZhCn).sort());
for (const key of Object.keys(cvsEn)) {
  assert.ok(cvsZhCn[key].trim());
  assert.deepEqual(placeholders(cvsEn[key]),placeholders(cvsZhCn[key]));
}
for (const language of ['zh','zh-cn','zh-tw']) assert.equal(cvsT(language,'commit'),'提交');
for (const language of ['en','de','zh-hk']) assert.equal(cvsT(language,'commit'),'Commit');
assert.notEqual(cvsT('zh-cn','missing-key'),'missing-key');
console.log(`CVS dictionary keys: ${Object.keys(cvsEn).length}; locale fallback passed.`);
