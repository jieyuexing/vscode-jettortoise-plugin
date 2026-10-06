// Compare literal frontend request fields and surfaces with the production Host schema.
const ts = require('typescript'), fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const host = ts.createSourceFile('router.ts', fs.readFileSync(path.join(root,'src/messages/messageRouter.ts'),'utf8'), ts.ScriptTarget.Latest, true);
const constants={}, specs={};
function names(node) { if (!node) return ['panel']; if(ts.isAsExpression(node))return names(node.expression); if(ts.isArrayLiteralExpression(node))return node.elements.map(x=>x.text);return constants[node.getText(host)]; }
function hostVisit(node) {
 if(ts.isVariableDeclaration(node)) {
  if(node.initializer && (ts.isArrayLiteralExpression(node.initializer)||ts.isAsExpression(node.initializer)))constants[node.name.getText(host)]=names(node.initializer);
  if(node.name.getText(host)==='SPECS')for(const property of node.initializer.properties){const call=property.initializer;specs[property.name.getText(host)]={surfaces:names(call.arguments[0]),fields:call.arguments[1]?.properties?.map(x=>x.name.getText(host))||[]};}
 }
 ts.forEachChild(node,hostVisit);
}hostVisit(host);
let calls=0;
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})) {const file=path.join(dir,e.name);if(e.isDirectory()){walk(file);continue;}if(!/\.tsx?$/.test(file)||file.includes('.test.'))continue;
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='bridge.request'&&ts.isStringLiteral(node.arguments[0])){
   const command=node.arguments[0].text, spec=specs[command];assert.ok(spec,`Missing command ${command}`);calls++;
   const params=node.arguments[1];if(params&&ts.isObjectLiteralExpression(params))for(const field of params.properties)if(field.name)assert.ok(spec.fields.includes(field.name.getText(source)),`${file}: ${command}.${field.name.getText(source)}`);
   const surface=file.includes('/push/')?'push':file.includes('/rollback/')?'rollback':file.endsWith('/conflicts/MergeStandaloneApp.tsx')?'merge':file.endsWith('/conflicts/App.tsx')?'conflicts':file.includes('/panel/')||file.includes('/commit/')||file.endsWith('/shared/store/commit-store.ts')||file.endsWith('/shared/store/panel-store.ts')?'panel':undefined;
   if(surface)assert.ok(spec.surfaces.includes(surface),`${file}: ${command} cannot run on ${surface}`);
 }ts.forEachChild(node,visit);}visit(source);
}}
walk(path.join(root,'webview/src'));console.log(JSON.stringify({frontendLiteralRequests:calls,fieldAndSurfaceContracts:true}));
