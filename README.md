<p align="center">
  <img src="docs/screenshot.png" alt="dsh-workspace-preview screenshot" width="880">
</p>

# dsh-workspace-preview

<p align="center">
  <a href="https://badgen.net/badge/license/MIT/green"><img src="https://badgen.net/badge/license/MIT/green" alt="license"></a>
  <a href="https://badgen.net/badge/version/0.2.2/8257D0"><img src="https://badgen.net/badge/version/0.2.2/8257D0" alt="version 0.2.2"></a>
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
- Hover any row for inline file operations: **rename** (Enter to commit, Esc/blur cancels) and **delete** (two-step inline confirm; directories are removed recursively)
- Hide with the `»` button; re-open from the floating rail
- Drag-resizable (200–480 px), width persisted

**Column 3 — file preview (dispatch by type)**

| Type | Preview |
|---|---|
| Code / text | dsh's own `ReadBlock` card: line numbers + **shiki syntax highlighting** (30+ languages, same extension map as dsh's built-in read tool) + copy button + expand/collapse; first 3000 lines |
| Markdown (`.md` / `.markdown` / `.mdx`) | Rendered GFM via dsh's `MarkdownText`: headings, lists, tables, links, KaTeX math; code fences highlighted |
| HTML (`.html` / `.htm` / `.xhtml`) | Rendered page inside a **sandboxed iframe** (`sandbox=""`: scripts, forms, same-origin access, popups and top navigation all disabled; `referrerPolicy="no-referrer"`) — workspace HTML can never execute in the host page |
| Images (`png jpg jpeg gif webp svg bmp ico avif`) | Inline `<img>` on a checkerboard canvas |
| Word `.docx` | Structured preview: headings, paragraphs and tables, extracted host-side from the OOXML package |
| Excel `.xlsx` | Sheet tabs + scrollable grid (shared strings / inline strings / numbers; ≤8 sheets, ≤500×100 cells each) |
| PowerPoint `.pptx` | Slide cards in presentation order with per-paragraph text lines |
| Legacy Office (`.doc/.xls/.ppt`) | Notice suggesting re-save as OOXML |
| Binary / oversized | Size notice + "open with default app" |

**Editing (text, code, JSON)**

- Any fully-loaded text file gets an **编辑/Edit** button: the preview swaps to a monospace editor with a dirty dot, `⌘/Ctrl+S` to save, and a JSON **format** button for `.json`/`.jsonc`
- Saves are conflict-safe: the host refuses the write when the file changed on disk since you opened it (offers a reload instead of clobbering)
- Truncated files (>256 KiB shown) are read-only so a partial buffer can never overwrite the full file

Both panels: open-in-default-app, close, drag-resize, dark/light theme via dsh design tokens.

## Usage

- **Browse** — column 4 follows the workspace of the current session; use the in-panel selector to pin a different workspace. Click a directory to expand it lazily, toggle dotfiles with the eye button, and refresh with the ⟳ button.
- **Preview** — click a file: code/text renders with shiki highlighting, Markdown rendered, images inline, HTML pages rendered in a sandboxed iframe, Office documents structured. Drag a panel's left edge to resize it; the `»` button hides the tree (re-open from the floating rail).
- **Edit** — with a text file open, click the pencil button (编辑). The editor shows a `●` dot while dirty; save with `⌘/Ctrl+S` or the save button, cancel with × (a confirmation guards unsaved changes). For `.json` / `.jsonc` the `{}` button pretty-prints the buffer. If the file changed on disk since you opened it, the save is refused with a conflict notice — click 重新加载 to pick up the new content.
- **Rename** — hover a tree row and click the pencil: edit the name inline, Enter commits, Esc (or clicking away) cancels. Renaming a file that is open moves the preview along; renaming a directory re-roots its expanded children.
- **Delete** — hover a row and click the trash button, then confirm inline. Directories are deleted **recursively** (the confirm row says so). The workspace root itself can never be renamed or deleted. There is no undo — deleted files do not go to a trash bin.

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

**Local development install (file: link)** — when you install from a local path, `dsh plugin` creates a **symlink** at `~/.dsh/profiles/web/node_modules/dsh-workspace-preview` pointing at that directory, so "installed version == folder version" always holds. After editing the source there is **no re-install needed**: restart `dsh web` and refresh the tab (re-run `dsh plugin --profile web add <path>` only if the link broke). To verify the installed copy matches the folder:

```sh
dsh plugin --profile web list                     # expect dsh-workspace-preview@file:<abs path>
node -p "require('$HOME/.dsh/profiles/web/node_modules/dsh-workspace-preview/package.json').version"
node -p "require('$(pwd)/package.json').version"  # run inside the repo; both lines must match
```

## How it works

`dsh-workspace-preview` is a dual-face **bundle plugin** in the official dsh format (`dsh.bundle.patch` + `dsh.client`):

