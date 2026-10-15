// Publish the already-packaged VSIX for the current manifest version.
//
// Authentication (see docs/release.md):
//   --entra  vsce publish --azure-credential; the token comes from the Azure
//            identity chain (AZURE_* env, `az login`, …). Default when `az
//            account show` succeeds.
//   --pat    Personal Access Token from VSCE_PAT or the login keychain item
//            `vscode-marketplace-token` (account `jettortoise`). Passed to vsce
//            through the environment only, never through argv. Default
//            otherwise. Global PATs stop working on 2026-12-01.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, 'release', `jettortoise-${manifest.version}.vsix`);
if (!fs.existsSync(vsix)) {
  console.error(`Missing ${path.relative(root, vsix)}; run \`pnpm run vsce:package\` first.`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const azLoggedIn = () => spawnSync('az', ['account', 'show', '-o', 'none'], { stdio: 'ignore' }).status === 0;
const mode = argv.includes('--pat') ? 'pat' : argv.includes('--entra') ? 'entra' : azLoggedIn() ? 'entra' : 'pat';

const args = ['publish', '--packagePath', vsix];
const env = { ...process.env };
if (mode === 'entra') {
  args.push('--azure-credential');
} else {
  let pat = process.env.VSCE_PAT;
  if (!pat) {
    const keychain = spawnSync(
      'security',
      ['find-generic-password', '-a', 'jettortoise', '-s', 'vscode-marketplace-token', '-w'],
      { encoding: 'utf8' },
    );
    pat = keychain.status === 0 ? keychain.stdout.trim() : '';
  }
  if (!pat) {
    console.error('No Marketplace token: run `az login` for Entra, set VSCE_PAT, or add keychain item vscode-marketplace-token (see docs/release.md).');
    process.exit(1);
  }
  env.VSCE_PAT = pat;
}
console.log(`Publishing ${path.relative(root, vsix)} as ${manifest.publisher}.${manifest.name} via ${mode === 'entra' ? 'Microsoft Entra ID' : 'PAT'}`);

const vsce = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [vsce, ...args], { cwd: root, stdio: 'inherit', env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
