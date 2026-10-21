# Pulse 桌面端与共享数据

桌面端使用 Electron，保留聊天、工作两种模式。会话与消息保存在数据目录的 `pulse.sqlite`；Runtime、附件、工作区和配置继续使用原有目录。桌面分页查询经过 preload 和只读工作线程，直接读 SQLite；H5 经本机 Server 查询同一数据库。后台服务是唯一在线写入入口，内部数据进程串行执行事务。

## 开发与打包

要求 Node >=22.13（桌面 CI 使用 Node 24）和 pnpm 12.4.2。Electron 与后台 Node 分开打包，后台的 Node 和原生依赖必须在目标系统及架构上构建。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @hunterzhu/pulse-desktop exec node node_modules/electron/install.js
pnpm native:prepare
pnpm desktop:build
pnpm desktop:app:prepare
pnpm desktop:app:dev
```

`desktop:build` 仍负责原有桌面自动化辅助程序。应用的新命令为：

```sh
pnpm desktop:app:pack     # 生成应用目录
pnpm desktop:app:dist     # 生成当前平台安装包
pnpm desktop:app:smoke    # 隔离数据、模拟模型的真实 Electron 验收
pnpm desktop:app:startup-smoke # 无已有服务时启动独立后台
```

产物位于 `artifacts/desktop/`。macOS 为 DMG/ZIP，Windows 为 NSIS/ZIP，Linux 为 AppImage/DEB。未配置签名凭据时产物仅作为测试包。`.github/workflows/desktop.yml` 提供 macOS arm64/x64、Windows x64、Linux x64 的原生构建和验收矩阵；通过 workflow_dispatch 运行，不自动发布。Runner 标签来源：https://github.com/actions/runner-images 。

测试时使用 `PULSE_DESKTOP_DATA_DIR` 指定隔离数据目录，`PULSE_DESKTOP_USER_DATA` 指定隔离 Electron 用户目录。默认连接现有数据目录中的兼容 `service.json`；未运行时使用随包后台启动。退出桌面不会终止后台。菜单可查看或停止服务。

安装包默认使用 `~/.pulse/data`，不会自动选择仓库的开发目录。若该目录尚未迁移，桌面会明确提示「旧版数据」，不会尝试另起后台写入旧数据。通过菜单「Pulse → 数据目录…」选择已迁移的目录，选择会保存在当前桌面用户配置中；重启桌面后生效，已有后台任务继续运行。服务状态窗口同时显示实际数据目录和服务地址。

本仓库 H5 开发数据位于 `.pulse-dev/h5/data`，已运行的开发后台为 7333 时，桌面会通过该目录的 `service.json` 复用它。首次从命令行启动也可指定：

```sh
PULSE_DESKTOP_DATA_DIR="$PWD/.pulse-dev/h5/data" pnpm desktop:app:dev
```

优先级是 `PULSE_DESKTOP_DATA_DIR`、`PULSE_DATA_DIR`、桌面保存的目录、默认目录。菜单选择目录会替换本次启动的环境变量覆盖值，并重启窗口。

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
