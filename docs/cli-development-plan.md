# Pulse CLI 首版开发方案

状态：首版核心闭环已实现；真实 Provider/公网服务和跨平台现场验收仍需用户环境完成。更新：2026-09-22。

## 1. 产品目标

CLI 是可在本机日常使用的通用任务助手，编程是其中一种用途。用户用自然语言提出目标，助手读取必要资料、调用工具、产出结果，遇到缺失信息或需要授权的操作时停下来询问，并支持下次继续。

首版以单用户、单机、前台运行、macOS 为验收范围；代码保持平台边界，Linux/Windows 不默认宣称已验收。既能在项目目录工作，也能在普通资料目录工作，不要求 Git 仓库。

首版完成后应能实际完成四类任务：

1. 读取若干本地文本资料，归纳观点并生成 Markdown 报告。
2. 搜索公开网页，读取来源，生成带来源链接的信息汇总。
3. 查看目录、提出整理方案，经授权创建或移动文件，输出操作清单。
4. 阅读代码、修改文件、执行验证命令，解释结果与改动。

第一版原生支持文本、Markdown、JSON、CSV 等文本读写。PDF、Office 文档的专业解析/生成、登录网站、邮箱和日历等作为后续工具扩展，不把“能执行 shell”计作这些能力已经完成。

## 2. 当前能力与接入缺口

以下是当前实现与验收边界；“已实现”表示源码和离线验证已覆盖，不等同于真实 Provider、联网服务或终端人工验收。

| 能力 | 当前基础 | CLI 所需工作 |
| --- | --- | --- |
| 推理与调用工具 | `LocalHost` 装配 ReAct、工具调用、Human Effect 审批、流式事件和失败反馈 | 真实 Provider 现场验收 |
| 模型 | OpenAI-compatible、Anthropic、Mock Adapter，支持文本 observation | 配置解析、模型选择、凭据读取、真实服务验收 |
| 交互 | CLI 支持 `run`、交互输入、文本/JSONL、取消、审批提示、`/status`、`/tools`、`/artifacts` | 非 TTY 的外部客户端回复协议仍可继续增强 |
| 文件与命令 | 已注册 `fs.list/read/search/write/apply_patch/move`、`artifact.record`、`shell.exec`，有路径边界、hash、冲突保护和输出上限 | OS 级隔离仍不属于首版承诺 |
| 恢复 | Conversation/Run 目录、input/runtime/outcome、manifest、File backend、Human Effect 恢复和 Runtime CAS 锁已接通 | 真正杀进程后的多平台现场演练待用户环境验收 |
| 工具策略 | `read-only`、`ask`、`auto`；ask 产生可恢复 Human Effect，批准绑定 toolCallId，拒绝返回助手错误 | 长期授权规则仍是后续版本 |
| 联网检索 | `--allow-network` 下提供 `web.fetch` / `web.search`、重定向拒绝、私网/IPv6 本地地址拦截和正文上限 | 真实网络和引用质量需在用户环境验收 |
| 多端 | 四个新目录为空 | 确定共享应用层和终端边界 |

主要依据：

- `packages/runtime/src/dsl/session.ts`
- `packages/runtime/src/dsl/program.ts`
- `packages/runtime/src/scheduler/runtime.ts`
- `packages/runtime/src/storage/persistence.ts` 与 `storage/session.ts`
- `packages/adapters/src/providers/` 与 `tools/`
- `packages/tool-sdk/src/index.ts`

需要优先验证的接缝：

1. `PulseSession.sessionId` 当前就是 Agent ID；它不是跨多次用户输入的 Conversation。
2. ReAct 已支持按工具调用批次生成 Human Effect；批准绑定 `toolCallId` 后才提交 ToolEffect，拒绝会形成结构化失败并回到宿主。
3. Runtime 增加了 `builtinHumanEffects` 兼容开关：CLI Host 在组合模型/工具 executor 下启用 Runtime-owned 等待、回复、超时和恢复；其他自定义 executor 默认保持既有 Human Effect 语义。
4. `warmStart` 复制选定事实、发现与结果引用，不等于恢复整段聊天记录，也不等于继续未完成的执行。
5. `FilesystemTool` 的路径和 hash 基础可以复用，但要补路径创建前检查、symlink 与外部并发修改的验收；不能把路径检查或 `cwd` 宣称为 OS 级 shell 沙箱。

