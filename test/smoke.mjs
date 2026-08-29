/**
 * Host smoke test for dsh-workspace-preview: exercises the RPC handler
 * (list + read + write + rename + remove endpoints, OOXML extraction)
 * against the real workspace directory with a fake cordis ctx.
 * Run: node test/smoke.mjs
 */
import { apply } from '../lib/index.js';
import { buildDocx, buildPptx, buildXlsx } from './office-fixtures.mjs';
import { promises as fs } from 'node:fs';
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
        if (channel !== '/dsh-workspace-preview') throw new Error(`unexpected channel ${channel}`);
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

// write / rename / remove / office — scratch files live under .smoke-tmp/
// inside the checkout (hence inside the fenced workspace) and are cleaned up.
const TMP = path.join(root, '.smoke-tmp');
await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
try {
  const f1 = path.join(TMP, 'edit-me.txt');
  await fs.writeFile(f1, 'original content', 'utf8');

  // write: round-trip
  {
    const res = await handler('write', { path: f1, content: '更新后的内容 ✓' });
    check('write ok', res.ok === true, res.ok ? '' : res.error?.message);
    check('write returns bytes + mtimeMs',
      typeof res.value?.bytes === 'number' && typeof res.value?.mtimeMs === 'number');
    check('write round-trip content', (await fs.readFile(f1, 'utf8')) === '更新后的内容 ✓');
  }

  // write: stale mtime -> conflict; fresh mtime -> ok
  {
    const stale = await handler('write', { path: f1, content: 'x', mtimeMs: 1 });
    check('write stale mtime -> conflict', stale.ok === false && stale.error?.code === 'conflict', stale.error?.message);
    const fresh = await handler('write', { path: f1, content: 'second', mtimeMs: (await fs.stat(f1)).mtimeMs });
    check('write fresh mtime ok', fresh.ok === true, fresh.ok ? '' : fresh.error?.message);
  }

  // write: directory / outside workspace rejected
  {
    const res = await handler('write', { path: TMP, content: 'x' });
    check('write(dir) rejected', res.ok === false);
  }
  {
    const res = await handler('write', { path: '/etc/hosts', content: 'x' });
    check('write(/etc/hosts) rejected', res.ok === false && /outside the registered workspaces/.test(res.error?.message ?? ''), res.error?.message);
  }

  // rename: happy path keeps content
  const f2 = path.join(TMP, 'renamed.txt');
  {
    const res = await handler('rename', { path: f1, newName: 'renamed.txt' });
    check('rename ok', res.ok === true && res.value?.path === f2, res.ok ? '' : res.error?.message);
    check('rename keeps content', (await fs.readFile(f2, 'utf8')) === 'second');
  }

  // rename: existing target / bad name / workspace root / outside rejected
  {
    await fs.writeFile(path.join(TMP, 'taken.txt'), 'taken', 'utf8');
    const res = await handler('rename', { path: f2, newName: 'taken.txt' });
    check('rename onto existing rejected', res.ok === false && /already exists/.test(res.error?.message ?? ''));
  }
  {
    const res = await handler('rename', { path: f2, newName: 'a/b' });
    check('rename with path separator rejected', res.ok === false);
  }
  {
    const res = await handler('rename', { path: WORKSPACE, newName: 'nope' });
    check('rename(workspace root) rejected', res.ok === false && /workspace root/.test(res.error?.message ?? ''));
  }
  {
    const res = await handler('rename', { path: '/etc/hosts', newName: 'hosts2' });
    check('rename(/etc/hosts) rejected', res.ok === false);
  }

  // remove: file, then a directory tree
  {
    const res = await handler('remove', { path: path.join(TMP, 'taken.txt') });
    check('remove(file) ok', res.ok === true, res.ok ? '' : res.error?.message);
    let gone = false;
    try { await fs.lstat(path.join(TMP, 'taken.txt')); } catch { gone = true; }
    check('remove actually deletes', gone);
  }
  {
    await fs.mkdir(path.join(TMP, 'sub/deep'), { recursive: true });
    await fs.writeFile(path.join(TMP, 'sub/deep/x.txt'), 'x', 'utf8');
    const res = await handler('remove', { path: path.join(TMP, 'sub') });
    check('remove(dir tree) ok', res.ok === true, res.ok ? '' : res.error?.message);
  }

  // remove: workspace root / outside rejected
  {
    const res = await handler('remove', { path: WORKSPACE });
    check('remove(workspace root) rejected', res.ok === false && /workspace root/.test(res.error?.message ?? ''));
  }
  {
    const res = await handler('remove', { path: '/etc' });
    check('remove(/etc) rejected', res.ok === false);
  }

  // office: fixtures built in-memory, read through the read endpoint
  {
    const p = path.join(TMP, 'sample.docx');
    await fs.writeFile(p, buildDocx());
    const res = await handler('read', { path: p });
    check('read(docx) kind=office', res.ok === true && res.value?.kind === 'office' && res.value?.format === 'docx', res.ok ? '' : res.error?.message);
    const blocks = res.value?.blocks ?? [];
    check('docx heading extracted (entities decoded)',
      blocks.some((b) => b.type === 'heading' && b.level === 1 && b.text.includes('A & B')));
    check('docx paragraph keeps tab', blocks.some((b) => b.type === 'para' && b.text.includes('\t')));
    check('docx 2x2 table extracted',
      blocks.some((b) => b.type === 'table' && b.rows.length === 2 && b.rows[0].length === 2));
  }
  {
    const p = path.join(TMP, 'sample.xlsx');
    await fs.writeFile(p, buildXlsx());
    const res = await handler('read', { path: p });
    check('read(xlsx) kind=office', res.ok === true && res.value?.format === 'xlsx', res.ok ? '' : res.error?.message);
    check('xlsx two sheets', (res.value?.sheets?.length ?? 0) === 2);
    check('xlsx column gap lands empty cell', (res.value?.sheets?.[0]?.rows?.[0]?.length ?? 0) >= 3);
  }
  {
    const p = path.join(TMP, 'sample.pptx');
    await fs.writeFile(p, buildPptx());
    const res = await handler('read', { path: p });
    check('read(pptx) kind=office', res.ok === true && res.value?.format === 'pptx', res.ok ? '' : res.error?.message);
    check('pptx two slides with lines',
      (res.value?.slides?.length ?? 0) === 2 && res.value.slides.every((s) => Array.isArray(s.lines)));
  }

  // legacy OLE2 office: recognized, not parsed
  {
    const p = path.join(TMP, 'old.doc');
    await fs.writeFile(p, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    const res = await handler('read', { path: p });
    check('read(.doc) -> binary + legacy-office hint',
      res.ok === true && res.value?.kind === 'binary' && res.value?.hint === 'legacy-office');
  }

  // list: truncated flag — exactly MAX_ENTRIES entries must NOT be flagged
  {
    const dir = path.join(TMP, 'exact-cap');
    await fs.mkdir(dir);
    for (let i = 0; i < 2000; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const res = await handler('list', { path: dir });
    check('list exactly 2000 entries not truncated',
      res.ok === true && res.value?.truncated === false && res.value?.entries?.length === 2000,
      res.ok ? `truncated=${res.value?.truncated}` : res.error?.message);
    const over = path.join(TMP, 'over-cap');
    await fs.mkdir(over);
    for (let i = 0; i < 2001; i++) await fs.writeFile(path.join(over, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const res2 = await handler('list', { path: over });
    check('list 2001 entries truncated',
      res2.ok === true && res2.value?.truncated === true && res2.value?.entries?.length === 2000,
      res2.ok ? `truncated=${res2.value?.truncated}` : res2.error?.message);
  }

  // fence: a symlinked workspace root must still work — canonicalInside has to
  // canonicalize the roots, not just the requested path (regression)
  {
    let handler2;
    const link = path.join(TMP, 'root-link');
    await fs.symlink(TMP, link, 'dir');
    const ctx2 = {
      workspaceRegistry: { list: () => [{ path: link }] },
      connection: { rpc: { handle: (_c, h) => { handler2 = h; return async () => {}; } } },
      effect: (fn) => { fn(); return () => {}; },
    };
    apply(ctx2);
    const res = await handler2('list', { path: link });
    check('list via symlinked root ok', res.ok === true, res.ok ? '' : res.error?.message);
    const sub = await handler2('list', { path: path.join(link, 'exact-cap') });
    check('list inside symlinked root ok', sub.ok === true && (sub.value?.entries?.length ?? 0) === 2000);
    const root = await handler2('remove', { path: link });
    check('remove via symlinked root (itself) still rejected', root.ok === false && /workspace root/.test(root.error?.message ?? ''));
  }
} finally {
  await fs.rm(TMP, { recursive: true, force: true });
}

// dispose
{
  for (const dispose of disposers.reverse()) await dispose();
  check('disposer runs', disposed === true);
}

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
