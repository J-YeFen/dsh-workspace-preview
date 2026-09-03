/**
 * Build the Office rich-preview chunk (方案 A pattern — one-time dev build,
 * artifact committed; runtime stays zero-dependency).
 *
 *   node scripts/build-office-rich.mjs
 *
 * Prerequisite: `npm install --save-dev docx-preview jszip` (registry access
 * needed once at authoring time — the packages are never shipped).
 *
 * Bundles src-office-rich/office-rich-entry.js (docx-preview + jszip, both
 * devDependencies) into the committed artifact
 * lib/client-chunk-office-rich.js, served by the host at
 * /dsh-workspace-preview/bundle/office-rich.js and fetched lazily when the
 * user opens a .docx/.pptx file. Re-run after changing src-office-rich/ or
 * bumping the devDependencies; commit the produced artifact alongside.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src-office-rich/office-rich-entry.js')],
  outfile: path.join(root, 'lib/client-chunk-office-rich.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  // docx-preview is Apache-2.0 / jszip MIT — keep their license headers in the
  // committed artifact (appended at the end of the bundle).
  legalComments: 'eof',
  logLevel: 'info',
});

console.log('built lib/client-chunk-office-rich.js');
