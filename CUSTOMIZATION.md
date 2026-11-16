# CloudCLI Web IDE 定制

运行分支：`custom/web-ide`。基于官方 v1.37.8（`2053f3d`），保留完整上游历史。

- Fork：https://github.com/stitch626-dev/cloudcli
- 上游：https://github.com/siteboon/claudecodeui
- Mac mini 源码：`/Users/robert/Desktop/code/doit/cloudcli`
- 本机维护副本：`/Users/jiangwanli/Desktop/code/doit/cloudcli`
- 网页入口：https://cloudcli-render-entry.onrender.com/

## 已实现

桌面端常驻资源管理器，可与聊天、终端、版本控制并排使用；顶部按钮可隐藏文件树，文件夹图标可以选择其他目录。手机端继续从 Files 进入。选择文件后复用现有 CodeMirror 编辑器，支持文本编辑和保存、Markdown / HTML 预览，以及图片、PDF、音视频预览。切换文件、从文件树切换项目时保留原有未保存内容确认。

文件树使用有界批量预加载和浏览器缓存，详见下方策略。树内筛选查找已预载的文件；跨项目文件搜索继续使用原有命令面板。保留原有 Git ignore 和系统目录限制。

Star、版本/更新提示、问题反馈、社区链接已从展开和折叠侧栏移除，保留 Settings。Fork 使用 Git 合并维护更新，避免网页更新操作覆盖定制代码。

首次进入默认选择已注册的 `doit` 项目。默认项目路径由构建时的 `VITE_DEFAULT_WORKSPACE_PATH` 控制；文件夹选择器仍由运行时 `WORKSPACE_BROWSE_START` 控制。

## 文件树加速与默认预览

- **批量预载**：进入工作区一次获取根目录及附近 3 层目录；深入尚未缓存的目录时，再批量取该目录周围的内容。服务端广度优先读取，最多 96 个目录、10,000 个节点、4 路目录并发，300 ms 软预算；根目录始终完整，超过预算的目录按需加载。跳过 `.git`、`node_modules` 等目录，不递归扫描整个磁盘。
- **浏览器缓存**：按用户、项目 ID 和路径隔离目录元数据，内存与当前标签页的 `sessionStorage` 共用最多 6 个项目、约 200 万字符的缓存，缓存不包含文件内容。切项目、重开文件树、刷新网页可先显示已有目录。新鲜期 30 秒，最长保留 30 分钟；退出会清理。
- **后台更新**：缓存过期后，在展开目录、重新进入工作区或窗口重新获得焦点时更新；手动刷新、新建、删除、重命名、上传、保存会触发更新，期间保留已有树。没有常驻轮询：终端或其他工具修改磁盘后，点击刷新可立即同步。浏览器最多 3 个目录请求并行；旧项目和旧刷新请求不能覆盖当前状态。
- **服务端缓存**：20 秒有效期、最多 256 个目录 / 30,000 个节点，合并相同目录的并发请求。目录修改时间、`.gitignore` 变化、文件操作及手动刷新会让缓存失效；命中缓存仍检查真实路径，防止符号链接越界。父子工作区一起失效。
- **默认预览**：`.md`、`.markdown`、`.html`、`.htm` 普通打开时显示预览；工具栏可切换源码编辑，未保存内容继续保留。点击带行号的引用或打开差异时显示源码，便于定位。
- **HTML 范围**：支持静态 HTML、内联交互、相对图片 / CSS / 普通 JS，以及 CSS 内相对图片、字体和导入。资源最多 48 个、单项 4 MiB、总计 16 MiB、4 路并发；读取过程中逐块执行体积限额，超限立即取消下载，即使响应没有 Content-Length 也有效。CSS 引用最多 3 层。使用隔离 iframe，资源从鉴权 API 获取后转换为数据，不把登录令牌传给页面。
- **HTML 边界**：内置预览不运行项目开发服务器，不支持动态 API 请求或相对 ES module 导入；`srcset` 使用备用 `src`。Vite / React 等依赖 TS、JSX 或本地模块入口的 HTML 会提示可能无法完整显示，应通过该项目自己的开发服务查看。

公网首次请求仍受 Render → Funnel → Mac mini 链路影响。此优化通过减少往返次数改善展开体验，不能消除首次联网、打开未缓存文件和保存文件的链路延迟。

## 构建与运行