## 3. 分层与目录

推荐先采用进程内调用，不先启动 HTTP 服务。`packages/server` 首先承载可嵌入的应用宿主，后续再增加传输层。

```text
packages/cli       终端输入、命令、渲染、信号处理
       │
       ▼
packages/server    应用宿主：Conversation、Run、配置、工具策略、恢复
       │
       ├── packages/runtime    执行语义与状态事实
       ├── packages/adapters   模型、文件、命令、网络的执行适配
       └── packages/tool-sdk   工具定义与注册

后续 apps/desktop → 嵌入宿主或本地 IPC
后续 apps/web     → server HTTP/事件传输 → 同一个应用宿主
```

建议布局：

```text
packages/cli/src/
  bin.ts                 可执行入口
  commands/              setup、doctor、run、resume、sessions
  terminal/              输入、流式输出、审批、格式化

packages/server/src/
  index.ts               导出 createLocalHost，导入时不监听端口
  application/           conversation、run、事件投影、恢复
  agent/                 通用助手 Program、上下文组装
  config/                配置校验、凭据引用、工作目录
  policy/                策略判定、审批记录
  storage/               应用元数据、单写者锁
  tools/                 内置工具装配与能力配置
  transport/             后续 HTTP/IPC 阶段再建立
```

CLI 不直接修改 Runtime state、不自己重试副作用、不把全部历史拼成无限增长的 system prompt。Runtime 不引入终端、CLI 配置文件或 HTTP 概念。

首版保持 TypeScript/ESM、现有 Node 与构建体系。参数与基础终端输入优先使用 Node 内建接口；采用行式交互和流式输出，暂不实现全屏 TUI。新 package 要接入项目 references；`apps/*` 在有实际 package 时再加入 workspace。

### 本地开发、打包与安装运行脚本

脚本属于首版正式交付，随功能一起开发。根 `package.json` 提供统一入口，较复杂的逻辑放在 `scripts/cli/`，各入口共享路径、参数和进程管理代码。保留现有根 `build`、`test` 等入口的职责，避免复制两套构建逻辑。

以下命令已接入根 `package.json`；行为和退出码已做离线验证，真实终端断点/跨平台仍需验收：

| 根脚本 | 用途与行为 |
| --- | --- |
| `pnpm cli:dev` | 首次编译 CLI 及其依赖后启动开发实例；不要求先手工构建 core；保留 stdin/TTY，透传 CLI 参数 |
| `pnpm cli:watch` | 监听 CLI、server 和 core 依赖的源码并增量构建；独立前台进程，配合开发实例使用 |
| `pnpm cli:debug` | 复用开发启动流程，启用 source map 和 Node Inspector；默认只监听 `127.0.0.1`，支持自定义端口与启动时暂停 |
| `pnpm cli:build` | 按依赖顺序构建 CLI 的完整依赖图；类型错误立即失败，不启动交互、不打发布包 |
| `pnpm cli:start` | 直接运行仓库内已构建的 CLI；无构建产物时明确提示先执行 `cli:build`，不隐式安装依赖 |
| `pnpm cli:pack` | 从明确的构建输入生成可分发压缩包、版本清单和校验和；失败时不留下看似完整的正式产物 |
| `pnpm cli:run-package -- --archive <path>` | 将指定包解压到隔离目录并运行包内入口，透传其余 CLI 参数；验证实际产物，不回退到源码或仓库 dist |
| `pnpm cli:verify-package -- --archive <path>` | 在临时目录验证包结构、运行依赖、help/version、Mock 任务、文件产物和恢复流程；默认离线且不使用个人配置 |
| `pnpm cli:install -- --archive <path>` | 从指定包安装到用户级目录并设置 `pulse` 入口；输出版本、安装位置及 PATH 提示 |
| `pnpm cli:uninstall` | 仅移除可确认归本安装器管理的入口和程序文件，保留用户配置、凭据引用与会话数据 |

开发环境约定：

