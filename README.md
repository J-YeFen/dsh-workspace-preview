<p align="center">
  <img src="docs/screenshot.png" alt="dsh-workspace-preview screenshot" width="880">
</p>

# dsh-workspace-preview

<p align="center">
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license"></a>
  <a href="https://badgen.net/badge/version/0.1.1/8257D0"><img src="https://badgen.net/badge/version/0.1.1/8257D0" alt="version 0.1.0"></a>
  <a href="https://badgen.net/badge/format/official%20bundle%20plugin/8257D0"><img src="https://badgen.net/badge/format/official%20bundle%20plugin/8257D0" alt="official bundle plugin"></a>
</p>

<p align="center"><strong>English</strong> | <a href="#中文">中文</a></p>

**dsh-workspace-preview** is a [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) web plugin that turns the workspace into a four-column workbench:

```
┌────────────┬────────────────┬──────────────┬──────────────┐
│  Column 1  │   Column 2     │   Column 3   │   Column 4   │
│  sessions  │  conversation  │  file preview│  file tree   │
│  (dsh core)│  (dsh core)    │  (dsh-workspace-preview)  │  (dsh-workspace-preview)  │
└────────────┴────────────────┴──────────────┴──────────────┘
```

Select a workspace in the left sidebar and column 4 shows its directory tree; click a file to preview it in column 3. The tree sidebar can be hidden (a floating rail stays at the right edge) and both columns are drag-resizable. Layout state persists in `localStorage`.

## Features

**Column 4 — workspace file tree**

- Follows the workspace selected in the left sidebar (session-aware), with an in-panel workspace switcher
- Lazy per-directory loading, dirs-first sorting, hidden-file toggle, refresh
- Hide with the `»` button; re-open from the floating rail
- Drag-resizable (200–480 px), width persisted

**Column 3 — file preview (dispatch by type)**

| Type | Preview |
|---|---|
| Code / text | dsh's own `ReadBlock` card: line numbers + **shiki syntax highlighting** (30+ languages, same extension map as dsh's built-in read tool) + copy button + expand/collapse; first 3000 lines |
| Markdown (`.md` / `.markdown` / `.mdx`) | Rendered GFM via dsh's `MarkdownText`: headings, lists, tables, links, KaTeX math; code fences highlighted |
| Images (`png jpg jpeg gif webp svg bmp ico avif`) | Inline `<img>` on a checkerboard canvas |
| Binary / oversized | Size notice + "open with default app" |

Both panels: open-in-default-app, close, drag-resize, dark/light theme via dsh design tokens.

## Install

