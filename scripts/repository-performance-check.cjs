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
  static file(name) { return { scheme: 'file', path: name, fsPath: name }; }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const setup = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'repository-performance-'));
  const calls = path.join(base, 'calls.jsonl');
  const fake = path.join(base, 'fake-cvs');
  await fs.writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');const out=${JSON.stringify(calls)};fs.appendFileSync(out,JSON.stringify({phase:'start',pid:process.pid,args:process.argv.slice(2),time:Date.now()})+'\\n');setTimeout(()=>{fs.appendFileSync(out,JSON.stringify({phase:'end',pid:process.pid,time:Date.now()})+'\\n');},120);\n`, { mode: 0o755 });
  const events = { focus: new Emitter(), save: new Emitter(), files: new Emitter() };
  const warnings = [];
  const vscode = {
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
  await build({ entryPoints: ['src/repositories/manager.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, plugins: [{ name: 'vscode-fixture', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'module.exports=global.__performanceVscode;' })); } }] });
  const { RepositoryManager } = require(bundle);
  const manager = new RepositoryManager({ extensionUri: Uri.file(process.cwd()) });
  for (let n = 0; n < 6; n++) {
    const dir = path.join(base, 'wc-' + n); await fs.mkdir(path.join(dir, 'CVS'), { recursive: true });
    await fs.writeFile(path.join(dir, 'CVS/Root'), ':local:/nonexistent/cvsroot\n');
    await fs.writeFile(path.join(dir, 'CVS/Repository'), 'module-' + n + '\n');
    await fs.writeFile(path.join(dir, 'CVS/Entries'), '/app.txt/1.1/Thu Jan  1 00:00:00 1970//\n');
    await fs.writeFile(path.join(dir, 'app.txt'), 'modified\n');
  }
  const read = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const settle = async () => { await delay(500); await Promise.all([...manager.entries.values()].map(entry => entry.cvs.network)); };
  return { base, calls, fake, manager, events, warnings, read, settle };
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
    await fx.manager.scan(); await fx.settle(); await fs.writeFile(fx.calls, '');
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
    const session = [...fx.manager.entries.values()][0].cvs;
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
