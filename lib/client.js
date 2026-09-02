window.__ModuleLoader__.load({
  id: "dsh-workspace-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const {
      useState,
      useEffect,
      useLayoutEffect,
      useRef,
      useMemo,
      useCallback,
    } = React;
    const el = React.createElement;
    // dsh 平台种子模块：复用应用自带的 read 卡片（行号 + shiki 高亮 + 复制）
    // 与 GFM Markdown 渲染器（代码围栏同样高亮）。
    const { ReadBlock, MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives");

    // ── pure helpers ────────────────────────────────────────────────────────

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    const extOf = (name) => {
      const i = name.lastIndexOf(".");
      return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
    };

    // 与 dsh 内置 read 工具完全一致的扩展名 → shiki 语法 id 映射
    // （dsh-tool-fs 的 langFromPath 同款表）。
    const LANG_BY_EXTENSION = {
      ts: "ts", tsx: "tsx", mts: "ts", cts: "ts",
      js: "js", jsx: "jsx", mjs: "js", cjs: "js",
      json: "json", jsonc: "json",
      py: "py", rb: "rb", go: "go", rs: "rs", java: "java",
      c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
      cs: "cs", kt: "kotlin", swift: "swift", php: "php",
      sh: "sh", bash: "sh", zsh: "sh",
      yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
      md: "md", markdown: "md", mdx: "mdx",
      html: "html", htm: "html", css: "css", scss: "scss", less: "less",
      sql: "sql", xml: "xml", lua: "lua",
    };
    const MD_EXTS = new Set(["md", "markdown", "mdx"]);
    // 直接渲染为页面的扩展名（沙箱 iframe 走 /html 路由）
    const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
    const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"]);
    const OFFICE_EXTS = new Set(["docx", "xlsx", "pptx"]);

    const fmtSize = (n) => {
      if (n == null) return "";
      if (n < 1024) return `${n} B`;
      const units = ["KB", "MB", "GB", "TB"];
      let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
      return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
    };

    const LANG_LABELS = {
      js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
      jsx: "JSX", ts: "TypeScript", tsx: "TSX",
      json: "JSON", yml: "YAML", yaml: "YAML", toml: "TOML",
      md: "Markdown", html: "HTML", xml: "XML", svg: "SVG",
      css: "CSS", scss: "SCSS", less: "Less",
      py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
      java: "Java", c: "C", h: "C", cpp: "C++", hpp: "C++", cs: "C#",
      php: "PHP", sh: "Shell", bash: "Shell", zsh: "Shell",
      sql: "SQL", txt: "Text", log: "Log", ini: "INI", env: "Env",
    };
    const langOf = (name) =>
      LANG_LABELS[extOf(name)] ?? (extOf(name) ? extOf(name).toUpperCase() : "Text");

    // ── URL builders（v0.3：图片/HTML 走宿主 HTTP 路由，不再 base64/改 src）──

    // POSIX 绝对路径规范化（合并 "." / ".."；host 只回传绝对路径）
    const normalizeAbsPath = (p) => {
      const out = [];
      for (const seg of p.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") { if (out.length) out.pop(); }
        else out.push(seg);
      }
      return "/" + out.join("/");
    };

    // 绝对路径 → URL 分段（每段 encodeURIComponent；HTML 路由用于相对资源回解析）
    const encodePathSegments = (p) =>
      p.split("/").filter(Boolean).map((seg) => encodeURIComponent(seg)).join("/");

    // Markdown 内嵌图片需要「绝对 http(s)」URL（宿主渲染器只放行绝对 URL），
    // 所以这里拼上 origin；<img> 预览与 iframe src 用同源相对路径即可。
    const origin = () =>
      (typeof window !== "undefined" && window.location && window.location.origin) || "";

    const mediaUrlOf = (p) => `${origin()}/dsh-workspace-preview/media?path=${encodeURIComponent(normalizeAbsPath(p))}`;
    const htmlUrlOf = (p) => `/dsh-workspace-preview/html/${encodePathSegments(p)}`;
    const chunkUrlOf = (name) => `/dsh-workspace-preview/bundle/${name}.js`;

    // ── 懒 chunk loader（v0.3：重 viewer 拆独立脚本，按需拉取）─────────────
    // chunk 脚本契约：`globalThis.__dshChunks__[name] = (require) => exports`。
    // require 只回答 react（与 jsx 别名）——chunk 由本仓库手写，无其它外部依赖。
    const chunkCache = new Map();
    function loadChunk(name) {
      const cached = chunkCache.get(name);
      if (cached !== undefined) return cached;
      const task = (async () => {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.async = true;
          s.src = chunkUrlOf(name);
          s.addEventListener("load", () => { s.remove(); resolve(); }, { once: true });
          s.addEventListener("error", () => { s.remove(); reject(new Error(`[dsh-workspace-preview] chunk ${name} failed to load`)); }, { once: true });
          document.head.append(s);
        });
        const factory = (globalThis.__dshChunks__ || {})[name];
        if (typeof factory !== "function") {
          throw new Error(`[dsh-workspace-preview] chunk "${name}" script did not register its factory`);
        }
        return factory((spec) => {
          if (spec === "react") return React;
          if (spec === "react/jsx-runtime") {
            return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment };
          }
          throw new Error(`[dsh-workspace-preview] chunk require('${spec}') is not an allowed external`);
        });
      })();
      chunkCache.set(name, task);
      void task.catch(() => chunkCache.delete(name));
      return task;
    }

    // ── viewer 注册表（v0.3：分发数据驱动；加新格式 = 加一行 + 可选 chunk）──
    // needs:
    //   'html'  —— 不取数，iframe 直连 /html 路由
    //   'media' —— 不取数，<img> 直连 /media 路由
    //   'text'  —— read 一次（code / markdown）
    //   'data'  —— read 一次（office，数据由 host 解析，渲染在懒 chunk）
    const viewerDefs = [
      { id: "html", exts: HTML_EXTS, needs: "html", priority: 60 },
      { id: "image", exts: IMG_EXTS, needs: "media", priority: 50 },
      { id: "markdown", exts: MD_EXTS, needs: "text", priority: 40 },
      { id: "office", exts: OFFICE_EXTS, needs: "data", priority: 30 },
      { id: "code", exts: null, needs: "text", priority: 0 }, // catch-all
    ];
    const matchViewer = (ext) => {
      let best = null;
      for (const v of viewerDefs) {
        if (v.exts !== null && !v.exts.has(ext)) continue;
        if (best === null || v.priority > best.priority) best = v;
      }
      return best;
    };

    // ── CSS (design tokens come from the dsh theme) ─────────────────────────

    const CSS = [
      ".fx-root.fx-root{position:absolute;inset:0;pointer-events:none;z-index:15;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".fx-root *{box-sizing:border-box}",
      ".fx-panel{position:absolute;top:0;bottom:0;display:flex;flex-direction:column;pointer-events:auto;background:var(--dsw-alias-bg-base);transition:right var(--ds-transition-duration-slow) var(--ds-ease-in-out),width var(--ds-transition-duration-slow) var(--ds-ease-in-out)}",
      ".fx-root.fx-dragging .fx-panel{transition:none}",
      ".fx-tree{right:0;border-left:1px solid var(--dsw-alias-border-l2)}",
      ".fx-preview{border-left:1px solid var(--dsw-alias-border-l2)}",
      ".fx-handle{position:absolute;top:0;bottom:0;left:-5px;width:10px;cursor:col-resize;z-index:2;touch-action:none}",
      ".fx-handle:hover{background:linear-gradient(90deg,transparent,var(--dsw-alias-fill-tsp-secondary))}",
      ".fx-head{display:flex;align-items:center;gap:6px;height:40px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}",
      ".fx-head-ico{color:var(--dsw-alias-label-primary-bluish);flex:none}",
      ".fx-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".fx-sub{font-size:11px;color:var(--dsw-alias-label-quaternary);flex:none}",
      ".fx-spacer{flex:1}",
      ".fx-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}",
      ".fx-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".fx-btn-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}",
      ".fx-select{flex:none;margin:8px 10px 0;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none;max-width:calc(100% - 20px)}",
      ".fx-pathbar{flex:none;padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-quaternary);border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 搜索条（v0.3）
      ".fx-searchbar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".fx-search{flex:1;min-width:0;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none}",
      ".fx-search:focus{border-color:var(--dsw-alias-border-l4)}",
      ".fx-treebody{flex:1;overflow:auto;padding:4px 0 10px}",
      ".fx-scroll::-webkit-scrollbar{width:8px;height:8px}",
      ".fx-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}",
      ".fx-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}",
      ".fx-row{display:flex;align-items:center;gap:6px;height:26px;padding:0 10px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;user-select:none}",
      ".fx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".fx-row-sel,.fx-row-sel:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
      ".fx-chev{width:14px;height:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
      ".fx-chev-leaf{opacity:0}",
      ".fx-chevron{transition:transform .15s ease}",
      ".fx-rotated{transform:rotate(90deg)}",
      ".fx-ico{flex:none;color:var(--dsw-alias-label-tertiary)}",
      ".fx-ico-folder{color:var(--dsw-alias-label-primary-bluish)}",
      ".fx-name{overflow:hidden;text-overflow:ellipsis;flex:1}",
      ".fx-size{font-size:11px;color:var(--dsw-alias-label-quaternary);flex:none}",
      ".fx-dim{color:var(--dsw-alias-label-quaternary);font-size:12px}",
      ".fx-err-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-error);flex:none}",
      ".fx-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 16px;color:var(--dsw-alias-label-quaternary);text-align:center;font-size:12px;flex:1;min-height:0}",
      ".fx-spin{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:fxspin .8s linear infinite}",
      "@keyframes fxspin{to{transform:rotate(360deg)}}",
      ".fx-rail{position:absolute;right:0;top:50%;transform:translateY(-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-right:none;border-radius:8px 0 0 8px;color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:0 2px 8px var(--dsw-alias-bg-mask-1)}",
      ".fx-rail:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}",
      ".fx-rail-label{writing-mode:vertical-rl;font-size:11px}",
      ".fx-preview-body{flex:1;overflow:hidden;display:flex;flex-direction:column}",
      ".fx-code-scroll{flex:1;overflow:auto}",
      ".fx-md-scroll{flex:1;overflow:auto}",
      ".fx-md{max-width:860px;padding:6px 18px 24px}",
      // Markdown 内嵌图片不超出预览宽度（大图如截图会缩放）
      ".fx-md img{max-width:100%;height:auto}",
      ".fx-img-wrap{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px;background:repeating-conic-gradient(var(--dsw-alias-bg-layer-2) 0% 25%,var(--dsw-alias-bg-layer-1) 0% 50%) 0 0/20px 20px}",
      ".fx-img{max-width:100%;max-height:100%;box-shadow:0 2px 12px var(--dsw-alias-bg-mask-1);border-radius:4px}",
      // HTML 渲染预览：沙箱 iframe 铺满预览体
      ".fx-html-wrap{flex:1;overflow:hidden;background:var(--dsw-alias-bg-base)}",
      ".fx-html-frame{display:block;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}",
      ".fx-notice{display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;padding:32px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;flex:1;min-height:0}",
      ".fx-notice-ico{color:var(--dsw-alias-label-quaternary)}",
      ".fx-trunc-note{padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);flex:none}",
      ".fx-chip{flex:none;font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
      // 编辑器（CodeMirror 宿主，v0.3.1：懒 chunk /bundle/editor.js）
      ".fx-cm-wrap{flex:1;min-height:0;position:relative}",
      ".fx-cm-wrap .fx-cm{position:absolute;inset:0}",
      ".fx-cm-wrap .fx-cm .cm-editor{height:100%}",
      ".fx-cm-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-quaternary);font-size:12px;background:var(--dsw-alias-bg-base);z-index:1}",
      ".fx-savebar{flex:none;display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".fx-savebar-ok{color:var(--dsw-alias-label-primary-bluish)}",
      ".fx-savebar-err{color:var(--dsw-alias-label-error)}",
      ".fx-dirty{color:var(--dsw-alias-label-quaternary);flex:none}",
      // 目录树行内操作（hover 显示，顶替文件尺寸列）
      ".fx-row-actions{display:none;gap:2px;flex:none}",
      ".fx-row:hover .fx-row-actions{display:inline-flex}",
      ".fx-row:hover .fx-size{display:none}",
      ".fx-row-actions .fx-btn{width:20px;height:20px}",
      ".fx-rename{flex:1;min-width:0;height:20px;border:1px solid var(--dsw-alias-label-primary-bluish);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 6px;outline:none}",
      ".fx-mini-btn{flex:none;height:20px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
      ".fx-mini-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".fx-mini-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}",
      ".fx-confirm-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-error)}",
      // 软链接（v0.3）：行尾小标记；失效链接名用错误色
      ".fx-symlink{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:2px}",
      ".fx-name-broken{color:var(--dsw-alias-label-error)}",
    ].join("");

    const CSS_TAG = "dsh-workspace-preview/style.css";
    if (typeof document !== "undefined" &&
        document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-workspace-preview";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── icons (inline SVG, stroke = currentColor) ───────────────────────────

    const ICON_PATHS = {
      folder: ["M3 6.5A1.5 1.5 0 0 1 4.5 5h3.6l1.6 2h5.8A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8Z"],
      file: ["M6.5 2.5h4.6l3.4 3.4v11.6a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z", "M11 2.5v3.4h3.4"],
      chevronRight: ["m8.5 5.5 4.5 4.5-4.5 4.5"],
      chevronDown: ["m5.5 8 4.5 4.5L14.5 8"],
      doubleRight: ["m6.5 5 4.5 4.5L6.5 14", "M11.5 5 16 9.5l-4.5 4.5"],
      x: ["m5 5 10 10", "M15 5 5 15"],
      external: ["M10 5h5v5", "M14.5 5.5 9 11", "M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12"],
      refresh: ["M16 8a6 6 0 1 0 .5 5", "M16 4v4h-4"],
      search: ["m14.5 14.5-3-3", "M11 6.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"],
      eye: ["M2 10s3.5-5 8-5 8 5 8 5-3.5 5-8 5-8-5-8-5Z", "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
      eyeOff: ["M4 4l12 12", "M9.4 6.2A8.2 8.2 0 0 1 10 6c4.5 0 8 4 8 4a13 13 0 0 1-2.2 2.7", "M6.2 9.4A13.2 13.2 0 0 0 2 10s3.5 5 8 5c.6 0 1.2-.1 1.7-.2"],
      image: ["M3 4h14v12H3z", "M6.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", "m3.5 13.5 4-4 3 3 3.5-3.5 2.5 2.5"],
      code: ["m7.5 6-4 4 4 4", "M12.5 6l4 4-4 4"],
      edit: ["M13.5 3.5a1.77 1.77 0 0 1 2.5 2.5L7 15l-3.5 1 1-3.5 9-9Z"],
      save: ["M4.5 3.5h8l3 2.5v10.5h-11V3.5Z", "M7 3.5V7h5V3.5", "M7 16.5V11h6v5.5"],
      format: ["M7 3.5c-2.5 0-2.5 2-2.5 3v2c0 1.2-.8 1.5-2 1.5 1.2 0 2 .3 2 1.5v2c0 1 0 3 2.5 3", "M13 3.5c2.5 0 2.5 2 2.5 3v2c0 1.2.8 1.5 2 1.5-1.2 0-2 .3-2 1.5v2c0 1 0 3-2.5 3"],
      trash: ["M4 6h12", "M8 6V4.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V6", "M6 6l.8 10a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9L14 6"],
    };

    function makeIcon(name, size) {
      const paths = ICON_PATHS[name] ?? [];
      return (props) => el("svg", Object.assign({
        viewBox: "0 0 20 20",
        width: size ?? 15,
        height: size ?? 15,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      }, props), paths.map((d, i) => el("path", { key: i, d })));
    }

    const FolderIcon = makeIcon("folder");
    const FileIcon = makeIcon("file");
    const ChevronIcon = makeIcon("chevronRight", 12);
    const DoubleRightIcon = makeIcon("doubleRight");
    const CloseIcon = makeIcon("x");
    const ExternalIcon = makeIcon("external");
    const RefreshIcon = makeIcon("refresh");
    const SearchIcon = makeIcon("search");
    const EyeIcon = makeIcon("eye");
    const EyeOffIcon = makeIcon("eyeOff");
    const ImageIcon = makeIcon("image", 26);
    const CodeIcon = makeIcon("code", 26);
    const EditIcon = makeIcon("edit");
    const SaveIcon = makeIcon("save");
    const FormatIcon = makeIcon("format");
    const TrashIcon = makeIcon("trash");

    function IconButton({ title, onClick, active, disabled, icon, size }) {
      return el("button", {
        type: "button",
        className: "fx-btn" + (active ? " fx-btn-active" : ""),
        title,
        "aria-label": title,
        onClick,
        disabled: disabled === true,
      }, el(icon, { width: size ?? 15, height: size ?? 15 }));
    }

    // 父目录路径（POSIX 风格，host 只回传绝对路径）
    const parentOf = (p) => {
      const i = p.lastIndexOf("/");
      return i > 0 ? p.slice(0, i) : "/";
    };

    // ── Markdown 预处理（v0.3：本地图片直指宿主 /media 路由）────────────────
    // 宿主 MarkdownText 把原始 HTML 当字面文本显示、只放行绝对 http(s) 图片
    // URL。因此：剥掉原始 HTML 标签；本地图片引用（`![alt](路径)` 与
    // `<img src>`）改写成指向 /media 路由的绝对 URL——真实 URL 会被渲染成
    // 真正的 <img>，浏览器直接向宿主要字节，无需 base64、无需假域名占位、
    // 无需渲染后再换 src。外部 http(s) 图片保留原样。

    // 把图片引用解析为工作区绝对路径；外部 URL / 锚点 / 协议相对引用返回 null
    const resolveWorkspacePath = (dir, src) => {
      let s = String(src).trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") || s.startsWith("#")) return null;
      s = s.replace(/[?#].*$/, "");
      if (!s) return null;
      try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
      return s.startsWith("/") ? normalizeAbsPath(s) : normalizeAbsPath(dir + "/" + s);
    };

    // 预处理整篇 Markdown：跳过围栏代码块，逐行变换（见 transformLine）
    function prepareMarkdownText(text, dir) {
      const lines = text.split("\n");
      const out = [];
      let inFence = false;
      for (const line of lines) {
        if (/^\s*(```+|~~~+)/.test(line)) { inFence = !inFence; out.push(line); continue; }
        if (inFence) { out.push(line); continue; }
        out.push(transformLine(line, dir));
      }
      return out.join("\n");
    }

    // 单行变换：行内代码遮罩 → `<img>` / `![...]` 改写 → 剥 HTML 标签 → 还原遮罩
    function transformLine(line, dir) {
      // 行内代码（`` `...` ``）先整体遮罩，避免其中的图片语法被误处理
      const codeMask = [];
      let s = line.replace(/`{1,}[^`\n]*`{1,}/g, (m) => {
        codeMask.push(m);
        return `\uE000CODE${codeMask.length - 1}\uE001`;
      });
      // `<img ...>`：本地路径 → /media 绝对 URL；外部 http(s) → markdown 图片语法；
      // data:/其它 → 只留 alt 文本（或原标签，随后被剥掉）
      s = s.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
        const src = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] ?? "";
        const alt = /(?:^|\s)alt\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] ?? "";
        const p = resolveWorkspacePath(dir, src);
        if (p && IMG_EXTS.has(extOf(p))) return `![${alt}](${mediaUrlOf(p)})`;
        if (/^https?:/i.test(src)) return alt ? `![${alt}](${src})` : `![](${src})`;
        return alt || m;
      });
      // `![alt](src)`：本地路径 → /media 绝对 URL；其余（外部 http(s)、data: 等）原样保留
      s = s.replace(/!\[([^\]]*)\]\(([^()\s]+)(?:\s+["'][^"']*["'])?\)/g, (m, alt, src) => {
        const p = resolveWorkspacePath(dir, src);
        if (p && IMG_EXTS.has(extOf(p))) return `![${alt}](${mediaUrlOf(p)})`;
        return m;
      });
      // 剥掉其余原始 HTML 标签（宿主把它们当字面文本显示，等于乱码）；`<br>` 换行
      s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-zA-Z][^>]*>/g, "");
      return s.replace(/\uE000CODE(\d+)\uE001/g, (m, i) => codeMask[Number(i)] ?? "");
    }

    // ── 预览视图组件 ────────────────────────────────────────────────────────

    // HTML：沙箱 iframe 直接加载 /html 路由（CSP sandbox 头 + 相对资源可解析；
    // iframe 再叠加 sandbox="" 属性 = 双边界）。HTML 不再经 RPC 取文本。
    function HtmlView({ url }) {
      return el("div", { className: "fx-preview-body" },
        el("div", { className: "fx-html-wrap" },
          el("iframe", {
            className: "fx-html-frame",
            title: "HTML 渲染预览",
            sandbox: "",
            referrerPolicy: "no-referrer",
            src: url,
          })));
    }

    // Markdown：GFM 渲染；本地图片已是 /media 绝对 URL，宿主直接渲染成 <img>，
    // 无占位/换源环节（v0.3）。纯函数 + memo，树交互不重算。
    function MdView({ text, dir, truncated }) {
      const prepared = useMemo(() => prepareMarkdownText(text, dir), [text, dir]);
      return el("div", { className: "fx-preview-body" },
        el("div", { className: "fx-md-scroll fx-scroll" },
          el("div", { className: "fx-md" },
            el(MarkdownText, { text: prepared }))),
        truncated
          ? el("div", { className: "fx-trunc-note" },
              "内容过长，仅渲染前 256 KiB，完整内容请用外部程序打开")
          : null,
      );
    }

    // 代码/文本：复用 dsh 的 read 卡片 —— 行号 + shiki 语法高亮 + 复制按钮。
    const MAX_CODE_LINES = 3000;
    function CodeView({ text, ext, truncated }) {
      const lines = text.split("\n");
      const shown = lines.slice(0, MAX_CODE_LINES).map((line, i) => ({ number: i + 1, text: line }));
      const omitted = lines.length - shown.length;
      return el("div", { className: "fx-preview-body" },
        el("div", { className: "fx-code-scroll fx-scroll" },
          el(ReadBlock, {
            lines: shown,
            totalLines: lines.length,
            lang: LANG_BY_EXTENSION[ext],
            maxLines: Math.max(1, shown.length),
            className: "fx-readblock",
          })),
        (truncated || omitted > 0)
          ? el("div", { className: "fx-trunc-note" },
              `仅显示前 ${shown.length.toLocaleString()} 行${omitted > 0 ? `（共 ${lines.length.toLocaleString()} 行）` : ""}，完整内容请用外部程序打开`)
          : null,
      );
    }

    // 图片：<img> 直连 /media 路由（无 base64 膨胀）。
    function ImageView({ url, name }) {
      return el("div", { className: "fx-img-wrap fx-scroll" },
        el("img", { className: "fx-img", src: url, alt: name }));
    }

    // Office：懒 chunk（/bundle/office.js）里的渲染组件；数据来自 host 解析。
    function LazyOfficeView({ data }) {
      const [state, setState] = useState({ status: "loading" });
      useEffect(() => {
        let alive = true;
        loadChunk("office").then((mod) => {
          if (!alive) return;
          if (typeof mod?.OfficeView !== "function") {
            setState({ status: "error", message: "office chunk 缺少 OfficeView" });
            return;
          }
          setState({ status: "ready", Comp: mod.OfficeView });
        }).catch((error) => {
          if (!alive) return;
          setState({ status: "error", message: String(error?.message ?? error) });
        });
        return () => { alive = false; };
      }, []);
      if (state.status === "loading") {
        return el("div", { className: "fx-empty" },
          el("span", { className: "fx-spin" }), el("span", null, "加载 Office 预览…"));
      }
      if (state.status === "error") {
        return el("div", { className: "fx-notice" },
          el(CloseIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
          el("span", null, "Office 预览加载失败"),
          el("span", { className: "fx-dim" }, state.message));
      }
      return el(state.Comp, { data });
    }

    // ── CodeMirror 编辑器（懒 chunk /bundle/editor.js）─────────────────────
    // 编辑态由 textarea 换成 CodeMirror 6（v0.3.1，方案 A：devDeps 一次性打包，
    // 运行时零依赖）。组件只负责挂载/卸载与回调转发；⌘/Ctrl+S 由 chunk 内
    // keymap 触发 onSave，文档变化经 onDocChange 同步 draft（脏标记/保存同旧逻辑）。
    function CmEditor({ doc, ext, onDocChange, onSave }) {
      const hostRef = useRef(null);
      const apiRef = useRef(null);
      const [phase, setPhase] = useState("loading"); // loading | ready | error
      const [errMsg, setErrMsg] = useState(null);
      // 最新回调放进 ref，避免 CM 事件闭包拿到过期引用
      const cbRef = useRef({ onDocChange, onSave });
      cbRef.current = { onDocChange, onSave };
      const docRef = useRef(doc);
      docRef.current = doc;

      useEffect(() => {
        let cancelled = false;
        loadChunk("editor").then((mod) => {
          if (cancelled) return;
          if (typeof mod?.createEditor !== "function") {
            setPhase("error");
            setErrMsg("editor chunk 缺少 createEditor");
            return;
          }
          try {
            const api = mod.createEditor({
              parent: hostRef.current,
              doc: docRef.current,
              language: ext,
              onChange: (text) => cbRef.current.onDocChange?.(text),
              onSave: () => cbRef.current.onSave?.(),
            });
            if (cancelled) { api.destroy(); return; }
            apiRef.current = api;
            setPhase("ready");
          } catch (error) {
            setPhase("error");
            setErrMsg(String(error?.message ?? error));
          }
        }).catch((error) => {
          if (!cancelled) {
            setPhase("error");
            setErrMsg(String(error?.message ?? error));
          }
        });
        return () => {
          cancelled = true;
          if (apiRef.current) { try { apiRef.current.destroy(); } catch { /* ignore */ } }
          apiRef.current = null;
        };
      }, [ext]); // 每次编辑会话挂载一次（父级用 editSeq key 控制重挂载）

      return el("div", { className: "fx-cm-wrap" },
        el("div", { ref: hostRef, className: "fx-cm" }),
        phase === "loading" && el("div", { className: "fx-cm-loading" },
          el("span", { className: "fx-spin" }), el("span", null, "加载编辑器…")),
        phase === "error" && el("div", { className: "fx-cm-loading" },
          el(CloseIcon, { width: 20, height: 20 }),
          el("span", null, `编辑器加载失败：${errMsg ?? ""}`)),
      );
    }

    const MemoHtmlView = React.memo(HtmlView);
    const MemoMdView = React.memo(MdView);
    const MemoCodeView = React.memo(CodeView);
    const MemoImageView = React.memo(ImageView);
    const MemoOfficeView = React.memo(LazyOfficeView);

    // ── the FileExplorer surface ────────────────────────────────────────────

    const STORE_KEYS = {
      open: "dsh.workspacePreview.treeOpen",
      width: "dsh.workspacePreview.treeWidth",
      previewWidth: "dsh.workspacePreview.previewWidth",
    };
    const loadBool = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; } };
    const loadNum = (k, d) => { try { const v = Number(localStorage.getItem(k)); return Number.isFinite(v) && v > 0 ? v : d; } catch { return d; } };

    const TREE_MIN = 200, TREE_MAX = 480, TREE_DEFAULT = 280;
    const PREVIEW_MIN = 320, PREVIEW_MAX = 960, PREVIEW_DEFAULT = 560;
    const MEDIA_CAP = 20 * 1024 * 1024; // 与 host 媒体路由一致；超过则给提示而非破图

    function FileExplorer(props) {
      const { rpc, openPath } = props;

      // Framework standard hooks (global seat).
      const currentSessionId = props.useSessions((s) => s.current);
      const wsItems = props.useWorkspaces((s) => s.items);
      const recentWsId = props.useWorkspaces((s) => s.recentWorkspaceId);

      // Panel geometry / visibility (persisted).
      const [treeOpen, setTreeOpenState] = useState(() => loadBool(STORE_KEYS.open, true));
      const [treeWidth, setTreeWidthState] = useState(() => loadNum(STORE_KEYS.width, TREE_DEFAULT));
      const [previewWidth, setPreviewWidthState] = useState(() => loadNum(STORE_KEYS.previewWidth, PREVIEW_DEFAULT));
      const [showHidden, setShowHidden] = useState(false);
      const [dragging, setDragging] = useState(false);

      const setTreeOpen = (v) => { setTreeOpenState(v); try { localStorage.setItem(STORE_KEYS.open, v ? "1" : "0"); } catch {} };
      const setTreeWidth = (v) => { setTreeWidthState(v); try { localStorage.setItem(STORE_KEYS.width, String(Math.round(v))); } catch {} };
      const setPreviewWidth = (v) => { setPreviewWidthState(v); try { localStorage.setItem(STORE_KEYS.previewWidth, String(Math.round(v))); } catch {} };

      // Workspace resolution: follow the current session's workspace (the
      // left sidebar's picker), then the override chosen in this panel.
      const [wsOverrideId, setWsOverrideId] = useState(null);
      const activeWs = useMemo(() => {
        if (wsOverrideId) return wsItems.find((w) => w.workspaceId === wsOverrideId) ?? null;
        const bySession = wsItems.find((w) => w.sessionIds.includes(currentSessionId));
        if (bySession) return bySession;
        return wsItems.find((w) => w.workspaceId === recentWsId) ?? wsItems[0] ?? null;
      }, [wsItems, currentSessionId, recentWsId, wsOverrideId]);
      const rootPath = activeWs?.path ?? null;

      // Tree state.
      const [expanded, setExpanded] = useState(() => new Set());
      const [children, setChildren] = useState(() => new Map());
      const [loading, setLoading] = useState(() => new Set());
      const [errors, setErrors] = useState(() => new Map());
      const [selected, setSelected] = useState(null); // {path,name,size,ext}
      const [preview, setPreview] = useState({ phase: "idle" }); // {phase, kind, data?, url?, ext?}

      // 搜索态（v0.3）
      const [searchOpen, setSearchOpen] = useState(false);
      const [searchQuery, setSearchQuery] = useState("");
      const [searching, setSearching] = useState(false);
      const [searchRes, setSearchRes] = useState(null); // null | {results, truncated, error?}
      const searchSeq = useRef(0);

      // 编辑态与树操作态（重命名行 / 删除确认行各同时只保留一个）
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState("");
      const [saving, setSaving] = useState(false);
      const [saveMsg, setSaveMsg] = useState(null); // {kind:'ok'|'err', text, reload?}
      const [renaming, setRenaming] = useState(null);
      const [confirmDel, setConfirmDel] = useState(null);
      // 编辑会话序号：进入编辑态时自增；CM 编辑器的挂载 key 用它（重命名不重挂载）
      const [editSeq, setEditSeq] = useState(0);

      const fetchChildren = useCallback(async (dirPath) => {
        setLoading((prev) => new Set(prev).add(dirPath));
        setErrors((prev) => { const n = new Map(prev); n.delete(dirPath); return n; });
        try {
          const res = await rpc.call("/dsh-workspace-preview", "list", { path: dirPath });
          if (!res.ok) throw new Error(res.error?.message ?? "list failed");
          setChildren((prev) => new Map(prev).set(dirPath, res.value.entries));
        } catch (error) {
          setErrors((prev) => new Map(prev).set(dirPath, String(error?.message ?? error)));
        } finally {
          setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
        }
      }, [rpc]);

      // Re-root the tree when the active workspace changes.
      const loadedRoot = useRef(null);
      useEffect(() => {
        if (!rootPath || loadedRoot.current === rootPath) return;
        loadedRoot.current = rootPath;
        setExpanded(new Set([rootPath]));
        setChildren(new Map());
        setErrors(new Map());
        setSelected(null);
        setPreview({ phase: "idle" });
        setEditing(false);
        setSaveMsg(null);
        setRenaming(null);
        setConfirmDel(null);
        setSearchOpen(false);
        setSearchQuery("");
        setSearchRes(null);
        void fetchChildren(rootPath);
      }, [rootPath, fetchChildren]);

      const toggleDir = (dirPath) => {
        const willExpand = !expanded.has(dirPath);
        setExpanded((prev) => {
          const n = new Set(prev);
          if (willExpand) n.add(dirPath); else n.delete(dirPath);
          return n;
        });
        if (willExpand && !children.has(dirPath) && !loading.has(dirPath)) void fetchChildren(dirPath);
      };

      const refreshAll = () => {
        setChildren(new Map());
        setErrors(new Map());
        setRenaming(null);
        setConfirmDel(null);
        for (const dirPath of expanded) void fetchChildren(dirPath);
      };

      // ── 搜索 ──────────────────────────────────────────────────────────────

      const runSearch = useCallback(async (query) => {
        const q = query.trim();
        const seq = ++searchSeq.current;
        if (!rootPath || q === "") { setSearchRes(null); setSearching(false); return; }
        setSearching(true);
        try {
          const res = await rpc.call("/dsh-workspace-preview", "search", { root: rootPath, query: q });
          if (seq !== searchSeq.current) return;
          if (!res.ok) throw new Error(res.error?.message ?? "search failed");
          setSearchRes(res.value);
        } catch (error) {
          if (seq !== searchSeq.current) return;
          setSearchRes({ results: [], truncated: false, error: String(error?.message ?? error) });
        } finally {
          if (seq === searchSeq.current) setSearching(false);
        }
      }, [rootPath, rpc]);

      // 输入防抖 250ms
      useEffect(() => {
        if (!searchOpen) return undefined;
        const t = setTimeout(() => void runSearch(searchQuery), 250);
        return () => clearTimeout(t);
      }, [searchQuery, searchOpen, runSearch]);

      const openSearch = () => {
        setSearchOpen(true);
        setSearchRes(null);
        setSearchQuery("");
        searchSeq.current++;
        setSearching(false);
      };
      const closeSearch = () => {
        setSearchOpen(false);
        setSearchQuery("");
        setSearchRes(null);
        searchSeq.current++;
        setSearching(false);
      };

      // 搜索命中目录：展开 root → dir 的祖先链，退出搜索回到树
      const revealDir = (dirPath) => {
        const chain = [];
        let cur = dirPath;
        while (cur && cur !== rootPath && cur.startsWith(rootPath + "/")) {
          chain.unshift(cur);
          cur = parentOf(cur);
        }
        setExpanded((prev) => {
          const n = new Set(prev);
          n.add(rootPath);
          for (const p of chain) n.add(p);
          return n;
        });
        for (const p of [rootPath, ...chain]) {
          if (!children.has(p) && !loading.has(p)) void fetchChildren(p);
        }
        closeSearch();
      };

      const readSeq = useRef(0);
      // 编辑脏状态的最新引用：openFile / doRemove / submitRename 在丢弃未保存
      // 草稿之前用它确认，避免点错文件/删除/改名时静默丢失编辑内容。
      const dirtyRef = useRef(false);

      const confirmDiscard = () => {
        if (!dirtyRef.current) return true;
        return window.confirm("放弃未保存的修改？");
      };

      // ── 打开文件：viewer 注册表分发（v0.3）─────────────────────────────
      // html / 图片不读正文（直连路由）；markdown/代码/office 经 read 取数据。
      const openFile = (entry) => {
        if (!confirmDiscard()) return; // 有脏草稿时先确认，取消则保持当前预览
        const seq = ++readSeq.current;
        const ext = extOf(entry.name);
        const viewer = matchViewer(ext);
        setSelected({ path: entry.path, name: entry.name, size: entry.size, ext });
        setPreview({ phase: "loading", kind: viewer?.needs ?? "text" });
        setEditing(false);
        setSaveMsg(null);
        if (!viewer || viewer.needs === "html") {
          // HTML：沙箱 iframe 直连 /html 路由（相对资源可解析）
          setPreview({ phase: "ready", kind: "html", url: htmlUrlOf(entry.path) });
          return;
        }
        if (viewer.needs === "media") {
          // 图片：<img> 直连 /media 路由；超大时给提示而非破图
          if (entry.size != null && entry.size > MEDIA_CAP) {
            setPreview({ phase: "ready", kind: "too-large-media", size: entry.size });
          } else {
            setPreview({ phase: "ready", kind: "media", url: mediaUrlOf(entry.path), name: entry.name });
          }
          return;
        }
        (async () => {
          try {
            const res = await rpc.call("/dsh-workspace-preview", "read", { path: entry.path });
            if (seq !== readSeq.current) return;
            if (!res.ok) throw new Error(res.error?.message ?? "read failed");
            const data = res.value;
            if (data.kind === "text") {
              const ext2 = extOf(entry.name);
              const kind = MD_EXTS.has(ext2) ? "markdown" : "code";
              setPreview({ phase: "ready", kind, data, ext: ext2 });
            } else if (data.kind === "office") {
              setPreview({ phase: "ready", kind: "office", data });
            } else {
              // binary / too-large / legacy-office（hint 在 data 上）
              setPreview({ phase: "ready", kind: data.kind, data });
            }
          } catch (error) {
            if (seq !== readSeq.current) return;
            setPreview({ phase: "error", message: String(error?.message ?? error) });
          }
        })();
      };

      const closePreview = () => {
        readSeq.current++;
        setSelected(null);
        setPreview({ phase: "idle" });
        setEditing(false);
        setSaveMsg(null);
      };

      // ── 编辑 / 保存（仅文本类且未截断的文件可编辑，防止用片段覆盖全文件）──

      const canEdit = preview.phase === "ready" &&
        (preview.kind === "code" || preview.kind === "markdown") &&
        preview.data?.truncated === false;
      const dirty = editing && canEdit && draft !== preview.data.text;
      dirtyRef.current = dirty;

      const startEdit = () => {
        if (!canEdit) return;
        setDraft(preview.data.text);
        setEditSeq((n) => n + 1);
        setEditing(true);
        setSaveMsg(null);
      };

      const cancelEdit = () => {
        if (dirty && !window.confirm("放弃未保存的修改？")) return;
        setEditing(false);
        setSaveMsg(null);
      };

      const saveEdit = async () => {
        if (!dirty || saving) return;
        setSaving(true);
        setSaveMsg(null);
        try {
          const res = await rpc.call("/dsh-workspace-preview", "write", {
            path: selected.path,
            content: draft,
            mtimeMs: preview.data.mtimeMs, // 乐观并发：外部改动则 host 拒绝
          });
          if (!res.ok) {
            if (res.error?.code === "conflict") {
              setSaveMsg({ kind: "err", text: "文件已被外部修改，保存被拒绝", reload: true });
              return;
            }
            throw new Error(res.error?.message ?? "write failed");
          }
          setPreview((p) => ({ ...p, data: { ...p.data, text: draft, truncated: false, size: res.value.bytes, mtimeMs: res.value.mtimeMs } }));
          setSelected((s) => (s ? { ...s, size: res.value.bytes } : s));
          setEditing(false);
          setSaveMsg({ kind: "ok", text: "已保存" });
          void fetchChildren(parentOf(selected.path)); // 刷新所在目录的大小/时间
        } catch (error) {
          setSaveMsg({ kind: "err", text: `保存失败：${String(error?.message ?? error)}` });
        } finally {
          setSaving(false);
        }
      };

      const formatJson = () => {
        try {
          setDraft(JSON.stringify(JSON.parse(draft), null, 2));
          setSaveMsg(null);
        } catch (error) {
          setSaveMsg({ kind: "err", text: `JSON 解析失败：${String(error?.message ?? error)}` });
        }
      };

      // 保存成功提示 2.5s 后自动消失
      useEffect(() => {
        if (saveMsg?.kind !== "ok") return undefined;
        const t = setTimeout(() => setSaveMsg(null), 2500);
        return () => clearTimeout(t);
      }, [saveMsg]);

      // ── 树文件操作：重命名 / 删除 ──

      const submitRename = async (entry, rawName) => {
        const newName = rawName.trim();
        setRenaming(null);
        if (!newName || newName === entry.name) return;
        const parent = parentOf(entry.path);
        try {
          const res = await rpc.call("/dsh-workspace-preview", "rename", { path: entry.path, newName });
          if (!res.ok) throw new Error(res.error?.message ?? "rename failed");
          const newPath = res.value.path;
          if (entry.kind === "dir") {
            // 目录改名：前缀改写展开集合，丢弃旧路径下的缓存并重新拉取
            const underOld = (p) => p === entry.path || p.startsWith(entry.path + "/");
            const remap = (p) => (underOld(p) ? newPath + p.slice(entry.path.length) : p);
            setExpanded((prev) => new Set([...prev].map(remap)));
            setChildren((prev) => {
              const n = new Map();
              for (const [k, v] of prev) if (!underOld(k)) n.set(k, v);
              return n;
            });
            if (selected && underOld(selected.path)) {
              if (!confirmDiscard()) return; // 取消则整个重命名不执行
              closePreview();
            }
            for (const d of [...expanded].map(remap)) {
              if (d === newPath || d.startsWith(newPath + "/")) void fetchChildren(d);
            }
          } else if (selected?.path === entry.path) {
            if (editing) {
              // 内容未变：保留草稿与编辑态，仅让预览跟随新路径（避免静默丢改动）
              setSelected((s) => (s ? { ...s, path: newPath, name: newName, ext: extOf(newName) } : s));
            } else {
              openFile({ path: newPath, name: newName, size: selected.size }); // 预览跟随新路径
            }
          }
          await fetchChildren(parent);
        } catch (error) {
          setErrors((prev) => new Map(prev).set(parent, String(error?.message ?? error)));
        }
      };

      const doRemove = async (entry) => {
        setConfirmDel(null);
        const parent = parentOf(entry.path);
        // 删除会连带关闭正在编辑的预览：有脏草稿时先确认，取消则放弃删除
        if (selected &&
            (selected.path === entry.path || selected.path.startsWith(entry.path + "/")) &&
            !confirmDiscard()) {
          return;
        }
        try {
          const res = await rpc.call("/dsh-workspace-preview", "remove", { path: entry.path });
          if (!res.ok) throw new Error(res.error?.message ?? "remove failed");
          if (selected && (selected.path === entry.path || selected.path.startsWith(entry.path + "/"))) closePreview();
          await fetchChildren(parent);
        } catch (error) {
          setErrors((prev) => new Map(prev).set(parent, String(error?.message ?? error)));
        }
      };

      // Shift the app frame left so the docks become real columns.
      const rootRef = useRef(null);
      const previewOpen = selected !== null;
      const dockWidth = (treeOpen ? treeWidth : 0) + (previewOpen ? previewWidth : 0);
      useLayoutEffect(() => {
        const overlay = rootRef.current?.closest("[data-shell-overlay]");
        const frame = overlay?.parentElement;
        if (!frame) return;
        if (dockWidth > 0) {
          frame.style.paddingRight = `${dockWidth}px`;
          frame.style.transition = "grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out), padding-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)";
        } else {
          frame.style.paddingRight = "";
          frame.style.transition = "";
        }
        return () => {
          frame.style.paddingRight = "";
          frame.style.transition = "";
        };
      }, [dockWidth]);

      // Drag-to-resize for right-docked panels (drag left => wider).
      function resizeHandlers(getWidth, setWidth, min, max) {
        const drag = useRef({ active: false, x0: 0, w0: 0 });
        return {
          onPointerDown: (e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { active: true, x0: e.clientX, w0: getWidth() };
            setDragging(true);
          },
          onPointerMove: (e) => {
            const d = drag.current;
            if (!d.active) return;
            setWidth(clamp(d.w0 + (d.x0 - e.clientX), min, max));
          },
          onPointerUp: () => { drag.current.active = false; setDragging(false); },
          onPointerCancel: () => { drag.current.active = false; setDragging(false); },
        };
      }

      const treeResize = resizeHandlers(() => treeWidth, setTreeWidth, TREE_MIN, TREE_MAX);
      const previewResize = resizeHandlers(() => previewWidth, setPreviewWidth, PREVIEW_MIN, PREVIEW_MAX);

      // ── tree body ─────────────────────────────────────────────────────────

      const renderNode = (entry, depth) => {
        const isDir = entry.kind === "dir";
        const isExpanded = expanded.has(entry.path);
        const kids = children.get(entry.path);
        const isLoading = loading.has(entry.path);
        const err = errors.get(entry.path);
        const isSel = selected?.path === entry.path;
        const isRenaming = renaming === entry.path;
        const isConfirming = confirmDel === entry.path;
        // 名称区：普通态 / 重命名输入框 / 删除两段确认
        let nameZone;
        if (isRenaming) {
          nameZone = el("input", {
            className: "fx-rename",
            defaultValue: entry.name,
            spellCheck: false,
            ref: (node) => {
              if (!node) return;
              node.focus();
              const dot = isDir ? -1 : entry.name.lastIndexOf(".");
              node.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
            },
            onClick: (e) => e.stopPropagation(),
            onKeyDown: (e) => {
              e.stopPropagation();
              if (e.key === "Enter") void submitRename(entry, e.currentTarget.value);
              else if (e.key === "Escape") setRenaming(null);
            },
            onBlur: () => setRenaming(null), // Enter/Esc 已处理；点击他处视为取消
          });
        } else if (isConfirming) {
          nameZone = el(React.Fragment, null,
            el("span", { className: "fx-confirm-text", title: entry.name },
              isDir ? `删除目录及全部内容？` : `确认删除 ${entry.name}？`),
            el("button", {
              type: "button", className: "fx-mini-btn fx-mini-danger",
              onClick: (e) => { e.stopPropagation(); void doRemove(entry); },
            }, "删除"),
            el("button", {
              type: "button", className: "fx-mini-btn",
              onClick: (e) => { e.stopPropagation(); setConfirmDel(null); },
            }, "取消"),
          );
        } else {
          nameZone = el(React.Fragment, null,
            el("span", {
              className: "fx-name" + (entry.broken ? " fx-name-broken" : ""),
              title: entry.isSymlink ? (entry.broken ? "失效的符号链接" : "符号链接") : undefined,
            }, entry.name),
            entry.isSymlink ? el("span", { className: "fx-symlink" }, "↳") : null,
            !isDir && entry.size != null ? el("span", { className: "fx-size" }, fmtSize(entry.size)) : null,
            el("span", { className: "fx-row-actions" },
              el(IconButton, {
                title: "重命名", icon: EditIcon,
                onClick: (e) => { e.stopPropagation(); setRenaming(entry.path); setConfirmDel(null); },
              }),
              el(IconButton, {
                title: isDir ? "删除目录（含全部内容）" : "删除文件", icon: TrashIcon,
                onClick: (e) => { e.stopPropagation(); setConfirmDel(entry.path); setRenaming(null); },
              })),
          );
        }
        const row = el("div", {
          key: entry.path,
          className: "fx-row" + (isSel ? " fx-row-sel" : ""),
          style: { paddingLeft: 8 + depth * 14 },
          title: entry.path,
          onClick: (e) => {
            e.stopPropagation();
            if (isRenaming || isConfirming) return;
            if (isDir) toggleDir(entry.path);
            else openFile(entry);
          },
        },
          isDir
            ? (isLoading
                ? el("span", { className: "fx-chev" }, el("span", { className: "fx-spin", style: { width: 10, height: 10 } }))
                : el("span", { className: "fx-chev" }, el(ChevronIcon, { className: "fx-chevron" + (isExpanded ? " fx-rotated" : "") })))
            : el("span", { className: "fx-chev fx-chev-leaf" }),
          el(isDir ? FolderIcon : FileIcon, { className: "fx-ico" + (isDir ? " fx-ico-folder" : "") }),
          nameZone,
          err ? el("span", { className: "fx-err-dot", title: err }) : null,
        );
        if (!isDir || !isExpanded) return row;
        const inner = [];
        if (err) inner.push(el("div", { key: "err", className: "fx-row fx-dim", style: { paddingLeft: 22 + depth * 14 } }, err));
        else if (kids === undefined) inner.push(el("div", { key: "load", className: "fx-row fx-dim", style: { paddingLeft: 22 + depth * 14 } }, "加载中…"));
        else if (kids.length === 0) inner.push(el("div", { key: "empty", className: "fx-row fx-dim", style: { paddingLeft: 22 + depth * 14 } }, "空文件夹"));
        else for (const kid of kids) {
          if (!showHidden && kid.hidden) continue;
          inner.push(renderNode(kid, depth + 1));
        }
        return el(React.Fragment, { key: entry.path }, [row, ...inner]);
      };

      const rootKids = rootPath ? (children.get(rootPath) ?? []) : [];

      // 树体内容：搜索结果 / 空态 / 目录树
      let bodyContent;
      if (searchRes !== null) {
        bodyContent = el("div", { className: "fx-treebody fx-scroll" },
          searchRes.error
            ? el("div", { className: "fx-row fx-dim" }, searchRes.error)
            : searchRes.results.length === 0 && !searching
              ? el("div", { className: "fx-row fx-dim" }, "无匹配文件")
              : searchRes.results.map((r) => el("div", {
                  key: r.path,
                  className: "fx-row",
                  style: { paddingLeft: 10 },
                  title: r.path,
                  onClick: () => {
                    if (r.kind === "dir") revealDir(r.path);
                    else openFile(r);
                  },
                },
                  el(r.kind === "dir" ? FolderIcon : FileIcon, { className: "fx-ico" + (r.kind === "dir" ? " fx-ico-folder" : "") }),
                  el("span", { className: "fx-name" }, r.name),
                  el("span", { className: "fx-dim", style: { flex: "none", fontSize: 11 } },
                    rootPath && r.path.startsWith(rootPath + "/")
                      ? parentOf(r.path).slice(rootPath.length + 1)
                      : "")),
              ),
          searchRes.truncated
            ? el("div", { className: "fx-row fx-dim" }, "结果过多，仅显示前 500 条")
            : null,
          searching
            ? el("div", { className: "fx-row fx-dim" }, "搜索中…")
            : null,
        );
      } else if (!rootPath) {
        bodyContent = el("div", { className: "fx-empty" },
          el(FolderIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
          el("span", null, "暂无工作区"),
          el("span", { className: "fx-dim" }, "在左侧边栏选择或创建一个工作区"));
      } else if (rootKids.length === 0 && !loading.has(rootPath) && errors.has(rootPath)) {
        bodyContent = el("div", { className: "fx-empty" },
          el(CloseIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
          el("span", null, "无法读取目录"),
          el("span", { className: "fx-dim" }, errors.get(rootPath)));
      } else {
        bodyContent = el("div", { className: "fx-treebody fx-scroll" },
          rootKids.filter((k) => showHidden || !k.hidden).map((kid) => renderNode(kid, 0)),
          rootKids.length === 0 && !loading.has(rootPath) && !errors.has(rootPath)
            ? el("div", { className: "fx-row fx-dim" }, "空文件夹")
            : null,
          loading.has(rootPath) && rootKids.length === 0
            ? el("div", { className: "fx-row fx-dim" }, "加载中…")
            : null,
        );
      }

      // ── preview body ──────────────────────────────────────────────────────

      let previewBody;
      if (!selected) {
        previewBody = el("div", { className: "fx-empty" },
          el(CodeIcon, { className: "fx-notice-ico" }),
          el("span", null, "点击左侧目录树中的文件进行预览"));
      } else if (preview.phase === "loading") {
        previewBody = el("div", { className: "fx-empty" }, el("span", { className: "fx-spin" }), el("span", null, "读取中…"));
      } else if (preview.phase === "error") {
        previewBody = el("div", { className: "fx-notice" },
          el(CloseIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
          el("span", null, "预览失败"),
          el("span", { className: "fx-dim" }, preview.message));
      } else if (editing && canEdit) {
        // 编辑态：CodeMirror（懒 chunk），文档变化同步 draft；⌘/Ctrl+S 经
        // chunk 内 keymap 触发 saveEdit（host 仍做 mtimeMs 冲突校验 + 原子写）
        previewBody = el(CmEditor, {
          key: `${selected.path}::${editSeq}`,
          doc: preview.data.text,
          ext: selected.ext,
          onDocChange: setDraft,
          onSave: () => void saveEdit(),
        });
      } else {
        const kind = preview.kind;
        if (kind === "html") {
          // HTML：沙箱 iframe 直连路由（双边界：路由 CSP 头 + iframe sandbox=""）
          previewBody = el(MemoHtmlView, { key: selected.path, url: preview.url });
        } else if (kind === "media") {
          previewBody = el(MemoImageView, { key: selected.path, url: preview.url, name: selected.name });
        } else if (kind === "markdown") {
          // Markdown：GFM 渲染；内嵌图片已是 /media 绝对 URL
          previewBody = el(MemoMdView, {
            key: selected.path,
            text: preview.data.text,
            dir: parentOf(selected.path),
            truncated: preview.data.truncated,
          });
        } else if (kind === "code") {
          previewBody = el(MemoCodeView, { key: selected.path, text: preview.data.text, ext: preview.ext, truncated: preview.data.truncated });
        } else if (kind === "office") {
          // Office：数据由 host 解析，渲染组件在懒 chunk 中按需加载
          previewBody = el(MemoOfficeView, { key: selected.path, data: preview.data });
        } else {
          // binary / too-large / too-large-media / legacy-office
          const data = preview.data ?? {};
          const size = preview.size ?? data.size;
          const label = kind === "too-large" || kind === "too-large-media"
            ? `文件过大（${fmtSize(size)}），无法内联预览`
            : data.hint === "legacy-office"
              ? `旧版 Office 格式（.${data.ext}）暂不支持预览，请另存为 .docx/.xlsx/.pptx 后再试`
              : `二进制文件（${fmtSize(size)}），无法内联预览`;
          previewBody = el("div", { className: "fx-notice" },
            (kind === "too-large" || kind === "too-large-media") ? el(CodeIcon, { className: "fx-notice-ico" }) : el(ImageIcon, { className: "fx-notice-ico" }),
            el("span", null, label),
            el(IconButton, { title: "用默认程序打开", onClick: () => void openPath(selected.path), icon: ExternalIcon }));
        }
      }

      // ── assemble ──────────────────────────────────────────────────────────

      const hideButton = el(IconButton, { title: "隐藏边栏", onClick: () => setTreeOpen(false), icon: DoubleRightIcon });

      return el("div", { ref: rootRef, className: "fx-root" + (dragging ? " fx-dragging" : "") },
        previewOpen && el("section", {
          className: "fx-panel fx-preview",
          style: { right: treeOpen ? treeWidth : 0, width: previewWidth },
          "aria-label": "文件预览",
        },
          el("div", { className: "fx-handle", title: "拖动调整宽度", ...previewResize }),
          el("div", { className: "fx-head" },
            el(CodeIcon, { width: 16, height: 16, className: "fx-head-ico" }),
            el("span", { className: "fx-title" }, selected.name),
            editing && dirty ? el("span", { className: "fx-dirty", title: "有未保存的修改" }, "●") : null,
            selected.size != null ? el("span", { className: "fx-sub" }, fmtSize(selected.size)) : null,
            el("span", { className: "fx-chip" }, langOf(selected.name)),
            el("span", { className: "fx-spacer" }),
            editing
              ? el(React.Fragment, null,
                  (selected.ext === "json" || selected.ext === "jsonc") &&
                    el(IconButton, { title: "格式化 JSON", onClick: formatJson, icon: FormatIcon }),
                  el(IconButton, { title: "保存（⌘/Ctrl+S）", onClick: () => void saveEdit(), disabled: !dirty || saving, icon: SaveIcon }),
                  el(IconButton, { title: "取消编辑", onClick: cancelEdit, icon: CloseIcon }))
              : el(React.Fragment, null,
                  canEdit && el(IconButton, { title: "编辑", onClick: startEdit, icon: EditIcon }),
                  el(IconButton, { title: "用默认程序打开", onClick: () => void openPath(selected.path), icon: ExternalIcon }),
                  el(IconButton, {
                    title: "关闭预览", icon: CloseIcon,
                    onClick: () => { if (!dirty || window.confirm("放弃未保存的修改？")) closePreview(); },
                  })),
          ),
          el("div", { className: "fx-pathbar", title: selected.path }, selected.path),
          saveMsg && el("div", { className: "fx-savebar " + (saveMsg.kind === "ok" ? "fx-savebar-ok" : "fx-savebar-err") },
            el("span", null, saveMsg.text),
            saveMsg.reload
              ? el("button", { type: "button", className: "fx-mini-btn", onClick: () => openFile(selected) }, "重新加载")
              : null),
          previewBody,
        ),
        treeOpen && el("aside", {
          className: "fx-panel fx-tree",
          style: { right: 0, width: treeWidth },
          "aria-label": "工作区文件目录",
        },
          el("div", { className: "fx-handle", title: "拖动调整宽度", ...treeResize }),
          el("div", { className: "fx-head" },
            el(FolderIcon, { width: 16, height: 16, className: "fx-head-ico" }),
            el("span", { className: "fx-title" }, "文件"),
            el("span", { className: "fx-spacer" }),
            el(IconButton, { title: "搜索文件", active: searchOpen, onClick: searchOpen ? closeSearch : openSearch, icon: SearchIcon }),
            el(IconButton, { title: showHidden ? "隐藏隐藏文件" : "显示隐藏文件", active: showHidden, onClick: () => setShowHidden((v) => !v), icon: showHidden ? EyeIcon : EyeOffIcon }),
            el(IconButton, { title: "刷新", onClick: refreshAll, icon: RefreshIcon }),
            hideButton,
          ),
          wsItems.length > 0 && el("select", {
            className: "fx-select",
            value: wsOverrideId ?? "",
            title: activeWs?.path ?? "",
            onChange: (e) => setWsOverrideId(e.target.value || null),
          },
            el("option", { value: "" }, "跟随左侧会话"),
            ...wsItems.map((w) => el("option", { key: w.workspaceId, value: w.workspaceId }, w.title)),
          ),
          searchOpen && el("div", { className: "fx-searchbar" },
            el("input", {
              className: "fx-search",
              placeholder: "按文件名搜索…",
              autoFocus: true,
              value: searchQuery,
              spellCheck: false,
              onChange: (e) => setSearchQuery(e.target.value),
              onKeyDown: (e) => {
                e.stopPropagation();
                if (e.key === "Escape") closeSearch();
              },
            })),
          activeWs && !searchOpen && el("div", { className: "fx-pathbar", title: activeWs.path }, activeWs.path),
          bodyContent,
        ),
        // 树收起时右缘悬浮条；预览打开时让开预览面板宽度，避免盖住其内容
        !treeOpen && el("div", { className: "fx-rail", style: { right: previewOpen ? previewWidth : 0 }, title: "显示文件目录", onClick: () => setTreeOpen(true) },
          el(FolderIcon, { width: 18, height: 18 }),
          el("span", { className: "fx-rail-label" }, "文件"),
        ),
      );
    }

    // ── plugin body ─────────────────────────────────────────────────────────

    const inject = ["slots", "connection", "workspaces"];

    function apply(ctx) {
      return ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "dsh-workspace-preview",
        order: 100,
        label: "dsh-workspace-preview file explorer",
        inject: () => ({
          rpc: ctx.connection.rpc,
          openPath: (p) => ctx.workspaces.openPath(p),
        }),
      }, FileExplorer));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
