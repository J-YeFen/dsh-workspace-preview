/**
 * dsh-workspace-preview — host half (v0.3 architecture).
 *
 * Two transport faces, one workspace fence:
 *
 * 1. RPC channel `/dsh-workspace-preview` (loopback, `ctx.connection.rpc`):
 *      list   {path}                 -> one directory level (opendir streaming;
 *                                       symlinks resolved to target kind + broken
 *                                       flag; hidden flag; dirs-first natural sort)
 *      search {root, query}          -> filename search under a workspace root
 *                                       (budgeted walk, hidden dirs skipped)
 *      read   {path}                 -> bounded preview payload for one file
 *      write  {path, content, mtimeMs?} -> overwrite a text file: mtimeMs conflict
 *                                       check FIRST, then atomic tmp+rename write
 *      rename {path, newName}        -> rename inside the same directory
 *      remove {path}                 -> delete a file or directory tree
 *
 * 2. HTTP routes on the shared webserver (browser-trust fence, same origin as
 *    the /api gateway — loopback or trustedHosts; cross-site markers refused):
 *      GET /dsh-workspace-preview/media?path=…   -> raw image/media bytes
 *      GET /dsh-workspace-preview/office-raw?path=… -> whole .docx/.pptx bytes for
 *                                                   the browser-side rich renderer
 *                                                   (docx-preview / pptx canvas)
 *      GET /dsh-workspace-preview/html/<path…>   -> HTML file with CSP `sandbox`
 *                                                   header (path-encoded URL so
 *                                                   relative assets resolve back
 *                                                   into this route)
 *      GET /dsh-workspace-preview/bundle/<name>.js -> lazy client chunks
 *                                                   (allowlisted, ETag revalidated)
 *
 * Every filesystem path funnels through `canonicalInside()` (realpath + prefix
 * check against every `workspaceRegistry` root) — the browser surface can never
 * read arbitrary host files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractOffice } from './office.js';

/** Host cordis services this fiber waits for. */
export const inject = ['connection', 'workspaceRegistry', 'webServer', 'webRuntime'];
// webRuntime 必须注入:访问 ctx.webRuntime 会触发 cordis 代理的 get,未注入的服务
// 属性访问会抛 'cannot get property ... without inject'(optional chaining 挡不住)。

/** Hard caps: listing size, whole-file read/write, and returned text length. */
const MAX_ENTRIES = 2000;
const MAX_READ_BYTES = 3 * 1024 * 1024; // 3 MiB whole-file read/write cap
const MAX_TEXT_BYTES = 256 * 1024; // 256 KiB of text returned (HTML is whole, see HTML_EXT)
const BINARY_PROBE_BYTES = 8192;
const MEDIA_CAP = 20 * 1024 * 1024; // media route cap (images), 20 MiB
const OFFICE_CAP = 30 * 1024 * 1024; // Office 文件读上限(docx/xlsx/pptx 常超 3 MiB,单独放宽)
const MAX_SEARCH_VISITED = 50000; // search walk budget (dirs visited)
const MAX_SEARCH_RESULTS = 500; // search result cap

/** HTML documents are rendered as pages in the browser — returned whole. */
const HTML_EXT = new Set(['html', 'htm', 'xhtml']);

/** Extensions previewed as images (<img src="/dsh-workspace-preview/media?…">). */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
]);

/** OOXML extensions previewed as structured documents (mini unzip + XML scan). */
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx']);

/**
 * Extensions served raw to the browser-side rich renderer (v0.3.5): docx is
 * rendered by the bundled docx-preview in the lazy `office-rich` chunk, pptx
 * by the chunk's own canvas renderer. Both need the WHOLE file in the browser
 * (unlike the RPC `read` text extraction), fetched from /office-raw.
 */
const OFFICE_RAW_EXT = new Set(['docx', 'pptx']);

