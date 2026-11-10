const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const disposable = () => ({ dispose() {} });
class Emitter {
  listeners = new Set();
  event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  fire(value) { for (const fn of this.listeners) fn(value); }
  dispose() { this.listeners.clear(); }
}
class Uri {
  static file(name) { return { scheme: 'file', path: name, fsPath: name, toString: () => 'file://' + name }; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const setup = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-performance-'));
  const calls = path.join(base, 'calls.jsonl');
  const fake = path.join(base, 'fake-cvs');
  await fs.writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');const out=${JSON.stringify(calls)};fs.appendFileSync(out,JSON.stringify({phase:'start',pid:process.pid,args:process.argv.slice(2),time:Date.now()})+'\\n');setTimeout(()=>{fs.appendFileSync(out,JSON.stringify({phase:'end',pid:process.pid,time:Date.now()})+'\\n');},120);\n`, { mode: 0o755 });
  const events = { focus: new Emitter(), save: new Emitter(), files: new Emitter() };
  const warnings = [];
  const commands = [];
  const vscode = {
    commands: {executeCommand: async (...args) => commands.push(args)},
    Uri, EventEmitter: Emitter, RelativePattern: class {}, ProgressLocation: {Notification:1,Window:10},
    l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, n) => args[n] ?? '') },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [{ uri: Uri.file(base) }],
      getConfiguration: () => ({ get: (key, fallback) => key === 'cvsPath' ? fake : fallback }),
      onDidChangeWorkspaceFolders: () => disposable(), onDidGrantWorkspaceTrust: () => disposable(),
      onDidSaveTextDocument: events.save.event,
      createFileSystemWatcher: () => ({ onDidChange: events.files.event, onDidCreate: () => disposable(), onDidDelete: () => disposable(), dispose() {} }),
    },
    window: { withProgress: (_options,run)=>run({report(){}}, {onCancellationRequested:()=>disposable()}), onDidChangeActiveTextEditor: () => disposable(), onDidChangeWindowState: events.focus.event, showWarningMessage: message => { warnings.push(message); return Promise.resolve(); } },
  };
  global.__performanceVscode = vscode;
  const bundle = path.join(base, 'manager.cjs');
  await build({ stdin: {contents: 'export {RepositoryManager} from "./src/repositories/manager.ts"; export {CvsAdapter} from "./src/cvs/core.mjs"; export {runNetwork} from "./src/repositories/network.cjs";', resolveDir:process.cwd()}, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, plugins: [{ name: 'vscode-fixture', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'module.exports=global.__performanceVscode;' })); } }] });
  const { RepositoryManager, CvsAdapter, runNetwork } = require(bundle);
  const localReads=[];const localStatus=CvsAdapter.prototype.localStatus;
  CvsAdapter.prototype.localStatus=function(...args){localReads.push(this.root);return localStatus.apply(this,args)};
  const manager = new RepositoryManager({ extensionUri: Uri.file(process.cwd()) });
  for (let n = 0; n < 6; n++) {
    const dir = path.join(base, 'wc-' + n); await fs.mkdir(path.join(dir, 'CVS'), { recursive: true });
    await fs.writeFile(path.join(dir, 'CVS/Root'), ':local:/nonexistent/cvsroot\n');
    await fs.writeFile(path.join(dir, 'CVS/Repository'), 'module-' + n + '\n');
    await fs.writeFile(path.join(dir, 'CVS/Entries'), '/app.txt/1.1/Thu Jan  1 00:00:00 1970//\n');
    await fs.writeFile(path.join(dir, 'app.txt'), 'modified\n');
  }
  const read = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const settle = async () => { await delay(500); await Promise.all([...manager.entries.values()].map(entry => entry.cvs?.network)); };
  return { base, calls, fake, manager, events, warnings, commands, localReads, runNetwork, read, settle };
};
test('登记、文件变化与焦点自动刷新不运行 CVS 命令', async () => {
  const fx = await setup();
  try {
    await fx.manager.scan(); await fx.settle();
    assert.equal((await fx.read()).length, 0, 'registration contacted CVS');
    fx.events.files.fire(Uri.file(path.join(fx.base, 'wc-0/CVS/Entries')));
    fx.events.save.fire({ uri: Uri.file(path.join(fx.base, 'wc-0/app.txt')) });
    fx.events.focus.fire({ focused: true });
    await fx.settle();
    assert.equal((await fx.read()).length, 0, 'automatic refresh contacted CVS');
  } finally { fx.manager.dispose(); await fs.rm(fx.base, { recursive: true, force: true }); }
});
test('显式多仓刷新最多并发 2 条网络命令', async () => {
  const fx = await setup();
  try {
    await fx.manager.scan();
    for(const entry of fx.manager.entries.values()) await fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(entry.info.root));
    await fx.settle(); await fs.writeFile(fx.calls, '');
    await fx.manager.request('refreshRepositories'); await fx.settle();
    let active = 0, peak = 0, starts = 0;
    for (const call of await fx.read()) { if (call.phase === 'start') { peak = Math.max(peak, ++active); starts++; } else active--; }
    assert.equal(starts, 6); assert.equal(active, 0); assert.ok(peak <= 2, 'peak network concurrency: ' + peak);
  } finally { fx.manager.dispose(); await fs.rm(fx.base, { recursive: true, force: true }); }
});
test('扫描超限静默发布暂停状态，停止自动重试，显式扫描仅重试本地', async () => {
  const fx = await setup();
  try {
    await fx.manager.scan(); await fx.settle();
    const entry = [...fx.manager.entries.values()][0];
    await fx.manager.execute('jettortoise.synchronizeRepository', Uri.file(entry.info.root));await fx.settle();
    const session = entry.cvs;
    let attempts = 0;
    session.adapter.localStatus = async () => { attempts++; throw Object.assign(new Error('inventoryLimit'), { code: 'inventoryLimit' }); };
    await session.refresh(); await session.refresh(); await session.refresh();
    assert.equal(attempts, 1); assert.equal(fx.warnings.length, 0);
    assert.deepEqual(await fx.manager.request('getCvsFiles',{repositoryId:session.id}),[]);
    assert.equal(attempts,1,'history file list retried a stopped scan');
    assert.equal(fx.manager.state().snapshots[0].error, undefined);
    assert.equal(fx.manager.state().snapshots[0].scanPaused, true);
    const calls = (await fx.read()).length;
    await fx.manager.request('scanRepository', {repositoryId:session.id});
    assert.equal(attempts, 2);
    assert.equal(fx.manager.state().snapshots[0].scanPaused, true);
    session.adapter.localStatus = async () => { attempts++; return []; };
    await fx.manager.request('scanRepository', {repositoryId:session.id});
    assert.equal(attempts, 3);
    assert.equal(fx.manager.state().snapshots[0].scanPaused, undefined);
    assert.equal((await fx.read()).length, calls, 'local scan contacted CVS');
    await assert.rejects(fx.manager.request('scanRepository', {repositoryId:session.id, network:true}), /Unexpected request field/);
  } finally { fx.manager.dispose(); await fs.rm(fx.base, { recursive: true, force: true }); }
});

