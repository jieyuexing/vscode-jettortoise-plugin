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
    window: { withProgress: (_options,run)=>run({}, {onCancellationRequested:()=>disposable()}), onDidChangeActiveTextEditor: () => disposable(), onDidChangeWindowState: events.focus.event, showWarningMessage: message => { warnings.push(message); return Promise.resolve(); } },
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
test('扫描超限只提示一次并停止自动重试，不写入树快照错误', async () => {
  const fx = await setup();
  try {
    await fx.manager.scan(); await fx.settle();
    const entry = [...fx.manager.entries.values()][0];
    await fx.manager.execute('jettortoise.synchronizeRepository', Uri.file(entry.info.root));await fx.settle();
    const session = entry.cvs;
    let attempts = 0;
    session.adapter.localStatus = async () => { attempts++; throw Object.assign(new Error('inventoryLimit'), { code: 'inventoryLimit' }); };
    await session.refresh(); await session.refresh(); await session.refresh();
    assert.equal(attempts, 1); assert.equal(fx.warnings.length, 1);
    assert.deepEqual(await fx.manager.request('getCvsFiles',{repositoryId:session.id}),[]);
    assert.equal(attempts,1,'history file list retried a stopped scan');
    assert.equal(fx.manager.state().snapshots[0].error, undefined);
  } finally { fx.manager.dispose(); await fs.rm(fx.base, { recursive: true, force: true }); }
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


test('按需同步：打开只列 Git，未同步 CVS 不读本地状态、不调用 CVS', async () => {
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
    await assert.rejects(fx.manager.execute('jettortoise.openHistory',Uri.file(path.join(fx.base,'wc-0'))),/available repository/);
    for (const entry of fx.manager.entries.values()) if(entry.cvs) assert.deepEqual(entry.cvs.files, []);
    assert.equal((await fx.read()).length, 0);
    await fx.manager.request('refreshRepositories'); await fx.settle();
    assert.equal((await fx.read()).length, 0, 'global refresh loaded an unsynced CVS repository');
    assert.equal(fx.localReads.length,0);
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