| Half | File | Role |
|---|---|---|
| Node | `lib/index.js` | Registers the `/dsh-workspace-preview` RPC channel on the loopback web transport via `ctx.connection.rpc.handle`. Endpoints: `list` (one directory level), `read` (bounded file preview), `write` (conflict-safe text overwrite), `rename`, `remove`. OOXML extraction lives in `lib/office.js` (zero-dependency mini unzip + XML scan). |
| Browser | `lib/client.js` | Registers into the `shell.overlay` slot. Renders the two docked columns, shifts the app frame via `padding-right` so they behave as real columns 3/4. Reuses dsh's seeded `ReadBlock` / `MarkdownText` primitives for previews. |

All file access is fenced to **registered workspace directories** (`ctx.workspaceRegistry`): every request is `realpath`-resolved and rejected if it escapes the workspace roots. Caps: 1 MiB per file read/write, 256 KiB text returned, 2000 entries per listing. Mutating endpoints add their own guards: `write` checks the client-supplied `mtimeMs` and fails with `conflict` on a stale copy, `rename` refuses existing targets, and `remove`/`rename` never touch a workspace root.

## Development

```sh
node --check lib/index.js && node --check lib/client.js   # syntax
node test/smoke.mjs                                       # host RPC smoke tests
```

Layout: `lib/index.js` (node half) · `lib/client.js` (browser bundle) · `cordis.patch.yml` (bundle patch row) · `test/smoke.mjs`.

## Publishing

1. **Bump the version** — increment `version` in `package.json` (semver, e.g. 0.2.0 → 0.2.1) and sync the version badge at the top of this README.
2. **Regression checks** — `node --check lib/index.js && node --check lib/client.js && node --check lib/office.js` and `node test/smoke.mjs` must all pass (the smoke suite covers the five RPC endpoints, OOXML extraction, and fence/truncation regressions).
3. **Commit and tag** — `git add -A && git commit`, then:

```sh
git tag v0.2.1 && git push origin main --tags
```

### 1. npm

```sh
npm login
npm publish --access public
```

`files` in `package.json` already limits the tarball to `lib/` + `cordis.patch.yml` (zero dependencies, no build step). After publishing, users install with:

```sh
dsh plugin --profile web add dsh-workspace-preview
```

### 2. GitHub

Push this repo; users install straight from GitHub (Option 2 above). `docs/screenshot.png` is referenced by this README — keep it in the repo.

### 3. Local (file:) installs

A local `file:` install follows the folder automatically — no publish action is required; restart `dsh web` and refresh.

### 4. Community registries / lists

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

**dsh-workspace-preview** 是 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Web 插件：在原有布局右侧新增两列，构成 4 列工作台 —— 第 1、2 列为 dsh 原有（会话边栏 + 对话），第 3 列为**文件预览**（代码 shiki 高亮 / Markdown 渲染 / HTML 沙箱渲染 / 图片内联显示 / Word·Excel·PPT 结构化预览），第 4 列为**工作区文件目录树**（跟随左侧工作区、懒加载、可隐藏、可拖宽、行内重命名与删除）。布局状态持久化于 `localStorage`（`dsh.workspacePreview.*`）。

0.2.2 新增：

- **HTML 渲染预览**：`.html` / `.htm` / `.xhtml` 文件在**沙箱 iframe**（`sandbox=""`：脚本、表单、同源访问、弹窗与顶层导航全部禁用；`referrerPolicy="no-referrer"`）中渲染为页面，工作区内的 HTML 永远不会在宿主页面上下文执行任意脚本；截断文件只读并提示。

0.2.1 修复：

- 编辑中的文件被**点击其他文件 / 删除 / 重命名目录**时不再静默丢弃未保存修改（弹确认框；重命名正在编辑的文件会保留草稿并跟随新路径）。
- 目录树收起后，右缘悬浮条不再盖住预览面板（预览打开时悬浮条让开其宽度）。
- host 端工作区围栏把注册的根路径也做 `realpath` 规范化后再比较：即使注册的是符号链接路径（如 macOS 的 `/tmp` → `/private/tmp`），工作区也照常可用；目录恰好 2000 项时不再误报 `truncated`。

0.2.0 新增：

- **编辑保存**：完整加载的文本/代码文件可一键进入编辑（等宽编辑器、脏标记、`⌘/Ctrl+S` 保存、`.json` 格式化）；保存携带读取时的 `mtimeMs`，文件被外部改动则拒绝写入（`conflict`）并提供重新加载，截断文件只读。
- **Office 预览**：`.docx`（标题/段落/表格）、`.xlsx`（多 sheet 页签 + 表格，≤8 sheet、500×100 上限）、`.pptx`（按顺序的幻灯片文本卡片）——host 端零依赖解 zip + XML 扫描（`lib/office.js`）；旧版 `.doc/.xls/.ppt`（OLE2）提示另存为新格式。
- **文件操作**：目录树行 hover 出现重命名（Enter 提交 / Esc 取消）与删除（两段行内确认，目录递归删除）按钮；重命名拒绝覆盖同名目标，工作区根目录不可改名/删除。

