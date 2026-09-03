/**
 * dsh-workspace-preview — Office RICH preview chunk (v0.3.5), build-time entry.
 *
 * THIS FILE IS NOT SHIPPED. It is bundled ONCE at dev time by
 * scripts/build-office-rich.mjs (esbuild) into the committed artifact
 * lib/client-chunk-office-rich.js, which the host serves at
 * /dsh-workspace-preview/bundle/office-rich.js. Runtime stays zero-dependency:
 * consumers never install docx-preview / jszip (devDependencies only).
 *
 * Chunk contract (mirrors lib/client-chunk-office.js / editor chunk): the
 * bundled script registers `globalThis.__dshChunks__["office-rich"] =
 * (require) => exports`; the main client injects the script and calls the
 * factory, whose require answers only `react`. Everything below that needs
 * React components is defined inside the factory so it closes over the host's
 * React instance.
 *
 * What this chunk does — the RAW archive (fetched from the host's
 * /office-raw route) is handed to the browser:
 *   .docx  -> docx-preview `renderAsync` (real Word-style flow rendering:
 *             runs, styles, lists, tables, inline images, headers/footers)
 *   .pptx  -> the chunk's own lightweight canvas renderer (JSZip + DOMParser):
 *             every shape/picture is laid out with its EMU geometry on a
 *             16:9 slide canvas, so a deck looks like slides, not a text dump.
 *
 * Both views carry an explicit "精确审阅" (open in native Office) affordance:
 * the main client passes onOpenExternal wired to the host's openPath.
 */
import { renderAsync } from 'docx-preview';
import JSZip from 'jszip';

// ── chunk CSS (injected on first materialization) ──────────────────────────

const CSS = [
  // 富渲染工具栏(精确审阅入口)
  ".fx-richtoolbar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}",
  ".fx-richtoolbar .fx-spacer{flex:1}",
  ".fx-richtoolbar .fx-mini-btn{height:20px;padding:0 8px}",
  // docx-preview 渲染区:灰底上放"白纸",贴近阅读观感
  ".fx-docx-scroll{flex:1;overflow:auto;min-height:0;background:var(--dsw-alias-bg-layer-2)}",
  ".fx-docx-paper{max-width:820px;margin:6px auto;background:#fff;color:#000;min-height:calc(100% - 12px);padding:24px 32px 48px;box-shadow:0 2px 14px var(--dsw-alias-bg-mask-2)}",
  ".fx-docx-paper .docx-wrapper{background:transparent}",
  // 抹掉 docx-preview 逐节套用的 Word 页边距(padding-top 常为 1in)与整页 min-height,
  // 让快速预览内容贴顶开始,不再出现第一页顶部的大段留白
  ".fx-docx-paper section.docx{padding:0 !important;min-height:0 !important}",
  // pptx 画布渲染区
  ".fx-ppt-scroll{flex:1;overflow:auto;min-height:0;padding:14px;display:flex;flex-direction:column;align-items:center;gap:14px;background:var(--dsw-alias-bg-layer-2)}",
  ".fx-ppt-slide{position:relative;flex:none;box-shadow:0 2px 14px var(--dsw-alias-bg-mask-2);background:#fff;overflow:hidden}",
  ".fx-ppt-num{position:absolute;top:6px;right:10px;font-size:10px;color:var(--dsw-alias-label-quaternary);z-index:3}",
  ".fx-ppt-box{position:absolute;overflow:hidden;box-sizing:border-box}",
  ".fx-ppt-text{width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden}",
  ".fx-ppt-line{white-space:pre-wrap;word-break:break-word;line-height:1.18}",
].join('');

// ── zip / XML helpers (pure, chunk-local) ──────────────────────────────────

const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_INCH = 914400;
const DPI = 96;

/** All descendant elements of `root` (incl. root) with the given localName. */
function byLocalName(root, name) {
  const out = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === name) out.push(all[i]);
  }
  if (root.localName === name) out.unshift(root);
  return out;
}

