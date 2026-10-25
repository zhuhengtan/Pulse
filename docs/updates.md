# Pulse 分模块更新

桌面壳、后台运行包、Web/H5 前端分别使用 `shell-v*`、`backend-v*`、`frontend-v*` 发布。后台内部的 data/runtime/tool-sdk/adapters/server/cli 继续配套发布，桌面与 H5 共用一个前端包。第一版只发布稳定版本，不发布预发布通道。

## 使用

设置 → 组件版本提供独立的 Pulse 版本总览：桌面壳、后台包、Web/H5 的当前及最新发布版本、已下载与上一版本，并列出后台内部 Server、CLI、Runtime、Data、Adapters、Tool SDK 的实际版本。后台模块仍配套更新。技能版本在“工具与技能 → 已安装”中单独管理。

在设置 → 软件更新中检查、下载、安排空闲应用或回退。启动后检查一次，此后每六小时检查；失败退避重试。自动下载默认开启，可以关闭。关闭自动下载仍保留版本检查，手动下载后点击“空闲时应用”。Electron 壳只提供版本说明和安装包下载，由用户安装。

```bash
pulse update status
pulse update check
pulse update download
pulse update apply
pulse update rollback
pulse update auto-download off
```

更新核心位于 server 的 `updates` 子模块，纯 Node 运行。CLI/server 的安装方式接入托管更新：

桌面在后台不可用时使用安装包内的受信更新入口，仍能查看、检查和下载版本；应用请求会保留到后台下次启动。后台健康时则共用正在运行的更新核心和下载进度。

```bash
pulse update enable
```

该命令保留已有 npm 命令，在 `$PULSE_HOME/bin`（默认 `~/.pulse/bin`）注册托管入口。已有可识别的 launchd/systemd H5 定义会备份并改为稳定启动器，不停止当前服务；用户下次重新加载服务时生效。开发源码默认不自动更新。首次使用新更新系统，旧桌面用户需手动安装一次支持该系统的壳。

旧后台第一次接入时，在任务空闲后通过“桌面环境 → 应用后台更新”切到托管后台。旧版没有维护协议，不能对其承诺自动无损切换；接入之后的更新使用完整空闲门禁。若旧 CLI 仍占用旧数据库服务，先退出该 CLI，再启动新版后台。

## 兼容与生效

组件清单声明平台、架构、版本、最低后台/壳/Chromium 要求、HTTP/事件/桥接/原生浏览器/读取协议，以及可读写的数据版本。更新器选择最新兼容的后台和前端组合；记住已连接壳的能力，后台独立运行时也不会忽略其兼容要求。需要新壳或不可逆数据迁移时，保留当前版本并提示人工处理。

后台进入维护状态前，检查运行与启动中的任务、消息队列、审批、终端、自动化会话、上传、数据请求和定时任务。数据写入服务还会原子获取维护租约：其他 CLI 正在使用数据时等待，租约有效时外部写入返回 `SERVICE_UPDATING`。维护期间新 API 请求返回 503 和 `Retry-After`；定时任务延后领取，不记为执行失败。

独立协调进程先记录切换日志，再停止自己创建的旧后台。候选后台复用原监听参数、端口、配置和设备授权，在维护状态下完成数据库与读取进程健康检查后才接入任务。失败恢复上一组代码版本，暂停失败版本的自动重试，不用旧数据库覆盖用户数据。进程退出中断切换时，下一次启动按日志恢复旧版本。

手动回退也会暂停刚回退版本的自动重试，避免马上升回去；用户明确再次下载时允许重试。已经安排的切换不会被后续自动下载替换。

前端切换不重启后台。HTML 指向 `/_pulse/<组件ID>/assets/`，旧页面继续使用自己的懒加载资源。新页面使用当前版本，已打开页面提示刷新；用户点击刷新时将草稿临时存入当前标签页的 sessionStorage，恢复后删除。附件处理中或存储失败时阻止该刷新操作。

## 本地存储与协议

- `$PULSE_HOME/updates/scopes/<数据目录摘要>.json`：每个数据目录的当前、上一组、候选、失败版本和设置。
- `$PULSE_HOME/updates/components/<组件ID>/`：只读使用的独立版本目录；更新不原地覆盖。
- `$PULSE_HOME/updates/bootstrap.json`：稳定启动器使用的基础运行包，升级后继续保留。
- 下载暂存、签名清单缓存和进程锁位于同一 updates 目录。

保留基础、当前、上一组及历史前端资源。第一版不自动删除历史版本，避免误删被旧进程或页面使用的文件。

`GET /api/updates` 返回更新状态。配对 H5 只能看到前端代次与协议；本机管理员能查看完整版本、兼容性、进度与等待原因。`POST /api/updates/check|download` 异步接受后返回 202，状态接口用于跟踪结果；`apply|rollback|settings` 管理应用与自动下载。所有修改接口要求本机管理员身份和同源请求。纯 CLI 操作使用相同跨进程锁。

## 签名与发布

索引与组件清单使用 Ed25519 签名；清单包含归档摘要和每个文件/链接的摘要。解包只接受清单内的文件，先写普通文件再建立受限链接，拒绝路径穿越和指向目录外的链接。索引序号不可倒退，过期索引不能触发新更新。已安装版本继续离线可用。

公开验证密钥同时固化在 server 与壳中。私钥仅存在本机发布密钥目录或 CI secret，不能写进仓库、产物和更新索引。初始密钥位于 `~/.pulse/release-keys/update-ed25519-20261025.pem`，权限 0600；CI 配置 `PULSE_UPDATE_SIGNING_KEY` secret 为该私钥，`PULSE_UPDATE_KEY_ID` variable 为 `pulse-20261025`。密钥轮换时必须保留旧壳的信任链，不能仅替换发布私钥。

```bash
pnpm release:version backend 0.9.0
pnpm release:version frontend 0.8.1
pnpm release:version shell 0.8.1
```

提交目标版本并让同一提交的三个平台 CI 全部通过，然后单独推送对应组件标签。新 Component release 工作流只打包该组件；完整上传草稿附件后公开 Release。后台/前端 Release 不改 GitHub Latest，下载页只选择完整的桌面 Release。Pages 在组件发布成功后重建签名索引，并每周续期；生产索引固定为 `https://zhuhengtan.github.io/Pulse/updates/stable.json`。

后台发布同时汇集三平台原生依赖，并按依赖顺序发布六个配套 npm 包，方便无桌面用户首次安装或接入托管更新。npm Trusted Publisher 应配置为 `components.yml`；首次接入可沿用仓库的 `NPM_TOKEN` 回退。前端和壳的发布不触发 npm 后台包发布。

后台沿用根目录双语 CHANGELOG；壳和前端分别在 `docs/component-releases/shell/<version>.md`、`docs/component-releases/frontend/<version>.md` 写更新说明。说明会随组件签名，客户端直接展示；版本脚本和发布打包都检查说明是否存在。

本地打包示例（密钥只通过文件路径传入）：

```bash
export PULSE_UPDATE_KEY_ID=pulse-20261025
export PULSE_UPDATE_PRIVATE_KEY_FILE="$HOME/.pulse/release-keys/update-ed25519-20261025.pem"
node scripts/desktop/prepare.mjs
node scripts/updates/pack.mjs backend
node scripts/updates/pack.mjs frontend
node scripts/updates/frontend-smoke.mjs
```

macOS 壳仍采用免费 ad-hoc 签名，没有 Developer ID/公证的首次安装信任体验；应用不会要求关闭系统保护。正式签名与壳内自动安装属于后续发布配置，不影响上述组件更新。
