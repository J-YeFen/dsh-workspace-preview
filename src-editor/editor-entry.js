/**
 * CodeMirror 6 editor chunk — build-time entry (方案 A).
 *
 * This file is NOT shipped. It is bundled ONCE at dev time by
 * scripts/build-editor.mjs (esbuild) into the committed artifact
 * lib/client-chunk-editor.js, which the plugin's host serves at
 * /dsh-workspace-preview/bundle/editor.js. Runtime stays zero-dependency:
 * consumers never install the CodeMirror packages listed in devDependencies.
 *
 * Chunk contract (mirrors lib/client-chunk-office.js): the bundled script
 * registers `globalThis.__dshChunks__["editor"] = (require) => exports`;
 * the main client injects the script and calls the factory. The factory
 * ignores the require (no externals needed — react is not imported here;
 * this chunk exposes an imperative API that the React wrapper in
 * lib/client.js drives).
 *
 * Exports: createEditor({ parent, doc, language, theme?, onChange?, onSave? })
 *   -> { destroy(), focus(), getDoc(): string }
 */
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";

/** 扩展名 → CodeMirror language 扩展构造器（与主客户端 LANG_BY_EXTENSION 对齐的子集）。 */
const LANGUAGE_BY_EXT = {
  // JS/TS
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript({ jsx: true }),
  cjs: () => javascript({ jsx: true }),
  ts: () => javascript({ jsx: true, typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  mts: () => javascript({ jsx: true, typescript: true }),
  cts: () => javascript({ jsx: true, typescript: true }),
  // 数据/标记
  json: () => json(),
  jsonc: () => json(),
  yaml: () => yaml(),
  yml: () => yaml(),
  html: () => html(),
  htm: () => html(),
  xml: () => xml(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  md: () => markdown(),
  markdown: () => markdown(),
  // 后端/系统
  py: () => python(),
  go: () => go(),
  rs: () => rust(),
  java: () => java(),
  c: () => cpp(),
  h: () => cpp(),
  cc: () => cpp(),
  cpp: () => cpp(),
  hpp: () => cpp(),
  cxx: () => cpp(),
  php: () => php(),
  sql: () => sql(),
};

/** dsh 主题 token 适配（浅色/深色跟随 --dsw-alias-*）。 */
function dshTheme() {
  return EditorView.theme({
    "&": {
      backgroundColor: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "12px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.6",
    },
    ".cm-content": { padding: "12px 14px", caretColor: "var(--dsw-alias-label-primary)" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "var(--dsw-alias-bg-base)",
      color: "var(--dsw-alias-label-quaternary)",
      borderRight: "1px solid var(--dsw-alias-border-l1)",
    },
    ".cm-activeLine": { backgroundColor: "var(--dsw-alias-interactive-bg-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--dsw-alias-interactive-bg-hover-solid)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--dsw-alias-bg-layer-2)",
      border: "1px solid var(--dsw-alias-border-l2)",
      color: "var(--dsw-alias-label-primary)",
    },
    ".cm-searchMatch": { backgroundColor: "var(--dsw-alias-state-warn-tertiary)" },
    ".cm-foldGutter .cm-gutterElement": { cursor: "pointer" },
  });
}

/**
 * Create a CodeMirror editor inside `parent`.
 * @param opts.parent 挂载的 DOM 节点（将被 CM 接管）
 * @param opts.doc    初始文档
 * @param opts.language 扩展名（映射到语言包）
 * @param opts.onChange 文档变化回调（全文，供外层脏标记）
 * @param opts.onSave   ⌘/Ctrl+S 回调（由外层负责 RPC 保存）
 */
export function createEditor(opts) {
  const { parent, doc = "", language = "", onChange, onSave } = opts;
  const languageSupport =
    typeof LANGUAGE_BY_EXT[language] === "function" ? LANGUAGE_BY_EXT[language]() : undefined;

  const saveKeymap = keymap.of([
    onSave
      ? { key: "Mod-s", run: () => { onSave(); return true; } }
      : { key: "Mod-s", run: () => true }, // 吞掉默认浏览器保存
  ]);

  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      indentWithTab,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      saveKeymap,
      syntaxHighlighting(defaultHighlightStyle),
      dshTheme(),
      languageSupport ? [languageSupport] : [],
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && typeof onChange === "function") {
          onChange(update.state.doc.toString());
        }
      }),
      EditorView.editorAttributes.of({ "aria-label": "代码编辑器" }),
    ],
  });

  const view = new EditorView({ state, parent });
  view.focus();

  return {
    destroy: () => view.destroy(),
    focus: () => view.focus(),
    getDoc: () => view.state.doc.toString(),
    view,
  };
}

globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};
globalThis.__dshChunks__["editor"] = (require) => ({
  createEditor,
});