Mac mini 已安装依赖，继续使用原 `com.robert.cloudcli` LaunchAgent 和原端口 3001。

```sh
cd /Users/robert/Desktop/code/doit/cloudcli
export PATH="$HOME/.local/share/cloudcli/node/bin:$PATH"
VITE_DEFAULT_WORKSPACE_PATH=/Users/robert/Desktop/code/doit npm run build
launchctl kickstart -k gui/$(id -u)/com.robert.cloudcli
```

首次部署或依赖变更时先运行 `npm ci`。运行身份、数据库、代理配置和登录文件继续保存在 Mac mini 私有运行目录 `~/.local/share/cloudcli/`，不在代码仓库内。

## 合并官方更新

`origin` 指向自己的 Fork；`upstream` 指向官方仓库。定制代码与官方主分支分开维护。

```sh
git switch custom/web-ide
git status --short
git fetch upstream
git log --oneline HEAD..upstream/main
# 确认工作区已提交后合并；有冲突则保留定制需求并手动解决。
git merge upstream/main
npm run test:client
npm run typecheck
npm run build
git push origin custom/web-ide
```

合并不会自动部署。Mac mini 更新代码后按上面的构建与运行步骤操作；Mini 上的构建需要带默认工作区环境变量。GitHub 的 Sync fork 可用于同步官方 `main`，定制运行分支仍需合并、验证后再部署。

## 验证与回滚

2026-11-16 文件树加速 / 默认预览更新（功能提交 `a6f128e`）：完整 1,165 项前端测试、35 项 File Tree 后端测试通过；前后端类型检查、Mac mini 前后端构建通过，lint 无错误（保留既有警告）。覆盖缓存隔离、并发失败、刷新/切项目竞态、隐藏面板时保存与退出、HTML 资源流式限额及默认预览切换。

本轮实测 `doit` 快照一次返回 78 个目录、457 个条目、约 105 KiB，包含 `cloudcli/src`；Mini 冷读 9–19 ms、缓存命中约 3 ms，公网两次采样约 2.3 秒和 3.1 秒。旧版依次读取根、`cloudcli`、`src` 的三个公网请求约 2.7 / 7.9 / 7.7 秒。网络存在波动，样本仅用于说明减少逐层往返的收益，不是固定时延保证。`truncated: true` 表示仍有更深目录等待按需加载，不代表返回了残缺的目录列表。

公网 HTML 已与 Mini 的最新 `dist/index.html` 逐字节比对一致。浏览器已验证缓存展开、HTML 默认预览、相对 CSS / SVG 图片与外部 JS 按钮交互；Markdown 默认预览和源码切换通过自动测试，另通过实际保存接口验证 Markdown 写入 Mini 磁盘。未登录快照返回 401，越界目录返回 403。

本轮回滚与验证资料位于 Mini 的 `~/.local/share/cloudcli/backups/tree-preview-20261116/`：`previous-commit.txt`、`source.tar.gz`、`build.tar.gz`、`build.log`、测试/类型检查日志与 `verification.json`。回滚可恢复原提交 `07842aa` 并按上方步骤重建；数据库不在源码备份内，也不应覆盖。

### 首次 Web IDE 部署记录

2026-11-16：23 项 File Tree 后端测试、88 项相关前端测试、完整 1,132 项前端测试通过；前后端类型检查、前后端构建通过。Lint 0 错误，项目仍有既有警告。修正了既有侧栏测试缺少 `backgroundSessionIds` 参数导致的类型检查失败。

本次部署后，本机 `doit` 根目录、CloudCLI 目录、src 目录及主目录选择器约 2–7 ms，文件树响应不含递归子目录。未登录返回 401，越界目录返回 403。公网加载时间另受 Render 唤醒和网络链路影响；本轮公网项目列表约 3.25 秒、根目录文件树约 5.36 秒。

正式网页已实际验证默认打开 `doit`、展开文件夹、切换到 `cloudcli` 工作区、Markdown 预览、Files 视图填满编辑区，以及编辑保存后内容写回 Mini 磁盘。

修改前源码与前端构建备份：`~/.local/share/cloudcli/backups/web-ide-20261116/source-and-dist.tar.gz`；原有未提交改动另存 `existing-changes.patch`。测试、构建和接口验证日志位于同一私有目录。回滚时先保留当前改动，再恢复备份或检出本分支的上一个提交，重新构建并重启；不覆盖运行数据库。