- 固定并记录实际验收的 Node 最低版本和 pnpm 版本，提供首次安装依赖的命令；所有入口先做必要的版本与文件检查。
- `cli:dev`、`cli:debug` 默认使用仓库内 `.pulse-dev/` 的独立配置和数据目录；该目录加入忽略规则。通过显式配置才能接入正式数据，开发调试不能自动读写日常会话。
- 提供不含密钥的配置示例、环境变量示例，以及 Mock 模式，保证没有外部服务凭据也能启动并调试基本链路。
- watch 只更新构建产物，不强制重启正在执行工具的 Agent。现有进程继续使用已加载版本，用户在安全收尾后重启；程序版本变化仍执行正常恢复兼容检查。
- 启动脚本转发 SIGINT/SIGTERM 和退出码，只清理自己创建的子进程。Inspector 端口被占用时明确报错或使用用户指定端口，不终止其他进程。
- 明确定义脚本自身参数与透传 CLI 参数的边界；带空格的路径、中文任务、多行输入和管道输入不得因中间包装层损坏。

首版分发形式采用“需要 Node 的可解压运行包”，先验收 macOS，不承诺独立原生可执行文件。建议产物目录：

```text
artifacts/cli/
  pulse-<version>.tar.gz
  pulse-<version>.sha256

压缩包内部：
  pulse/
    bin/pulse             可执行启动器，定位自身目录并调用 Node
    install.sh            解压后可直接使用的用户级安装入口
    uninstall.sh          仅清理本安装器管理的程序文件
    app/                  编译后的入口、内部包与完整运行依赖
    package.json          版本、Node 要求等运行元数据
    manifest.json         构建版本、源码 revision/dirty 标记、文件清单
    README.md             解压、运行、安装、升级与恢复说明
    LICENSES/             实际分发依赖的许可信息
```

打包实现必须解决 `workspace:*` 和运行时依赖闭包：所有 `@hunterzhu/*` 运行依赖与 `zod` 等依赖都随包提供，Node 内建模块由目标机 Node 提供。选择 bundle 或独立部署目录方案时，以隔离运行验收为依据；不能直接把含有未解析 workspace 依赖的源码包当成交付包。安装和运行不需要目标机具备 pnpm、TypeScript、仓库路径或联网下载依赖。

只收集明确的运行产物、文档与许可证，不把开发配置、密钥、会话数据、测试 fixture 或整个工作目录打进去。构建失败保留上一份完整包；`artifacts/cli/` 加入忽略规则，清理仅作用于本脚本管理的输出目录。

包内启动器与安装器应允许用户脱离源码仓库操作。用户级安装采用 `~/.pulse/versions/pulse/<version>/` 加 `~/.pulse/bin/pulse` 入口；已有同名非 Pulse 文件时停止覆盖。升级先安装并验证新版本，再原子切换入口，保留上一版本供回退；程序回退不等于旧版可以读取新版数据，存储兼容检查仍需执行。`PULSE_HOME` 可移动整个用户目录，`PULSE_INSTALL_ROOT` 仅作为旧版本兼容别名。

开发文档至少给出以下完整路径，示例版本 `0.1.0` 仅用于展示；命令在对应阶段实现后必须实际验证：

```sh
# 本地调试（首次先按文档安装依赖）
pnpm cli:dev -- --cwd /absolute/path/to/workspace
pnpm cli:debug -- --cwd /absolute/path/to/workspace

# 构建后运行
pnpm cli:build
pnpm cli:start -- --cwd /absolute/path/to/workspace

# 打包、验包、直接运行包
pnpm cli:pack
pnpm cli:verify-package -- --archive /absolute/path/to/pulse-0.1.0.tar.gz
pnpm cli:run-package -- --archive /absolute/path/to/pulse-0.1.0.tar.gz -- --help

# 安装后日常使用
pnpm cli:install -- --archive /absolute/path/to/pulse-0.1.0.tar.gz
pulse --version
pulse doctor
pulse --cwd /absolute/path/to/workspace
```

验收包含：无预先 dist 的首次开发启动；Inspector 能命中 TypeScript 断点；修改依赖包后重新运行能看到变化；从含空格路径启动；在源码仓库不可访问、无开发依赖的目录中运行解压包；安装/升级/回退/卸载保留会话数据。离线产物验证与真实 Provider 验收分开记录。

## 4. 用户交互