/** Relationship Id -> normalized zip path from a .rels XML document. */
function relsOf(relsDoc) {
  const map = new Map();
  for (const rel of byLocalName(relsDoc, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    map.set(id, target);
  }
  return map;
}

/** Resolve a rels Target against its part dir (`ppt/slides` etc). */
function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segs = (baseDir + '/' + target).split('/');
  const out = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/** localName of an element's first child with the given name (may be text node-safe). */
function firstChildEl(el, name) {
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].localName === name) return kids[i];
  }
  return null;
}

/** a:rPr -> { b, i, sz(1/100pt), color } (solid fill only). */
function runProps(rPr) {
  const out = { b: false, i: false, sz: 0, color: null };
  if (!rPr) return out;
  out.b = rPr.getAttribute('b') === '1' || rPr.getAttribute('b') === 'true';
  out.i = rPr.getAttribute('i') === '1' || rPr.getAttribute('i') === 'true';
  const sz = Number(rPr.getAttribute('sz'));
  if (Number.isFinite(sz) && sz > 0) out.sz = sz;
  const fill = firstChildEl(rPr, 'solidFill');
  const srgb = fill && firstChildEl(fill, 'srgbClr');
  out.color = srgb ? srgb.getAttribute('val') ?? null : null;
  return out;
}

/**
 * One a:p paragraph -> { lines: [{text, b, i, sz, color}], algn }.
 * Each a:r becomes one styled fragment; a:br splits into a new fragment.
 */
function parsePara(p) {
  const frags = [];
  let cur = null;
  const flush = () => { if (cur) frags.push(cur); cur = null; };
  const pPr = firstChildEl(p, 'pPr');
  let algn = null;
  if (pPr) {
    const a = pPr.getAttribute('algn');
    if (a === 'l' || a === 'ctr' || a === 'r' || a === 'just') algn = a;
  }
  const runs = byLocalName(p, 'r');
  for (const r of runs) {
    const t = firstChildEl(r, 't');
    const text = t ? t.textContent ?? '' : '';
    const pr = runProps(firstChildEl(r, 'rPr'));
    if (text) {
      flush();
      cur = { text, b: pr.b, i: pr.i, sz: pr.sz, color: pr.color };
    }
  }
  flush();
  // a:br breaks inside the paragraph
  const breaks = byLocalName(p, 'br');
  if (breaks.length) {
    // cheap approximation: paragraph-level breaks are rare on slides; keep them
    // as newlines by appending to the last fragment
    const last = frags[frags.length - 1];
    if (last) last.text += '\n'.repeat(breaks.length);
  }
  return { frags, algn };
}

/** solid fill srgbClr under an element subtree (or null). */
function solidFillOf(el) {
  const srgb = byLocalName(el, 'srgbClr')[0];
  if (srgb) {
    const val = srgb.getAttribute('val');
    if (val) return `#${val}`;
  }
  return null;
}

/** MIME by extension for slide media parts. */
const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

// ── pptx: one slide -> renderable boxes ─────────────────────────────────────

const ANCHOR_MAP = { t: 'flex-start', ctr: 'center', b: 'flex-end', stretch: 'stretch' };

/**
 * Parse a slide part into boxes for the canvas:
 *   text boxes {kind:'text', x,y,w,h (EMU), bg, anchor, paras:[{frags,algn}]}
 *   pictures  {kind:'image', x,y,w,h, dataUrl, mime}
 */
