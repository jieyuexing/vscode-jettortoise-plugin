const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {build}=require('esbuild');
const {pathToFileURL}=require('node:url');
const git=(cwd,args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const disposable=()=>({dispose(){}});
class Emitter{listeners=new Set();event=fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)}};fire(value){for(const fn of this.listeners)fn(value)}dispose(){this.listeners.clear()}}
class Uri{
 constructor(scheme,authority,name,query=''){this.scheme=scheme;this.authority=authority;this.path=name;this.query=query;this.fsPath=name}
 static file(name){return new Uri('file','',path.resolve(name))} static from(value){return new Uri(value.scheme,value.authority||'',value.path,value.query||'')} static joinPath(base,...parts){return Uri.file(path.join(base.fsPath,...parts))} static parse(value){const url=new URL(value);return new Uri(url.protocol.slice(0,-1),url.host,decodeURIComponent(url.pathname),url.search.slice(1))}
 toString(){return `${this.scheme}://${this.authority}${this.path}${this.query?'?'+this.query:''}`}
}
async function main(){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'restart-host-'));
 let manager,connection;
 try{
  const root=path.join(base,'workspace');await fs.mkdir(root);
  const createGit=async name=>{const dir=path.join(root,name);await fs.mkdir(dir);git(dir,['init','-b','main']);git(dir,['config','user.name','Restart Fixture']);git(dir,['config','user.email','restart@example.invalid']);for(const file of ['same.txt','excluded.txt'])await fs.writeFile(path.join(dir,file),'base\n');git(dir,['add','.']);git(dir,['commit','-m','base']);return dir;};
  const first=await createGit('git-a'),second=await createGit('git-b');
  const events={save:new Emitter(),focus:new Emitter(),active:new Emitter(),folders:new Emitter()};
  const commands=[];const warnings=[];
  let confirm=async()=>{};
  const vscode={Uri,EventEmitter:Emitter,Disposable:class{constructor(fn){this.dispose=fn}},RelativePattern:class{constructor(base,pattern){this.base=base;this.pattern=pattern}},ProgressLocation:{Notification:1},ViewColumn:{One:1,Active:1},FileSystemError:{NoPermissions:()=>new Error('no permissions')},l10n:{t:(message,...args)=>message.replace(/\{(\d+)\}/g,(_,index)=>args[index]??'')},env:{clipboard:{writeText:async()=>{}}},workspace:{isTrusted:true,workspaceFolders:[{uri:Uri.file(root)}],textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback}),onDidChangeWorkspaceFolders:events.folders.event,onDidGrantWorkspaceTrust:()=>disposable(),onDidSaveTextDocument:events.save.event,createFileSystemWatcher:()=>({onDidChange:()=>disposable(),onDidCreate:()=>disposable(),onDidDelete:()=>disposable(),dispose(){}})},window:{onDidChangeActiveTextEditor:events.active.event,onDidChangeWindowState:events.focus.event,showWarningMessage:async(message,_options,...labels)=>{warnings.push(message);await confirm();return labels[0]},showInformationMessage:()=>{},showErrorMessage:()=>{},showTextDocument:async uri=>{commands.push(['open',uri])},withProgress:(_options,run)=>run({}, {onCancellationRequested:()=>disposable()}),setStatusBarMessage:()=>{},activeTextEditor:undefined},commands:{executeCommand:async(...args)=>{commands.push(args)}}};
  const bundle=path.join(base,'host.cjs');global.__restartVscode=vscode;
  await build({entryPoints:['src/repositories/manager.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,plugins:[{name:'fixture',setup(build){build.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports=global.__restartVscode;'}))}}]});
  const core=await import(pathToFileURL(path.resolve('src/cvs/core.mjs')).href);
  const cvsProcess=new core.CvsProcess(process.env.JETTORTOISE_TEST_CVS||'cvs');
  const repository=path.join(base,'cvs-repository'),seed=path.join(base,'seed'),cvsRoot=`:local:${repository}`,wc=path.join(root,'legacy');
  await fs.mkdir(repository);await fs.mkdir(seed);await cvsProcess.run(['-d',cvsRoot,'init'],base);await fs.writeFile(path.join(seed,'same.txt'),'base\n');await fs.writeFile(path.join(seed,'excluded.txt'),'base excluded\n');await fs.writeFile(path.join(seed,'incoming.txt'),'incoming base\n');await cvsProcess.run(['-d',cvsRoot,'import','-m','base','demo','vendor','start'],seed);await core.checkout(cvsProcess,cvsRoot,'demo',wc);
  const {RepositoryManager}=require(bundle);manager=new RepositoryManager({extensionUri:Uri.file(process.cwd())});
  const sent=[];const subscribers=new Set();let receive;
  connection=manager.connect({postMessage:msg=>{sent.push(msg);for(const fn of subscribers)fn(msg);return Promise.resolve(true)},onDidReceiveMessage:fn=>{receive=fn;return disposable()}});
  const waitFor=(predicate)=>new Promise((resolve,reject)=>{const check=msg=>{if(predicate(msg)){clearTimeout(timer);subscribers.delete(check);resolve(msg)}};const timer=setTimeout(()=>{subscribers.delete(check);reject(new Error('snapshot timeout'))},10000);subscribers.add(check);});
  await manager.scan();await manager.request('refreshRepositories');
  const state=manager.state();assert.equal(state.repositories.length,3);const a=state.repositories.find(r=>r.root===first),b=state.repositories.find(r=>r.root===second),c=state.repositories.find(r=>r.root===wc);assert.ok(a&&b&&c);
  await fs.writeFile(path.join(first,'same.txt'),'git a selected\n');await fs.writeFile(path.join(second,'same.txt'),'git b selected\n');await fs.writeFile(path.join(first,'excluded.txt'),'staged excluded\n');git(first,['add','excluded.txt']);await fs.writeFile(path.join(wc,'same.txt'),'CVS selected text\n');await fs.writeFile(path.join(wc,'excluded.txt'),'CVS excluded text\n');
  await manager.request('refreshRepositories');
  await assert.rejects(manager.request('commitRepositories',{message:'invalid',files:[{repositoryId:a.id,path:'../outside'}]}),/traversal/);
  await assert.rejects(manager.request('commitRepositories',{message:'invalid',files:[{repositoryId:a.id,path:'same.txt',cwd:root}]}),/Invalid selected/);
  await assert.rejects(manager.request('updateProject',{repositoryId:a.id,cwd:root}),/Unexpected/);
  await assert.rejects(manager.request('ignoreUnversioned',{repositoryId:a.id,filePaths:['same.txt']}),/unversioned/);
  await manager.request('commitRepositories',{message:'cross repository selection',files:[a,b,c].map(r=>({repositoryId:r.id,path:'same.txt'}))});
  assert.equal(git(first,['show','HEAD:same.txt']),'git a selected');assert.equal(git(second,['show','HEAD:same.txt']),'git b selected');assert.equal(git(first,['show','HEAD:excluded.txt']),'base');assert.equal(git(first,['diff','--cached','--name-only']),'excluded.txt');
  const history=await manager.request('getCvsHistory',{repositoryId:c.id,filePath:'same.txt'});assert.ok(history.some(r=>r.subject==='cross repository selection'));
  const excludedHistory=await manager.request('getCvsHistory',{repositoryId:c.id,filePath:'excluded.txt'});assert.ok(!excludedHistory.some(r=>r.subject==='cross repository selection'));
  await manager.request('diffCvsRevision',{repositoryId:c.id,filePath:'same.txt',revision:history.find(r=>r.subject==='cross repository selection').revisionId});assert.ok(commands.some(args=>args[0]==='vscode.diff'&&args[1].authority===c.id&&args[2].authority===c.id));
  await manager.request('showDiffForWorkingFile',{repositoryId:c.id,filePath:'same.txt',staged:false});assert.ok(commands.some(args=>args[0]==='vscode.diff'&&args[1].authority===c.id&&args[2].scheme==='file'));
  const peer=await core.checkout(cvsProcess,cvsRoot,'demo',path.join(base,'peer'));await fs.writeFile(path.join(peer,'incoming.txt'),'remote incoming update\n');await new core.CvsAdapter(peer,cvsProcess).commit(['incoming.txt'],'remote incoming');
  const incoming=waitFor(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===c.id&&msg.data.files.some(file=>file.path==='incoming.txt'&&file.status==='incoming'));
  await manager.request('refreshRepositories');await incoming;
  await assert.rejects(manager.request('commitRepositories',{message:'forbidden incoming',files:[{repositoryId:c.id,path:'incoming.txt'}]}),/cannot be committed/);
  const unknown=path.join(wc,'.gradle');await fs.mkdir(path.join(unknown,'cache'),{recursive:true});await fs.writeFile(path.join(unknown,'cache','huge.bin'),'unknown\n');
  const adapter=new core.CvsAdapter(wc,{run:()=>assert.fail('local refresh invoked CVS')});
  const originalReaddir=fs.readdir;let enumerated=false;fs.readdir=async(name,...args)=>{if(String(name)===unknown)enumerated=true;return originalReaddir(name,...args)};
  try{const local=await adapter.localStatus();assert.equal(enumerated,false,'unknown directory was enumerated before expand');assert.deepEqual(local.filter(f=>f.state==='Unknown').map(f=>f.newPath),['.gradle/']);}finally{fs.readdir=originalReaddir}
  await manager.request('refreshRepositories');const children=await manager.request('expandUnversioned',{repositoryId:c.id,filePath:'.gradle'});assert.deepEqual(children.map(f=>[f.path,f.directory]),[['.gradle/cache',true]]);
  await manager.request('ignoreUnversioned',{repositoryId:c.id,filePaths:['.gradle/cache/huge.bin']});assert.match(await fs.readFile(path.join(wc,'.cvsignore'),'utf8'),/^\.gradle$/m);await assert.rejects(fs.access(path.join(unknown,'.cvsignore')));
  const cvsSession=manager.entries.get(c.id).cvs;
  await cvsSession.operate('fixture queue barrier',async()=>{});
  const cvsRunner=cvsSession.adapter.process,originalRun=cvsRunner.run.bind(cvsRunner);let networkRuns=0;
  cvsRunner.run=async(...args)=>{networkRuns++;return originalRun(...args)};
  const focusSnapshot=waitFor(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===c.id&&!msg.data.refreshing);
  events.focus.fire({focused:true});await focusSnapshot;assert.equal(networkRuns,0,'focus refresh invoked CVS');
  const originalLocal=cvsSession.adapter.localStatus.bind(cvsSession.adapter);const pathsRead=[];cvsSession.adapter.localStatus=async paths=>{pathsRead.push(paths);return originalLocal(paths)};
  // 焦点只走本地；保存只读取这一文件，未保存编辑器阻止提交。
  const savedBefore=sent.length;events.save.fire({uri:Uri.file(path.join(wc,'same.txt'))});await waitFor(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===c.id);assert.ok(sent.length>savedBefore);assert.deepEqual(pathsRead.at(-1),['same.txt']);assert.equal(networkRuns,0,'save invoked CVS');cvsSession.adapter.localStatus=originalLocal;cvsRunner.run=originalRun;
  await manager.request('rollbackFiles',{repositoryId:c.id,filePaths:['excluded.txt']});const backups=(await fs.readdir(wc)).filter(file=>file.startsWith('excluded.txt.jettortoise-backup-'));assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(wc,backups[0]),'utf8'),'CVS excluded text\n');
  vscode.workspace.textDocuments=[{isDirty:true,uri:Uri.file(path.join(second,'same.txt'))}];await fs.writeFile(path.join(second,'same.txt'),'dirty editor candidate\n');await manager.request('refreshRepositories');await assert.rejects(manager.request('commitRepositories',{message:'dirty',files:[{repositoryId:b.id,path:'same.txt'}]}),/unsaved/);vscode.workspace.textDocuments=[];
  // 同项目 build 不登记、不出现在父清单，仍拦住整树 update。
  const buildDir=path.join(wc,'build');await fs.mkdir(path.join(buildDir,'CVS'),{recursive:true});await fs.writeFile(path.join(buildDir,'CVS','Root'),cvsRoot+'\n');await fs.writeFile(path.join(buildDir,'CVS','Repository'),'demo/build\n');await fs.writeFile(path.join(buildDir,'CVS','Entries'),'');await fs.writeFile(path.join(buildDir,'sentinel.txt'),'protected\n');
  await manager.scan();await manager.request('refreshRepositories');assert.ok(!manager.repositories.some(r=>r.root===buildDir));assert.ok(manager.state().snapshots.find(s=>s.repositoryId===c.id).files.every(f=>!f.path.startsWith('build')));await manager.request('selectRepository',{repositoryId:c.id,surface:'commit'});await assert.rejects(manager.request('updateProject'),/Nested/);assert.equal(await fs.readFile(path.join(buildDir,'sentinel.txt'),'utf8'),'protected\n');
  // 一个根失效不能清空其它仓库；移除/失信后拒绝新操作。
  await fs.rename(path.join(first,'.git'),path.join(first,'git-away'));await manager.request('refreshRepositories');assert.ok(manager.state().snapshots.find(s=>s.repositoryId===a.id).error);assert.ok(manager.state().snapshots.find(s=>s.repositoryId===b.id).files.some(f=>f.path==='same.txt'));
  vscode.workspace.isTrusted=false;await assert.rejects(manager.request('commitRepositories',{message:'untrusted',files:[{repositoryId:b.id,path:'same.txt'}]}),/trusted/);vscode.workspace.isTrusted=true;
  await receive({type:'request',id:'bad',command:'updateProject',params:{repositoryId:b.id,root:'/elsewhere'}});assert.equal(sent.at(-1).success,false);
  const beforeDisposed=await fs.readFile(path.join(second,'same.txt'),'utf8');confirm=async()=>connection.dispose();await receive({type:'request',id:'closed-confirmation',command:'rollbackFiles',params:{repositoryId:b.id,filePaths:['same.txt']}});assert.equal(await fs.readFile(path.join(second,'same.txt'),'utf8'),beforeDisposed,'disposed view still rolled back a file');
  console.log(JSON.stringify({multiRepository:true,selectedPaths:true,indexPreserved:true,cvsHistory:true,revisionDiff:true,lazyUnknownDirectory:true,ignoreAtManagedParent:true,nestedWriteProtection:true,isolatedErrors:true,dirtyEditors:true,untrusted:true,localOnlyFocus:true,targetedSave:true,incomingCannotCommit:true,rollbackBackup:true,confirmationLiveness:true}));
 }finally{connection?.dispose();manager?.dispose();delete global.__restartVscode;await fs.rm(base,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
