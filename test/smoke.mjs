/**
 * Host smoke test for dsh-workspace-preview: exercises the RPC handler
 * (list + read endpoints) against the real workspace directory with a fake
 * cordis ctx. Run: node test/smoke.mjs
 */
import { apply } from '../lib/index.js';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// The workspace root we fence against — this repository checkout itself.
const WORKSPACE = path.resolve(root, '..');

let handler;
let disposed = false;
const disposers = [];

const ctx = {
  workspaceRegistry: { list: () => [{ path: WORKSPACE }] },
  connection: {
    rpc: {
      handle: (channel, h, options) => {
        if (channel !== '/dsh-workspace-previewspace-preview') throw new Error(`unexpected channel ${channel}`);
        if (options?.authority !== 'loopback') throw new Error('expected loopback authority');
        handler = h;
        return async () => { disposed = true; };
      },
    },
  },
  effect: (fn) => {
    // Real cordis runs effect bodies synchronously at registration.
    disposers.push(fn());
    return () => {};
  },
};

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

apply(ctx);
if (handler === undefined) { console.log('FAIL  rpc channel registered'); process.exit(1); }
console.log('PASS  rpc channel registered with loopback authority');

// list: workspace root
{
  const res = await handler('list', { path: WORKSPACE });
  check('list(root) ok', res.ok === true, res.ok ? '' : res.error?.message);
  const { entries, path: listed, truncated } = res.value;
  check('list(root) returns entries', Array.isArray(entries) && entries.length > 0, `${entries.length} entries`);
  check('list(root) path echoes', listed === WORKSPACE);
  check('list(root) has dsh-workspace-preview dir', entries.some((e) => e.kind === 'dir' && e.name === 'dsh-workspace-preview'));
  const dirs = entries.filter((e) => e.kind === 'dir');
  const files = entries.filter((e) => e.kind === 'file');
  check('list(root) dirs sorted before files', dirs.length + files.length === entries.length && (files.length === 0 || dirs.every((d) => entries.indexOf(d) < entries.indexOf(files[0]))));
  check('list(root) file entries carry size', files.every((f) => typeof f.size === 'number'));
  check('list(root) not truncated', truncated !== true);
}

// list: a real subdirectory
{
  const res = await handler('list', { path: path.join(WORKSPACE, 'dsh-workspace-preview/lib') });
  check('list(lib) ok', res.ok === true, res.ok ? '' : res.error?.message);
  check('list(lib) contains index.js + client.js',
    res.value.entries.some((e) => e.name === 'index.js') &&
    res.value.entries.some((e) => e.name === 'client.js'));
}

// read: text file
{
  const res = await handler('read', { path: path.join(WORKSPACE, 'dsh-workspace-preview/lib/index.js') });
  check('read(index.js) ok', res.ok === true, res.ok ? '' : res.error?.message);
  check('read(index.js) kind=text', res.value.kind === 'text');
  check('read(index.js) contains apply(ctx)', res.value.text.includes('export function apply(ctx)'));
  check('read(index.js) size matches', res.value.size > 1000);
}

// read: nonexistent file
{
  const res = await handler('read', { path: path.join(WORKSPACE, 'no-such-file.txt') });
  check('read(missing) fails', res.ok === false);
  check('read(missing) error message', /does not exist/.test(res.error?.message ?? ''), res.error?.message);
}

// list: outside workspace — must be rejected
{
  const outside = '/etc';
  const res = await handler('list', { path: outside });
  check('list(/etc) rejected', res.ok === false);
  check('list(/etc) mentions outside-workspace', /outside the registered workspaces/.test(res.error?.message ?? ''), res.error?.message);
}

// read: directory — must be rejected
{
  const res = await handler('read', { path: path.join(WORKSPACE, 'dsh-workspace-preview') });
  check('read(dir) rejected', res.ok === false);
}

// unknown endpoint
{
  const res = await handler('nope', {});
  check('unknown endpoint fails', res.ok === false && /unknown endpoint/.test(res.error?.message ?? ''));
}

// dispose
{
  for (const dispose of disposers.reverse()) await dispose();
  check('disposer runs', disposed === true);
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
