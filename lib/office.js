/**
 * dsh-workspace-preview — mini OOXML text extractor.
 *
 * Synchronous, dependency-free text extraction for the three Office Open
 * XML formats, which are all zip archives of XML parts:
 *
 *   docx  -> { format: 'docx', blocks }   headings, paragraphs, tables
 *   xlsx  -> { format: 'xlsx', sheets }   cell grids, shared strings joined
 *   pptx  -> { format: 'pptx', slides }   plain text lines per slide
 *
 * The zip reader and XML scanner below are deliberately minimal — just
 * enough of both specs to walk the parts real OOXML producers write, with
 * hard caps so a corrupt or hostile file cannot exhaust memory.
 */
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

/** Zip record signatures. */
const EOCD_SIG = 0x06054b50; // end of central directory
const CDIR_SIG = 0x02014b50; // central directory entry
const LOCAL_SIG = 0x04034b50; // local file header

/** Hard caps for the zip reader. */
const MAX_ZIP_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024; // 16 MiB per inflated entry
const EOCD_LOOKBACK = 64 * 1024 + 22; // EOCD record plus maximum comment

/** Extraction caps per format. */
const MAX_SHEETS = 8;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 100;
const MAX_SLIDES = 100;

/** Offset of the end-of-central-directory record, scanning backwards. */
function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_LOOKBACK);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip archive: end of central directory not found');
}

/**
 * Open `buffer` as a zip archive and return { names, readEntry }.
 * `readEntry(name)` resolves one entry by its archive path (e.g.
 * `word/document.xml`) and returns its bytes, or null when the archive
 * has no such entry. Only method 0 (stored) and method 8 (deflate) are
 * supported; anything else throws.
 */
function openZip(buffer) {
  const eocdAt = findEocd(buffer);
  const total = buffer.readUInt16LE(eocdAt + 10);
  if (total > MAX_ZIP_ENTRIES) {
    throw new Error(`zip archive has too many entries (${total})`);
  }
  const entries = new Map();
  let p = buffer.readUInt32LE(eocdAt + 16);
  for (let n = 0; n < total; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CDIR_SIG) {
      throw new Error('corrupt zip archive: bad central directory');
    }
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const entry = {
      method: buffer.readUInt16LE(p + 10),
      compressedSize: buffer.readUInt32LE(p + 20),
      size: buffer.readUInt32LE(p + 24),
      localOffset: buffer.readUInt32LE(p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.localOffset === 0xffffffff) {
      throw new Error('zip64 archives are not supported');
    }
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    entries.set(name, entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  const readEntry = (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size > MAX_ENTRY_BYTES) {
      throw new Error(`zip entry too large: ${name} (${entry.size} bytes)`);
    }
    const at = entry.localOffset;
    if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIG) {
      throw new Error(`corrupt zip archive: bad local header for ${name}`);
    }
    // Local header name/extra lengths may differ from the central ones.
    const dataStart = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
    if (dataStart + entry.compressedSize > buffer.length) {
      throw new Error(`corrupt zip archive: truncated data for ${name}`);
    }
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      let out;
      try {
        out = inflateRawSync(raw);
      } catch {
        throw new Error(`corrupt zip archive: cannot inflate entry ${name}`);
      }
      if (out.length > MAX_ENTRY_BYTES) {
        throw new Error(`zip entry too large: ${name} (${out.length} bytes)`);
      }
      return out;
    }
    throw new Error(`unsupported zip compression method ${entry.method} for ${name}`);
  };
  return { names: () => [...entries.keys()], readEntry };
}

/** Named entities defined by XML itself; numeric ones are computed. */
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode `&lt;`-style named entities and `&#NN;` / `&#xHH;` numerics. */
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (raw, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
    }
    return NAMED_ENTITIES[body] ?? raw;
  });
}

