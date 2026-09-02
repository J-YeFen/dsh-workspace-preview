/**
 * Build the CodeMirror editor chunk (方案 A — one-time dev build, artifact
 * committed; runtime stays zero-dependency).
 *
 *   node scripts/build-editor.mjs
 *
 * Bundles src-editor/editor-entry.js (devDependency CodeMirror packages) into
 * the committed artifact lib/client-chunk-editor.js, served by the host at
 * /dsh-workspace-preview/bundle/editor.js and fetched lazily when the user
 * enters edit mode. Re-run this script after changing src-editor/ or bumping
 * the CodeMirror devDependencies; commit the produced artifact alongside.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'src-editor/editor-entry.js')],
  outfile: path.join(root, 'lib/client-chunk-editor.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

console.log('built lib/client-chunk-editor.js');
