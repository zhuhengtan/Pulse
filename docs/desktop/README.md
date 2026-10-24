# Pulse 桌面端与共享数据

桌面端使用 Electron，保留聊天、工作两种模式。会话与消息保存在数据目录的 `pulse.sqlite`；Runtime、附件、工作区和配置继续使用原有目录。桌面分页查询经过 preload 和只读工作线程，直接读 SQLite；H5 经本机 Server 查询同一数据库。后台服务是唯一在线写入入口，内部数据进程串行执行事务。

## 开发与打包

本地测试可在仓库根目录一键启动：

```sh
./start-dev.sh
```

也可以运行 `pnpm dev`（Windows 使用此命令）。要求已安装 Node >=22.13、pnpm 12.4.2；缺少项目依赖、Electron 或 Chromium 时脚本会自动准备，首次运行需要网络。默认启动开发后台 `7333`、前端 `5174` 及 Electron 窗口。前端代码/样式保存后自动刷新，Electron 主进程/preload 的修改须重开窗口，后端修改须重启开发后台后生效。

脚本复用 `.pulse-dev/h5/data` 中已运行的后台和匹配当前仓库/后台的 Vite，不会自动停止任务或重启服务。已有后台若是旧代码，可运行 `./restart-dev.sh`：先构建，再核验数据目录、服务 PID 和前端归属，使用 SIGTERM 正常停止开发后台并在原端口启动新版。它保留聊天和配置，执行中的任务会中断；匹配的 Vite 与 Electron 窗口继续复用，主进程/preload 修改仍须关闭窗口后重开。停止超时会报错，不强杀。配置和模型沿用 `PULSE_CONFIG` / `PULSE_HOME` / `~/.pulse` 的现有规则；开发聊天、设备与窗口配置保存在 `.pulse-dev`，不注册用户 CLI 或修改终端 PATH。脚本不打包应用，也不编译可选的原生桌面控制辅助程序（需要时单独运行 `pnpm desktop:build`）。

```sh
./start-dev.sh --web-only  # 仅开后台和网页，用输出的地址访问
./start-dev.sh --no-build  # 已编译时快速启动，不适用于刚修改过后端的情况
./start-dev.sh --help
./restart-dev.sh             # 构建并重启开发后台，复用或打开预览
./restart-dev.sh --web-only  # 重启后台，仅保留或启动网页预览
./restart-dev.sh --no-build  # 已有最新 dist 时跳过构建
```

退出窗口或按 Ctrl+C，只关闭本次新开的窗口/前端，已复用的前端不受影响，后台继续运行。后台日志位于 `.pulse-dev/logs/backend.log`；复用的后台仍使用其原来的日志入口。端口冲突会报错，不会结束占用进程；`7332` 保留给正式服务。需要另一套测试环境时可同时设置 `PULSE_DEV_DIR`、`PULSE_WEB_DEV_PORT` 和 `PULSE_DESKTOP_DEV_URL`，例如：

```sh
PULSE_DEV_DIR=.pulse-dev/sandbox PULSE_WEB_DEV_PORT=7343 PULSE_DESKTOP_DEV_URL=http://127.0.0.1:5184/work/new ./start-dev.sh
```

脚本的隔离启动回归可用 `PULSE_LOCAL_DEV_LIVE=1 pnpm exec vitest run tests/live/local-dev-start.test.ts` 运行；隔离重启回归使用 `PULSE_LOCAL_DEV_LIVE=1 pnpm exec vitest run tests/live/local-dev-restart.test.ts`。

要求 Node >=22.13（桌面 CI 使用 Node 24）和 pnpm 12.4.2。Electron 与后台 Node 分开打包，后台的 Node 和原生依赖必须在目标系统及架构上构建。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @hunterzhu/pulse-desktop exec node node_modules/electron/install.js
pnpm native:prepare
pnpm desktop:build
pnpm desktop:app:prepare
pnpm desktop:app:dev
```

`pnpm desktop:app:dev` 打开连接本地 Vite（默认 `http://127.0.0.1:5174`）的 Electron 开发窗口，前端代码与样式保存后自动更新，无需重新构建。Vite 未启动时会自动启动；已存在的 Vite 会直接复用。默认使用 `.pulse-dev/h5/data` 与 `.pulse-dev/electron`，通过开发数据目录的 `service.json` 复用后台，不影响安装版数据。可用 `PULSE_DESKTOP_DEV_URL` 指定带明确端口的本机 HTTP 地址；打包应用忽略此变量。

`desktop:build` 仍负责原有桌面自动化辅助程序。应用的新命令为：

```sh
pnpm desktop:app:pack     # 生成应用目录
pnpm desktop:app:dist     # 生成当前平台安装包
pnpm desktop:app:smoke    # 隔离数据、模拟模型的真实 Electron 验收
pnpm desktop:app:startup-smoke # 无已有服务时启动独立后台
pnpm desktop:app:install-smoke # 无系统 Node/Chrome 的隔离首启与修复验收
```