const NAME_RE = /^[\w:.-]+/;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Attributes of one tag source as a plain object, values decoded. */
function parseAttrs(source) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** Index of the `>` closing the tag opened at `from`, quote-aware. */
function tagEnd(xml, from) {
  let quote = '';
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse `xml` into a light element tree: { name, attrs, children } nodes
 * whose children mix elements with decoded text strings. Namespace
 * prefixes are matched literally (`w:p` stays `w:p`). This is a tag
 * scanner, not a DOM — mis-nested input degrades gracefully instead of
 * throwing; only unterminated constructs make the part unreadable.
 */
function parseXml(xml, partName) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const pushText = (raw, decode = true) => {
    if (raw) stack[stack.length - 1].children.push(decode ? decodeEntities(raw) : raw);
  };
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      pushText(xml.slice(i));
      break;
    }
    if (lt > i) pushText(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new Error(`malformed XML in ${partName}: unterminated comment`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error(`malformed XML in ${partName}: unterminated CDATA section`);
      pushText(xml.slice(lt + 9, end), false); // CDATA is literal text
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new Error(`malformed XML in ${partName}: unterminated processing instruction`);
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      // DOCTYPE and friends: skipped up to the next '>' (enough for OOXML parts).
      const end = xml.indexOf('>', lt + 2);
      if (end === -1) throw new Error(`malformed XML in ${partName}: unterminated declaration`);
      i = end + 1;
      continue;
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt === -1) throw new Error(`malformed XML in ${partName}: unterminated tag`);
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      // Pop back to the matching open element; ignore stray closers.
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const source = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = NAME_RE.exec(source);
    if (!nameMatch) continue; // not a tag shape we understand — skip it
    const node = {
      name: nameMatch[0],
      attrs: parseAttrs(source.slice(nameMatch[0].length)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** All descendant elements (depth-first, document order) named `name`. */
function descendants(node, name) {
  const out = [];
  const visit = (el) => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      if (child.name === name) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** First descendant element named `name`, or null. */
function firstDescendant(node, name) {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.name === name) return child;
    const hit = firstDescendant(child, name);
    if (hit) return hit;
  }
  return null;
}

/** Direct child elements named `name`, in document order. */
function childrenNamed(node, name) {
  return node.children.filter((child) => typeof child !== 'string' && child.name === name);
}

/** First direct child element named `name`, or null. */
function firstChild(node, name) {
  return node.children.find((child) => typeof child !== 'string' && child.name === name) ?? null;
}

/** Decoded attribute value of an element, or undefined when absent. */
function attr(node, name) {
  return node.attrs[name];
}

/** All text below `node`, already entity-decoded at parse time. */
function textOf(node) {
  let out = '';
  const visit = (el) => {
    for (const child of el.children) {
      if (typeof child === 'string') out += child;
      else visit(child);
    }
  };
  visit(node);
  return out;
}

/** Text of one w:p: w:t joined, w:tab -> tab, w:br / w:cr -> newline. */
function paragraphText(p) {
  let out = '';
  const visit = (el) => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      if (child.name === 'w:t') {
        out += textOf(child);
        continue; // w:t wraps plain text only — do not descend twice
      }
      if (child.name === 'w:tab') out += '\t';
      else if (child.name === 'w:br' || child.name === 'w:cr') out += '\n';
      visit(child);
    }
  };
  visit(p);
  return out;
}

/** Heading level implied by w:pPr/w:pStyle (0 = not a heading). */
function headingLevel(p) {
  const pPr = firstChild(p, 'w:pPr');
  const style = pPr && firstChild(pPr, 'w:pStyle');
  const val = style && attr(style, 'w:val');
  if (!val) return 0;
  const v = val.trim();
  if (v.toLowerCase() === 'title') return 1;
  const m = /^heading\s*([1-6])$/i.exec(v);
  return m ? Number(m[1]) : 0;
}

