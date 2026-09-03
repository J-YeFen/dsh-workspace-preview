/**
 * Host smoke test for dsh-workspace-preview (v0.3 architecture):
 * drives the RPC channel endpoints (list/search/read/write/rename/remove —
 * incl. symlink list fields, atomic conflict-safe write, OOXML extraction,
 * caps, multi-root fence) AND the three HTTP routes (media / html / bundle —
 * incl. the browser-trust fence) against the real workspace directory with a
 * fake cordis ctx.
 * Run: node test/smoke.mjs
 */
import { apply, inject } from '../lib/index.js';
import { buildDocx, buildPptx, buildXlsx } from './office-fixtures.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// The workspace root we fence against — this repository checkout itself.
const WORKSPACE = path.resolve(root, '..');

let failures = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

// ── fake cordis ctx: rpc + webserver routes + effect ───────────────────────
let handler;
let routes = [];
let disposed = false;
const disposers = [];

const ctx = {
  workspaceRegistry: { list: () => [{ path: WORKSPACE }] },
  webRuntime: { trustedHosts: [] },
  webServer: {
    register: (r) => {
      routes.push(r);
      return async () => { disposed = true; };
    },
  },
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
    disposers.push(fn());
    return () => {};
  },
};

check('host inject includes webRuntime (cordis proxy get guard)', inject.includes('webRuntime'), inject.join(','));
apply(ctx);
if (handler === undefined) { console.log('FAIL  rpc channel registered'); process.exit(1); }
console.log('PASS  rpc channel registered with loopback authority');

const route = (p) => routes.find((r) => r.path === p);
for (const p of ['/dsh-workspace-preview/media', '/dsh-workspace-preview/office-raw', '/dsh-workspace-preview/html', '/dsh-workspace-preview/bundle']) {
  check(`http route registered: ${p}`, route(p) !== undefined);
}

// ── HTTP fake req/res helpers ──────────────────────────────────────────────
const makeRes = () => {
  let status = 0;
  let headers = null;
  let body = '';
  return {
    get status() { return status; },
    get headers() { return headers ?? {}; },
    get body() { return body; },
    writeHead(s, h) { status = s; headers = h ?? null; },
    end(b) { body = b ?? ''; },
  };
};

async function httpGet(routePath, url, reqHeaders = {}) {
  const res = makeRes();
  await route(routePath).handler({
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:3080', ...reqHeaders },
  }, res);
  return res;
}

// trust fence: foreign host / cross-site refused on the media route
{
  const res = await httpGet('/dsh-workspace-preview/media', '/dsh-workspace-preview/media?path=' + encodeURIComponent(path.join(WORKSPACE, 'dsh-workspace-preview/README.md')), { host: 'evil.example.com' });
  check('media: foreign host refused', res.status === 403, String(res.status));
}
{
  const res = await httpGet('/dsh-workspace-preview/media', '/dsh-workspace-preview/media?path=x', { 'sec-fetch-site': 'cross-site' });
  check('media: cross-site refused', res.status === 403, String(res.status));
}

