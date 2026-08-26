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
      ".fx-pathbar{flex:none;padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-quaternary);border-bottom:1px solid var(--dsw-alias-border-l1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".fx-select{flex:none;margin:8px 10px 0;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;padding:0 8px;outline:none;max-width:calc(100% - 20px)}",
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
      ".fx-img-wrap{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px;background:repeating-conic-gradient(var(--dsw-alias-bg-layer-2) 0% 25%,var(--dsw-alias-bg-layer-1) 0% 50%) 0 0/20px 20px}",
      ".fx-img{max-width:100%;max-height:100%;box-shadow:0 2px 12px var(--dsw-alias-bg-mask-1);border-radius:4px}",
      ".fx-notice{display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;padding:32px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;flex:1;min-height:0}",
      ".fx-notice-ico{color:var(--dsw-alias-label-quaternary)}",
      ".fx-trunc-note{padding:6px 12px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);flex:none}",
      ".fx-chip{flex:none;font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
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
      eye: ["M2 10s3.5-5 8-5 8 5 8 5-3.5 5-8 5-8-5-8-5Z", "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
      eyeOff: ["M4 4l12 12", "M9.4 6.2A8.2 8.2 0 0 1 10 6c4.5 0 8 4 8 4a13 13 0 0 1-2.2 2.7", "M6.2 9.4A13.2 13.2 0 0 0 2 10s3.5 5 8 5c.6 0 1.2-.1 1.7-.2"],
      image: ["M3 4h14v12H3z", "M6.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z", "m3.5 13.5 4-4 3 3 3.5-3.5 2.5 2.5"],
      code: ["m7.5 6-4 4 4 4", "M12.5 6l4 4-4 4"],
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
    const EyeIcon = makeIcon("eye");
    const EyeOffIcon = makeIcon("eyeOff");
    const ImageIcon = makeIcon("image", 26);
    const CodeIcon = makeIcon("code", 26);

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
    const MAX_CODE_LINES = 3000;

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
      const [preview, setPreview] = useState({ phase: "idle" });

      const fetchChildren = useCallback(async (dirPath) => {
        setLoading((prev) => new Set(prev).add(dirPath));
        setErrors((prev) => { const n = new Map(prev); n.delete(dirPath); return n; });
        try {
          const res = await rpc.call("/dsh-workspace-previewspace-preview", "list", { path: dirPath });
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
        for (const dirPath of expanded) void fetchChildren(dirPath);
      };

      const readSeq = useRef(0);
      const openFile = (entry) => {
        const seq = ++readSeq.current;
        setSelected({ path: entry.path, name: entry.name, size: entry.size, ext: extOf(entry.name) });
        setPreview({ phase: "loading" });
        (async () => {
          try {
            const res = await rpc.call("/dsh-workspace-previewspace-preview", "read", { path: entry.path });
            if (seq !== readSeq.current) return;
            if (!res.ok) throw new Error(res.error?.message ?? "read failed");
            setPreview({ phase: "ready", data: res.value });
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
        const row = el("div", {
          key: entry.path,
          className: "fx-row" + (isSel ? " fx-row-sel" : ""),
          style: { paddingLeft: 8 + depth * 14 },
          title: entry.path,
          onClick: (e) => {
            e.stopPropagation();
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
          el("span", { className: "fx-name" }, entry.name),
          !isDir && entry.size != null ? el("span", { className: "fx-size" }, fmtSize(entry.size)) : null,
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

      const treeBody = !activeWs
        ? el("div", { className: "fx-empty" },
            el(FolderIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
            el("span", null, "暂无工作区"),
            el("span", { className: "fx-dim" }, "在左侧边栏选择或创建一个工作区"))
        : rootKids.length === 0 && !loading.has(rootPath) && errors.has(rootPath)
          ? el("div", { className: "fx-empty" },
              el(CloseIcon, { width: 26, height: 26, className: "fx-notice-ico" }),
              el("span", null, "无法读取目录"),
              el("span", { className: "fx-dim" }, errors.get(rootPath)))
          : el("div", { className: "fx-treebody fx-scroll" },
              rootKids.filter((k) => showHidden || !k.hidden).map((kid) => renderNode(kid, 0)),
              rootKids.length === 0 && !loading.has(rootPath) && !errors.has(rootPath)
                ? el("div", { className: "fx-row fx-dim" }, "空文件夹")
                : null,
              loading.has(rootPath) && rootKids.length === 0
                ? el("div", { className: "fx-row fx-dim" }, "加载中…")
                : null,
            );

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
      } else {
        const data = preview.data;
        if (data.kind === "text") {
          const ext = extOf(selected.name);
          if (MD_EXTS.has(ext)) {
            // Markdown：复用 dsh 的 GFM 渲染器（标题/列表/表格/代码围栏高亮/公式）。
            previewBody = el("div", { className: "fx-preview-body" },
              el("div", { className: "fx-md-scroll fx-scroll" },
                el("div", { className: "fx-md" }, el(MarkdownText, { text: data.text }))),
              data.truncated
                ? el("div", { className: "fx-trunc-note" }, "内容过长，仅渲染前 256 KiB，完整内容请用外部程序打开")
                : null,
            );
          } else {
            // 代码/文本：复用 dsh 的 read 卡片 —— 行号 + shiki 语法高亮 + 复制按钮。
            const lines = data.text.split("\n");
            const shown = lines.slice(0, MAX_CODE_LINES).map((text, i) => ({ number: i + 1, text }));
            const omitted = lines.length - shown.length;
            previewBody = el("div", { className: "fx-preview-body" },
              el("div", { className: "fx-code-scroll fx-scroll" },
                el(ReadBlock, {
                  lines: shown,
                  totalLines: lines.length,
                  lang: LANG_BY_EXTENSION[ext],
                  maxLines: Math.max(1, shown.length),
                  className: "fx-readblock",
                })),
              (data.truncated || omitted > 0)
                ? el("div", { className: "fx-trunc-note" },
                    `仅显示前 ${shown.length.toLocaleString()} 行${omitted > 0 ? `（共 ${lines.length.toLocaleString()} 行）` : ""}，完整内容请用外部程序打开`)
                : null,
            );
          }
        } else if (data.kind === "image") {
          previewBody = el("div", { className: "fx-img-wrap fx-scroll" },
            el("img", { className: "fx-img", src: `data:${data.mime};base64,${data.base64}`, alt: selected.name }));
        } else {
          const label = data.kind === "too-large"
            ? `文件过大（${fmtSize(data.size)}），无法内联预览`
            : `二进制文件（${fmtSize(data.size)}），无法内联预览`;
          previewBody = el("div", { className: "fx-notice" },
            data.kind === "too-large" ? el(CodeIcon, { className: "fx-notice-ico" }) : el(ImageIcon, { className: "fx-notice-ico" }),
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
            selected.size != null ? el("span", { className: "fx-sub" }, fmtSize(selected.size)) : null,
            el("span", { className: "fx-chip" }, langOf(selected.name)),
            el("span", { className: "fx-spacer" }),
            el(IconButton, { title: "用默认程序打开", onClick: () => void openPath(selected.path), icon: ExternalIcon }),
            el(IconButton, { title: "关闭预览", onClick: closePreview, icon: CloseIcon }),
          ),
          el("div", { className: "fx-pathbar", title: selected.path }, selected.path),
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
          activeWs && el("div", { className: "fx-pathbar", title: activeWs.path }, activeWs.path),
          treeBody,
        ),
        !treeOpen && el("div", { className: "fx-rail", title: "显示文件目录", onClick: () => setTreeOpen(true) },
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
