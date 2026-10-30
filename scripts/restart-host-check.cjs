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
 const activationSubscriptions=[];
 let historyCleanups=[];
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
  await fs.mkdir(repository);await fs.mkdir(seed);await cvsProcess.run(['-d',cvsRoot,'init'],base);await fs.writeFile(path.join(seed,'same.txt'),'base\n');await fs.writeFile(path.join(seed,'excluded.txt'),'base excluded\n');await fs.writeFile(path.join(seed,'incoming.txt'),'incoming base\n');await fs.writeFile(path.join(seed,'unchanged.txt'),'unchanged base\n');await fs.writeFile(path.join(seed,'saved-during.txt'),'save base\n');await cvsProcess.run(['-d',cvsRoot,'import','-m','base','demo','vendor','start'],seed);await core.checkout(cvsProcess,cvsRoot,'demo',wc);
  const {RepositoryManager}=require(bundle);manager=new RepositoryManager({extensionUri:Uri.file(process.cwd())});
  const sent=[];const subscribers=new Set();let receive;
  connection=manager.connect({postMessage:msg=>{sent.push(msg);for(const fn of subscribers)fn(msg);return Promise.resolve(true)},onDidReceiveMessage:fn=>{receive=fn;return disposable()}});
  const waitFor=(predicate)=>new Promise((resolve,reject)=>{const check=msg=>{if(predicate(msg)){clearTimeout(timer);subscribers.delete(check);resolve(msg)}};const timer=setTimeout(()=>{subscribers.delete(check);reject(new Error('snapshot timeout'))},10000);subscribers.add(check);});
  await manager.scan();await manager.request('refreshRepositories');
  const state=manager.state();assert.equal(state.repositories.length,3);const a=state.repositories.find(r=>r.root===first),b=state.repositories.find(r=>r.root===second),c=state.repositories.find(r=>r.root===wc);assert.ok(a&&b&&c);
  // 资源命令必须选择右键资源所属仓库，不能沿用前一个编辑器/提交区的仓库。
  for (const command of ['jettortoise.updateProject', 'jettortoise.openCommitPanel', 'jettortoise.openHistory'])
    assert.ok(require('../package.json').contributes.commands.some(item=>item.command===command), 'missing public command '+command);
  await manager.execute('jettortoise.openCommitPanel',Uri.file(second));
  assert.equal(manager.state().commitRepositoryId,b.id);
  assert.equal(commands.at(-1)[0],'jettortoise.commitPanel.focus');
  await manager.execute('jettortoise.showFileHistory',Uri.file(path.join(first,'same.txt')));
  assert.equal(manager.state().logRepositoryId,a.id);assert.equal(manager.state().activeFile,'same.txt');
  await manager.execute('jettortoise.openHistory',Uri.file(wc));
  assert.equal(manager.state().logRepositoryId,c.id);assert.equal(manager.state().activeFile,undefined);
  let resourceUpdates=0;const resourceSession=manager.entries.get(b.id).git;const originalResourceUpdate=resourceSession.update;
  resourceSession.update=async()=>{resourceUpdates++};
  try {await manager.execute('jettortoise.updateProject',Uri.file(second));assert.equal(resourceUpdates,1)} finally {resourceSession.update=originalResourceUpdate}
  await assert.rejects(manager.execute('jettortoise.openCommitPanel',Uri.file(base)),/available repository/);
  await assert.rejects(manager.execute('jettortoise.updateProject',Uri.parse('https://example.invalid/demo')),/available repository/);
  vscode.workspace.isTrusted=false;
  await assert.rejects(manager.execute('jettortoise.openHistory',Uri.file(first)),/trusted/);vscode.workspace.isTrusted=true;
  // 真实 :local: CVS：时间戳假修改须消失，网络返回前保存的另一个文件须保留。
  const refreshSession=manager.entries.get(c.id).cvs;
  await refreshSession.network;
  const unchangedPath=path.join(wc,'unchanged.txt');
  const unchangedStat=await fs.stat(unchangedPath);
  await fs.utimes(unchangedPath,unchangedStat.atime,new Date(unchangedStat.mtimeMs+2000));
  await refreshSession.refresh();
  assert.ok(manager.state().snapshots.find(s=>s.repositoryId===c.id).files.some(f=>f.path==='unchanged.txt'&&f.status==='modified'),'local timestamp mismatch must first appear as modified');
  const raceRunner=refreshSession.adapter.process,raceOriginal=raceRunner.run.bind(raceRunner);
  let releaseNetwork,networkReturned;
  const networkGate=new Promise(resolve=>{releaseNetwork=resolve});
  const networkReady=new Promise(resolve=>{networkReturned=resolve});
  raceRunner.run=async(...args)=>{
    const output=await raceOriginal(...args);
    assert.ok(!output.stdout.toString('utf8').includes('unchanged.txt'),'real CVS must confirm unchanged content');
    networkReturned();
    await networkGate;
    return output;
  };
  try{
    await refreshSession.refresh(undefined,true);
    await networkReady;
    const savedPath=path.join(wc,'saved-during.txt');
    const savedStat=await fs.stat(savedPath);
    await fs.writeFile(savedPath,'saved after network started\n');
    await fs.utimes(savedPath,savedStat.atime,new Date(savedStat.mtimeMs+4000));
    await refreshSession.refresh(['saved-during.txt']);
    releaseNetwork();await refreshSession.network;
    const afterNetwork=manager.state().snapshots.find(s=>s.repositoryId===c.id).files;
    assert.ok(!afterNetwork.some(f=>f.path==='unchanged.txt'),'network-confirmed clean file remained in Changes');
    assert.ok(afterNetwork.some(f=>f.path==='saved-during.txt'&&f.status==='modified'),'save during network was overwritten');
    await refreshSession.refresh();
    assert.ok(!manager.state().snapshots.find(s=>s.repositoryId===c.id).files.some(f=>f.path==='unchanged.txt'),'local refresh resurrected network-confirmed clean file');
  }finally{releaseNetwork();await refreshSession.network;raceRunner.run=raceOriginal}

  await fs.writeFile(path.join(first,'same.txt'),'git a selected\n');await fs.writeFile(path.join(second,'same.txt'),'git b selected\n');await fs.writeFile(path.join(first,'excluded.txt'),'staged excluded\n');git(first,['add','excluded.txt']);await fs.writeFile(path.join(wc,'same.txt'),'CVS selected text\n');await fs.writeFile(path.join(wc,'excluded.txt'),'CVS excluded text\n');
  await manager.request('refreshRepositories');
  await assert.rejects(manager.request('commitRepositories',{message:'invalid',files:[{repositoryId:a.id,path:'../outside'}]}),/traversal/);
  await assert.rejects(manager.request('commitRepositories',{message:'invalid',files:[{repositoryId:a.id,path:'same.txt',cwd:root}]}),/Invalid selected/);
  await assert.rejects(manager.request('updateProject',{repositoryId:a.id,cwd:root}),/Unexpected/);
  await assert.rejects(manager.request('ignoreUnversioned',{repositoryId:a.id,filePaths:['same.txt']}),/unversioned/);
  // 挂载 CVS 历史的真实 effect/bridge 合同；Hook fixture 不代表真实窗口渲染。
  const historyEffects=[],historyRequests=[];let stateIndex=0,latestHistory=[];
  const historyBridge={request:(command,params)=>{const request=manager.request(command,params).then(result=>{if(command==='getCvsHistory')latestHistory=result;return result});historyRequests.push({command,request});return request},onEvent:handler=>{const listener=msg=>{if(msg.type==='event')handler(msg.event,msg.data)};subscribers.add(listener);return()=>subscribers.delete(listener)}};
  global.__restartHistory={bridge:historyBridge,react:{useState:initial=>[stateIndex++===1?'same.txt':initial,()=>{}],useRef:value=>({current:value}),useCallback:fn=>fn,useEffect:fn=>historyEffects.push(fn)}};
  const historyBundle=path.join(base,'history.cjs');
  await build({entryPoints:['webview/src/panel/components/CvsHistory.tsx'],bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:historyBundle,plugins:[{name:'history-fixture',setup(build){build.onResolve({filter:/^(react(?:\/jsx-runtime)?|.*shared\/bridge)$/},args=>({path:args.path,namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='react'?'module.exports=global.__restartHistory.react;':args.path==='react/jsx-runtime'?'exports.jsx=exports.jsxs=()=>null;':'exports.bridge=global.__restartHistory.bridge;'}))}}]});
  require(historyBundle).CvsHistory({repositoryId:c.id,activeFile:'same.txt'});
  historyCleanups=historyEffects.map(effect=>effect()).filter(fn=>typeof fn==='function');
  const drainHistory=async()=>{for(let index=0;index<historyRequests.length;index++)await historyRequests[index].request};
  await drainHistory();const historyReadsBefore=historyRequests.filter(item=>item.command==='getCvsHistory').length;
  manager.broadcast('repositoryWritten',{repositoryId:a.id});await drainHistory();assert.equal(historyRequests.filter(item=>item.command==='getCvsHistory').length,historyReadsBefore,'other repository refreshed CVS history');
  await manager.request('showDiffForWorkingFile',{repositoryId:c.id,filePath:'same.txt',staged:false});
  const baseDiff=commands.findLast(args=>args[0]==='vscode.diff'&&args[1].authority===c.id);
  const baseUri=baseDiff[1];vscode.workspace.textDocuments=[{uri:baseUri,isDirty:false}];
  const changedUris=[];manager.onDidChangeRevision(uri=>changedUris.push(uri));
  assert.equal(Buffer.from(await manager.readFile(baseUri)).toString(),'base\n');
  await manager.request('commitRepositories',{message:'cross repository selection',files:[a,b,c].map(r=>({repositoryId:r.id,path:'same.txt'}))});
  assert.equal(git(first,['show','HEAD:same.txt']),'git a selected');assert.equal(git(second,['show','HEAD:same.txt']),'git b selected');assert.equal(git(first,['show','HEAD:excluded.txt']),'base');assert.equal(git(first,['diff','--cached','--name-only']),'excluded.txt');
  assert.equal(Buffer.from(await manager.readFile(baseUri)).toString(),'CVS selected text\n','open BASE did not resolve the new Entries revision');
  assert.ok(changedUris.some(uri=>uri.toString()===baseUri.toString()),'open revision URI was not invalidated');
  assert.ok(sent.some(msg=>msg.event==='repositoryWritten'&&msg.data.repositoryId===c.id),'CVS history has no write notification');
  assert.match(baseDiff[3], /BASE ↔ working tree/);
  await drainHistory();assert.equal(historyRequests.filter(item=>item.command==='getCvsHistory').length,historyReadsBefore+1,'visible history was not re-requested after commit');assert.ok(latestHistory.some(row=>row.subject==='cross repository selection'),'reloaded history lacks new revision');
  for(const cleanup of historyCleanups)cleanup();historyCleanups=[];const requestCount=historyRequests.length;manager.broadcast('repositoryWritten',{repositoryId:c.id});assert.equal(historyRequests.length,requestCount,'unmounted history retained subscription');

  vscode.workspace.textDocuments=[];
  const history=await manager.request('getCvsHistory',{repositoryId:c.id,filePath:'same.txt'});assert.ok(history.some(r=>r.subject==='cross repository selection'));
  const excludedHistory=await manager.request('getCvsHistory',{repositoryId:c.id,filePath:'excluded.txt'});assert.ok(!excludedHistory.some(r=>r.subject==='cross repository selection'));
  await manager.request('diffCvsRevision',{repositoryId:c.id,filePath:'same.txt',revision:history.find(r=>r.subject==='cross repository selection').revisionId});assert.ok(commands.some(args=>args[0]==='vscode.diff'&&args[1].authority===c.id&&args[2].authority===c.id));
  await manager.request('showDiffForWorkingFile',{repositoryId:c.id,filePath:'same.txt',staged:false});assert.ok(commands.some(args=>args[0]==='vscode.diff'&&args[1].authority===c.id&&args[2].scheme==='file'));
  const peer=await core.checkout(cvsProcess,cvsRoot,'demo',path.join(base,'peer'));await fs.writeFile(path.join(peer,'incoming.txt'),'remote incoming update\n');await new core.CvsAdapter(peer,cvsProcess).commit(['incoming.txt'],'remote incoming');
  const incoming=waitFor(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===c.id&&msg.data.files.some(file=>file.path==='incoming.txt'&&file.status==='incoming'));
  await manager.request('refreshRepositories');await incoming;
  await assert.rejects(manager.request('commitRepositories',{message:'forbidden incoming',files:[{repositoryId:c.id,path:'incoming.txt'}]}),/cannot be committed/);
  await manager.request('showDiffForWorkingFile',{repositoryId:c.id,filePath:'incoming.txt',staged:false});
  const incomingBase=commands.findLast(args=>args[0]==='vscode.diff'&&args[1].authority===c.id)[1];
  assert.equal(Buffer.from(await manager.readFile(incomingBase)).toString(),'incoming base\n');
  const beforeUpdate=changedUris.length;
  await manager.execute('jettortoise.updateProject',Uri.file(wc));
  assert.ok(changedUris.slice(beforeUpdate).some(uri=>uri.toString()===incomingBase.toString()),'update did not invalidate BASE');
  assert.equal(Buffer.from(await manager.readFile(incomingBase)).toString(),'remote incoming update\n');
  const otherRevision=Uri.from({scheme:'jettortoise',authority:a.id,path:'/same.txt',query:'ref=HEAD'});await manager.readFile(otherRevision);
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
  const beforeRollback=changedUris.length;await manager.request('rollbackFiles',{repositoryId:c.id,filePaths:['excluded.txt']});assert.ok(changedUris.length>beforeRollback,'rollback did not invalidate revision content');assert.ok(changedUris.slice(beforeRollback).every(uri=>uri.authority===c.id),'CVS rollback invalidated another repository');const backups=(await fs.readdir(wc)).filter(file=>file.startsWith('excluded.txt.jettortoise-backup-'));assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(wc,backups[0]),'utf8'),'CVS excluded text\n');
  vscode.workspace.textDocuments=[{isDirty:true,uri:Uri.file(path.join(second,'same.txt'))}];await fs.writeFile(path.join(second,'same.txt'),'dirty editor candidate\n');await manager.request('refreshRepositories');await assert.rejects(manager.request('commitRepositories',{message:'dirty',files:[{repositoryId:b.id,path:'same.txt'}]}),/unsaved/);vscode.workspace.textDocuments=[];
  // 未登记 build 不出现在父清单，显式 -l 更新跳过它；登记后的异 Root 仍拦截。
  const buildDir=path.join(wc,'build');await fs.mkdir(path.join(buildDir,'CVS'),{recursive:true});await fs.writeFile(path.join(buildDir,'CVS','Root'),cvsRoot+'\n');await fs.writeFile(path.join(buildDir,'CVS','Repository'),'demo/build\n');await fs.writeFile(path.join(buildDir,'CVS','Entries'),'');await fs.writeFile(path.join(buildDir,'sentinel.txt'),'protected\n');
  await manager.scan();await manager.request('refreshRepositories');assert.ok(!manager.repositories.some(r=>r.root===buildDir));assert.ok(manager.state().snapshots.find(s=>s.repositoryId===c.id).files.every(f=>!f.path.startsWith('build')));await manager.request('selectRepository',{repositoryId:c.id,surface:'commit'});await manager.request('updateProject');assert.equal(await fs.readFile(path.join(buildDir,'sentinel.txt'),'utf8'),'protected\n');
  await fs.appendFile(path.join(wc,'CVS','Entries'),'D/build////\n');await fs.writeFile(path.join(buildDir,'CVS','Root'),':local:/foreign-update-fixture\n');
  await assert.rejects(manager.request('updateProject'),error=>{assert.match(error.message,/Nested.*build/);assert.ok(!error.message.includes(wc));return true});assert.equal(await fs.readFile(path.join(buildDir,'sentinel.txt'),'utf8'),'protected\n');
  // 一个根失效不能清空其它仓库；移除/失信后拒绝新操作。
  await fs.rename(path.join(first,'.git'),path.join(first,'git-away'));await manager.request('refreshRepositories');assert.ok(manager.state().snapshots.find(s=>s.repositoryId===a.id).error);assert.ok(manager.state().snapshots.find(s=>s.repositoryId===b.id).files.some(f=>f.path==='same.txt'));
  vscode.workspace.isTrusted=false;await assert.rejects(manager.request('commitRepositories',{message:'untrusted',files:[{repositoryId:b.id,path:'same.txt'}]}),/trusted/);vscode.workspace.isTrusted=true;
  await receive({type:'request',id:'bad',command:'updateProject',params:{repositoryId:b.id,root:'/elsewhere'}});assert.equal(sent.at(-1).success,false);
  const beforeDisposed=await fs.readFile(path.join(second,'same.txt'),'utf8');confirm=async()=>connection.dispose();await receive({type:'request',id:'closed-confirmation',command:'rollbackFiles',params:{repositoryId:b.id,filePaths:['same.txt']}});assert.equal(await fs.readFile(path.join(second,'same.txt'),'utf8'),beforeDisposed,'disposed view still rolled back a file');
  const originalReaddirForActivation=fs.readdir;let releaseDiscovery,discoveryStarted;
  const discoveryGate=new Promise(resolve=>{releaseDiscovery=resolve}),discoveryReady=new Promise(resolve=>{discoveryStarted=resolve});
  const registeredViews=[];let textProvider,fileProvider;const fileChanges=[];
  Object.assign(vscode,{FileType:{File:1},FileChangeType:{Changed:1},StatusBarAlignment:{Left:1}});
  vscode.workspace.registerTextDocumentContentProvider=(_scheme,provider)=>{textProvider=provider;return disposable()};
  vscode.workspace.registerFileSystemProvider=(_scheme,provider)=>{fileProvider=provider;provider.onDidChangeFile(changes=>fileChanges.push(...changes));return disposable()};
  vscode.window.registerWebviewViewProvider=(_id,provider)=>{registeredViews.push(provider);return disposable()};
  vscode.window.createStatusBarItem=()=>({...disposable(),show(){}});vscode.commands.registerCommand=()=>disposable();
  const activationBundle=path.join(base,'activation.cjs');await build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',outfile:activationBundle,plugins:[{name:'fixture',setup(build){build.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports=global.__restartVscode;'}))}}]});
  fs.readdir=async(name,...args)=>{if(String(name)===root){discoveryStarted();await discoveryGate}return originalReaddirForActivation(name,...args)};
  try{
    require(activationBundle).activate({extensionUri:Uri.file(process.cwd()),subscriptions:activationSubscriptions});
    const restoredRead=textProvider.provideTextDocumentContent(baseUri);await discoveryReady;releaseDiscovery();
    assert.equal(await restoredRead,'CVS selected text\n','restored URI read raced discovery');
    assert.equal(Buffer.from(await fileProvider.readFile(baseUri)).toString(),'CVS selected text\n');
    const textChanges=[];textProvider.onDidChange(uri=>textChanges.push(uri));
    const restoredManager=registeredViews[0].manager,restoredEntry=restoredManager.entries.get(c.id);
    restoredManager.written(restoredEntry);
    assert.ok(textChanges.some(uri=>uri.toString()===baseUri.toString()));assert.ok(fileChanges.some(change=>change.uri.toString()===baseUri.toString()&&change.type===1));
  }finally{releaseDiscovery();fs.readdir=originalReaddirForActivation;for(const subscription of activationSubscriptions.splice(0))subscription.dispose()}
  console.log(JSON.stringify({restoredUriBeforeView:true,textAndBinaryInvalidation:true,baseAfterCommit:true,historyReloadAfterCommit:true,multiRepository:true,selectedPaths:true,indexPreserved:true,cvsHistory:true,revisionDiff:true,lazyUnknownDirectory:true,ignoreAtManagedParent:true,nestedWriteProtection:true,isolatedErrors:true,dirtyEditors:true,untrusted:true,localOnlyFocus:true,targetedSave:true,incomingCannotCommit:true,rollbackBackup:true,confirmationLiveness:true}));
 }finally{for(const cleanup of historyCleanups)cleanup();for(const subscription of activationSubscriptions)subscription.dispose();connection?.dispose();manager?.dispose();delete global.__restartHistory;delete global.__restartVscode;await fs.rm(base,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
