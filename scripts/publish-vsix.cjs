// Publish the already-packaged VSIX for the current manifest version.
// The Marketplace token comes from VSCE_PAT or the login keychain item
// `vscode-marketplace-token` (account `jettortoise`); it is passed to vsce
// through the environment only, never through argv.
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
  console.error('No Marketplace token: set VSCE_PAT or add keychain item vscode-marketplace-token (see docs/release.md).');
  process.exit(1);
}

const vsce = require.resolve('@vscode/vsce/vsce');
const result = spawnSync(process.execPath, [vsce, 'publish', '--packagePath', vsix], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VSCE_PAT: pat },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
