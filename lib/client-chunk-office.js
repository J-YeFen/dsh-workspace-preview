/**
 * dsh-workspace-preview — lazy chunk: Office structured preview.
 *
 * Served by the host at `/dsh-workspace-preview/bundle/office.js` and fetched
 * on first use of an office file (see the chunk loader inside lib/client.js).
 * Contract: the script registers `globalThis.__dshChunks__["office"]`; the
 * loader injects the script and calls the factory with a require that answers
 * `react` (and the jsx runtime aliases). Everything office-specific — the
 * components AND their CSS — lives here so the main bundle never pays for it.
 *
 * The DATA is parsed host-side (lib/office.js, zero-dep OOXML extractor) and
 * arrives through the RPC `read` endpoint as `{kind:'office', format,
 * blocks|sheets|slides}`; this chunk only renders it.
 */
globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};
globalThis.__dshChunks__["office"] = (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const React = require("react");
  const { useState } = React;
  const el = React.createElement;

  // ── office styles (injected on first materialization) ──────────────────
  const CSS = [
    ".fx-doc-scroll{flex:1;overflow:auto}",
    ".fx-doc{max-width:860px;padding:12px 18px 24px}",
    ".fx-doc h1,.fx-doc h2,.fx-doc h3,.fx-doc h4,.fx-doc h5,.fx-doc h6{color:var(--dsw-alias-label-primary);margin:14px 0 6px}",
    ".fx-doc p{margin:6px 0;white-space:pre-wrap;line-height:1.7;color:var(--dsw-alias-label-primary)}",
    ".fx-doc-table{border-collapse:collapse;margin:10px 0;font-size:12px}",
    ".fx-doc-table td{border:1px solid var(--dsw-alias-border-l2);padding:4px 10px;white-space:pre-wrap}",
    ".fx-sheet-tabs{flex:none;display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}",
    ".fx-sheet-tab{flex:none;padding:4px 12px;border:1px solid transparent;border-radius:6px 6px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}",
    ".fx-sheet-tab:hover{color:var(--dsw-alias-label-primary)}",
    ".fx-sheet-tab-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);border-bottom-color:var(--dsw-alias-bg-base);background:var(--dsw-alias-bg-layer-1)}",
    ".fx-sheet-scroll{flex:1;overflow:auto}",
    ".fx-sheet-table{border-collapse:collapse;font-size:12px}",
    ".fx-sheet-table td{border:1px solid var(--dsw-alias-border-l1);padding:3px 10px;white-space:pre;max-width:320px;overflow:hidden;text-overflow:ellipsis}",
    ".fx-sheet-table tr:first-child td{font-weight:600;background:var(--dsw-alias-bg-layer-1);position:sticky;top:0}",
    ".fx-slides{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px}",
    ".fx-slide-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);position:relative;flex:none}",
    ".fx-slide-num{position:absolute;top:8px;right:10px;font-size:10px;color:var(--dsw-alias-label-quaternary)}",
    ".fx-slide-line{white-space:pre-wrap;line-height:1.7;color:var(--dsw-alias-label-primary)}",
    ".fx-slide-line-first{font-weight:600;font-size:14px;margin-bottom:4px}",
    // shared notices reuse the main bundle's .fx-empty / .fx-dim / .fx-trunc-note
  ].join("");

  const CSS_TAG = "dsh-workspace-preview/office.css";
  if (typeof document !== "undefined" &&
      document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-workspace-preview";
    tag.dataset.pluginCss = CSS_TAG;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── views ────────────────────────────────────────────────────────────────

  function DocxView({ data }) {
    return el("div", { className: "fx-doc-scroll fx-scroll" },
      el("div", { className: "fx-doc" },
        (data.blocks ?? []).map((b, i) => {
          if (b.type === "heading") {
            const tag = `h${Math.min(6, Math.max(1, b.level ?? 1))}`;
            return el(tag, { key: i }, b.text);
          }
          if (b.type === "table") {
            return el("table", { key: i, className: "fx-doc-table" },
              el("tbody", null,
                b.rows.map((r, ri) => el("tr", { key: ri },
                  r.map((c, ci) => el("td", { key: ci }, c))))));
          }
          return el("p", { key: i }, b.text);
        })));
  }

  function XlsxView({ data }) {
    const [sheetIdx, setSheetIdx] = useState(0);
    const sheets = data.sheets ?? [];
    const sheet = sheets[Math.min(sheetIdx, Math.max(0, sheets.length - 1))];
    return el(React.Fragment, null,
      sheets.length > 1 && el("div", { className: "fx-sheet-tabs" },
        sheets.map((s, i) => el("button", {
          key: i,
          type: "button",
          className: "fx-sheet-tab" + (i === sheetIdx ? " fx-sheet-tab-active" : ""),
          onClick: () => setSheetIdx(i),
        }, s.name || `Sheet ${i + 1}`))),
      el("div", { className: "fx-sheet-scroll fx-scroll" },
        sheet
          ? el("table", { className: "fx-sheet-table" },
              el("tbody", null,
                sheet.rows.map((r, ri) => el("tr", { key: ri },
                  r.map((c, ci) => el("td", { key: ci, title: c }, c))))))
          : el("div", { className: "fx-empty" }, el("span", null, "空工作表"))),
      sheet?.truncated
        ? el("div", { className: "fx-trunc-note" }, "工作表过大，仅显示前 500 行 × 100 列")
        : null,
    );
  }

  function PptxView({ data }) {
    return el("div", { className: "fx-slides fx-scroll" },
      (data.slides ?? []).map((s, i) => el("div", { key: i, className: "fx-slide-card" },
        el("span", { className: "fx-slide-num" }, `${i + 1} / ${data.slides.length}`),
        s.lines.length === 0
          ? el("div", { className: "fx-dim" }, "（空白页）")
          : s.lines.map((ln, li) => el("div", {
              key: li,
              className: "fx-slide-line" + (li === 0 ? " fx-slide-line-first" : ""),
            }, ln)))));
  }

  /** Unified entry: pick the structured view by data.format. */
  function OfficeView({ data }) {
    if (!data || typeof data !== "object") {
      return el("div", { className: "fx-empty" }, el("span", null, "无法解析该 Office 文件"));
    }
    if (data.format === "docx") return el(DocxView, { data });
    if (data.format === "xlsx") return el(XlsxView, { data });
    if (data.format === "pptx") return el(PptxView, { data });
    return el("div", { className: "fx-empty" },
      el("span", null, data.hint === "legacy-office"
        ? "旧版 Office 格式（.doc/.xls/.ppt）暂不支持预览，请另存为 .docx/.xlsx/.pptx 后再试"
        : "二进制文件，无法内联预览"));
  }

  exports.OfficeView = OfficeView;
  return module.exports;
};
