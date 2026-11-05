// Usage: node scripts/build.mjs <web|offline>   (OUT_DIR overrides dist/<edition>)
import { cp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const edition = process.argv[2];
if (!['web', 'offline'].includes(edition)) {
  console.error('edition must be "web" or "offline"');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.env.OUT_DIR ?? path.join(root, 'dist', edition));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(root, 'src'), out, { recursive: true });
await writeFile(
  path.join(out, 'build.json'),
  JSON.stringify({ edition, builtAt: new Date().toISOString() }, null, 2) + '\n',
);
console.log(`built ${edition} -> ${path.relative(root, out) || out}`);