/** One w:tbl as a rows-of-cells grid; cell paragraphs join with '\n'. */
function tableBlock(tbl) {
  const rows = childrenNamed(tbl, 'w:tr').map((tr) =>
    childrenNamed(tr, 'w:tc').map((tc) =>
      descendants(tc, 'w:p').map(paragraphText).join('\n'),
    ),
  );
  return { type: 'table', rows };
}

function extractDocx(zip) {
  const part = zip.readEntry('word/document.xml');
  if (!part) throw new Error('docx: missing key part word/document.xml');
  const root = parseXml(part.toString('utf8'), 'word/document.xml');
  const body = firstDescendant(root, 'w:body') ?? root;
  const blocks = [];
  for (const child of body.children) {
    if (typeof child === 'string') continue;
    if (child.name === 'w:p') {
      const text = paragraphText(child);
      if (!text.trim()) continue; // empty paragraph — skipped
      const level = headingLevel(child);
      blocks.push(level ? { type: 'heading', level, text } : { type: 'para', text });
    } else if (child.name === 'w:tbl') {
      blocks.push(tableBlock(child));
    }
  }
  return { format: 'docx', blocks };
}

/** Relationship Id -> normalized zip path, from a .rels part. */
function parseRels(xml, baseDir, partName) {
  const rels = new Map();
  for (const rel of descendants(parseXml(xml, partName), 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (!id || !target) continue;
    rels.set(
      id,
      target.startsWith('/')
        ? target.slice(1) // package-absolute target
        : path.posix.normalize(`${baseDir}/${target}`),
    );
  }
  return rels;
}

/** Column index (A=0) from a cell reference like `B12`; -1 when absent. */
function columnIndex(ref) {
  const m = /^([A-Za-z]+)/.exec(ref ?? '');
  if (!m) return -1;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return col - 1;
}

/** Display text of one xlsx cell, resolving shared/inline strings. */
function cellText(c, shared) {
  const type = attr(c, 't');
  if (type === 's') {
    const v = firstChild(c, 'v');
    const idx = v ? Number(textOf(v).trim()) : NaN;
    return Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
  }
  if (type === 'inlineStr') {
    const is = firstChild(c, 'is');
    return is ? descendants(is, 't').map(textOf).join('') : '';
  }
  // t="str", t="b" and untyped cells all expose their raw <v> text.
  const v = firstChild(c, 'v');
  return v ? textOf(v) : '';
}

/** sheetData -> rows of string cells; sparse columns become '' holes. */
function sheetGrid(root, shared) {
  const rows = [];
  let truncated = false;
  const sheetData = firstDescendant(root, 'sheetData');
  if (!sheetData) return { rows, truncated };
  for (const rowEl of childrenNamed(sheetData, 'row')) {
    if (rows.length >= MAX_SHEET_ROWS) {
      truncated = true;
      break;
    }
    const cells = [];
    let nextCol = 0;
    for (const c of childrenNamed(rowEl, 'c')) {
      const explicit = columnIndex(attr(c, 'r'));
      const col = explicit >= 0 ? explicit : nextCol;
      nextCol = col + 1;
      if (col >= MAX_SHEET_COLS) {
        truncated = true;
        continue;
      }
      while (cells.length < col) cells.push(''); // hole left by a sparse ref
      cells[col] = cellText(c, shared);
    }
    rows.push(cells);
  }
  return { rows, truncated };
}

function extractXlsx(zip) {
  const workbookPart = zip.readEntry('xl/workbook.xml');
  if (!workbookPart) throw new Error('xlsx: missing key part xl/workbook.xml');
  const relsPart = zip.readEntry('xl/_rels/workbook.xml.rels');
  if (!relsPart) throw new Error('xlsx: missing key part xl/_rels/workbook.xml.rels');
  const rels = parseRels(relsPart.toString('utf8'), 'xl', 'xl/_rels/workbook.xml.rels');
  const shared = [];
  const sharedPart = zip.readEntry('xl/sharedStrings.xml'); // optional part
  if (sharedPart) {
    for (const si of descendants(parseXml(sharedPart.toString('utf8'), 'xl/sharedStrings.xml'), 'si')) {
      shared.push(descendants(si, 't').map(textOf).join(''));
    }
  }
  const sheets = [];
  const workbook = parseXml(workbookPart.toString('utf8'), 'xl/workbook.xml');
  for (const sheetEl of descendants(workbook, 'sheet').slice(0, MAX_SHEETS)) {
    const name = attr(sheetEl, 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(sheetEl, 'r:id');
    const target = rid ? rels.get(rid) : undefined;
    if (!target) {
      throw new Error(`xlsx: sheet "${name}" has no worksheet relationship (${rid ?? 'no r:id'})`);
    }
    const part = zip.readEntry(target);
    if (!part) throw new Error(`xlsx: missing worksheet part ${target}`);
    const grid = sheetGrid(parseXml(part.toString('utf8'), target), shared);
    sheets.push({ name, rows: grid.rows, truncated: grid.truncated });
  }
  return { format: 'xlsx', sheets };
}

const SLIDE_PART_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

/** One slide as its non-empty a:p lines (a:t runs concatenated). */
function slideLines(root) {
  const lines = [];
  for (const p of descendants(root, 'a:p')) {
    const text = descendants(p, 'a:t').map(textOf).join('');
    if (text.trim()) lines.push(text);
  }
  return { lines };
}

function extractPptx(zip) {
  let slideParts = [];
  const presentation = zip.readEntry('ppt/presentation.xml');
  const relsPart = zip.readEntry('ppt/_rels/presentation.xml.rels');
  if (presentation && relsPart) {
    const rels = parseRels(relsPart.toString('utf8'), 'ppt', 'ppt/_rels/presentation.xml.rels');
    const root = parseXml(presentation.toString('utf8'), 'ppt/presentation.xml');
    const list = firstDescendant(root, 'p:sldIdLst');
    for (const sldId of list ? childrenNamed(list, 'p:sldId') : []) {
      const target = rels.get(attr(sldId, 'r:id') ?? '');
      if (target) slideParts.push(target);
    }
  }
  if (!slideParts.length) {
    // Older/foreign structure: fall back to the slide parts on disk,
    // ordered by slide number rather than lexically.
    slideParts = zip
      .names()
      .filter((name) => SLIDE_PART_RE.test(name))
      .sort((a, b) => Number(SLIDE_PART_RE.exec(a)[1]) - Number(SLIDE_PART_RE.exec(b)[1]));
  }
  if (!slideParts.length) {
    throw new Error('pptx: no slides (missing ppt/presentation.xml and no ppt/slides/slide*.xml parts)');
  }
  const slides = [];
  for (const partName of slideParts.slice(0, MAX_SLIDES)) {
    const part = zip.readEntry(partName);
    if (!part) throw new Error(`pptx: missing slide part ${partName}`);
    slides.push(slideLines(parseXml(part.toString('utf8'), partName)));
  }
  return { format: 'pptx', slides };
}

/**
 * Extract the text content of an in-memory OOXML file.
 *
 * @param {Buffer|Uint8Array} buffer whole file bytes
 * @param {string} ext one of 'docx' | 'xlsx' | 'pptx' (a leading dot and
 *   uppercase are tolerated)
 * @returns {{format:'docx',blocks:Array}|{format:'xlsx',sheets:Array}|{format:'pptx',slides:Array}}
 * @throws on unsupported extensions, corrupt archives and missing key parts
 */
export function extractOffice(buffer, ext) {
  const kind = String(ext ?? '').trim().toLowerCase().replace(/^\./, '');
  if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') {
    throw new Error(`unsupported office extension: ${String(ext)} (expected docx, xlsx or pptx)`);
  }
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new Error('extractOffice expects the file bytes as a Buffer or Uint8Array');
  }
  const zip = openZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  if (kind === 'docx') return extractDocx(zip);
  if (kind === 'xlsx') return extractXlsx(zip);
  return extractPptx(zip);
}
