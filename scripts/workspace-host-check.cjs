/* Headless activate/session integration check; all repositories are temporary. */
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");
function git(cwd, args) { return cp.execFileSync("git", args, { cwd, encoding: "utf8" }); }
async function repo(root, text) { await fs.mkdir(root, { recursive: true }); git(root, ["init", "-b", "main"]); git(root, ["config", "user.name", "Host Check"]); git(root, ["config", "user.email", "host@example.invalid"]); await fs.writeFile(path.join(root, "tracked.txt"), text); git(root, ["add", "tracked.txt"]); git(root, ["commit", "-m", "initial"]); }
async function main() {
  const project = path.resolve(__dirname, ".."); const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-workspace-host-"));
  try {
    const a = path.join(temp, "a"), b = path.join(temp, "b"), c = path.join(temp, "cvs-copy"); await repo(a, "a\n"); await repo(b, "b\n");
    const bRemote = path.join(temp, "b-remote.git"), bWriter = path.join(temp, "b-writer");
    git(temp, ["init", "--bare", bRemote]); git(bRemote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(b, ["remote", "add", "origin", bRemote]); git(b, ["push", "-u", "origin", "main"]);
    git(temp, ["clone", bRemote, bWriter]); git(bWriter, ["config", "user.name", "Host Writer"]); git(bWriter, ["config", "user.email", "writer@example.invalid"]);
    async function advanceB(content, message) { await fs.writeFile(path.join(bWriter,"tracked.txt"), content); git(bWriter,["add","tracked.txt"]); git(bWriter,["commit","-m",message]); git(bWriter,["push"]); }
    const cvsCore = await import(path.join(project,'src/cvs/core.mjs'));
    const cvsClient = process.env.JETTORTOISE_TEST_CVS || '/opt/homebrew/bin/cvs';
    const cvsProcess = new cvsCore.CvsProcess(cvsClient);
    const canonicalTemp=await fs.realpath(temp), repository=path.join(canonicalTemp,'cvs-server'), seed=path.join(canonicalTemp,'seed');
    await fs.mkdir(repository);await fs.mkdir(seed);
    const cvsRoot=':local:'+repository;
    await cvsProcess.run(['-d',cvsRoot,'init'],canonicalTemp);
    await fs.writeFile(path.join(seed,'tracked.txt'),'cvs base\n');
    await cvsProcess.run(['-d',cvsRoot,'import','-m','initial','demo','vendor','start'],seed);
    await cvsCore.checkout(cvsProcess,cvsRoot,'demo',path.join(canonicalTemp,'cvs-copy'));

    const entry = path.join(temp, "entry.ts"), bundle = path.join(temp, "extension.cjs"), stub = path.join(temp, "vscode.cjs");
    await fs.writeFile(stub, `
const state=global.__jettortoiseHostMock||(global.__jettortoiseHostMock={commands:new Map(),panels:[],listeners:[]});
class D{constructor(f){this.dispose=f||(()=>{});}} class E{constructor(){this.listeners=new Set();this.event=cb=>{this.listeners.add(cb);return new D(()=>this.listeners.delete(cb));};}fire(value){for(const cb of [...this.listeners])cb(value);}dispose(){this.listeners.clear();}} const U=global.__jettortoiseUri||(global.__jettortoiseUri=class U{constructor(v){Object.assign(this,v);this.fsPath=v.fsPath||v.path||"";}static file(fsPath){return new U({scheme:"file",fsPath,path:fsPath,authority:"",query:""});}static from(v){return new U(v);}static joinPath(b,...s){return U.file(require("node:path").join(b.fsPath,...s));}toString(){return this.scheme+"://"+(this.authority||"")+(this.path||"")+(this.query?"?"+this.query:"");}});
function panel(title){const received=[];const callbacks=new Set();const disposeCallbacks=new Set();const webview={cspSource:"test",options:{},asWebviewUri:u=>u.toString(),postMessage:async m=>{received.push(m);},receive:async msg=>{await Promise.all([...callbacks].map(cb=>cb(msg)));},onDidReceiveMessage:cb=>{callbacks.add(cb);return new D(()=>callbacks.delete(cb));}};const p={title,webview,active:true,reveal(){p.revealCount=(p.revealCount||0)+1;},onDidDispose:cb=>{disposeCallbacks.add(cb);return new D(()=>disposeCallbacks.delete(cb));},onDidChangeViewState:()=>new D(),dispose(){for(const cb of [...disposeCallbacks])cb();p.closed=true;},received,revealCount:0};state.panels.push(p);return p;}
state.sourceControls=[];state.watchers=[];state.gitPrompts=[];
exports.scm={createSourceControl(id,label,rootUri){const groups=[];const source={id,label,rootUri,groups,inputBox:{value:""},createResourceGroup(id,label){const group={id,label,resourceStates:[],dispose(){}};groups.push(group);return group;},dispose(){source.disposed=true;}};state.sourceControls.push(source);return source;}};
exports.ThemeColor=class{constructor(id){this.id=id;}};exports.ThemeIcon=class{constructor(id,color){this.id=id;this.color=color;}};exports.ConfigurationTarget={Workspace:2};
exports.Uri=U;exports.Disposable=D;exports.EventEmitter=E;exports.ViewColumn={Active:1};exports.StatusBarAlignment={Left:1};exports.ProgressLocation={Notification:1};exports.FileType={File:1};exports.FileSystemError={NoPermissions:()=>new Error("NoPermissions"),FileNotFound:()=>new Error("FileNotFound")};exports.l10n={t:(m,...a)=>a.reduce((x,v,i)=>x.replace("{"+i+"}",String(v)),m)};exports.env={language:"en",clipboard:{writeText:async()=>{},readText:async()=>""}};exports.workspace=global.__jettortoiseWorkspace||(global.__jettortoiseWorkspace={isTrusted:true,workspaceFolders:[],textDocuments:[],getConfiguration:()=>({get:(_k,d)=>d}),registerFileSystemProvider:()=>new D(),registerTextDocumentContentProvider:()=>new D(),onDidChangeWorkspaceFolders:()=>new D(),createFileSystemWatcher:()=>({onDidChange:()=>new D(),onDidCreate:()=>new D(),onDidDelete:()=>new D(),dispose(){}})});exports.window={createOutputChannel:()=>({appendLine:line=>{(state.diagnostics??=[]).push(line);},dispose(){}}),registerFileDecorationProvider:provider=>{state.decorations=provider;return new D();},onDidChangeWindowState:cb=>{state.windowState=cb;return new D();},activeTextEditor:undefined,createWebviewPanel:(_t,title)=>panel(title),registerWebviewPanelSerializer:()=>new D(),createStatusBarItem:()=>({show(){},dispose(){}}),onDidChangeActiveTextEditor:()=>new D(),showErrorMessage:async message=>{console.error("HOST_ERROR",message);},showInformationMessage:async(message,...items)=>{if(message.startsWith("This repository has not been added:")){state.addPrompts=(state.addPrompts||0)+1;return items[0];}if(message.startsWith("Ignore built-in")){state.gitPrompts.push(message);return state.ignoreGit || message.endsWith(state.ignoreGitRoot) ? items[0] : items[1];}},showWarningMessage:async(_m,_o,label)=>{if(state.beforeConfirm)await state.beforeConfirm();return state.confirm ? label : undefined;},showQuickPick:async()=>undefined,showOpenDialog:async()=>undefined,withProgress:async(_o,fn)=>fn({report(){}}, {onCancellationRequested:()=>new D()})};exports.commands={registerCommand:(id,cb)=>{state.commands.set(id,cb);return new D(()=>state.commands.delete(id));},executeCommand:async(...args)=>{(state.executed??=[]).push(args);}};exports.Range=class{};exports.RelativePattern=class{};exports.__state=state;
`);
    await fs.writeFile(entry, `export {activate} from ${JSON.stringify(path.join(project,"src/extension.ts"))};\nexport {RepositoryScm} from ${JSON.stringify(path.join(project,"src/scm/provider.ts"))};\nexport {scmCvsChange} from ${JSON.stringify(path.join(project,"src/cvs/session.ts"))};\n`);
    global.__jettortoiseHostMock = { commands: new Map(), panels: [], listeners: [] };
    global.__jettortoiseWorkspace = { isTrusted: true, workspaceFolders: [], textDocuments: [], getConfiguration: () => ({ get: (key, fallback) => key === "cvsPath" ? cvsClient : key === "autoDiscoverRepositories" ? false : key === "ignoredRepositories" ? (global.__jettortoiseHostMock.ignored || ["/synthetic-existing"]) : fallback,update:async(key,value,target)=>{assert.equal(key,"ignoredRepositories");assert.equal(target,2);global.__jettortoiseHostMock.ignored=value;} }), registerFileSystemProvider: () => ({ dispose() {} }), registerTextDocumentContentProvider: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidGrantWorkspaceTrust: () => ({ dispose() {} }), onDidSaveTextDocument: cb => { (global.__jettortoiseHostMock.saveListeners??=[]).push(cb);return {dispose(){}}; }, fs: { delete: uri => fs.rm(uri.fsPath,{recursive:true,force:true}) }, createFileSystemWatcher: () => {const watcher={onDidChange:cb=>{watcher.changed=cb;return {dispose(){}};},onDidCreate:cb=>{watcher.created=cb;return {dispose(){}};},onDidDelete:cb=>{watcher.deleted=cb;return {dispose(){}};},dispose(){watcher.disposed=true;}};global.__jettortoiseHostMock.watchers.push(watcher);return watcher;} };
    await esbuild.build({ entryPoints:[entry], bundle:true, platform:"node", format:"cjs", outfile:bundle, plugins:[{name:"vscode",setup(build){build.onResolve({filter:/^vscode$/},()=>({path:stub}));}}] });
    const { activate, RepositoryScm, scmCvsChange } = require(bundle), vscode = require(stub); vscode.workspace.workspaceFolders = [a,b,c].map(fsPath=>({uri:vscode.Uri.file(fsPath)})); const saved=new Map(); const context={extensionUri:vscode.Uri.file(project),subscriptions:[],workspaceState:{get:(key,fallback)=>saved.has(key)?saved.get(key):fallback,update:async(key,value)=>{saved.set(key,value);}}}; activate(context);
    vscode.__state.ignoreGitRoot=b; const manifest=require(path.join(project,"package.json")); const declared=manifest.contributes.commands.map(item=>item.command); assert.ok(declared.length>=16); const missing=declared.filter(id=>!vscode.__state.commands.has(id)); assert.deepEqual(missing,[]);
    await vscode.__state.commands.get("jettortoise.openHistory")(vscode.Uri.file(path.join(a,"tracked.txt"))); await vscode.__state.commands.get("jettortoise.openHistory")(vscode.Uri.file(path.join(b,"tracked.txt"))); await vscode.__state.commands.get("jettortoise.openHistory")(vscode.Uri.file(path.join(c,"tracked.txt"))); assert.equal(vscode.__state.addPrompts,3); assert.equal(vscode.__state.panels.length,3); assert.equal(new Set(vscode.__state.panels.map(p=>p.title)).size,3);
    async function until(check,label){const end=Date.now()+10000;while(!check()){if(Date.now()>end)throw new Error("Timed out: "+label);await new Promise(resolve=>setTimeout(resolve,10));}}
    await until(()=>vscode.__state.sourceControls.filter(s=>!s.disposed).length===3,"three native providers");
    const scmA=vscode.__state.sourceControls.find(s=>s.rootUri.fsPath===a),scmC=vscode.__state.sourceControls.find(s=>s.rootUri.fsPath===c);
    const scmCommand=(name,...args)=>vscode.__state.commands.get("jettortoise.scm."+name)(...args);
    const group=(source,id)=>source.groups.find(g=>g.id===id);
    await fs.writeFile(path.join(a,"deferred.txt"),"base\n");git(a,["add","deferred.txt"]);git(a,["commit","-m","prepare SCM"]);
    await fs.writeFile(path.join(a,"tracked.txt"),"SCM worktree\n");await fs.writeFile(path.join(a,"deferred.txt"),"deferred\n");await fs.writeFile(path.join(a,"unknown.txt"),"unknown\n");
    await scmCommand("refresh",scmA);
    assert.equal(group(scmA,"changes").resourceStates.length,2);
    assert.equal(group(scmA,"untracked").resourceStates.length,1);
    const deferredState=group(scmA,"changes").resourceStates.find(s=>s.change.path==="deferred.txt");
    await scmCommand("diff",scmA,"tracked.txt");
    const diskDiff=vscode.__state.executed.filter(call=>call[0]==="vscode.diff").at(-1);
    assert.equal(diskDiff[2].scheme,"file");assert.equal(diskDiff[2].fsPath,path.join(a,"tracked.txt"));
    await scmCommand("defer",deferredState);
    assert.equal(group(scmA,"deferred").resourceStates.length,1);
    assert.ok([...saved.values()].some(value=>Array.isArray(value)&&value.includes("deferred.txt")));
    scmA.inputBox.value="SCM paths only";await scmCommand("commit",scmA);
    assert.equal(scmA.inputBox.value,"");assert.equal(git(a,["show","HEAD:tracked.txt"]),"SCM worktree\n");assert.equal(git(a,["show","HEAD:deferred.txt"]),"base\n");
    const quick=await scmA.quickDiffProvider.provideOriginalResource(vscode.Uri.file(path.join(a,"tracked.txt")));
    assert.match(quick.query,/HEAD/);
    assert.equal(await scmA.quickDiffProvider.provideOriginalResource(vscode.Uri.file(path.join(a,"unknown.txt"))),undefined);
    await fs.writeFile(path.join(a,"deferred.txt"),"base\n");await scmCommand("refresh",scmA);assert.equal(group(scmA,"deferred").resourceStates.length,0);
    await until(()=>vscode.__state.gitPrompts.length===2,"Git prompt once per repository");
    assert.ok(vscode.__state.ignored.includes(b));assert.ok(vscode.__state.ignored.includes("/synthetic-existing"));assert.ok(!vscode.__state.ignored.includes(a));
    const prompts=vscode.__state.gitPrompts.length;await scmCommand("refresh",scmA);assert.equal(vscode.__state.gitPrompts.length,prompts);
    assert.equal(scmC.groups.some(g=>g.id==="remote"),true);
    await fs.writeFile(path.join(c,"unknown.txt"),"unknown\n");await scmCommand("refresh",scmC);
    assert.ok(group(scmC,"untracked").resourceStates.some(state=>state.change.path==="unknown.txt"));
    await scmCommand("diff",scmC,"unknown.txt");
    const cvsUnknownDiff=vscode.__state.executed.filter(call=>call[0]==="vscode.diff").at(-1);assert.equal(cvsUnknownDiff[1].scheme,"jettortoise");assert.equal(cvsUnknownDiff[2].fsPath,path.join(c,"unknown.txt"));
    const cvsQuick=await scmC.quickDiffProvider.provideOriginalResource(vscode.Uri.file(path.join(c,"tracked.txt")));assert.match(cvsQuick.query,/ref=1/);
    assert.equal(await scmC.quickDiffProvider.provideOriginalResource(vscode.Uri.file(path.join(c,"unknown.txt"))),undefined);
    await fs.rm(path.join(c,"unknown.txt"));
    await fs.rm(path.join(a,"unknown.txt"));
    // 同一套 provider 验证 CVS 状态映射、组优先级、持久化及刷新合并。
    const fixtureChanges=["Locally Modified","Locally Added","Locally Removed","Unknown","File had conflicts on merge","Needs Checkout","Needs Patch","Needs Merge"].map((state,i)=>scmCvsChange({newPath:`fixture-${i}.txt`,entryRevision:"1.1",state}));
    let refreshCalls=0,activeRefresh=0,maxRefresh=0,release;
    const fakeAdapter={onDidChange:new vscode.EventEmitter().event,refresh:async(_request,publish)=>{refreshCalls++;maxRefresh=Math.max(maxRefresh,++activeRefresh);publish(fixtureChanges);await new Promise(resolve=>{release=resolve;});activeRefresh--;},commit:async()=>true,rollback:async()=>{},add:async()=>{},ignore:async()=>{},diff:async()=>{},baseline:async()=>undefined};
    const descriptor={id:"synthetic-scm",root:a,kind:"cvs"};
    const fake=new RepositoryScm(descriptor,fakeAdapter,context,new vscode.EventEmitter());
    assert.equal(fake.groups.get("changes").resourceStates.length,4);
    assert.equal(fake.groups.get("untracked").resourceStates.length,1);
    assert.equal(fake.groups.get("remote").resourceStates.length,2);
    assert.equal(fake.groups.get("conflicts").resourceStates.length,1);
    await fake.move(["fixture-0.txt"],true);
    const queued=[fake.refresh(true),fake.refresh(true),fake.refresh(false)];
    release();await until(()=>refreshCalls===2,"coalesced refresh");release();await Promise.all(queued);
    assert.equal(refreshCalls,2);assert.equal(maxRefresh,1);
    fake.dispose();
    const persisted=new RepositoryScm(descriptor,{...fakeAdapter,refresh:async(_request,publish)=>{publish(fixtureChanges);throw new Error("synthetic network failure");}},context,new vscode.EventEmitter());
    await persisted.refresh(false);assert.equal(persisted.groups.get("deferred").resourceStates.length,1);assert.match(persisted.groups.get("changes").label,/synthetic network failure/);assert.equal(persisted.groups.get("changes").hideWhenEmpty,false);persisted.dispose();
    let finishNetwork,networkDone=false,localSaves=0;
    const fresh={path:"fixture-live.txt",status:"deleted"};
    const live=new RepositoryScm({...descriptor,id:"synthetic-live"},{...fakeAdapter,refresh:async(request,publish)=>{
      if(request.paths){localSaves++;assert.deepEqual(request.paths,["fixture-live.txt"]);publish([fresh]);return;}
      publish([{...fresh,status:"modified"}]);await new Promise(resolve=>{finishNetwork=resolve;});publish([{...fresh,status:"modified"}]);networkDone=true;
    }},context,new vscode.EventEmitter());
    vscode.__state.watchers.at(-1).changed(vscode.Uri.file(path.join(a,"fixture-live.txt")));
    await until(()=>localSaves===1,"single-file refresh while network running");
    assert.equal(live.changes.get("fixture-live.txt").status,"deleted");finishNetwork();await until(()=>networkDone,"late network snapshot");assert.equal(live.changes.get("fixture-live.txt").status,"deleted");live.dispose();
    const before=vscode.__state.panels.length; await vscode.__state.commands.get("jettortoise.openCommit")(vscode.Uri.file(path.join(a,"tracked.txt"))); assert.equal(vscode.__state.panels.length,before); const aPanel=vscode.__state.panels.find(p=>p.webview.html.includes('data-mode="panel"')); await aPanel.webview.receive({type:"jettortoiseHistoryReady"}); assert.ok(aPanel.received.some(m=>m.event==="showFileHistory")); assert.ok(aPanel.received.some(m=>m.event==="showCommitPanel"));
    const bPanel=vscode.__state.panels.find(p=>p !== aPanel && p.webview.html.includes('data-mode="panel"'));
    assert.ok([...vscode.__state.commands.keys()].every(id=>id.startsWith('jettortoise.')));
    let serial=0;
    async function request(panel,command,params={}) {
      const id=String(++serial);
      await panel.webview.receive({type:'request',id,command,params});
      const response=panel.received.find(m=>m.type==='response' && m.id===id);
      assert.ok(response,`No response to ${command}`);
      return response;
    }
    async function catalogRequest(panel, action, repositoryId) {
      const id=`catalog-${++serial}`;
      await panel.webview.receive({type:"jettortoiseCatalog",id,action,...(repositoryId?{repositoryId}:{})});
      const response=panel.received.find(m=>m.type==="jettortoiseWorkbenchResponse"&&m.id===id);
      assert.ok(response,`No catalog response to ${action}`);
      return response;
    }
    const bId=crypto.createHash("sha256").update(`git\0${await fs.realpath(b)}`).digest("hex");
    await advanceB("remote one\n", "remote one");
    const focusBefore={a:aPanel.revealCount,b:bPanel.revealCount};
    const updatedOther=await catalogRequest(aPanel,"update",bId);
    assert.equal(updatedOther.ok,true,JSON.stringify(updatedOther));
    assert.equal(await fs.readFile(path.join(b,"tracked.txt"),"utf8"),"remote one\n");
    assert.deepEqual({a:aPanel.revealCount,b:bPanel.revealCount},focusBefore,"catalog update focused a different workbench tab");
    const successSnapshot=aPanel.received.filter(m=>m.type==="jettortoiseCatalogSnapshot").at(-1);
    assert.equal(successSnapshot.data.entries.find(entry=>entry.repository.id===bId).activity.status,"success");
    await advanceB("remote two\n", "remote two");
    Object.defineProperty(global.__jettortoiseWorkspace,"textDocuments",{configurable:true,get(){return [{isDirty:true,uri:vscode.Uri.file(path.join(b,"tracked.txt"))}];}});
    const dirtyUpdate=await catalogRequest(aPanel,"update",bId);
    assert.equal(dirtyUpdate.ok,false,"dirty editor did not reject queued catalog update");
    assert.equal(await fs.readFile(path.join(b,"tracked.txt"),"utf8"),"remote one\n");
    const errorSnapshot=aPanel.received.filter(m=>m.type==="jettortoiseCatalogSnapshot").at(-1);
    assert.equal(errorSnapshot.data.entries.find(entry=>entry.repository.id===bId).activity.status,"error");
    Object.defineProperty(global.__jettortoiseWorkspace,"textDocuments",{configurable:true,writable:true,value:[]});
    const retryUpdate=await catalogRequest(aPanel,"update",bId);
    assert.equal(retryUpdate.ok,true,JSON.stringify(retryUpdate));
    assert.equal(await fs.readFile(path.join(b,"tracked.txt"),"utf8"),"remote two\n");
    await fs.writeFile(path.join(a,'only-a.txt'),'a change');
    await fs.writeFile(path.join(b,'only-b.txt'),'b change');
    const aStatus=await request(aPanel,'getWorkingTreeChanges'),bStatus=await request(bPanel,'getWorkingTreeChanges');
    assert.equal(aStatus.success,true);assert.equal(bStatus.success,true);
    assert.match(JSON.stringify(aStatus.data),/only-a.txt/);assert.doesNotMatch(JSON.stringify(aStatus.data),/only-b.txt/);
    assert.match(JSON.stringify(bStatus.data),/only-b.txt/);assert.doesNotMatch(JSON.stringify(bStatus.data),/only-a.txt/);
    const denied=await request(aPanel,'deleteFiles',{filePaths:['only-a.txt'],cwd:b});assert.equal(denied.success,false);
    const cancelled=await request(aPanel,'deleteFiles',{filePaths:['only-a.txt']});assert.equal(cancelled.data.cancelled,true);await fs.access(path.join(a,'only-a.txt'));
    vscode.__state.confirm=true;
    const deleted=await request(aPanel,'deleteFiles',{filePaths:['only-a.txt']});assert.equal(deleted.success,true);await assert.rejects(fs.access(path.join(a,'only-a.txt')));await fs.access(path.join(b,'only-b.txt'));
    const bEvents=bPanel.received.filter(m=>m.event==='commitStateChanged').length;
    await fs.writeFile(path.join(a,'tracked.txt'),'new a');
    const stage=await request(aPanel,'stageFile',{filePath:'tracked.txt'});assert.equal(stage.success,true);
    assert.equal(git(b,['diff','--cached','--name-only']).trim(),'');
    assert.equal(bPanel.received.filter(m=>m.event==='commitStateChanged').length,bEvents);
    const gitCommit=await request(aPanel,'commitChanges',{message:'Git Host fixture',amend:false,filePaths:['tracked.txt']});
    assert.equal(gitCommit.success,true,JSON.stringify(gitCommit));assert.equal(git(a,['log','-1','--format=%s']).trim(),'Git Host fixture');
    assert.equal(git(b,['log','-1','--format=%s']).trim(),'remote two');
    aPanel.dispose();await vscode.__state.commands.get('jettortoise.openHistory')(vscode.Uri.file(path.join(a,'tracked.txt')));
    assert.equal(vscode.__state.panels.length,4);
    const reopen=vscode.__state.panels.at(-1);await reopen.webview.receive({type:'jettortoiseHistoryReady'});
    assert.equal(reopen.received.filter(m=>m.event==='showFileHistory').length,1);
    await aPanel.webview.receive({type:'request',id:'closed',command:'stageAll',params:{}});
    assert.equal(aPanel.received.filter(m=>m.id==='closed').length,0);
    const cvsPanel=vscode.__state.panels.find(p=>p.webview.html.includes('data-mode="cvs"'));
    await cvsPanel.webview.receive({type:'ready'});
    await cvsPanel.webview.receive({type:'refresh'});
    assert.ok(cvsPanel.received.some(m=>m.type==='state' && m.files.some(f=>f.newPath==='tracked.txt')));
    await fs.writeFile(path.join(c,'tracked.txt'),'cvs committed\n');
    await cvsPanel.webview.receive({type:'commit',paths:['tracked.txt'],message:'CVS Host fixture'});
    assert.ok(cvsPanel.received.some(m=>m.type==='committed'));
    assert.equal(git(a,['log','-1','--format=%s']).trim(),'Git Host fixture');
    assert.equal(git(b,['log','-1','--format=%s']).trim(),'remote two');
    const committedCount=cvsPanel.received.filter(m=>m.type==='committed').length;
    // The fixture itself is rooted through /var while the registry canonicalizes
    // to /private/var. Both CVS mutation entry points must still reject a dirty
    // editor using that lexical alias before they touch the working copy.
    Object.defineProperty(global.__jettortoiseWorkspace,"textDocuments",{configurable:true,get(){return [{isDirty:true,uri:vscode.Uri.file(path.join(c,"tracked.txt"))}];}});
    const cvsErrorsBefore=cvsPanel.received.filter(m=>m.type==='error').length;
    await cvsPanel.webview.receive({type:'update'});
    await cvsPanel.webview.receive({type:'commit',paths:['tracked.txt'],message:'must reject dirty editor'});
    assert.equal(cvsPanel.received.filter(m=>m.type==='committed').length,committedCount);
    assert.ok(cvsPanel.received.filter(m=>m.type==='error').length>=cvsErrorsBefore+2);
    assert.equal(await fs.readFile(path.join(c,'tracked.txt'),'utf8'),'cvs committed\n');
    Object.defineProperty(global.__jettortoiseWorkspace,"textDocuments",{configurable:true,writable:true,value:[]});
    await cvsPanel.webview.receive({type:'commit',paths:['../a/tracked.txt'],message:'reject'});
    assert.equal(cvsPanel.received.filter(m=>m.type==='committed').length,committedCount);
    assert.ok(cvsPanel.received.some(m=>m.type==='error'));
    const child = path.join(a, 'nested'); await repo(child, 'nested sentinel\n');
    const childDelete = await request(reopen, 'deleteFiles', {filePaths:['nested/tracked.txt']});
    assert.equal(childDelete.success, false);
    assert.equal(await fs.readFile(path.join(child,'tracked.txt'),'utf8'),'nested sentinel\n');
    const parentFiles = await request(reopen, 'getWorkingTreeChanges');
    assert.ok(parentFiles.data.every(file => !file.path.startsWith('nested')));
    const notices = await request(reopen, 'getRepositoryBoundaries');
    assert.ok(notices.data.some(item => item.path === 'nested' && !item.added));
    const forgedChild = await request(reopen, 'openRepositoryBoundary', {boundaryId:'0'.repeat(64)});
    assert.equal(forgedChild.success,false);
    git(a,['-c','advice.addEmbeddedRepo=false','add','nested']);
    await fs.writeFile(path.join(a,'selected-parent.txt'),'should remain unstaged\n');
    const beforeIndex=git(a,['ls-files','--stage','-z']);
    const rejectedCommit=await request(reopen,'commitChanges',{message:'reject nested',filePaths:['selected-parent.txt']});
    assert.equal(rejectedCommit.success,false);
    assert.equal(git(a,['ls-files','--stage','-z']),beforeIndex);

    // A new boundary created while the Host confirmation is open must also win.
    const late=path.join(a,'late-child');await fs.mkdir(late);
    await fs.writeFile(path.join(late,'sentinel.txt'),'late sentinel\n');
    vscode.__state.beforeConfirm=async()=>{git(late,['init','-b','main']);vscode.__state.beforeConfirm=undefined;};
    const lateDelete=await request(reopen,'deleteFiles',{filePaths:['late-child/sentinel.txt']});
    assert.equal(lateDelete.success,false);
    assert.equal(await fs.readFile(path.join(late,'sentinel.txt'),'utf8'),'late sentinel\n');
    const beforeHidden=vscode.__state.sourceControls.filter(source=>!source.disposed).length;
    await catalogRequest(reopen,"remove",bId);
    await until(()=>vscode.__state.sourceControls.filter(source=>!source.disposed).length===beforeHidden-1,"hidden SourceControl disposed");
    const bScm=vscode.__state.sourceControls.find(source=>source.rootUri.fsPath===b);assert.equal(bScm.disposed,true);
    const promptsBeforeRestore=vscode.__state.gitPrompts.length;
    await vscode.__state.commands.get("jettortoise.addRepository")(vscode.Uri.file(b));
    await until(()=>vscode.__state.sourceControls.some(source=>source.rootUri.fsPath===b&&!source.disposed),"restored provider");
    assert.equal(vscode.__state.gitPrompts.length,promptsBeforeRestore);
    // 失去信任时在窗口事件同步释放全部提供者。
    vscode.workspace.isTrusted=false;vscode.__state.windowState({focused:true});
    await until(()=>vscode.__state.sourceControls.every(source=>source.disposed),"trust loss disposed providers");
    assert.equal(vscode.__state.gitPrompts.length,promptsBeforeRestore);
    for(const d of context.subscriptions)d.dispose();
    console.log(JSON.stringify({nativeScmProviders:true,sharedCvsGroups:true,deferredPersistent:true,realScmCommitExcludesDeferredAndUntracked:true,fullRefreshCoalesced:true,failedNetworkRetainsLocal:true,hiddenAndTrustDisposal:true,gitPromptOnceAndPreservesConfig:true,declaredCommands:declared.length,addAndOpenBeforePanel:true,threeRepositoryPanels:true,perRepositorySingleton:true,readyQueue:true,workingChangesIsolated:true,hostConfirmCancel:true,mutationTargetIsolated:true,eventsIsolated:true,closeReopenListeners:true,realGitHostCommit:true,realCvsHostCommit:true,cvsTraversalRejected:true,cvsDirtyAliasUpdateRejected:true,cvsDirtyAliasCommitRejected:true,nestedHostDeleteRejected:true,commitRejectedBeforeStaging:true,boundaryCreatedDuringConfirmationRejected:true,catalogOtherRepositoryFastForward:true,catalogUpdateDidNotFocusOtherPanel:true,catalogSuccessFeedbackTargeted:true,dirtyEditorGuardRejected:true,catalogRetryAfterCleanSuccess:true}));

  } finally { await fs.rm(temp,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