/** Legacy OLE2 Office formats — recognized, but not parsed. */
const LEGACY_OFFICE_EXT = new Set(['doc', 'xls', 'ppt']);

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  // HTML 页面相对资源(经 /html 路由按扩展名伺服)
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  txt: 'text/plain',
  xml: 'text/xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

// ── browser-trust fence (structural copy of the /api gateway semantics) ────

function header(headers, name) {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host');
  if (host === undefined) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === undefined) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(request.headers, 'origin');
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── workspace fence (multi-root) ───────────────────────────────────────────

/**
 * Registered workspace roots, canonicalized with `fs.realpath`. The registry
 * normally stores canonical paths already (dsh's own `dsh-workspace` does),
 * but a root may still be non-canonical (symlinked components, `..`, or a
 * foreign embedder): prefix checks must compare like with like, or a
 * perfectly valid request would be rejected (or — worse — a root rename/
 * delete protection check could miss its target). Missing roots are skipped.
 */
async function canonicalRoots(ctx) {
  const raw = (ctx.workspaceRegistry?.list() ?? [])
    .map((w) => w.path)
    .filter((p) => typeof p === 'string');
  const roots = [];
  for (const p of raw) {
    try {
      roots.push(await fs.realpath(p));
    } catch {
      // Root no longer exists — it cannot fence anything; skip it.
    }
  }
  return roots;
}

/**
 * Canonicalize the requested path and require it to live inside one of the
 * registered workspace directories. Throws on any violation.
 */
async function canonicalInside(ctx, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('path must be an absolute filesystem path');
  }
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new Error(`path does not exist: ${target}`);
  }
  const roots = await canonicalRoots(ctx);
  if (!roots.length) throw new Error('no workspace registered on this host');
  const allowed = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!allowed) throw new Error('path is outside the registered workspaces');
  return real;
}

// ── RPC endpoints ──────────────────────────────────────────────────────────

/**
 * Single-level directory listing, opendir-streamed. Symlinks are stat'ed once
 * to expose their target kind (a symlink to a directory expands like a
 * directory); a dangling link is flagged `broken` instead of being dropped.
 * Hidden entries (dot-prefixed) are flagged, not filtered — the client owns
 * the visibility toggle. Unreadable non-symlink entries are skipped.
 */
