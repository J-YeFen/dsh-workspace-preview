/**
 * Test fixtures for lib/office.js: build minimal but fully valid OOXML
 * files (docx / xlsx / pptx) in memory, each returned as a Buffer.
 *
 * Entries are stored uncompressed (zip method 0), but the local headers,
 * central directory and EOCD record are all well-formed with real
 * table-driven CRC-32 values, so the output also passes external tools
 * such as `unzip -t`.
 */

/** CRC-32 (IEEE) lookup table, polynomial 0xEDB88320, computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Table-driven CRC-32 (IEEE) of a buffer. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Zip DOS date for 1980-01-01 — the conventional "no real date" value. */
const DOS_DATE = 0x21;

/**
 * Pack [{ name, content }] into a stored-method zip archive and return
 * the whole file as one Buffer. `content` may be a string (utf8) or a
 * Buffer. No extra fields, no archive comment.
 */
function buildZip(files) {
  const localChunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(DOS_DATE, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    localChunks.push(local, name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const centralChunks = [];
  for (const entry of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // central directory signature
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8); // flags
    record.writeUInt16LE(0, 10); // method 0 = stored
    record.writeUInt16LE(0, 12); // mod time
    record.writeUInt16LE(DOS_DATE, 14); // mod date
    record.writeUInt32LE(entry.crc, 16);
    record.writeUInt32LE(entry.size, 20); // compressed size
    record.writeUInt32LE(entry.size, 24); // uncompressed size
    record.writeUInt16LE(entry.name.length, 28);
    record.writeUInt16LE(0, 30); // extra field length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number start
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE(0, 38); // external attributes
    record.writeUInt32LE(entry.offset, 42); // local header offset
    centralChunks.push(record, entry.name);
    offset += 46 + entry.name.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(central.length, 8); // entries on this disk
  eocd.writeUInt16LE(central.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

/**
 * Minimal docx: a Heading1 paragraph carrying XML entities (`A &amp; B`),
 * a normal paragraph with two runs around a w:tab, and a 2x2 table.
 */
export function buildDocx() {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>A &amp; B — Hello OOXML</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>First run</w:t></w:r>
      <w:r><w:tab/></w:r>
      <w:r><w:t>second run</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>r1c1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>r1c2</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>r2c1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>r2c2</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>
`;
  return buildZip([{ name: 'word/document.xml', content: document }]);
}

/**
 * Minimal xlsx: two sheets ("People" and "Numbers"), a shared string
 * table including a rich-text entry, sheet1 exercising shared strings,
 * a plain number and a sparse column hole (A1 then C1), sheet2 reached
 * through a package-absolute relationship target.
 */
export function buildXlsx() {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="People" sheetId="1" r:id="rId1"/>
    <sheet name="Numbers" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>
`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="3">
  <si><t>Hello OOXML</t></si>
  <si><r><t>Rich </t></r><r><t>text cell</t></r></si>
  <si><t>Sheet2 shared</t></si>
</sst>
`;
  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="C1"><v>42</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2" t="inlineStr"><is><t>inline value</t></is></c>
    </row>
  </sheetData>
</worksheet>
`;
  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>2</v></c>
      <c r="B1" t="b"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>
`;
  return buildZip([
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: rels },
    { name: 'xl/sharedStrings.xml', content: sharedStrings },
    { name: 'xl/worksheets/sheet1.xml', content: sheet1 },
    { name: 'xl/worksheets/sheet2.xml', content: sheet2 },
  ]);
}

/**
 * Minimal pptx: two slides referenced from p:sldIdLst, each with two
 * a:p paragraphs; slide2 adds an empty a:p that extraction must skip.
 */
export function buildPptx() {
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId7"/>
    <p:sldId id="257" r:id="rId8"/>
  </p:sldIdLst>
</p:presentation>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>
`;
  const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Hello OOXML slide one</a:t></a:r></a:p>
      <a:p><a:r><a:t>Second line of slide one</a:t></a:r></a:p>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>
`;
  const slide2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody>
      <a:p><a:r><a:t>Hello OOXML slide two</a:t></a:r></a:p>
      <a:p/>
    </p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>
`;
  return buildZip([
    { name: 'ppt/presentation.xml', content: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', content: rels },
    { name: 'ppt/slides/slide1.xml', content: slide1 },
    { name: 'ppt/slides/slide2.xml', content: slide2 },
  ]);
}
