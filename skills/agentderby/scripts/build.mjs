import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const outdir = path.join(root, 'dist');

fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: path.join(outdir, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  sourcemap: true,
  // Node built-ins should stay external.
  external: ['events','stream','crypto','buffer','util','net','tls','http','https','url','zlib','assert','fs','path','os'],
  // Keep it simple: no minify, preserve names for debugging.
  minify: false,
  legalComments: 'none',
});

console.log('[agentderby] build ok -> dist/index.js');