function parseSlide(xmlText, relsMap, zip, slideDir) {
  const doc = parseXml(xmlText);
  const boxes = [];
  const slideBg = solidFillOf(byLocalName(doc, 'bg')[0] ?? doc);

  // shapes in true document order: sp (text) and pic (images) interleave
  const all = doc.getElementsByTagName('*');
  const shapeNodes = [];
  for (let i = 0; i < all.length; i++) {
    const ln = all[i].localName;
    if (ln === 'sp' || ln === 'pic') shapeNodes.push(all[i]);
  }
  for (const shape of shapeNodes) {
    // geometry
    const xfrm = byLocalName(shape, 'xfrm')[0];
    const off = xfrm && byLocalName(xfrm, 'off')[0];
    const ext = xfrm && byLocalName(xfrm, 'ext')[0];
    const x = off ? Number(off.getAttribute('x')) : 0;
    const y = off ? Number(off.getAttribute('y')) : 0;
    const w = ext ? Number(ext.getAttribute('cx')) : 0;
    const h = ext ? Number(ext.getAttribute('cy')) : 0;
    if (!(w > 0 && h > 0)) continue;
    const bg = solidFillOf(byLocalName(shape, 'spPr')[0] ?? shape) ?? undefined;

    if (shape.localName === 'pic') {
      const blip = byLocalName(shape, 'blip')[0];
      if (!blip) continue;
      const rid = blip.getAttributeNS(RELS_NS, 'embed') ?? blip.getAttribute('r:embed');
      if (!rid) continue;
      const target = relsMap.get(rid);
      if (!target) continue;
      const zipPath = resolveTarget(slideDir, target);
      const file = zip.file(zipPath);
      if (!file) continue;
      const m = /\.([a-z0-9]+)$/i.exec(zipPath);
      const mime = m ? IMG_MIME[m[1].toLowerCase()] : null;
      if (!mime) continue; // emf/wmf etc. cannot display inline
      boxes.push({
        kind: 'image', x, y, w, h,
        dataUrlPromise: file.async('base64').then((b64) => `data:${mime};base64,${b64}`),
      });
      continue;
    }

    // text shape (p:sp)
    const txBody = byLocalName(shape, 'txBody')[0];
    if (!txBody) continue;
    const bodyPr = byLocalName(txBody, 'bodyPr')[0];
    const anchor = bodyPr ? (ANCHOR_MAP[bodyPr.getAttribute('anchor') ?? 't'] ?? 'flex-start') : 'flex-start';
    const paras = [];
    for (const p of byLocalName(txBody, 'p')) paras.push(parsePara(p));
    boxes.push({ kind: 'text', x, y, w, h, bg, anchor, paras });
  }
  return { boxes, bg: slideBg ?? '#ffffff' };
}

/**
 * Full pptx parse: slide order from presentation.xml (sldIdLst), EMU slide
 * size, per-slide boxes, pictures decoded to data URLs.
 */
async function parsePptx(zip) {
  const presDoc = parseXml(await zip.file('ppt/presentation.xml').async('string'));
  const sldSz = byLocalName(presDoc, 'sldSz')[0];
  const emuW = Number(sldSz?.getAttribute('cx')) || 12192000;
  const emuH = Number(sldSz?.getAttribute('cy')) || 6858000;
  const presRels = parseXml(await zip.file('ppt/_rels/presentation.xml.rels').async('string'));
  const presRelMap = relsOf(presRels);

  const slidePaths = [];
  const sldIdLst = byLocalName(presDoc, 'sldIdLst')[0];
  if (sldIdLst) {
    for (const sldId of byLocalName(sldIdLst, 'sldId')) {
      const rid = sldId.getAttributeNS(RELS_NS, 'id') ?? sldId.getAttribute('r:id');
      const target = rid ? presRelMap.get(rid) : null;
      if (target) slidePaths.push(resolveTarget('ppt', target));
    }
  }
  if (!slidePaths.length) {
    const re = /^ppt\/slides\/slide(\d+)\.xml$/;
    const names = Object.keys(zip.files).filter((n) => re.test(n));
    names.sort((a, b) => Number(re.exec(a)[1]) - Number(re.exec(b)[1]));
    slidePaths.push(...names.slice(0, 60));
  }

  const slides = [];
  for (const partPath of slidePaths.slice(0, 60)) {
    const file = zip.file(partPath);
    if (!file) continue;
    const dir = partPath.slice(0, partPath.lastIndexOf('/'));
    const relsDoc = parseXml(await zip.file(`${dir}/_rels/${partPath.slice(dir.length + 1)}.rels`).async('string'));
    const relMap = relsOf(relsDoc);
    try {
      const { boxes, bg } = parseSlide(await file.async('string'), relMap, zip, dir);
      const resolved = await Promise.all(boxes.map(async (b) => {
        if (b.kind === 'image') b.dataUrl = await b.dataUrlPromise;
        delete b.dataUrlPromise;
        return b;
      }));
      slides.push({ boxes: resolved, bg });
    } catch {
      // a broken slide must not kill the deck — render it blank
      slides.push({ boxes: [], bg: '#ffffff' });
    }
  }
  return { emuW, emuH, slides };
}

// ── entry registration: factory answers react ──────────────────────────────

globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};
globalThis.__dshChunks__['office-rich'] = (require) => {
  const React = require('react');
  const { useState, useEffect, useRef, useLayoutEffect } = React;
  const el = React.createElement;

  // inject chunk CSS once
  const CSS_TAG = 'dsh-workspace-preview/office-rich.css';
  if (typeof document !== 'undefined' &&
      document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-workspace-preview';
    tag.dataset.pluginCss = CSS_TAG;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  /** Shared toolbar row: preview hint + native-Office entry. */
  function RichToolbar({ onOpenExternal }) {
    return el('div', { className: 'fx-richtoolbar' },
      el('span', null, '快速预览'),
      el('span', { className: 'fx-spacer' }),
      onOpenExternal &&
        el('button', {
          type: 'button',
          className: 'fx-mini-btn',
          title: '在本机 Office / 默认程序中打开原始文件',
          onClick: () => onOpenExternal(),
        }, '用本机office打开'));
  }

  function humanFetchError(message, status) {
    const m = /exceeds the (\d+) byte cap/.exec(message ?? '');
    if (m) return `文件过大(${(Number(m[1]) / 1024 / 1024).toFixed(0)} MiB 上限),无法在浏览器内富预览`;
    if (status === 404 || /not found|does not exist/.test(message ?? '')) {
      return '文件不存在或已被移出工作区';
    }
    return String(message ?? `HTTP ${status}`);
  }

  // ── .docx: docx-preview ───────────────────────────────────────────────────

  /**
   * Fetch the raw archive from /office-raw and let docx-preview render it into
   * a paper-white scroll container. styleContainer is a dedicated (invisible)
   * element so every re-render starts from a clean stylesheet.
   */
  function DocxRichView({ url, onOpenExternal }) {
    const scrollRef = useRef(null);
    const paperRef = useRef(null);
    const styleRef = useRef(null);
    const [phase, setPhase] = useState('loading'); // loading | ready | error
    const [errMsg, setErrMsg] = useState(null);

    useEffect(() => {
      let alive = true;
      const paper = paperRef.current;
      const styleBox = styleRef.current;
      (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            let message = '';
            try {
              const j = await res.json();
              message = j?.error?.message ?? '';
            } catch { /* non-JSON body */ }
            throw new Error(humanFetchError(message, res.status));
          }
          const buffer = await res.arrayBuffer();
          if (!alive) return;
          styleBox.innerHTML = '';
          paper.innerHTML = '';
          await renderAsync(buffer, paper, styleBox, {
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: true, // 关闭逐"页"按纸张高度撑开,内容自然生长
            ignoreFonts: false,
            breakPages: false,
            renderHeaders: true,
            renderFooters: true,
            useBase64URL: true,
          });
          if (alive) setPhase('ready');
        } catch (error) {
          if (!alive) return;
          setPhase('error');
          setErrMsg(String(error?.message ?? error));
        }
      })();
      return () => {
        alive = false;
        if (paper) paper.innerHTML = '';
      };
    }, [url]);

    return el('div', { className: 'fx-preview-body' },
      el(RichToolbar, { ext: 'docx', onOpenExternal }),
      el('div', { ref: styleRef, style: { display: 'none' } }),
      el('div', { ref: scrollRef, className: 'fx-docx-scroll fx-scroll' },
        phase === 'loading' && el('div', { className: 'fx-empty' },
          el('span', { className: 'fx-spin' }), el('span', null, '渲染 docx…')),
        phase === 'error' && el('div', { className: 'fx-notice' },
          el('span', null, 'docx 富渲染失败'),
          el('span', { className: 'fx-dim' }, errMsg),
          onOpenExternal && el('button', { type: 'button', className: 'fx-mini-btn', onClick: () => onOpenExternal() },
            '改用本机 Office 打开')),
        el('div', { ref: paperRef, className: 'fx-docx-paper' })));
  }

  // ── .pptx: self-built 16:9 canvas ─────────────────────────────────────────

  /** px per EMU at 96dpi, times zoom `scale` */
  const px = (emu, scale) => Math.max(0, Math.round((emu / EMU_PER_INCH) * DPI * scale));

  function PptxRichView({ url, name, onOpenExternal }) {
    const scrollRef = useRef(null);
    const [phase, setPhase] = useState('loading');
    const [errMsg, setErrMsg] = useState(null);
    const [deck, setDeck] = useState(null); // { emuW, emuH, slides }
    const [scale, setScale] = useState(0);

    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            let message = '';
            try {
              const j = await res.json();
              message = j?.error?.message ?? '';
            } catch { /* non-JSON body */ }
            throw new Error(humanFetchError(message, res.status));
          }
          const buffer = await res.arrayBuffer();
          const zip = await JSZip.loadAsync(buffer);
          const parsed = await parsePptx(zip);
          if (!alive) return;
          setDeck(parsed);
          setPhase('ready');
        } catch (error) {
          if (!alive) return;
          setPhase('error');
          setErrMsg(String(error?.message ?? error));
        }
      })();
      return () => { alive = false; };
    }, [url]);

    // measure available width -> zoom so the slide fits (native 96dpi px)
    const measure = () => {
      const node = scrollRef.current;
      if (!node) return;
      const avail = node.clientWidth - 28; // padding 14*2
      const dpiPx = (deck.emuW / EMU_PER_INCH) * DPI;
      setScale(avail > 0 ? Math.min(1, avail / dpiPx) : 0);
    };
    useLayoutEffect(() => {
      if (phase !== 'ready' || !deck) return;
      measure();
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }, [phase, deck]);

    const slides = deck?.slides ?? [];
    const body = [];
    if (phase === 'loading') {
      body.push(el('div', { key: 'ld', className: 'fx-empty' },
        el('span', { className: 'fx-spin' }), el('span', null, '解析 pptx…')));
    } else if (phase === 'error') {
      body.push(el('div', { key: 'er', className: 'fx-notice' },
        el('span', null, 'pptx 富渲染失败'),
        el('span', { className: 'fx-dim' }, errMsg),
        onOpenExternal && el('button', { type: 'button', className: 'fx-mini-btn', onClick: () => onOpenExternal() },
          '改用本机 Office 打开')));
    } else {
      slides.forEach((slide, si) => {
        const slideW = Math.max(1, px(deck.emuW, scale));
        const slideH = Math.max(1, px(deck.emuH, scale));
        const kids = slide.boxes.map((box, bi) => {
          if (box.kind === 'image') {
            return el('div', {
              key: bi,
              className: 'fx-ppt-box',
              style: {
                left: px(box.x, scale), top: px(box.y, scale),
                width: px(box.w, scale), height: px(box.h, scale),
              },
            }, el('img', { src: box.dataUrl, alt: '', style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' } }));
          }
          const paras = box.paras
            .filter((p) => p.frags.length)
            .map((p, pi) => el('div', {
              key: pi,
              className: 'fx-ppt-line',
              style: {
                textAlign: p.algn === 'ctr' ? 'center' : p.algn === 'r' ? 'right' : p.algn === 'just' ? 'justify' : 'left',
                fontSize: Math.max(4, Math.round(((p.frags[0].sz || 1800) / 100) * (96 / 72) * (scale || 1))),
              },
            }, p.frags.map((f, fi) => el('span', {
              key: fi,
              style: {
                fontWeight: f.b ? 700 : undefined,
                fontStyle: f.i ? 'italic' : undefined,
                color: f.color ? `#${f.color}` : undefined,
              },
            }, f.text))));
          return el('div', {
            key: bi,
            className: 'fx-ppt-box',
            style: {
              left: px(box.x, scale), top: px(box.y, scale),
              width: px(box.w, scale), height: px(box.h, scale),
              background: box.bg,
            },
          }, el('div', {
            className: 'fx-ppt-text',
            style: { justifyContent: box.anchor },
          }, paras));
        });
        body.push(el('div', { key: `s${si}`, className: 'fx-ppt-slide',
          style: { width: slideW, height: slideH, background: slide.bg } },
          el('span', { className: 'fx-ppt-num' }, `${si + 1} / ${slides.length}`),
          kids));
      });
    }

    return el('div', { className: 'fx-preview-body' },
      el(RichToolbar, { ext: 'pptx', onOpenExternal }),
      el('div', { ref: scrollRef, className: 'fx-ppt-scroll fx-scroll' }, body));
  }

  return { DocxRichView, PptxRichView };
};