产物位于 `artifacts/desktop/`。macOS 为 DMG/ZIP，仅支持 Apple Silicon；Windows 为 NSIS/ZIP，Linux 为 AppImage/DEB。当前构建未配置代码签名和 macOS 公证，下载后的系统信任提示仍需单独验收。`.github/workflows/desktop.yml` 提供 macOS arm64、Windows x64、Linux x64 的原生构建和验收矩阵；单独通过 workflow_dispatch 运行时只上传 Actions artifact，正式版本由 Release 工作流调用，通过全部构建和验收后上传公开 Release。完整发布门禁见 [发布流程](../release.md)。Runner 标签来源：https://github.com/actions/runner-images 。

测试时使用 `PULSE_DESKTOP_DATA_DIR` 指定隔离数据目录，`PULSE_DESKTOP_USER_DATA` 指定隔离 Electron 用户目录。默认连接现有数据目录中的兼容 `service.json`；未运行时使用随包后台启动。退出桌面不会终止后台。菜单可查看或停止服务。

安装包默认使用 `~/.pulse/data`，不会自动选择仓库的开发目录。若该目录尚未迁移，桌面会明确提示「旧版数据」，不会尝试另起后台写入旧数据。通过菜单「Pulse → 数据目录…」选择已迁移的目录，选择会保存在当前桌面用户配置中；重启桌面后生效，已有后台任务继续运行。服务状态窗口同时显示实际数据目录和服务地址。

本仓库 H5 开发数据位于 `.pulse-dev/h5/data`，已运行的开发后台为 7333 时，桌面会通过该目录的 `service.json` 复用它。首次从命令行启动也可指定：

```sh
PULSE_DESKTOP_DATA_DIR="$PWD/.pulse-dev/h5/data" pnpm desktop:app:dev
```

优先级是 `PULSE_DESKTOP_DATA_DIR`、`PULSE_DATA_DIR`、桌面保存的目录、默认目录。菜单选择目录会替换本次启动的环境变量覆盖值，并重启窗口。

## 安装与首次启动

完整安装包包含 Node、Pulse CLI、Server、网页资源、原生依赖和 Chromium。用户安装客户端并打开即可准备本机运行环境，无须另装 Node/npm、全局 npm 包或 Chrome，也不需要管理员权限。首次窗口显示准备进度；完成后可以进入 Pulse，或前往“模型与服务商”配置模型。云模型仍需用户自己的账号和 API Key，现有模型配置通过环境变量引用密钥；安装包不会提供模型额度，也不会安装 Ollama 等独立模型服务。

默认运行文件放在 `~/.pulse/desktop/runtimes/<版本>-<构建标识>/`，用户配置为 `~/.pulse/config.json`，数据为 `~/.pulse/data/`。首次安装只创建缺失的配置，不覆盖已有设置或聊天。新客户端版本会准备其自带的运行版本；若已有后台正在运行，保留它并显示版本提示，点击“应用后台更新”并确认后才重启。此流程不包含在线下载客户端更新。

首次启动会创建用户级 `~/.pulse/bin/pulse`（Windows 为 `pulse.cmd`），写入当前用户的终端 PATH；打开新终端后运行 `pulse --version`。macOS/Linux 修改对应 shell 配置中的 `Pulse Desktop CLI` 标记块，Windows 仅修改用户 PATH。已有其他 CLI 命令和非托管文件会保留，界面显示桌面版命令的完整路径；入口冲突时使用 `pulse-desktop` 等备用名称。符号链接管理的 shell 配置不会被覆盖，PATH 无法自动配置时显示手动操作路径。

“设置 → 桌面环境”及应用菜单“环境检查与修复…”显示安装状态、实际路径和后台版本。“检查并修复”校验完整运行文件并补回损坏组件，使用新的运行目录，不覆盖正在运行的版本，不删除配置、聊天或停止后台。旧运行目录暂时保留，避免破坏仍在执行的进程。退出窗口后后台继续运行。

开发模式默认只使用仓库运行环境，不注册用户命令或修改终端配置。测试可通过 `PULSE_DESKTOP_RUNTIME_DIR` 指向准备好的运行包启用完整首启，通过 `PULSE_DESKTOP_INSTALL_ROOT`、`PULSE_DESKTOP_SHELL_HOME`、`PULSE_DESKTOP_USER_DATA` 和 `PULSE_DESKTOP_DATA_DIR` 隔离安装、shell 配置、窗口配置和数据；打包应用始终使用随包运行资源。打包默认包含 Chromium，可设置 `PULSE_DESKTOP_BUNDLE_BROWSER=0` 构建精简测试包，此时浏览器需要用户自己准备，不属于完整安装体验。