Requirements: [dsh](https://github.com/deepseek-ai/deepseek-harness) with the `web` profile initialized.

**Option 1 — npm (after publishing, see below)**

```sh
dsh plugin --profile web add dsh-workspace-preview
```

**Option 2 — GitHub, one line (works without publishing; repo root is the package root)**

```sh
dsh plugin --profile web add "github:J-YeFen/dsh-workspace-preview"
```

**Option 3 — local checkout**

```sh
git clone https://github.com/J-YeFen/dsh-workspace-preview
cd dsh-workspace-preview
dsh plugin --profile web add .
```

Then **restart the web process** (`dsh web`) and refresh the browser tab. Verify the row landed in the composed tree with:

```sh
dsh --profile web --dump-config   # look for "== dsh-workspace-preview"
```

> No build step: the hand-written `lib/` artifacts are committed, so git/local installs work directly.

## How it works

`dsh-workspace-preview` is a dual-face **bundle plugin** in the official dsh format (`dsh.bundle.patch` + `dsh.client`):

| Half | File | Role |
|---|---|---|
| Node | `lib/index.js` | Registers the `/dsh-workspace-preview` RPC channel on the loopback web transport via `ctx.connection.rpc.handle`. Endpoints: `list` (one directory level), `read` (bounded file preview). |
| Browser | `lib/client.js` | Registers into the `shell.overlay` slot. Renders the two docked columns, shifts the app frame via `padding-right` so they behave as real columns 3/4. Reuses dsh's seeded `ReadBlock` / `MarkdownText` primitives for previews. |

All file access is fenced to **registered workspace directories** (`ctx.workspaceRegistry`): every request is `realpath`-resolved and rejected if it escapes the workspace roots. Caps: 1 MiB per file read, 256 KiB text returned, 2000 entries per listing.

## Development

```sh
node --check lib/index.js && node --check lib/client.js   # syntax
node test/smoke.mjs                                       # host RPC smoke tests
```

Layout: `lib/index.js` (node half) · `lib/client.js` (browser bundle) · `cordis.patch.yml` (bundle patch row) · `test/smoke.mjs`.

## Publishing

### 1. npm

```sh
npm login
npm publish --access public
```

The name `dsh-workspace-preview` is available on the public registry (verified at publish time); users install with:

```sh
dsh plugin --profile web add dsh-workspace-preview
```

### 2. GitHub

Push this repo; users install straight from GitHub (Option 2 above). `docs/screenshot.png` is referenced by this README — keep it in the repo.

### 3. Community registries / lists

`dsh-workspace-preview` follows the official bundle-plugin format ([plugin-registry](https://github.com/vlln/plugin-registry) spec: `dsh.bundle.patch` + `exports["./client"]`, zero `@deepseek-ai/*` runtime dependencies, committed artifacts). Submit it to:

- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) — the curated dsh plugin list (see its `contributing.md`)
- [vlln/plugin-registry](https://github.com/vlln/plugin-registry) — ecosystem console & spec

## Troubleshooting

- **Nothing appears after install** — the web host must be restarted (`dsh web`), then refresh the tab. Bundle rows join the layer stack at boot.
- **Tree shows "暂无工作区"** — select or create a workspace in the left sidebar; the panel follows the current session's workspace.
- **Preview fails with "读取失败"** — the path is outside a registered workspace, or the file is unreadable.
- **Changed the plugin source** — re-run `dsh plugin --profile web add <path>` (artifacts are committed), restart web, refresh.

## License

[MIT](LICENSE) © dsh-workspace-preview contributors

---

## 中文

**dsh-workspace-preview** 是 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Web 插件：在原有布局右侧新增两列，构成 4 列工作台 —— 第 1、2 列为 dsh 原有（会话边栏 + 对话），第 3 列为**文件预览**（代码 shiki 高亮 / Markdown 渲染 / 图片内联显示），第 4 列为**工作区文件目录树**（跟随左侧工作区、懒加载、可隐藏、可拖宽）。布局状态持久化于 `localStorage`（`dsh.workspacePreview.*`）。

安装（三选一，均可直接复制执行）：

```sh
dsh plugin --profile web add dsh-workspace-preview                     # npm
dsh plugin --profile web add "github:J-YeFen/dsh-workspace-preview"  # GitHub 一行安装
cd dsh-workspace-preview && dsh plugin --profile web add .             # 本地目录
```

安装后**重启 web 进程**（`dsh web`）并刷新页面即可生效；用 `dsh --profile web --dump-config` 可看到 `== dsh-workspace-preview` 行进入组合树。仓库已提交 `lib/` 构建产物，无需本地构建。

架构：双面 bundle 插件（官方格式 `dsh.bundle` + `dsh.client`）。Node 半边经 `ctx.connection.rpc.handle('/dsh-workspace-preview')` 提供 `list` / `read` 两个 RPC 端点，所有路径被 `ctx.workspaceRegistry` 围栏在工作区之内（单文件 1 MiB、文本 256 KiB、目录 2000 条上限）；浏览器半边注册进 `shell.overlay` 槽位，复用 dsh 自带的 `ReadBlock`（行号 + 高亮 + 复制）与 `MarkdownText`（GFM 渲染）渲染预览。

发布：`dsh-workspace-preview` 在 npm 上可用（已验证），`npm login` 后直接 `npm publish --access public` 即可，用户用 `dsh plugin --profile web add dsh-workspace-preview` 安装；或直接推 GitHub 供一行安装。插件符合官方 bundle 格式规范，可提交至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表与 [vlln/plugin-registry](https://github.com/vlln/plugin-registry) 生态。