当前 CLI 已提供 `setup`、`doctor`、`sessions`、`run`、`resume` 和无命令时的单轮输入。`resume <id> <task>` 开启新 Run；`resume <id>` 恢复 manifest 中的未完成 Run。

```sh
pulse setup
pulse doctor
npx @hunterzhu/pulse-cli                      # 把当前目录作为 workspace 开始聊天
pulse --cwd ~/Documents/research    # 显式选择资料目录
pulse run "阅读这些资料，生成摘要"
pulse run "阅读 task.md" --format jsonl
pulse sessions                       # 默认列出当前工作目录的会话
# `sessions --all` 为后续扩展
pulse resume <conversation-id> "继续上次任务"
# `resume --last` 与无 task 的恢复入口仍是后续扩展
```

交互命令控制在少量高频功能：`/help`、`/tools`、`/status`、`/artifacts`、`/exit`。每次普通输入都会在同一个 Conversation 中创建新的 Run，继续保留当前目录下的多轮上下文。

默认画面展示：工作目录、模型、权限模式；助手文本；当前动作与耗时；精简工具结果；产物路径；最终状态与用量。Lane/Effect/Attempt 等详情仅在 debug 视图出现。

- 支持中文、粘贴、多行输入、命令历史和终端宽度变化；执行期间先允许取消和回复问答，不承诺任意时刻修改在途目标。
- 同一 Conversation 首版只允许一个活动 Run；忙碌时提示等待或取消，不静默丢弃新输入。
- 第一次 Ctrl+C 取消当前 Run，等待有界收尾，保留会话；空闲时 Ctrl+C 提示退出，`/exit` 正常保存退出。再次强制退出要标记执行中断，下次按恢复逻辑处理。
- 用户问答与工具审批使用不同的提示类型。问答答案不是默认授权。
- 支持 `--no-color` 与非 TTY。JSONL 模式 stdout 只输出版本化事件，日志到 stderr。
- 无交互输入时如需新批准或补充信息：保存等待状态，返回 `needs_input`，允许 `resume` 继续，不无限挂住。
- 建议退出码：0 成功、1 执行失败、2 输入/配置错误、3 需要交互、130 用户取消。存在未决副作用时不能输出普通成功。

## 5. 会话、任务与状态所有权

```text
Conversation         用户看到的长期会话
  ├── Turn 1         一次用户输入及其回复
  │     └── Run      一次可恢复执行，对应一个根 Agent
  └── Turn 2
        └── Run
```

每个活动 Run 使用独立 Runtime 实例与恢复文件，避免按 Runtime 累积的预算混到其他轮次。Conversation ID 与 Run ID 使用全局唯一标识，Runtime 内部 ID 始终与 Run ID 一起定位。

应用层保存标题、工作目录、用户输入、消息记录、Turn→Run 关联、产物索引与 UI 游标。执行状态、Effect、Result、outbox 和 quarantine 由 Runtime 持久化负责；消息记录不能成为第二套执行账本。

跨轮上下文由应用层构造：用户约束、会话摘要、最近若干轮、显式关联的文件/结果。通过受支持的数据导入/上下文入口交给 Runtime，保留 privacy、来源和引用。使用 warm start 时显式选择继承内容；跨 Runtime 引用必须导入后再使用，不能直接拼旧 Result ID。不得用直接写 `runtime.state` 补接口。

大资料保存在文件或 Artifact 中，模型按需读取。Artifact 元数据不等于正文已送给模型。为跨轮摘要设独立预算，并保留近期原文和摘要来源；首版先实现有界历史，摘要失败时明确告知上下文不足。

模型的临时文本 chunk 只是展示信息；完整回复依据已结算 Result 确认。按 `(runId, effectId, attemptId)` 区分重试输出，避免把失败 attempt 的半句话拼成最终答案。工具输出和文件变化以执行结果与核查为准。

## 6. 内置工具与通用助手 Program

第一版使用单个主 Lane 的通用 ReAct 流程，主动并行拆任务放到后续版本。复用 Runtime 的调度、预算、重试和恢复能力。

