const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../packages/vcs-ui');
const allowed = ['react', 'react-dom', 'allotment', 'allotment/dist/style.css', '@tanstack/react-virtual'];
let checked = 0;
function walk(at) {
  for (const item of fs.readdirSync(at, {withFileTypes:true})) {
    const filename = path.join(at, item.name);
    if (item.isDirectory()) { walk(filename); continue; }
    if (!/\.tsx?$/.test(item.name)) continue;
    checked++;
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.')) {
          assert.ok(path.resolve(path.dirname(filename), specifier).startsWith(root + path.sep), `Import escapes shared UI: ${filename}: ${specifier}`);
        } else assert.ok(allowed.includes(specifier), `Backend or undeclared dependency in UI: ${filename}: ${specifier}`);
      }
      if (ts.isJsxText(node)) assert.ok(!/[A-Za-z]{2}/.test(node.text.replace(/&[^;]+;/g, '').trim()), `Untranslated shared JSX: ${filename}`);
      if (ts.isJsxAttribute(node) && ['title','label','placeholder','aria-label'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer)) {
        assert.ok(!/[A-Za-z]{2}/.test(node.initializer.text), `Untranslated shared attribute: ${filename}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
walk(path.join(root, 'src'));
const themeAdapter = fs.readFileSync(path.join(root, '../../webview/src/shared/theme/variables.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
assert.match(themeAdapter, /^@import ["']\.\.\/\.\.\/\.\.\/\.\.\/packages\/vcs-ui\/src\/theme\.css["'];$/);
const moduleObject = { exports: {} };
new Function('exports','module',ts.transpileModule(fs.readFileSync(path.join(root,'src/i18n.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(moduleObject.exports,moduleObject);
const {vcsUiEn,vcsUiZhCn,createVcsTranslator} = moduleObject.exports;
assert.deepEqual(Object.keys(vcsUiEn).sort(),Object.keys(vcsUiZhCn).sort());
for (const key of Object.keys(vcsUiEn)) {
  const params = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).filter(name=>name!=='plural').sort();
  assert.deepEqual(params(vcsUiEn[key]),params(vcsUiZhCn[key]),`Shared placeholder mismatch: ${key}`);
  assert.ok(vcsUiZhCn[key].trim());
}
for (const language of ['en','zh','zh-cn','zh-tw','de']) {
  const translate = createVcsTranslator(language);
  assert.equal(typeof translate('__missing_key__'), 'string');
  assert.notEqual(translate('__missing_key__'),'__missing_key__');
}
assert.ok(fs.existsSync(path.join(root,'LICENSE')),'Shared snapshots must carry their license');
console.log(JSON.stringify({sharedSourceFiles:checked,sharedTranslationKeys:Object.keys(vcsUiEn).length,noBackendImports:true,localeFallback:true}));
