const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const Module = require("node:module");
const result = buildSync({entryPoints:["webview/src/shared/models/changes.ts"],bundle:true,platform:"node",format:"cjs",write:false});
const model = new Module("grouping-check", module);
model._compile(result.outputFiles[0].text, "grouping-model.cjs");
const { groupChanges, fileKey, canCommit, initialSelection } = model.exports;
const repos = [{id:"a",root:"/work/a",kind:"git",name:"a"},{id:"b",root:"/work/b",kind:"cvs",name:"b"}];
const f = (path,status="modified",extra={}) => ({path,status,staged:false,...extra});
const snapshots = [
 {repositoryId:"a",files:[f("root.txt"),f("src/a.txt"),f("docs/b.txt"),f("new.txt","untracked"),f(".gradle/","untracked",{directory:true}),f(".gradle/cache/a","untracked"),f("nested/no.txt")],nestedPaths:["nested"]},
 {repositoryId:"b",files:[f("src/a.txt"),f("remote.txt","incoming"),f("build/no.txt")],nestedPaths:["build"]}
];
const groups = groupChanges(repos,snapshots);
assert.equal(groups.length,2);
assert.deepEqual(groups[0].directories.map(d=>d.path),["docs","src"]);
assert.equal(groups[0].count,3);
assert.deepEqual(groups[0].rootFiles.map(f=>f.path),["root.txt"]);
assert.deepEqual(groups[1].rootFiles,[]);
assert.ok(groups.every(g=>g.directories.every(d=>d.path!==".")));
assert.equal(groups[0].rootFiles.length+groups[0].directories.reduce((n,d)=>n+d.files.length,0),groups[0].count);
assert.equal(groups[1].count,1);
assert.equal(groups[0].unversioned.length,2);
assert.equal(groups[0].unversioned.filter(f=>f.directory).length,1);
assert.equal(groups[0].unversioned.find(f=>f.directory).path,".gradle/");
assert.equal(groups[1].incoming.length,1);
assert.equal(canCommit(groups[1].incoming[0]),false);
assert.deepEqual([...initialSelection(groups)],[]);
assert.notEqual(fileKey({...f("same"),repositoryId:"a"}),fileKey({...f("same"),repositoryId:"b"}));
assert.ok(groups.every(g=>![...g.changes,...g.unversioned,...g.incoming].some(f=>f.path.includes("no.txt"))));
assert.equal(groups[0].unversionedExpanded,false);
assert.equal(groups[1].incomingExpanded,false);
process.stdout.write("Repository/directory grouping, lazy directories, exclusions and selection checks passed.\n");