async function listDirectory(ctx, payload) {
  const dir = await canonicalInside(ctx, payload?.path);
  let handle;
  try {
    handle = await fs.opendir(dir);
  } catch (error) {
    throw new Error(`cannot list "${dir}": ${String(error?.message ?? error)}`);
  }
  const entries = [];
  let total = 0;
  try {
    for await (const dirent of handle) {
      total++;
      if (entries.length >= MAX_ENTRIES) continue;
      try {
        const full = path.join(dir, dirent.name);
        const hidden = dirent.name.startsWith('.');
        const row = { name: dirent.name, path: full, hidden };
        if (dirent.isSymbolicLink()) {
          row.isSymlink = true;
          try {
            const st = await fs.stat(full); // follows the link
            row.kind = st.isDirectory() ? 'dir' : 'file';
            if (row.kind === 'file') { row.size = st.size; row.mtimeMs = st.mtimeMs; }
          } catch {
            row.kind = 'file';
            row.broken = true;
          }
        } else if (dirent.isDirectory()) {
          row.kind = 'dir';
        } else if (dirent.isFile()) {
          row.kind = 'file';
          const st = await fs.stat(full);
          row.size = st.size;
          row.mtimeMs = st.mtimeMs;
        } else {
          continue; // sockets / fifos / devices — not listable rows
        }
        entries.push(row);
      } catch {
        // Unreadable entry — skip it rather than failing the whole listing.
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return ok({
    path: dir,
    truncated: total > entries.length,
    entries,
  });
}

/**
 * Filename search under one workspace root. Iterative walk (never descends
 * symlinked dirs or hidden dirs), budgeted by `MAX_SEARCH_VISITED` dirs and
 * `MAX_SEARCH_RESULTS`. Case-insensitive substring match on the basename.
 */
async function searchEntries(ctx, payload) {
  const root = await canonicalInside(ctx, payload?.root ?? payload?.path);
  const query = payload?.query;
  if (typeof query !== 'string') throw new Error('query must be a string');
  const q = query.trim().toLowerCase();
  if (q === '') return ok({ results: [], truncated: false });
  const results = [];
  const stack = [root];
  let visited = 0;
  let capped = false;
  while (stack.length > 0 && visited < MAX_SEARCH_VISITED && results.length < MAX_SEARCH_RESULTS) {
    const dir = stack.pop();
    visited++;
    let handle;
    try {
      handle = await fs.opendir(dir);
    } catch {
      continue;
    }
    try {
      for await (const dirent of handle) {
        if (results.length >= MAX_SEARCH_RESULTS) { capped = true; break; }
        const full = path.join(dir, dirent.name);
        const hidden = dirent.name.startsWith('.');
        const match = dirent.name.toLowerCase().includes(q);
        if (dirent.isDirectory()) {
          if (!hidden) stack.push(full);
          if (match) results.push({ name: dirent.name, path: full, kind: 'dir' });
        } else if (dirent.isFile() || dirent.isSymbolicLink()) {
          if (!match) continue;
          let kind = 'file';
          if (dirent.isSymbolicLink()) {
            try {
              const st = await fs.stat(full);
              if (st.isDirectory()) kind = 'dir';
            } catch { /* dangling link -> file-ish */ }
          }
          results.push({ name: dirent.name, path: full, kind });
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  if (visited >= MAX_SEARCH_VISITED || results.length >= MAX_SEARCH_RESULTS) capped = true;
  results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return ok({ results, truncated: capped });
}

/** NUL byte in the probe window => treat as binary. */
function isBinary(buffer) {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

async function readFilePreview(ctx, payload) {
  const target = await canonicalInside(ctx, payload?.path);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new Error('cannot preview a directory');
  const ext = path.extname(target).slice(1).toLowerCase();
  // Office 文档常超 3 MiB(尤其含内嵌图片的 docx),单独放宽上限;
  // 其余类型仍走 MAX_READ_BYTES。
  const readCap = OFFICE_EXT.has(ext) ? OFFICE_CAP : MAX_READ_BYTES;
  if (stat.size > readCap) {
    return ok({ kind: 'too-large', size: stat.size, ext });
  }
  const buffer = await fs.readFile(target);
  if (IMAGE_EXT.has(ext)) {
    return ok({
      kind: 'image',
      mime: MIME_BY_EXT[ext],
      size: stat.size,
      base64: buffer.toString('base64'),
    });
  }
  if (OFFICE_EXT.has(ext)) {
    // OOXML (zip) — parsed into structured blocks/sheets/slides. Throws on
    // corrupt archives; the channel wrapper folds that into the error branch.
    return ok({ kind: 'office', size: stat.size, ...extractOffice(buffer, ext) });
  }
  if (LEGACY_OFFICE_EXT.has(ext)) {
    return ok({ kind: 'binary', size: stat.size, ext, hint: 'legacy-office' });
  }
  if (isBinary(buffer)) {
    return ok({ kind: 'binary', size: stat.size, ext });
  }
  // HTML arrives whole (the browser renders it as a page); other text is
  // capped at MAX_TEXT_BYTES so huge logs/code never flood the preview.
  const fullHtml = HTML_EXT.has(ext);
  const truncated = !fullHtml && buffer.length > MAX_TEXT_BYTES;
  return ok({
    kind: 'text',
    text: (fullHtml ? buffer : buffer.subarray(0, MAX_TEXT_BYTES)).toString('utf8'),
    truncated,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

/**
 * Overwrite an existing text file. Order matters: the mtimeMs optimistic lock
 * is checked FIRST (a stale client-supplied mtime fails with `conflict`), then
 * the content is written atomically (temp sibling + rename) so a crash never
 * leaves a half-written file.
 */
async function writeFileContent(ctx, payload) {
  const target = await canonicalInside(ctx, payload?.path);
  const content = payload?.content;
  if (typeof content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_READ_BYTES) {
    throw new Error(`content exceeds the 3 MiB write cap (${bytes} bytes)`);
  }
  const stat = await fs.stat(target);
  if (stat.isDirectory()) throw new Error('cannot overwrite a directory');
  if (payload.mtimeMs != null && payload.mtimeMs !== stat.mtimeMs) {
    return fail('conflict', 'file changed on disk since it was read');
  }
  const tmp = `${target}.dsh-preview-tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  const after = await fs.stat(target);
  return ok({ bytes, mtimeMs: after.mtimeMs });
}

/** Rename within the same directory; refuses to overwrite an existing name. */
async function renameEntry(ctx, payload) {
  const source = await canonicalInside(ctx, payload?.path);
  const newName = payload?.newName;
  if (typeof newName !== 'string' || newName.length === 0 ||
      newName === '.' || newName === '..' ||
      /[/\\]/.test(newName) || newName.includes('\0')) {
    throw new Error('newName must be a plain file name (no path separators)');
  }
  if (newName === path.basename(source)) return ok({ path: source, unchanged: true });
  if ((await canonicalRoots(ctx)).includes(source)) {
    throw new Error('refusing to rename a workspace root');
  }
  const target = path.join(path.dirname(source), newName);
  try {
    await fs.lstat(target);
    throw new Error(`target already exists: ${newName}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.rename(source, target);
  return ok({ path: target });
}

/** Delete a file or directory tree. Workspace roots are never deletable. */
async function removeEntry(ctx, payload) {
  const target = await canonicalInside(ctx, payload?.path);
  if ((await canonicalRoots(ctx)).includes(target)) {
    throw new Error('refusing to delete a workspace root');
  }
  await fs.rm(target, { recursive: true });
  return ok({ removed: target });
}

const RPC_ENDPOINTS = {
  list: listDirectory,
  search: searchEntries,
  read: readFilePreview,
  write: writeFileContent,
  rename: renameEntry,
  remove: removeEntry,
};

// ── HTTP helpers ───────────────────────────────────────────────────────────

function writeRaw(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

/** Content type by extension (binary-safe fallback). */
function mediaTypeForPath(target) {
  const ext = path.extname(target).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Path-encode an absolute path into URL segments: `/a/b c/x` -> `/a/b%20c/x`. */
function encodePathSegments(p) {
  return p.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/');
}

/** Decode path-encoded URL segments back into an absolute path. */
function decodePathSegments(encoded) {
  const raw = encoded.split('/').filter(Boolean).map((seg) => {
    try { return decodeURIComponent(seg); } catch { return seg; }
  }).join('/');
  return '/' + raw;
}

// ── lazy chunk route ───────────────────────────────────────────────────────

const CHUNK_NAMES = ['office', 'editor', 'office-rich'];
// (editor / office-rich are esbuild bundles built by scripts/build-editor.mjs /
//  scripts/build-office-rich.mjs from devDependencies; artifacts are committed.)
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const chunkEtags = new Map();

async function etagOf(name) {
  const target = path.join(LIB_DIR, `client-chunk-${name}.js`);
  try {
    const info = await fs.stat(target);
    const memo = chunkEtags.get(name);
    if (memo !== undefined && memo.mtimeMs === info.mtimeMs && memo.size === info.size) return memo.etag;
    const etag = `"${createHash('sha1').update(await fs.readFile(target)).digest('hex').slice(0, 12)}"`;
    chunkEtags.set(name, { mtimeMs: info.mtimeMs, size: info.size, etag });
    return etag;
  } catch {
    return undefined;
  }
}

// ── plugin body ────────────────────────────────────────────────────────────

export function apply(ctx) {
  const trustedHostsOf = () => ctx.webRuntime?.trustedHosts ?? [];

  // RPC channel (loopback bridge) — six endpoints.
  ctx.effect(() => {
    const dispose = ctx.connection.rpc.handle(
      '/dsh-workspace-preview',
      async (endpoint, payload) => {
        try {
          const handler = RPC_ENDPOINTS[endpoint];
          if (!handler) return fail('bad-request', `unknown endpoint: ${endpoint}`);
          return await handler(ctx, payload);
        } catch (error) {
          return fail('bad-request', String(error?.message ?? error));
        }
      },
      { authority: 'loopback' },
    );
    return () => { void dispose(); };
  }, 'dsh-workspace-preview: rpc channel');

  // GET /dsh-workspace-preview/media?path=… — raw bytes for <img src>.
  // The client prefers this over base64-in-RPC: no string inflation, browser
  // caching applies, and Markdown image references point here directly.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-workspace-preview/media',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf())) {
        return writeRaw(res, 403, { 'content-type': 'application/json' }, '{"ok":false,"error":{"code":"forbidden","message":"forbidden","details":{}}}');
      }
      if (req.method !== 'GET') return writeRaw(res, 405, {}, '');
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid');
        const raw = url.searchParams.get('path');
        if (raw === null) throw new Error('path query is required');
        const target = await canonicalInside(ctx, raw);
        const info = await fs.stat(target);
        if (!info.isFile()) throw new Error('not a file');
        if (info.size > MEDIA_CAP) throw new Error('media file exceeds the 20 MiB cap');
        const body = await fs.readFile(target);
        writeRaw(res, 200, {
          'content-type': mediaTypeForPath(target),
          'cache-control': 'no-cache',
          'content-length': String(body.length),
        }, body);
      } catch (error) {
        writeRaw(res, 400, { 'content-type': 'application/json' },
          JSON.stringify({ ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } }));
      }
    },
  }), 'dsh-workspace-preview: media route');

  // GET /dsh-workspace-preview/html/<encoded absolute path segments> — HTML
  // page preview. The path lives in the URL PATH (each segment URI-encoded) so
  // the page's relative assets (./style.css, img/x.png) resolve back into this
  // route with the workspace scope intact. Every response carries the CSP
  // `sandbox` directive: inside the preview iframe the sandbox ATTRIBUTE is the
  // primary boundary; this header is defense-in-depth so even a top-level load
  // of the URL stays in an opaque origin with no same-origin access to the GUI.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-workspace-preview/html',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf())) {
        return writeRaw(res, 403, { 'content-type': 'application/json' }, '{"ok":false,"error":{"code":"forbidden","message":"forbidden","details":{}}}');
      }
      if (req.method !== 'GET') return writeRaw(res, 405, {}, '');
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid');
        const suffix = url.pathname.slice('/dsh-workspace-preview/html/'.length);
        const target = await canonicalInside(ctx, decodePathSegments(suffix));
        const info = await fs.stat(target);
        if (!info.isFile()) throw new Error('not a file');
        const ext = path.extname(target).slice(1).toLowerCase();
        const isHtml = HTML_EXT.has(ext);
        // 页面走 3 MiB,相对资源(图片/CSS/字体等)放宽到媒体上限
        const cap = isHtml ? MAX_READ_BYTES : MEDIA_CAP;
        if (info.size > cap) throw new Error(`${ext || 'asset'} exceeds the ${cap} byte cap`);
        const body = await fs.readFile(target);
        const headers = {
          // HTML 页面按 text/html,相对资源按扩展名给正确 content-type——
          // 否则 nosniff + text/html 会让浏览器拒绝把图片当作图片渲染
          'content-type': isHtml ? 'text/html; charset=utf-8' : mediaTypeForPath(target),
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
        };
        if (isHtml) {
          headers['x-content-type-options'] = 'nosniff';
          // The sandbox directive (no allow-same-origin -> opaque origin) is the
          // previewer's boundary even for top-level loads; object-src 'none'
          // blocks plugin embeds. The iframe itself additionally carries the
          // strict `sandbox=""` attribute (client side) — two boundaries.
          headers['content-security-policy'] = "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'";
        }
        writeRaw(res, 200, headers, body);
      } catch (error) {
        writeRaw(res, 400, { 'content-type': 'application/json' },
          JSON.stringify({ ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } }));
      }
    },
  }), 'dsh-workspace-preview: html route');

  // GET /dsh-workspace-preview/office-raw?path=… — whole .docx/.pptx bytes for
  // the browser-side rich renderer (v0.3.5). The lazy `office-rich` chunk needs
  // the raw archive (docx-preview / its own pptx zip walk), unlike the RPC
  // `read` text extraction. Same workspace fence + browser-trust fence as the
  // other routes; extension allowlist keeps the surface narrow; cap mirrors the
  // RPC office cap (OFFICE_CAP) so a file rejected there is rejected here too.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-workspace-preview/office-raw',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf())) {
        return writeRaw(res, 403, { 'content-type': 'application/json' }, '{"ok":false,"error":{"code":"forbidden","message":"forbidden","details":{}}}');
      }
      if (req.method !== 'GET') return writeRaw(res, 405, {}, '');
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid');
        const raw = url.searchParams.get('path');
        if (raw === null) throw new Error('path query is required');
        const target = await canonicalInside(ctx, raw);
        const info = await fs.stat(target);
        if (!info.isFile()) throw new Error('not a file');
        const ext = path.extname(target).slice(1).toLowerCase();
        if (!OFFICE_RAW_EXT.has(ext)) {
          throw new Error(`office-raw only serves .docx/.pptx (got .${ext})`);
        }
        if (info.size > OFFICE_CAP) {
          throw new Error(`office file exceeds the ${OFFICE_CAP} byte cap`);
        }
        const body = await fs.readFile(target);
        writeRaw(res, 200, {
          'content-type': 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
          'content-length': String(body.length),
        }, body);
      } catch (error) {
        writeRaw(res, 400, { 'content-type': 'application/json' },
          JSON.stringify({ ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } }));
      }
    },
  }), 'dsh-workspace-preview: office-raw route');

  // GET /dsh-workspace-preview/bundle/<name>.js — lazy client chunks.
  // Allowlisted names only (no path traversal); ETag revalidated per request.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-workspace-preview/bundle',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHostsOf())) {
        return writeRaw(res, 403, { 'content-type': 'application/json' }, '{"ok":false,"error":{"code":"forbidden","message":"forbidden","details":{}}}');
      }
      if (req.method !== 'GET') return writeRaw(res, 405, {}, '');
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.invalid');
        const name = url.pathname.slice('/dsh-workspace-preview/bundle/'.length);
        if (!name.endsWith('.js')) return writeRaw(res, 404, {}, '');
        const base = name.slice(0, -3);
        if (!CHUNK_NAMES.includes(base)) return writeRaw(res, 404, {}, '');
        const etag = await etagOf(base);
        if (etag === undefined) return writeRaw(res, 404, {}, '');
        if (req.headers['if-none-match'] === etag) return writeRaw(res, 304, { etag }, '');
        const body = await fs.readFile(path.join(LIB_DIR, `client-chunk-${base}.js`));
        writeRaw(res, 200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          etag,
          'content-length': String(body.length),
        }, body);
      } catch (error) {
        writeRaw(res, 400, { 'content-type': 'application/json' },
          JSON.stringify({ ok: false, error: { code: 'bad-request', message: String(error?.message ?? error), details: {} } }));
      }
    },
  }), 'dsh-workspace-preview: bundle route');
}