| 工具组 | 首版能力 | 关键要求 |
| --- | --- | --- |
| 文件读取 | list、read、search | 有界输出，行号/分页，忽略大文件与二进制，保留来源 |
| 文件变更 | create、apply_patch、move | 写前预览；已读文件 baseline hash；新文件不覆盖；移动同时检查源与目标；记录执行证据 |
| 命令执行 | shell.exec | command/args/cwd、超时、取消、输出截断、退出码；以 argv 调用 |
| 网络 | web.search、web.fetch | 一个真实搜索服务、URL/标题/摘录/获取时间、正文大小和超时限制、引用追踪 |
| 用户交互 | ask_user | 转为 HumanEffect，等待结果；不是阻塞终端的工具内部 readline |
| 产物 | 记录并列出生成文件 | 路径、类型、hash、所属 Run；最终回复可定位到文件 |

工具定义通过 tool-sdk；通用 I/O 实现归 adapters，启用哪些工具、预算和审批归应用宿主。工具报错需要成为可理解的反馈，让助手重新规划；不能因用户拒绝一次操作就无条件崩掉整场会话。

网络首版只读取公开 HTTP(S) 内容。搜索服务使用可替换接口，但先接通一个真实服务；未配置时 `/tools` 明示不可用。限制重定向和目标地址，默认不访问本机/私网/云元数据地址；私人站点以后以显式配置启用。网页与文件正文是资料，不得提高自身权限。

审批流程：模型产生完整操作提议 → 同步策略判定 → 如需询问，提交 human Effect → 校验回复与请求匹配 → 提交 ToolEffect → 执行器再次核对权限与操作参数 → 结算结果。

当前实现把审批建模为 Runtime Human Effect：工具提议先持久化并发出 waiting 事件，CLI 询问后以 `approved`/`reason` 回复；批准只放行对应 toolCallId，拒绝回到助手错误路径。`--auto-approve` 用于明确的无人值守运行。

## 7. 权限与配置

建议默认 `ask` 模式：已配置工作目录内普通读取自动执行；文件变更展示具体操作或 diff 后批准；shell 执行展示命令和 cwd 后批准。另提供 `read-only`，禁用变更与任意 shell。用户可建立受限的长期规则，避免每次询问相同操作；首版不提供隐含的全权限模式。

一次授权绑定 Conversation/Run、工具名、规范化参数摘要、目标路径、文件 baseline 与策略版本。参数或工作目录变化使旧授权失效。审批可以覆盖一组列明的操作，但不把“允许这次改文件”扩成“允许任何命令”。拒绝需要反馈给助手。

`shell.exec` 是受授权的本机进程执行，首版没有 OS 级隔离。工作目录只能限制文件工具，不能限制任意 shell 的读写范围；不得把字符串命令名单当安全沙箱。shell 子进程默认不继承模型/搜索服务密钥等敏感环境变量。

用户配置默认放 `~/.pulse/config.json`，运行数据放 `~/.pulse/data/`，应用日志放 `~/.pulse/logs/`，支持 `PULSE_HOME`、`PULSE_DATA_DIR`、`PULSE_LOG_DIR`、`--config`、`PULSE_CONFIG` 和项目目录 `.pulse/config.json` 覆盖。独立安装包的运行代码和内置 server 放在 `~/.pulse/versions/pulse/<version>/`，启动器放在 `~/.pulse/bin/pulse`。旧版本的 `~/.local/share/pulse/` 在首次默认启动时自动迁移。配置只保存 Provider、baseURL、model、环境变量名、工具开关和限额；密钥在执行时从环境或后续凭据存储读取，不进入会话快照、日志和导出。

配置优先级为显式 CLI 参数 → 环境变量 → 经信任的目录配置 → 用户配置 → 默认值。目录配置不能自行扩大授权、修改凭据目标或启用可执行插件。首次使用云模型时明确显示 Provider、目标端点和数据出网设置；不把 `local_only` 内容自动改为允许上传。

初始预算建议：单轮最多 20 次模型调用、40 次工具调用、15 分钟；shell 默认 60 秒超时，可配置调整。这些是产品默认值，不代表模型价格或耗时预测。UI 显示剩余调用额度；费用仅在有真实 usage 和定价配置时显示，未知值不按零计算。

`doctor` 检查配置、凭据是否存在、工作目录/数据目录可用性、工具依赖与可恢复会话；普通检查不发付费模型请求，`doctor --live` 显式进行真实连接验证。

## 8. 持久化与恢复