安装验收脚本使用临时目录与限制后的 PATH，检查首启、命令调用、内置浏览器、设备记忆以及修复时保留配置/数据/原后台。可设置 `PULSE_DESKTOP_EXECUTABLE` 为打包应用的可执行文件路径，检查真实资源路径。安装包需要在目标操作系统与处理器上分别构建和验收；本地未签名测试不能替代签名、下载后首次启动或跨平台验收。

## 一次性迁移

新版本不读取旧 JSONL/manifest/inbox 作为运行时数据源，不做双写。迁移前须确认任务已结束并停止使用该目录的旧版 CLI、H5 和开发实例；保留配置、附件与运行快照。

```sh
pnpm data:migrate --data-dir "$HOME/.pulse/data"          # 只预检
pnpm data:migrate --data-dir "$HOME/.pulse/data" --apply  # 备份后导入
```

Windows PowerShell 将数据路径替换为 `$env:USERPROFILE\.pulse\data`。迁移保留原始文件，并创建 `migration-backup-*`。重复执行校验已有记录，不重复导入；数据不一致时拒绝覆盖。在线服务、运行锁或数据写入进程存在时拒绝迁移。执行后启动新版本；旧版与新版不可同时对同一目录写入。回退前停止新版本并从备份恢复数据。本次实现没有对用户生产目录执行迁移。

## 接口与恢复

- 数据包 `@hunterzhu/pulse-data` 提供异步 `ConversationData` 与只读 `ConversationDatabase`。后者仅用于隔离的桌面查询进程、离线迁移及测试。
- 桌面与 Web 共用 `PulseWebTransport`，增加分页 `messages`、`onChange`、`subscribeChat`。桌面还提供本地服务连接状态；普通 H5 无原生权限。
- 聊天 `/api/chat/socket` 使用已有设备认证和 Origin 校验，复用业务处理器；消息携带 request ID，重复发送返回同一 receipt。连接不自动重发有副作用的请求。
- 工作操作继续 POST，事件继续 SSE。两种流均携带序号；游标超出缓冲区时发送 `resync`，补齐当前状态。服务重启后未结束任务显示中断，由用户恢复。
- 桌面默认每页 50 条；长正文提供预览和按需加载。缓存上限为 10 会话、每会话 200 消息、20MiB，草稿独立。长列表窗口化，回到已有会话恢复阅读位置，首次打开定位最新消息。
- Ask、审核、完成状态立即落库；普通运行摘要合批保存。列表和历史查询不调用 Worker RPC、不读取 Runtime 快照。元数据按字段事务更新，避免并发重命名覆盖运行状态。
- preload 只允许固定 API、查询和限定的终端/自动化 socket，不开放 SQL、文件系统或 Node 执行。关闭工作窗口不取消运行；服务不可用时刷新桌面仍可读本地记录，发送入口禁用。

## 验证命令与边界

```sh
pnpm exec tsc -b --pretty false
pnpm --filter @hunterzhu/pulse-web check
pnpm test
pnpm --filter @hunterzhu/pulse-web test
node scripts/data/benchmark.mjs
pnpm desktop:app:smoke
```

`benchmark.mjs` 是确定性组件负载：1万条消息、50MiB Runtime、两路共20条/秒投影事件、阻塞的 Worker 交互接口，同时重复本地和 Server 查询。它记录真实查询耗时、Worker RPC 和 Runtime 归档调用计数，不代表真实模型任务的吞吐。

真实 Electron smoke 验证本地历史绕过 Server、聊天 WS、工作 POST+SSE、分页和窗口化、30次切换、窗口退出后服务继续，以及服务停止后刷新仍可读取历史。使用临时数据和模拟模型，不读取用户配置或发送外部模型请求。

本机 macOS 的实测证据和执行状态见 [验收记录](./acceptance-2026-10-21.md)。Windows/Linux 与 macOS x64 必须由对应 CI/设备验证，不能用 macOS arm64 的通过结果代替。

## 内置浏览器

Electron 右侧工作窗口使用 `WebContentsView` 显示真正的网页；拖动面板或调整窗口时，网页视口随之改变，由网站自身的响应式布局适配。新窗口链接会转成同一工作窗口中的网页标签，关闭最后一个标签会关闭整个面板。打开网页不要求先选择项目。

Browser Use 通过本机认证的原生宿主连接操作这些相同页面，继续使用任务所有权、接管和控制租约；没有全局远程调试端口。人工接管后可以直接在网页内输入、点击和滚动。浏览器页面不加载 Pulse preload、不启用 Node，使用独立于设备登录的浏览器分区。后台断线时暂停操作，恢复后需要重新接管；旧截图会话在接管时切换为原生页面。

Web/H5 不提供 Browser Use 入口、截图遥控或浏览器控制 API；文件、图片、PDF 和 Diff 预览仍然可用。原生浏览器的人工界面不请求截图；视觉模型需要观察页面时，后台可以单次捕获该页面作为工具观察。
