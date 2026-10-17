import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({
  entryPoints: [
    'src/background.ts',
    'src/offscreen.ts',
    'src/content.ts',
    'src/app.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: false,
  legalComments: 'none',
});

await build({
  entryPoints: { 'media-worker': 'src/core/media-worker.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  legalComments: 'none',
});