首版选择 File 后端，先减少运行环境依赖；保留后端注入，SQLite 后续按数据规模切换。

```text
<data-dir>/conversations/<id>/
  manifest.json          标题、workspace、schemaVersion、Turn/Run 引用
  messages.jsonl         可重建的会话消息视图
  runs/<run-id>/
    input.json           已接收输入、配置指纹与程序版本，不含密钥
    runtime.json         Runtime 持久化文件
    artifacts/           可恢复产物或产物索引
```

原子更新 manifest；每个 Conversation 只允许一个写者。锁带进程/启动身份，不单凭“存在时间长”判断活跃锁过期。进程崩溃后先确认旧写者不在，再恢复。

应用与 Runtime 不是一个存储事务：先持久化输入和稳定 Run ID，再创建执行；启动时根据 runtime snapshot 对账 manifest，使用幂等消息 ID 重建最终回复和产物索引，避免崩溃窗口导致重复运行。

`resume` 分清两种行为：

- 上一 Run 已结束：加载历史，等待新输入并创建新 Run。
- 上一 Run 未结束：恢复相同 Run 的 Runtime snapshot、程序和工具版本，恢复待回复的问题/审批，或处理未决 Effect。

恢复遇到文件变更、失效授权、版本不兼容时明确暂停。未知副作用显示待核查状态，不自动重放 shell 或移动文件。优先用文件执行记录和 hash 对账；无法确定时由用户选择处理，不提供假定 exactly-once 的承诺。

流恢复按已持久化事实游标推进；收到 Runtime `gap` 后用 snapshot 重建状态，不能把缺失 observation 补成已发生事实。会话导出默认去除敏感内容；保留清理入口和存储大小提示，不在首版自动删除未决 Run。

## 9. 应用宿主最小契约

先以 TypeScript 接口实现，暂不冻结外部协议：

```ts
interface AssistantHost {
  createConversation(input: CreateConversationInput): Promise<Conversation>
  listConversations(query: ConversationQuery): Promise<ConversationSummary[]>
  sendMessage(id: string, input: UserMessageInput): Promise<RunHandle>
  resumeConversation(id: string): Promise<ConversationHandle>
  reply(runId: string, requestId: string, value: Reply): Promise<void>
  cancelRun(runId: string): Promise<void>
  subscribe(id: string, cursor?: string): AsyncIterable<AssistantEvent>
  snapshot(id: string): Promise<ConversationSnapshot>
  close(): Promise<void>
}
```

以上类型名是提议。事件包含 schemaVersion、conversationId、turnId、runId 与应用游标；必要时携带 runtimeSeq。首版至少覆盖：回复增量/完成、工具开始/结束、等待输入、产物、用量、运行完成/失败/取消/待核查、gap/snapshot。

应用事件只做投影，不让 UI 依赖整个 Runtime 内部对象。每个 Run 由 Host 独占消费 Runtime stream，再向 UI 分发；当前 observation 读取会 drain，不能让多个客户端分别消费同一底层流。持久化事实游标与临时 chunk 游标分开处理。以后 HTTP/IPC 包装这些能力，CLI 的终端层不需要重写。

## 10. 开发顺序与退出条件

| 阶段 | 交付 | 阶段结束必须证明 |
| --- | --- | --- |
| C0：接入验证与骨架 | CLI bin、嵌入式 Host、Mock/Provider 配置；dev/watch/debug/build/start 脚本 | 已完成；真实模型和 Inspector 断点需用户环境验收 |
| C1：最小任务闭环 | 单轮通用 Program、文件读写/搜索、apply_patch/move、shell、路径/hash 检查、read-only/ask/auto 审批 | 已完成并有 Mock 工具调用、批准/拒绝、冲突保护测试 |
| C2：日常会话 | 多轮上下文、文本/JSONL、会话列表、取消、状态/工具/产物命令；pack/run-package/verify-package | 已完成离线闭环；长上下文和真实 TTY 体验需继续验收 |
| C3：持久化与恢复 | Conversation/Run 目录、input/runtime/outcome、File backend CAS、Human Effect 恢复、版本检查 | 已完成离线恢复测试；真实 SIGKILL/跨进程演练仍需验收 |
| C4：通用检索任务 | `web.search/fetch`、来源结构、文件整理工具和批准链路 | 已完成工具闭环；公网搜索质量和来源引用需现场验收 |
| C5：个人试用交付 | setup/doctor、用户配置、install/uninstall、打包、验包、包内运行和校验和 | macOS 临时目录离线交付已完成；升级回退、跨平台和真实 Provider 任务需现场验收 |