test('Git 首次扫描超限仍发布首快照和仓库列表，路径与边界失败不冒充上限', async () => {
  const fx = await setup();
  try {
    const git = path.join(fx.base,'git'); await fs.mkdir(git);
    require('node:child_process').execFileSync('git',['init','-b','main'],{cwd:git,stdio:'ignore'});
    const sent=[];fx.manager.connect({postMessage:msg=>{sent.push(msg);return Promise.resolve(true)},onDidReceiveMessage:()=>disposable()});
    const id=fx.manager.add('git',git),entry=fx.manager.entries.get(id);
    assert.equal(fx.manager.state().logRepositoryId,id,'first Git selection waited for full discovery');
    let attempts=0;
    entry.git.service.getWorkingTreeChanges=async()=>{attempts++;throw Object.assign(Error('scan limit'),{code:'SCAN_LIMIT'})};
    await fx.settle();
    assert.equal(attempts,1);assert.equal(fx.warnings.length,0);
    assert.equal(fx.manager.state().repositories[0].id,id);
    assert.ok(sent.some(msg=>msg.event==='repositoryList'&&msg.data.repositories.some(repo=>repo.id===id)));
    assert.ok(sent.some(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===id&&msg.data.scanPaused===true),'paused first snapshot missing');
    fx.events.focus.fire({focused:true});await fx.settle();assert.equal(attempts,1);
    entry.git.service.getWorkingTreeChanges=async()=>[];
    await fx.manager.request('scanRepository',{repositoryId:id});
    assert.equal(fx.manager.state().snapshots[0].scanPaused,undefined);
    assert.ok(sent.some(msg=>msg.event==='repositorySnapshotDelta'&&msg.data.scanPaused===undefined));
    for(const code of ['BOUNDARY_UNAVAILABLE','path']) {
      entry.git.service.getWorkingTreeChanges=async()=>{throw Object.assign(Error('real failure '+code),{code})};
      await fx.manager.request('scanRepository',{repositoryId:id});
      assert.equal(fx.manager.state().snapshots[0].scanPaused,undefined);
      assert.match(fx.manager.state().snapshots[0].error,/real failure/);
    }
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('超大 CVS 启动不盘点，首次同步超限发暂停首快照且不联网', async () => {
  const fx=await setup();
  try {
    const root=path.join(fx.base,'wc-0');
    await fs.writeFile(path.join(root,'CVS/Entries'),Array.from({length:20001},(_,i)=>`/file-${i}.txt/1.1///\n`).join(''));
    const sent=[];fx.manager.connect({postMessage:msg=>{sent.push(msg);return Promise.resolve(true)},onDidReceiveMessage:()=>disposable()});
    await fx.manager.scan();await fx.settle();
    assert.equal(fx.localReads.length,0);assert.equal((await fx.read()).length,0);
    const entry=[...fx.manager.entries.values()].find(e=>e.info.root===root);
    await assert.rejects(fx.manager.request('scanRepository',{repositoryId:entry.info.id}),/available repository/);
    assert.equal(fx.localReads.length,0,'scan button bypassed unsynced CVS gating');
    entry.info.syncedAt=Date.now();
    const concurrent=await Promise.allSettled([entry.cvs.refresh(),fx.manager.request('getCvsFiles',{repositoryId:entry.info.id})]);
    assert.equal(concurrent[1].status,'fulfilled','history mount exposed the same inventory limit as an operation error');
    assert.ok(Array.isArray(concurrent[1].value));
    assert.deepEqual(await fx.manager.request('getCvsFiles',{repositoryId:entry.info.id}),[],'paused repository still listed files');
    await fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(root));await fx.settle();
    assert.equal(fx.warnings.length,0);assert.equal((await fx.read()).length,0);
    assert.ok(sent.some(msg=>msg.event==='repositorySnapshot'&&msg.data.repositoryId===entry.info.id&&msg.data.scanPaused));
    await fs.writeFile(path.join(root,'CVS/Entries'),'');
    await fx.manager.request('scanRepository',{repositoryId:entry.info.id});
    assert.equal(fx.manager.state().snapshots[0].scanPaused,undefined);
    assert.equal((await fx.read()).length,0);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('Git 自动状态不遍历两万忽略目录与嵌套仓内部，写预检仍检查忽略树', async () => {
  const fx=await setup();
  try {
    const cp=require('node:child_process'),root=path.join(fx.base,'git-large');
    await fs.mkdir(root);cp.execFileSync('git',['init','-b','main'],{cwd:root,stdio:'ignore'});
    await fs.writeFile(path.join(root,'.gitignore'),'node_modules/\nbuild/\n.local/\ndist/\n');
    for(const name of ['node_modules','build','.local','dist']) {
      const dir=path.join(root,name);await fs.mkdir(dir);
      for(let start=0;start<5000;start+=100) await Promise.all(Array.from({length:100},(_,i)=>fs.mkdir(path.join(dir,'d-'+(start+i)))));
    }
    const nested=path.join(root,'child');await fs.mkdir(nested);
    cp.execFileSync('git',['init','-b','main'],{cwd:nested,stdio:'ignore'});
    // 子仓中放损坏管理目录，若误进入会引起边界失败。
    await fs.mkdir(path.join(nested,'broken/CVS'),{recursive:true});
    await fs.writeFile(path.join(root,'visible.txt'),'visible\n');
    const id=fx.manager.add('git',root);await fx.settle();
    const snapshot=fx.manager.state().snapshots.find(s=>s.repositoryId===id);
    assert.equal(snapshot.error,undefined);assert.equal(snapshot.scanPaused,undefined);
    assert.deepEqual(snapshot.files.map(f=>f.path).sort(),['.gitignore','visible.txt']);
    const {listNestedRepositories}=require('../src/repositories/boundaries.cjs');
    await assert.rejects(listNestedRepositories(root,'git'),{code:'SCAN_LIMIT'},'write preflight silently skipped ignored directories');
    assert.deepEqual(await listNestedRepositories(nested,'git').catch(e=>e.code),'BOUNDARY_UNAVAILABLE');
    assert.equal(fx.warnings.length,0);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('CVS 与 Git 共用命令队列，本地命令不占网络位置且排队取消不启动进程', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'network-mixed-'));
  const previousPath = process.env.PATH;
  try {
    const calls = path.join(base, 'mixed.jsonl');
    const executable = `#!${process.execPath}\nconst fs=require('node:fs');const file=${JSON.stringify(calls)};const local=process.argv[2]==='status';const emit=phase=>fs.appendFileSync(file,JSON.stringify({phase,pid:process.pid,local})+'\\n');emit('start');setTimeout(()=>emit('end'),local?0:150);\n`;
    for (const command of ['fake-cvs','git']) await fs.writeFile(path.join(base,command),executable,{mode:0o755});
    process.env.PATH = base + path.delimiter + previousPath;
    const bundle = path.join(base,'mixed.cjs');
    await build({stdin:{contents:`export {CvsProcess} from ${JSON.stringify(path.resolve('src/cvs/core.mjs'))};export {GitService} from ${JSON.stringify(path.resolve('src/git/gitService.ts'))};export {runNetwork} from ${JSON.stringify(path.resolve('src/repositories/network.cjs'))};export {snapshotDelta,applySnapshotDelta} from ${JSON.stringify(path.resolve('src/repositories/changes.ts'))};`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:bundle,plugins:[{name:'vscode-fixture',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports={l10n:{t:x=>x}};'}));}}]});
    const {CvsProcess,GitService,runNetwork,snapshotDelta,applySnapshotDelta}=require(bundle);
    const network=[];
    for(let i=0;i<4;i++) network.push(new CvsProcess(path.join(base,'fake-cvs')).run(['update'],base));
    const git=new GitService(base);
    for(const verb of ['fetch','pull','push','ls-remote']) network.push(git.execGit([verb]));
    await git.execGit(['status']);
    const early=(await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(early.some(x=>x.local&&x.phase==='end'));
    assert.ok(early.filter(x=>!x.local&&x.phase==='end').length<8,'local command waited behind all network work');
    await Promise.all(network);
    let active=0,peak=0;
    for(const call of (await fs.readFile(calls,'utf8')).trim().split('\n').map(JSON.parse)) if(!call.local){if(call.phase==='start')peak=Math.max(peak,++active);else active--;}
    assert.equal(peak,2);assert.equal(active,0);
    let release;const gate=new Promise(resolve=>{release=resolve});
    const running=[runNetwork(()=>gate),runNetwork(()=>gate)];
    const controller=new AbortController();let started=false;
    const queued=runNetwork(async()=>{started=true},controller.signal);controller.abort();
    await assert.rejects(queued,{code:'cancelled'});assert.equal(started,false);release();await Promise.all(running);
    await assert.rejects(runNetwork(async()=>{throw Error('fixture failure')}),/fixture failure/);
    assert.equal(await runNetwork(async()=>42),42);
    const before={repositoryId:'a',files:[{repositoryId:'a',path:'one',status:'modified',staged:false},{repositoryId:'a',path:'two',status:'added',staged:false}]};
    const after={repositoryId:'a',files:[{...before.files[0],staged:true}],refreshing:true};
    const delta=snapshotDelta(before,after);
    assert.equal(delta.changed.length,1);assert.equal(delta.removed.length,1);
    assert.deepEqual(applySnapshotDelta(before,delta),after);
    assert.equal(snapshotDelta(after,after),undefined);
  } finally { process.env.PATH=previousPath;await fs.rm(base,{recursive:true,force:true}); }
});

test('恢复旧 CVS 修订 URI 不隐式读取服务器', async () => {
  const fx=await setup();
  try {
    await fx.manager.scan();await fx.settle();
    const entry=[...fx.manager.entries.values()][0];
    const uri={authority:entry.info.id,path:'/app.txt',query:'ref=1.1',toString:()=>`jettortoise://${entry.info.id}/app.txt?ref=1.1`};
    await assert.rejects(entry.cvs.readFile(uri),/Open the file diff or history again/);
    assert.equal((await fx.read()).length,0);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('文件图标只读取已安装主题并选择浅深色资源，拒绝主题目录外文件', async () => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'file-icons-'));
  try {
    const root=path.join(base,'theme');await fs.mkdir(root);
    await fs.writeFile(path.join(root,'light.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>');
    await fs.writeFile(path.join(root,'dark.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><path d="M2 2"/></svg>');
    await fs.writeFile(path.join(base,'outside.svg'),'<svg/>');
    await fs.writeFile(path.join(root,'theme.json'),JSON.stringify({iconDefinitions:{text:{iconPath:'dark.svg'},text_light:{iconPath:'light.svg'},escape:{iconPath:'../outside.svg'}},file:'text',fileExtensions:{evil:'escape'},light:{file:'text_light',fileExtensions:{evil:'escape'}}}));
    global.__fileIconVscode={workspace:{getConfiguration:()=>({get:()=> 'fixture-theme'})},extensions:{all:[{extensionUri:{fsPath:root},packageJSON:{contributes:{iconThemes:[{id:'fixture-theme',path:'theme.json'}]}}}]}};
    const bundle=path.join(base,'icons.cjs');
    await build({entryPoints:['src/views/file-icons.ts'],bundle:true,platform:'node',format:'cjs',outfile:bundle,plugins:[{name:'vscode-fixture',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'module.exports=global.__fileIconVscode;'}));}}]});
    const {getFileIcons}=require(bundle);const icons=await getFileIcons(['app.txt','source.evil']);
    assert.match(Buffer.from(icons['app.txt'].light.split(',')[1],'base64').toString(),/M1 1/);
    assert.match(Buffer.from(icons['app.txt'].dark.split(',')[1],'base64').toString(),/M2 2/);
    assert.equal(icons['source.evil'],null);
  } finally {await fs.rm(base,{recursive:true,force:true});}
});


test('按需同步：本地更改只列 Git，未同步 CVS 不读本地状态、不调用 CVS', async () => {
  const fx = await setup();
  try {
    const cp = require('node:child_process');
    const git = path.join(fx.base, 'git'); await fs.mkdir(git);
    cp.execFileSync('git', ['init', '-b', 'main'], {cwd:git, stdio:'ignore'});
    await fs.writeFile(path.join(git, 'new.txt'), 'git change\n');
    await fx.manager.scan(); await fx.settle();
    assert.deepEqual(fx.manager.state().repositories.map(r=>r.kind), ['git']);
    assert.equal(fx.manager.state().unsyncedCvsCount, 6);
    assert.equal(fx.manager.state().snapshots.length, 1);
    assert.equal(fx.localReads.length,0,'opening read unsynced CVS local status');
    for (const entry of fx.manager.entries.values()) if(entry.cvs) assert.deepEqual(entry.cvs.files, []);
    assert.equal((await fx.read()).length, 0);
    await fx.manager.request('refreshRepositories'); await fx.settle();
    assert.equal((await fx.read()).length, 0, 'global refresh loaded an unsynced CVS repository');
    assert.equal(fx.localReads.length,0);
  } finally { fx.manager.dispose(); await fs.rm(fx.base, {recursive:true,force:true}); }
});

test('日志列出未同步 CVS：文件清单只读 Entries，提交面与扫描仍拒绝', async () => {
  const fx = await setup();
  try {
    const cp = require('node:child_process');
    const git = path.join(fx.base, 'git'); await fs.mkdir(git);
    cp.execFileSync('git', ['init', '-b', 'main'], {cwd:git, stdio:'ignore'});
    const root = path.join(fx.base, 'wc-0');
    await fs.mkdir(path.join(root, 'sub/CVS'), {recursive:true});
    await fs.writeFile(path.join(root, 'CVS/Entries'), '/app.txt/1.1/Thu Jan  1 00:00:00 1970//\n/gone.txt/1.3/Thu Jan  1 00:00:00 1970//\nD/sub////\n');
    await fs.writeFile(path.join(root, 'CVS/Entries.Log'), 'A /added.txt/0/dummy timestamp//\nR /gone.txt/1.3/Thu Jan  1 00:00:00 1970//\n');
    await fs.writeFile(path.join(root, 'sub/CVS/Root'), ':local:/nonexistent/cvsroot\n');
    await fs.writeFile(path.join(root, 'sub/CVS/Repository'), 'module-0/sub\n');
    await fs.writeFile(path.join(root, 'sub/CVS/Entries'), '/deep.txt/1.2/Thu Jan  1 00:00:00 1970//\n');
    await fs.writeFile(path.join(root, 'unversioned.txt'), 'local only\n');
    await fx.manager.scan(); await fx.settle();
    const state = fx.manager.state();
    assert.deepEqual(state.repositories.map(r=>r.kind), ['git'], 'unsynced CVS leaked into local changes');
    assert.equal(state.logRepositories.length, 7, 'log must list every discovered repository');
    assert.ok(state.logRepositories.some(r=>r.root===root));
    assert.ok(state.logRepositoryId, 'log has no default repository');
    assert.equal(state.unsyncedCvsCount, 6);
    const entry = [...fx.manager.entries.values()].find(e=>e.info.root===root);
    await fx.manager.request('selectRepository', {repositoryId:entry.info.id, surface:'log'});
    assert.equal(fx.manager.state().logRepositoryId, entry.info.id);
    assert.deepEqual(await fx.manager.request('getCvsFiles', {repositoryId:entry.info.id}), ['added.txt','app.txt','sub/deep.txt']);
    assert.equal(fx.localReads.length, 0, 'file list scanned local changes');
    assert.equal((await fx.read()).length, 0, 'file list contacted CVS');
    assert.deepEqual(entry.cvs.files, []);
    assert.equal(fx.manager.state().snapshots.length, 1, 'file list published an unsynced snapshot');
    await assert.rejects(fx.manager.request('selectRepository', {repositoryId:entry.info.id, surface:'commit'}), /available repository/);
    for (const command of ['scanRepository', 'updateProject', 'getWorkingFilePreview', 'rollbackFiles'])
      await assert.rejects(fx.manager.request(command, command === 'getWorkingFilePreview' ? {repositoryId:entry.info.id, filePath:'app.txt'} : command === 'rollbackFiles' ? {repositoryId:entry.info.id, filePaths:['app.txt']} : {repositoryId:entry.info.id}), /available repository/, command);
    await assert.rejects(fx.manager.execute('jettortoise.openCommitPanel', Uri.file(root)), /available repository/);
    await fx.manager.execute('jettortoise.openHistory', Uri.file(root));
    assert.equal(fx.manager.state().logRepositoryId, entry.info.id);
    assert.equal(fx.manager.state().historyRequest.repositoryId, entry.info.id);
    await fx.manager.request('refreshRepositories'); await fx.settle();
    assert.equal(fx.localReads.length, 0); assert.equal((await fx.read()).length, 0, 'refresh loaded an unsynced CVS repository');
    assert.equal(fx.manager.state().unsyncedCvsCount, 6, 'viewing history counted as synchronization');
  } finally { fx.manager.dispose(); await fs.rm(fx.base, {recursive:true,force:true}); }
});

test('按需同步：同步先读本地再排队一次 update，移除与重扫不重新加载', async () => {
  const fx = await setup();
  try {
    await fx.manager.scan(); await fx.settle();
    const entry = [...fx.manager.entries.values()][0];
    await fs.writeFile(path.join(entry.info.root,'CVS/Tag'),'TSYNC_BRANCH\n');
    let refreshes=0; const refresh=entry.cvs.refresh.bind(entry.cvs);
    entry.cvs.refresh=async (...args)=>{refreshes++;return refresh(...args)};
    const sent=[]; fx.manager.connect({postMessage:msg=>{sent.push(msg);return Promise.resolve(true)},onDidReceiveMessage:()=>disposable()});
    await fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(entry.info.root));
    assert.equal(refreshes,1);
    assert.equal(fx.manager.state().repositories.length,1);
    assert.ok(fx.manager.state().repositories[0].syncedAt);
    assert.equal(fx.manager.state().unsyncedCvsCount,5);
    assert.equal(fx.manager.state().snapshots[0].branch,'SYNC_BRANCH');
    assert.ok(sent.some(msg=>msg.event==='repositorySnapshot'&&msg.data.files.length>0), 'local snapshot was not published first');
    assert.ok(fx.commands.some(call=>call[0]==='jettortoise.commitPanel.focus'));
    assert.ok(fx.commands.some(call=>call[0]==='jettortoise.gitLog.focus'));
    await fx.settle();
    const starts=(await fx.read()).filter(call=>call.phase==='start');
    assert.equal(starts.length,1);assert.ok(starts[0].args.includes('-n'));assert.ok(starts[0].args.includes('update'));
    await fs.writeFile(path.join(entry.info.root,'app.txt'),'changed after synchronization\n');
    fx.events.files.fire(Uri.file(path.join(entry.info.root,'app.txt')));await fx.settle();
    assert.ok(fx.manager.state().snapshots[0].files.some(file=>file.path==='app.txt'&&file.status==='modified'),'file watcher did not refresh local state');
    assert.equal((await fx.read()).filter(call=>call.phase==='start').length,1,'file watcher contacted CVS');
    await fx.manager.request('removeSynchronizedRepository',{repositoryId:entry.info.id});
    assert.equal(fx.manager.state().repositories.length,0);assert.equal(fx.manager.state().unsyncedCvsCount,6);
    assert.equal(fx.manager.state().logRepositoryId,entry.info.id,'removing synchronization moved the log away');
    await fx.manager.scan();fx.events.focus.fire({focused:true});await fx.settle();
    assert.equal(fx.manager.state().repositories.length,0);
    assert.equal((await fx.read()).filter(call=>call.phase==='start').length,1);
    await fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(entry.info.root));await fx.settle();
    assert.equal(fx.manager.state().repositories.length,1);
    assert.equal((await fx.read()).filter(call=>call.phase==='start').length,2);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('按需同步：菜单 when 仅匹配 CVS 根，命令也拒绝子目录、Git 与普通目录', async () => {
  const fx=await setup();
  try {
    const root=path.join(fx.base,'wc-0'); const child=path.join(root,'child');await fs.mkdir(child);
    const plain=path.join(fx.base,'plain');await fs.mkdir(plain);
    const git=path.join(fx.base,'git');await fs.mkdir(git);require('node:child_process').execFileSync('git',['init'],{cwd:git,stdio:'ignore'});
    await fx.manager.scan();await fx.settle();
    const menu=require('../package.json').contributes.menus['explorer/context'].find(item=>item.command==='jettortoise.synchronizeRepository');
    assert.ok(menu,'missing sync menu');
    assert.equal(menu.when,'explorerResourceIsFolder && resourceScheme == file && resourcePath in jettortoise.cvsSyncRoots');
    assert.equal(menu.group,'zz_jettortoise@1');
    const roots=fx.commands.findLast(call=>call[0]==='setContext'&&call[1]==='jettortoise.cvsSyncRoots')?.[2];
    assert.ok(roots.includes(root)); for(const candidate of [child,git,plain]) assert.ok(!roots.includes(candidate));
    for(const candidate of [child,git,plain]) await assert.rejects(fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(candidate)),/CVS repository root/);
    await fs.mkdir(path.join(root,'CVS-child')); // parent CVS exclusion is independent of discovery continuation rules
    const nested=path.join(root,'CVS-child');await fs.mkdir(path.join(nested,'CVS'));await fs.writeFile(path.join(nested,'CVS/Root'),':local:/nonexistent/cvsroot');await fs.writeFile(path.join(nested,'CVS/Repository'),'independent-nested');await fs.writeFile(path.join(nested,'CVS/Entries'),'');
    await fx.manager.scan();
    assert.ok([...fx.manager.entries.values()].some(entry=>entry.info.root===nested),'nested boundary must still be discovered');
    const nextRoots=fx.commands.findLast(call=>call[0]==='setContext'&&call[1]==='jettortoise.cvsSyncRoots')[2];assert.ok(!nextRoots.includes(nested));assert.equal(fx.manager.state().unsyncedCvsCount,6);
    await assert.rejects(fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(nested)),/CVS repository root/);
    assert.equal((await fx.read()).length,0);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});


test('按需同步：同步排进共享网络队列，排队期间移除不启动 CVS',async()=>{
  const fx=await setup();let release;
  const gate=new Promise(resolve=>{release=resolve});
  const blockers=[fx.runNetwork(()=>gate),fx.runNetwork(()=>gate)];
  try {
    await fx.manager.scan();await fx.settle();
    const entry=[...fx.manager.entries.values()][0];
    await fx.manager.execute('jettortoise.synchronizeRepository',Uri.file(entry.info.root));
    await delay(150);assert.equal((await fx.read()).length,0,'sync bypassed the shared network queue');
    assert.ok(fx.manager.state().snapshots[0].files.length>0,'local files must appear while network is queued');
    await fx.manager.request('removeSynchronizedRepository',{repositoryId:entry.info.id});
    release();await Promise.all(blockers);await delay(200);
    assert.equal((await fx.read()).length,0,'removed queued repository started CVS');
    assert.equal(fx.manager.state().repositories.length,0);
  } finally {release();await Promise.all(blockers);fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('多 Git 仓共用保存订阅，重复发现和焦点刷新不增加监听，关闭后释放', async () => {
  const fx = await setup();
  try {
    const {execFileSync} = require('node:child_process');
    for (let i=0;i<24;i++) execFileSync('git',['init','-q',path.join(fx.base,`git-${i}`)]);
    await fx.manager.scan();
    assert.equal(fx.events.save.listeners.size,1,'每仓不应注册全局保存监听');
    for(let i=0;i<20;i++) {
      await fx.manager.scan();fx.events.focus.fire({focused:true});
      assert.equal(fx.events.save.listeners.size,1);
    }
  } finally {fx.manager.dispose();assert.equal(fx.events.save.listeners.size,0);await fs.rm(fx.base,{recursive:true,force:true});}
});

test('首屏先返回仓库摘要，大快照分批传输且连接关闭后停止', async () => {
  const fx = await setup();
  try {
    const {execFileSync}=require('node:child_process');execFileSync('git',['init','-q',fx.base]);
    await fx.manager.scan();await delay(300);
    const entry=[...fx.manager.entries.values()].find(e=>e.info.kind==='git');
    entry.snapshot={repositoryId:entry.info.id,files:Array.from({length:60000},(_,i)=>({repositoryId:entry.info.id,path:`file-${i}.txt`,status:'modified',staged:false}))};
    let receive;const sent=[];
    const connection=fx.manager.connect({postMessage:async message=>{sent.push(message);return true;},onDidReceiveMessage:fn=>{receive=fn;return disposable();}});
    await receive({type:'request',id:'initial',command:'getRepositories',params:{}});
    const initial=sent.find(m=>m.type==='response');
    assert.equal(initial.data.snapshots[0].files.length,0,'首次响应不能携带六万文件');
    assert.equal(initial.data.snapshots[0].refreshing,true);
    await receive({type:'request',id:'overlap',command:'getRepositoryChanges',params:{}});
    await delay(800);
    const reset=sent.findLastIndex(m=>m.event==='repositorySnapshot');
    const chunks=sent.slice(reset+1).filter(m=>m.event==='repositorySnapshotDelta');
    assert.equal(chunks.reduce((n,m)=>n+m.data.changed.length,0),60000);
    assert.ok(chunks.every(m=>m.data.changed.length<=5000),'单批文件必须有界');
    assert.notEqual(chunks.at(-1).data.refreshing,true);
    await receive({type:'request',id:'again',command:'getRepositories',params:{}});
    await delay(40);
    const fresh={repositoryId:entry.info.id,files:[{repositoryId:entry.info.id,path:'fresh.txt',status:'modified',staged:false}]};
    entry.snapshot=fresh;fx.manager.publishSnapshot(fresh);
    await delay(100);
    const assembled=new Map();
    for(const message of sent) {
      if(message.event==='repositorySnapshot') { assembled.clear();for(const file of message.data.files)assembled.set(JSON.stringify([file.repositoryId,file.path]),file); }
      if(message.event==='repositorySnapshotDelta') { for(const key of message.data.removed)assembled.delete(key);for(const file of message.data.changed)assembled.set(JSON.stringify([file.repositoryId,file.path]),file); }
    }
    assert.deepEqual([...assembled.values()].map(file=>file.path),['fresh.txt'],'新小快照必须取消旧分批并完整替换');
    await receive({type:'request',id:'closing',command:'getRepositories',params:{}});connection.dispose();const before=sent.length;await delay(100);assert.equal(sent.length,before);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('忽略目录不登记 Git，但其中独立 CVS 仍然发现，显式根仍可打开', async () => {
  const fx=await setup();
  try {
    const {execFileSync}=require('node:child_process');execFileSync('git',['init','-q',fx.base]);
    await fs.writeFile(path.join(fx.base,'.gitignore'),'.local/tmp/\n');
    const ignored=path.join(fx.base,'.local','tmp','git');execFileSync('git',['init','-q',ignored]);
    // 目录名避开 cvs：大小写不敏感卷（macOS 默认 APFS）上 ignored/CVS 会解析到 ignored/cvs，把 Git 根误当 CVS 工作副本。
    await fs.mkdir(path.join(ignored,'module','CVS'),{recursive:true});
    for(const [name,value] of Object.entries({Root:':local:/nonexistent/cvsroot\n',Repository:'separate\n',Entries:''}))await fs.writeFile(path.join(ignored,'module','CVS',name),value);
    await fx.manager.scan();
    const roots=[...fx.manager.entries.values()].map(e=>e.info.root);
    assert.ok(!roots.includes(ignored),'忽略目录中的 Git 不自动登记');
    assert.ok(roots.includes(path.join(ignored,'module')),'CVS 不随 Git 忽略目录丢失');global.__performanceVscode.workspace.workspaceFolders=[{uri:Uri.file(ignored)}];await fx.manager.scan();assert.ok(fx.manager.repositories.some(repo=>repo.root===ignored),'显式工作区根仍可登记');
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});

test('本地 Git 刷新最多并发 4 个，同仓重复刷新合并', async () => {
  const fx=await setup();
  try {
    const {execFileSync}=require('node:child_process');
    for(let i=0;i<8;i++)execFileSync('git',['init','-q',path.join(fx.base,`git-${i}`)]);
    await fx.manager.scan();await Promise.all([...fx.manager.entries.values()].map(e=>e.refreshTask));
    let active=0,peak=0,calls=0;
    const entries=[...fx.manager.entries.values()].filter(e=>e.git);
    for(const entry of entries)entry.git.service.getWorkingTreeChanges=async()=>{calls++;peak=Math.max(peak,++active);await delay(40);active--;return[];};
    await Promise.all(Array.from({length:20},()=>entries.map(e=>fx.manager.refresh(e,false))).flat());
    assert.equal(calls,8);assert.equal(peak,4);assert.equal(active,0);
  } finally {fx.manager.dispose();await fs.rm(fx.base,{recursive:true,force:true});}
});
