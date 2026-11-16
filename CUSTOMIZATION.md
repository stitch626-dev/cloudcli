# CloudCLI Web IDE 定制

运行分支：`custom/web-ide`。基于官方 v1.37.8（`2053f3d`），保留完整上游历史。

- Fork：https://github.com/stitch626-dev/cloudcli
- 上游：https://github.com/siteboon/claudecodeui
- Mac mini 源码：`/Users/robert/Desktop/code/doit/cloudcli`
- 本机维护副本：`/Users/jiangwanli/Desktop/code/doit/cloudcli`
- 网页入口：https://cloudcli-render-entry.onrender.com/

## 已实现

桌面端常驻资源管理器，可与聊天、终端、版本控制并排使用；顶部按钮可隐藏文件树，文件夹图标可以选择其他目录。手机端继续从 Files 进入。选择文件后复用现有 CodeMirror 编辑器，支持文本编辑和保存、Markdown 预览，以及图片、PDF、音视频预览。切换文件、从文件树切换项目时保留原有未保存内容确认。

文件树按目录懒加载，展开文件夹时才读取下一层，切换工作区视图保留当前文件树。刷新会重新加载根目录及已展开的分支。树内筛选只查已加载文件；跨项目文件搜索继续使用原有命令面板。保留原有 Git ignore 和系统目录限制。

Star、版本/更新提示、问题反馈、社区链接已从展开和折叠侧栏移除，保留 Settings。Fork 使用 Git 合并维护更新，避免网页更新操作覆盖定制代码。

首次进入默认选择已注册的 `doit` 项目。默认项目路径由构建时的 `VITE_DEFAULT_WORKSPACE_PATH` 控制；文件夹选择器仍由运行时 `WORKSPACE_BROWSE_START` 控制。

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

2026-11-16：23 项 File Tree 后端测试、88 项相关前端测试、完整 1,132 项前端测试通过；前后端类型检查、前后端构建通过。Lint 0 错误，项目仍有既有警告。修正了既有侧栏测试缺少 `backgroundSessionIds` 参数导致的类型检查失败。

本次部署后，本机 `doit` 根目录、CloudCLI 目录、src 目录及主目录选择器约 2–7 ms，文件树响应不含递归子目录。未登录返回 401，越界目录返回 403。公网加载时间另受 Render 唤醒和网络链路影响。

修改前源码与前端构建备份：`~/.local/share/cloudcli/backups/web-ide-20261116/source-and-dist.tar.gz`；原有未提交改动另存 `existing-changes.patch`。测试、构建和接口验证日志位于同一私有目录。回滚时先保留当前改动，再恢复备份或检出本分支的上一个提交，重新构建并重启；不覆盖运行数据库。