C0 先解决高风险接缝；C1 以后可边开发边试用，C5 才标记首版达到个人日常可用。每阶段可单独评审与验证。

## 11. 验证策略与完成定义

验证分三层：现有 core 回归；Host/CLI 的离线集成与真实子进程测试；用户实际配置的 Provider、搜索服务和终端人工验收。Mock 通过不代替外部服务验收。

重点测试真实边界：

- 配置覆盖与缺凭据错误，错误内容不泄漏密钥。
- LLM 文本/工具调用 → 审批 → 执行 → 结果反馈的完整链路。
- 路径越界、symlink、文件 baseline 冲突、拒绝授权与过期授权。
- 运行中 Ctrl+C、shell 子进程退出、模型超时、断流与限额耗尽。
- 进程在收到输入、等待审批、执行副作用、结算结果各阶段中断后的恢复。
- 两个 CLI 打开同一 Conversation 时拒绝第二个写者。
- 流丢失后的 snapshot 重建、重复事件去重、恢复后最终回复不重复。
- 真实终端中文/多行输入，以及管道模式 stdout 的纯净性。
- 从本地打包产物安装，在非仓库目录调用 `pulse`；验证跨 package 依赖和可执行入口。
- 开发与正式配置/数据隔离；调试断点、watch 后的依赖更新、启动器信号与退出码透传。
- 包中运行依赖完整且不含敏感文件；源码不可访问时仍可执行；安装、升级、回退和卸载行为符合约定。

首版验收必须留下实际任务记录：输入、模型配置名称、工具链路、生成文件、恢复前后状态、失败处理结果。需要有效外部服务配置；没有配置时标为未验收，不替换为成功描述。

## 11.1 当前验证记录（2026-09-22）

已执行的离线证据：

- `pnpm exec tsc -b --pretty false`：通过。
- `pnpm vitest run tests/cli-host.test.ts`：9/9 通过，覆盖 Mock Run、Human Effect 审批/拒绝/自动执行、精确 patch、产物索引、未完成 Run 恢复、跨 Host 写锁、manifest/message 和网络开关。
- `pnpm cli:build`：通过。
- `node packages/cli/dist/bin.js doctor --live`：Mock Provider 真实执行探针通过；真实 Provider 只在用户显式传 `--live` 时请求。
- `node packages/cli/dist/bin.js run ...`：文本和 JSONL 输出均通过。
- `pnpm cli:pack`、`pnpm cli:verify-package`、`pnpm cli:run-package`：通过；包内入口不依赖源码仓库。
- 临时 `PULSE_HOME` 安装/卸载：通过，卸载保留用户数据目录；`PULSE_INSTALL_ROOT` 作为旧版本兼容别名。
- `pnpm test`：75 个测试文件中 484 个通过，13 个失败均是当前沙箱禁止监听本机 HTTP 端口（`worker-http` 10 个、`provider-http-integration` 3 个）；这不是 CLI 离线测试通过的替代品，也不能据此宣称真实 HTTP 运行时已验收。

仍需在用户环境完成的验收：真实 OpenAI-compatible/Anthropic 请求、真实网页搜索结果和引用质量、SIGKILL 后跨进程恢复、升级回退、跨平台安装，以及真实任务中的 PDF/Office 等后续能力。

## 12. 首版之后

后续按使用痛点增加：MCP 工具接入、PDF/Office 能力、浏览器任务、Skills、任务模板、主动多 Lane、后台运行与定时任务、完整 TUI、Web/桌面 UI。

包发布、npm workspace 兼容、pnpm publish、GitHub Actions 和 GitHub Release 的操作见 [`docs/release.md`](./release.md)。

MCP 服务和 Skills 的加载应走显式信任与权限映射。长期记忆独立于聊天历史，不以首版 Conversation 存储替代记忆系统。后台任务需要独立的进程所有权与恢复设计，不能通过“退出 CLI 但保持一个 Promise”实现。
