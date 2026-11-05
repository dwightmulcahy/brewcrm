// Usage: node scripts/build.mjs <web|offline>   (OUT_DIR overrides dist/<edition>)
//
// web:     PocketBase app dirs consumed by the Docker image (pb_public, pb_hooks, pb_migrations)
// offline: same app plus start scripts + instructions to run with a local PocketBase binary (no Docker)
import { cp, rm, writeFile, mkdir, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';

const edition = process.argv[2];
if (!['web', 'offline'].includes(edition)) {
  console.error('edition must be "web" or "offline"');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.OUT_DIR ?? path.join(root, 'dist', edition));
// Release builds pass APP_VERSION (tag without "v") and GIT_SHA; anything else is a dev build.
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const appVersion = (process.env.APP_VERSION ?? '').trim().replace(/^v/, '');
const version = semver.test(appVersion) ? appVersion : 'dev';
const commit = /^[0-9a-f]{7,40}$/i.test(process.env.GIT_SHA ?? '') ? process.env.GIT_SHA.slice(0, 7).toLowerCase() : '';
const dockerfile = await readFile(path.join(root, 'Dockerfile'), 'utf8');
const pbVersion = (dockerfile.match(/^ARG PB_VERSION=(\S+)/m) || [])[1];
if (!pbVersion) throw new Error('PB_VERSION not found in Dockerfile');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const dir of ['pb_public', 'pb_hooks', 'pb_migrations']) {
  await cp(path.join(root, dir), path.join(out, dir), { recursive: true });
}

if (edition === 'offline') {
  const args = '--dir=./pb_data --migrationsDir=./pb_migrations --hooksDir=./pb_hooks --publicDir=./pb_public';
  await writeFile(path.join(out, 'start.sh'),
    `#!/bin/sh\n# BrewCRM offline edition. Requires the PocketBase ${pbVersion} binary in this folder.\nset -e\ncd "$(dirname "$0")"\n` +
    `[ -f .env ] && set -a && . ./.env && set +a\n` +
    `exec ./pocketbase serve --http=127.0.0.1:\${PORT:-8080} ${args}\n`);
  await chmod(path.join(out, 'start.sh'), 0o755);
  await writeFile(path.join(out, 'start.cmd'),
    `@echo off\r\nrem BrewCRM offline edition. Requires pocketbase.exe ${pbVersion} in this folder.\r\ncd /d "%~dp0"\r\n` +
    `if "%PORT%"=="" set PORT=8080\r\npocketbase.exe serve --http=127.0.0.1:%PORT% ${args}\r\n`);
  await writeFile(path.join(out, 'OFFLINE.md'), `# BrewCRM offline edition

Runs on a single computer without Docker.

1. Download PocketBase ${pbVersion} for your OS from
   https://github.com/pocketbase/pocketbase/releases/tag/v${pbVersion}
   and put the \`pocketbase\` (or \`pocketbase.exe\`) binary in this folder.
2. Optional: create \`.env\` with integration keys (see \`.env.example\` in the repository).
   On Windows, set them as environment variables instead.
3. Create the admin: \`./pocketbase superuser upsert you@example.com 'long-password' --dir=./pb_data\`
4. Run \`./start.sh\` (macOS/Linux) or \`start.cmd\` (Windows) and open http://127.0.0.1:8080/_/
   to add sales users, then http://127.0.0.1:8080/ to use the app.

Data is stored in \`pb_data/\`. Back it up.
`);
}

await writeFile(
  path.join(out, 'build.json'),
  JSON.stringify({ edition, version, commit, pocketbase: pbVersion, builtAt: new Date().toISOString() }, null, 2) + '\n',
);
// Public copy for the UI: version and commit only (no dependency versions)
await writeFile(path.join(out, 'pb_public', 'version.json'), JSON.stringify({ version, commit }) + '\n');
console.log(`built ${edition} -> ${path.relative(root, out) || out}`);
