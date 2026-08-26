/**
 * dsh-workspace-preview — host half.
 *
 * Registers the `/dsh-workspace-previewspace-preview` RPC channel on the dsh web transport
 * (`ctx.connection.rpc.handle`, the same loopback bridge that carries
 * `/api`). The browser half calls two endpoints:
 *
 *   list  {path}          -> one directory level (dirs + files, sorted)
 *   read  {path}          -> bounded preview payload for one file
 *
 * Every request is fenced to the registered workspace directories
 * (`ctx.workspaceRegistry`): a path outside the workspaces is rejected, so
 * the browser surface can never be used to read arbitrary host files.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Host cordis services this fiber waits for. */
export const inject = ['connection', 'workspaceRegistry'];

/** Hard caps: listing size, whole-file read, and returned text length. */
const MAX_ENTRIES = 2000;
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB
const MAX_TEXT_BYTES = 256 * 1024; // 256 KiB of text returned
const BINARY_PROBE_BYTES = 8192;

/** Extensions previewed as images (base64 -> <img>). */
const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
]);

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
};

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * Canonicalize the requested path and require it to live inside one of the
 * registered workspace directories. Throws on any violation — the channel
 * wrapper folds throws into the RPC error branch.
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
  const roots = (ctx.workspaceRegistry?.list() ?? []).map((w) => w.path);
  if (!roots.length) throw new Error('no workspace registered on this host');
  const allowed = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!allowed) throw new Error('path is outside the registered workspaces');
  return real;
}

async function listDirectory(ctx, payload) {
  const dir = await canonicalInside(ctx, payload?.path);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const entries = [];
  for (const entry of dirents) {
    if (entries.length >= MAX_ENTRIES) break;
    try {
      const full = path.join(dir, entry.name);
      const hidden = entry.name.startsWith('.');
      let kind = 'file';
      if (entry.isDirectory()) kind = 'dir';
      else if (entry.isSymbolicLink()) {
        const stat = await fs.stat(full);
        kind = stat.isDirectory() ? 'dir' : 'file';
      }
      if (kind === 'dir') {
        entries.push({ name: entry.name, path: full, kind: 'dir', hidden });
        continue;
      }
      const stat = await fs.stat(full);
      entries.push({
        name: entry.name,
        path: full,
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        hidden,
      });
    } catch {
      // Unreadable entry — skip it rather than failing the whole listing.
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return ok({
    path: dir,
    truncated: dirents.length > entries.length || entries.length >= MAX_ENTRIES,
    entries,
  });
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
  if (stat.size > MAX_READ_BYTES) {
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
  if (isBinary(buffer)) {
    return ok({ kind: 'binary', size: stat.size, ext });
  }
  const truncated = buffer.length > MAX_TEXT_BYTES;
  return ok({
    kind: 'text',
    text: buffer.subarray(0, MAX_TEXT_BYTES).toString('utf8'),
    truncated,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.connection.rpc.handle(
      '/dsh-workspace-previewspace-preview',
      async (endpoint, payload) => {
        try {
          if (endpoint === 'list') return await listDirectory(ctx, payload);
          if (endpoint === 'read') return await readFilePreview(ctx, payload);
          return fail('bad-request', `unknown endpoint: ${endpoint}`);
        } catch (error) {
          return fail('bad-request', String(error?.message ?? error));
        }
      },
      { authority: 'loopback' },
    );
    return () => {
      void dispose();
    };
  }, 'dsh-workspace-preview: rpc channel');
}