// ── scratch area ───────────────────────────────────────────────────────────
const TMP = path.join(root, '.smoke-tmp');
await fs.rm(TMP, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });
try {
  // symlink fixtures: dir link + dangling link
  await fs.mkdir(path.join(TMP, 'realdir'), { recursive: true });
  await fs.writeFile(path.join(TMP, 'realdir/inner.txt'), 'inner', 'utf8');
  await fs.symlink(path.join(TMP, 'realdir'), path.join(TMP, 'dir-link'), 'dir');
  await fs.symlink(path.join(TMP, 'no-such-target'), path.join(TMP, 'dead-link'), 'file');

  // ── list: symlink fields ─────────────────────────────────────────────────
  {
    const res = await handler('list', { path: TMP });
    check('list(tmp) ok', res.ok === true, res.ok ? '' : res.error?.message);
    const dirLink = res.value.entries.find((e) => e.name === 'dir-link');
    check('list: dir symlink flagged + kind dir', dirLink?.isSymlink === true && dirLink?.kind === 'dir', JSON.stringify(dirLink));
    const dead = res.value.entries.find((e) => e.name === 'dead-link');
    check('list: dangling symlink flagged broken', dead?.isSymlink === true && dead?.broken === true, JSON.stringify(dead));
  }

  // ── search ───────────────────────────────────────────────────────────────
  {
    await fs.mkdir(path.join(TMP, 'sub/deep'), { recursive: true });
    await fs.writeFile(path.join(TMP, 'sub/deep/needle-report.txt'), 'x', 'utf8');
    const res = await handler('search', { root: TMP, query: 'needle' });
    check('search ok', res.ok === true, res.ok ? '' : res.error?.message);
    check('search finds nested file',
      res.value.results.some((r) => r.name === 'needle-report.txt' && r.kind === 'file'),
      JSON.stringify(res.value.results.slice(0, 3)));
  }
  {
    const res = await handler('search', { root: TMP, query: 'realdir' });
    check('search finds dirs too', res.ok === true && res.value.results.some((r) => r.kind === 'dir' && r.name === 'realdir'));
  }
  {
    const res = await handler('search', { root: TMP, query: 'zzz-nothing-zzz' });
    check('search no-match returns empty', res.ok === true && res.value.results.length === 0);
  }
  {
    const res = await handler('search', { root: '/etc', query: 'hosts' });
    check('search(/etc) rejected by fence', res.ok === false && /outside the registered workspaces/.test(res.error?.message ?? ''));
  }

  // ── media route: png bytes + content-type; missing/outside rejected ──────
  const pngPath = path.join(TMP, 'pixel.png');
  await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]));
  {
    const res = await httpGet('/dsh-workspace-preview/media', `/dsh-workspace-preview/media?path=${encodeURIComponent(pngPath)}`);
    check('media: png served', res.status === 200 && res.headers['content-type'] === 'image/png', `${res.status} ${res.headers['content-type']}`);
    check('media: bytes round-trip', Buffer.from(res.body, 'binary').length === 12);
  }
  {
    const res = await httpGet('/dsh-workspace-preview/media', '/dsh-workspace-preview/media?path=' + encodeURIComponent('/etc/hosts'));
    check('media: /etc rejected', res.status === 400, String(res.status));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/media', '/dsh-workspace-preview/media');
    check('media: missing path query -> 400', res.status === 400, String(res.status));
  }

  // ── office-raw route: whole .docx/.pptx bytes for the rich renderer ──────
  const rawDocxPath = path.join(TMP, 'sample.docx');
  const rawDocxBytes = buildDocx();
  await fs.writeFile(rawDocxPath, rawDocxBytes);
  {
    const res = await httpGet('/dsh-workspace-preview/office-raw', `/dsh-workspace-preview/office-raw?path=${encodeURIComponent(rawDocxPath)}`);
    check('office-raw: docx served',
      res.status === 200 && res.headers['content-type'] === 'application/octet-stream' && (res.headers['x-content-type-options'] ?? '') === 'nosniff',
      `${res.status} ${res.headers['content-type']}`);
    check('office-raw: bytes round-trip', Buffer.from(res.body, 'binary').length === rawDocxBytes.length);
  }
  {
    const xlsxPath = path.join(TMP, 'sample.xlsx');
    await fs.writeFile(xlsxPath, buildXlsx());
    const res = await httpGet('/dsh-workspace-preview/office-raw', `/dsh-workspace-preview/office-raw?path=${encodeURIComponent(xlsxPath)}`);
    check('office-raw: .xlsx rejected (allowlist)', res.status === 400, String(res.status));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/office-raw', '/dsh-workspace-preview/office-raw?path=' + encodeURIComponent('/etc/hosts'));
    check('office-raw: /etc rejected', res.status === 400, String(res.status));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/office-raw', '/dsh-workspace-preview/office-raw');
    check('office-raw: missing path query -> 400', res.status === 400, String(res.status));
  }

  // ── html route: encoded path, CSP header, relative segment decode ────────
  const htmlFile = path.join(TMP, 'page with space.html');
  await fs.writeFile(htmlFile, '<!doctype html><html><body><h1>hi</h1></body></html>', 'utf8');
  {
    const enc = htmlFile.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
    const res = await httpGet('/dsh-workspace-preview/html', `/dsh-workspace-preview/html/${enc}`);
    check('html: served with CSP sandbox header',
      res.status === 200 &&
      /sandbox/.test(res.headers['content-security-policy'] ?? '') &&
      (res.headers['x-content-type-options'] ?? '') === 'nosniff',
      `${res.status} csp=${res.headers['content-security-policy']}`);
    check('html: body round-trip', (res.body ?? '').includes('<h1>hi</h1>'));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/html', '/dsh-workspace-preview/html/etc/passwd');
    check('html: /etc/passwd path rejected', res.status === 400, String(res.status));
  }
  {
    // 相对资源(HTML 内嵌图片/CSS)必须按扩展名伺服正确 content-type,
    // 否则 nosniff + text/html 会让浏览器拒绝把图片当图片渲染
    const asset = path.join(TMP, 'asset.png');
    await fs.writeFile(asset, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]));
    const enc = asset.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
    const res = await httpGet('/dsh-workspace-preview/html', `/dsh-workspace-preview/html/${enc}`);
    check('html: relative asset served with image/png content-type',
      res.status === 200 && res.headers['content-type'] === 'image/png',
      `${res.status} ${res.headers['content-type']}`);
    check('html: relative asset not sandboxed (no CSP header on assets)',
      res.headers['content-security-policy'] === undefined);
  }

  // ── bundle route: allowlisted chunk served, unknown 404 ──────────────────
  {
    const res = await httpGet('/dsh-workspace-preview/bundle', '/dsh-workspace-preview/bundle/office.js');
    check('bundle: office.js served', res.status === 200 && /__dshChunks__/.test(res.body ?? ''), String(res.status));
    check('bundle: etag present', typeof res.headers.etag === 'string' && res.headers.etag.startsWith('"'));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/bundle', '/dsh-workspace-preview/bundle/editor.js');
    check('bundle: editor.js (CodeMirror) served', res.status === 200 && /createEditor/.test(res.body ?? ''), String(res.status));
  }
  {
    // office-rich = docx-preview + pptx canvas (esbuild bundle, artifact committed)
    const res = await httpGet('/dsh-workspace-preview/bundle', '/dsh-workspace-preview/bundle/office-rich.js');
    check('bundle: office-rich.js served', res.status === 200 && /__dshChunks__/.test(res.body ?? ''), String(res.status));
    check('bundle: office-rich etag present', typeof res.headers.etag === 'string' && res.headers.etag.startsWith('"'));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/bundle', '/dsh-workspace-preview/bundle/evil.js');
    check('bundle: unknown chunk 404', res.status === 404, String(res.status));
  }
  {
    const res = await httpGet('/dsh-workspace-preview/bundle', '/dsh-workspace-preview/bundle/../../secret.js');
    check('bundle: path traversal refused', res.status === 404, String(res.status));
  }

  // ── RPC basics (kept from v0.2.x) ────────────────────────────────────────
  {
    const res = await handler('list', { path: WORKSPACE });
    check('list(root) ok', res.ok === true, res.ok ? '' : res.error?.message);
    check('list(root) has dsh-workspace-preview dir', res.value.entries.some((e) => e.kind === 'dir' && e.name === 'dsh-workspace-preview'));
  }
  {
    const res = await handler('read', { path: path.join(WORKSPACE, 'dsh-workspace-preview/lib/index.js') });
    check('read(index.js) kind=text', res.ok === true && res.value?.kind === 'text');
    check('read(index.js) contains media route', (res.value?.text ?? '').includes('media route'));
  }
  {
    const res = await handler('list', { path: '/etc' });
    check('list(/etc) rejected', res.ok === false && /outside the registered workspaces/.test(res.error?.message ?? ''));
  }

  // ── write: mtimeMs conflict + atomic (no leftover tmp) ───────────────────
  const f1 = path.join(TMP, 'edit-me.txt');
  await fs.writeFile(f1, 'original content', 'utf8');
  {
    const stale = await handler('write', { path: f1, content: 'x', mtimeMs: 1 });
    check('write stale mtime -> conflict', stale.ok === false && stale.error?.code === 'conflict');
    const fresh = await handler('write', { path: f1, content: 'second', mtimeMs: (await fs.stat(f1)).mtimeMs });
    check('write fresh mtime ok', fresh.ok === true, fresh.ok ? '' : fresh.error?.message);
    check('write round-trip', (await fs.readFile(f1, 'utf8')) === 'second');
    const list = await handler('list', { path: TMP });
    check('write leaves no tmp files', list.value.entries.every((e) => !e.name.includes('.dsh-preview-tmp-')));
  }

  // ── rename / remove happy + rejections ───────────────────────────────────
  const f2 = path.join(TMP, 'renamed.txt');
  {
    const res = await handler('rename', { path: f1, newName: 'renamed.txt' });
    check('rename ok', res.ok === true && res.value?.path === f2);
    await fs.writeFile(path.join(TMP, 'taken.txt'), 'taken', 'utf8');
    const dup = await handler('rename', { path: f2, newName: 'taken.txt' });
    check('rename onto existing rejected', dup.ok === false && /already exists/.test(dup.error?.message ?? ''));
    const rootDel = await handler('remove', { path: WORKSPACE });
    check('remove(workspace root) rejected', rootDel.ok === false && /workspace root/.test(rootDel.error?.message ?? ''));
    const fileDel = await handler('remove', { path: path.join(TMP, 'taken.txt') });
    check('remove(file) ok', fileDel.ok === true);
    const dirDel = await handler('remove', { path: path.join(TMP, 'sub') });
    check('remove(dir tree) ok', dirDel.ok === true);
  }

  // ── office extraction (unchanged from v0.2.x) ────────────────────────────
  {
    const p = path.join(TMP, 'sample.docx');
    await fs.writeFile(p, buildDocx());
    const res = await handler('read', { path: p });
    check('read(docx) kind=office', res.ok === true && res.value?.format === 'docx');
    check('docx heading extracted (entities decoded)',
      (res.value?.blocks ?? []).some((b) => b.type === 'heading' && b.level === 1 && b.text.includes('A & B')));
  }
  {
    const p = path.join(TMP, 'sample.xlsx');
    await fs.writeFile(p, buildXlsx());
    const res = await handler('read', { path: p });
    check('read(xlsx) two sheets', res.ok === true && (res.value?.sheets?.length ?? 0) === 2);
  }
  {
    const p = path.join(TMP, 'sample.pptx');
    await fs.writeFile(p, buildPptx());
    const res = await handler('read', { path: p });
    check('read(pptx) two slides', res.ok === true && (res.value?.slides?.length ?? 0) === 2);
  }
  // office read cap regression: >3 MiB .docx must NOT be reported 'too-large'
  // (cap is relaxed for office; a synthetic over-cap zip then fails as
  //  "not a zip archive" instead of a size notice)
  {
    const p = path.join(TMP, 'big.docx');
    await fs.writeFile(p, Buffer.concat([buildDocx(), Buffer.alloc(4 * 1024 * 1024, 0x61)]));
    const res = await handler('read', { path: p });
    check('read(>3 MiB docx) not too-large (office cap relaxed)',
      !(res.ok === true && res.value?.kind === 'too-large'),
      res.ok ? `kind=${res.value?.kind}` : res.error?.message);
  }
  {
    const p = path.join(TMP, 'old.doc');
    await fs.writeFile(p, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
    const res = await handler('read', { path: p });
    check('read(.doc) -> binary + legacy hint', res.ok === true && res.value?.kind === 'binary' && res.value?.hint === 'legacy-office');
  }

  // ── caps (unchanged) ─────────────────────────────────────────────────────
  {
    const bigTxt = path.join(TMP, 'big.txt');
    await fs.writeFile(bigTxt, 'x'.repeat(300 * 1024), 'utf8');
    const res = await handler('read', { path: bigTxt });
    check('read(big.txt) truncated at 256 KiB', res.ok === true && res.value?.truncated === true && res.value?.text?.length === 256 * 1024);
  }
  {
    const dir = path.join(TMP, 'exact-cap');
    await fs.mkdir(dir);
    for (let i = 0; i < 2000; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const res = await handler('list', { path: dir });
    check('list exactly 2000 entries not truncated', res.ok === true && res.value?.truncated === false && res.value?.entries?.length === 2000);
    const over = path.join(TMP, 'over-cap');
    await fs.mkdir(over);
    for (let i = 0; i < 2001; i++) await fs.writeFile(path.join(over, `f${String(i).padStart(4, '0')}.txt`), 'x');
    const res2 = await handler('list', { path: over });
    check('list 2001 entries truncated', res2.ok === true && res2.value?.truncated === true && res2.value?.entries?.length === 2000);
  }

  // ── fence: symlinked workspace root regression ───────────────────────────
  {
    let handler2;
    const link = path.join(TMP, 'root-link');
    await fs.symlink(TMP, link, 'dir');
    const ctx2 = {
      workspaceRegistry: { list: () => [{ path: link }] },
      webRuntime: { trustedHosts: [] },
      webServer: { register: () => async () => {} },
      connection: { rpc: { handle: (_c, h) => { handler2 = h; return async () => {}; } } },
      effect: (fn) => { fn(); return () => {}; },
    };
    apply(ctx2);
    const res = await handler2('list', { path: link });
    check('list via symlinked root ok', res.ok === true, res.ok ? '' : res.error?.message);
    const sub = await handler2('list', { path: path.join(link, 'exact-cap') });
    check('list inside symlinked root ok', sub.ok === true && (sub.value?.entries?.length ?? 0) === 2000);
    const rootDel = await handler2('remove', { path: link });
    check('remove via symlinked root (itself) still rejected', rootDel.ok === false && /workspace root/.test(rootDel.error?.message ?? ''));
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