使用说明：

- **浏览**：第 4 列目录树跟随当前会话的工作区，也可用面板内下拉固定到其他工作区；点击目录懒加载展开，眼睛按钮切换隐藏文件，⟳ 刷新。
- **预览**：点击文件——代码/文本走 shiki 高亮卡片，Markdown 渲染，HTML 在沙箱 iframe 中渲染为页面，图片内联，Office 文档结构化展示。拖动面板左缘调宽，`»` 收起目录树（右缘悬浮条可重新展开）。
- **编辑**：打开文本文件后点铅笔按钮进入编辑；有未保存修改时标题旁显示 `●`，`⌘/Ctrl+S` 或保存按钮落盘，× 取消（有脏内容会先确认）；`.json` / `.jsonc` 可用 `{}` 按钮格式化。若文件在打开后被外部修改，保存会被拒绝（冲突提示），点「重新加载」获取新内容。
- **重命名**：hover 目录树某行 → 铅笔按钮 → 行内编辑名称，Enter 提交、Esc（或点击他处）取消。重命名正在预览的文件会让预览跟随新路径；重命名目录会重建其展开子树。
- **删除**：hover 某行 → 垃圾桶按钮 → 行内二次确认。目录**连同全部内容递归删除**（确认行有提示）。工作区根目录永远不可改名/删除；删除不进回收站，**无法撤销**。

安装（三选一，均可直接复制执行）：

```sh
dsh plugin --profile web add dsh-workspace-preview                     # npm
dsh plugin --profile web add "github:J-YeFen/dsh-workspace-preview"  # GitHub 一行安装
cd dsh-workspace-preview && dsh plugin --profile web add .             # 本地目录
```

安装后**重启 web 进程**（`dsh web`）并刷新页面即可生效；用 `dsh --profile web --dump-config` 可看到 `== dsh-workspace-preview` 行进入组合树。仓库已提交 `lib/` 构建产物，无需本地构建。

**本机开发安装（file: 链接）**：在本机用本地路径安装时，`dsh plugin` 会在 `~/.dsh/profiles/web/node_modules/dsh-workspace-preview` 建立指向该目录的**符号链接**，即「已安装版本 == 文件夹版本」恒成立。因此改完源码**无需重新安装**——重启 `dsh web` 并刷新页面即可生效；链接若失效，重跑一次 `dsh plugin --profile web add <路径>` 即可。验证已装版本与文件夹一致：

```sh
dsh plugin --profile web list                     # 应显示 dsh-workspace-preview@file:<绝对路径>
node -p "require('$HOME/.dsh/profiles/web/node_modules/dsh-workspace-preview/package.json').version"
node -p "require('$(pwd)/package.json').version"  # 在仓库目录下执行，两行输出应一致
```

架构：双面 bundle 插件（官方格式 `dsh.bundle` + `dsh.client`）。Node 半边经 `ctx.connection.rpc.handle('/dsh-workspace-preview')` 提供 `list` / `read` / `write` / `rename` / `remove` 五个 RPC 端点（Office 解析在 `lib/office.js`），所有路径被 `ctx.workspaceRegistry` 围栏在工作区之内（单文件读写 1 MiB、文本 256 KiB、目录 2000 条上限；`write` 校验 `mtimeMs` 防冲突覆盖，`rename` 拒绝同名目标，`remove`/`rename` 不可作用于工作区根）；浏览器半边注册进 `shell.overlay` 槽位，复用 dsh 自带的 `ReadBlock`（行号 + 高亮 + 复制）与 `MarkdownText`（GFM 渲染）渲染预览。

发布步骤：

1. **提升版本**：在 `package.json` 里递增 `version`（0.2.0 → 0.2.1 这种语义化版本），并同步更新本 README 顶部的版本徽标。
2. **回归检查**：`node --check lib/index.js && node --check lib/client.js && node --check lib/office.js` 与 `node test/smoke.mjs` 全部通过（冒烟测试覆盖 RPC 五端点、OOXML 提取与围栏/截断回归）。
3. **提交并打标签**：`git add -A && git commit`，然后 `git tag v<版本号> && git push origin main --tags`。
4. **npm 发布**：`npm login` 后执行 `npm publish --access public`（`files` 已限定为 `lib/` 与 `cordis.patch.yml`，零依赖、零构建）；发布后用户即可用 `dsh plugin --profile web add dsh-workspace-preview` 安装。
5. **GitHub 推送**：push 仓库即可让「GitHub 一行安装」指向最新提交（无需发布 npm）。注意 `docs/screenshot.png` 被本 README 引用，需保留在仓库中。
6. **本机验证**：本机若是 file: 链接安装，文件夹版本即已装版本，无需任何发布动作——重启 `dsh web` 并刷新即可。
7. **社区收录**（可选）：插件符合官方 bundle 格式规范，可提交至 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表与 [vlln/plugin-registry](https://github.com/vlln/plugin-registry) 生态。
