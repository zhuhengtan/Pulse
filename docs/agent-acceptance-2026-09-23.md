> 2026-09-24 更正：此前真实运行失败的归因已通过持久化快照重新核查。关键原因包括 Host 使用虚拟时钟、输出截断、工具失败未回传、摘要缺少续读入口，并非已证实的模型能力不足。后续修复和真实验收见 [本地可用性报告](agent-usability-2026-09-24.md)。

# Agent 整体 Review 与验收（2026-09-23）

结论：本机工程回归与安装链路通过；成熟 Agent 全量验收未通过。不能把离线测试通过视为真实任务质量、跨平台安全隔离或长期无人值守稳定性的证明。本次仅修改本地文件，未提交、推送或发布。

## 定时任务 P1 复验：已修复

原问题：超时只结束等待，执行器不响应取消时，旧执行仍运行却释放占用并启动下一项。

修复：超时和取消后先等待执行器结束，默认宽限 1 秒，可通过 SDK 的 cancellationGraceMs 配置。仍未结束时抛出 SCHEDULED_TASK_CANCELLATION_UNCONFIRMED，保留 durable claim 并停止派发。租约到期不能证明旧执行停止，因此只在 owner 进程确认退出后自动恢复；PID 复用等不确定状态保守保留占用。禁止删除仍有 run 的任务。

CLI 的 Runtime 取消可能先于底层工具停止，因此 CLI 一旦在执行期间取消，明确报告取消未确认并保留占用，不把 Runtime 的取消状态当作工具全部停止的证明。通用 SDK executor 必须在所有自有副作用停止后才 settle；无法确认时也必须报告上述错误码。

恢复方式：先检查并停止原 worker 及其任务子进程，确认旧执行不再产生副作用，再启动 worker。不要手工删除 store/claim 来绕过隔离。异常停止不能撤销已提交给外部系统的操作，外部幂等性仍由工具自身保证。

回归覆盖：延迟结束不与下一任务重叠、永久不响应取消时有界报错并保留占用、迟到写入期间其他 worker 无法领取、续租失败且取消卡住、租约过期不抢占活 owner、运行中删除被拒绝、executor settle 但报告底层未停止、owner 退出后的恢复。

## 本轮已修复

- 扩展工具绕过 `read-only`：在首次与恢复注册入口统一阻止非 read/none 能力执行，新增调用次数为零的回归。
- ReAct 最后一轮最终答案被错误拒绝：允许第 maxTurns 轮的最终答复，保留工具调用的预算限制。
- 定时任务工作目录漂移：持久化创建目录并传给会话。历史任务缺目录时明确失败，需重建，不能自动猜测。
- Windows 验包错误调用 Unix 安装器：按平台选择 PowerShell 安装、`.cmd` 启动与卸载；本机只验证 macOS 分支，Windows 分支仍需真实 CI。
- 评测虚报成功：同时要求 CLI 退出码、Runtime 成功和 TaskOutcome accepted；保留两层状态，禁止 Mock 冒充真实 Provider，新增状态核算回归。
- XLSX 稀疏列漏读：预览按最后列位置遍历，并正确标记列范围截断；新增 Z1 单独有值的真实 XLSX 回归。

## 计划验收映射

| 项目 | 当前证据 | 尚缺验收 |
| --- | --- | --- |
| A1 任务评测 | 24 项数据集结构校验、dry-run、静态评分器与状态核算 | 真实 Provider 每项至少 3 轮、人工语义评审、质量基线；token/cost 仍不可用 |
| A2 任务闭环 | TaskRecord/TaskOutcome、ResultRef、有限重规划、恢复与 Mock Host 测试 | 真实 Provider 的复杂修正和长期上下文质量 |
| A3 安全执行 | 本机 shell、权限与恢复回归 | Linux/Windows 真机隔离验证；对抗性 E2E 不由单测替代 |
| A4 能力扩展 | MCP、Skills、PDF/XLSX 有集成测试 | 真实 Browser/Jarvis 等远端服务 E2E；它们当前依赖外部 MCP 配置 |
| A5 模型路由 | 阶段路由与 fallback 回归 | 真实多 Provider 故障切换、成本/延迟对比 |
| A6 定时任务 | 持久化、工作目录、失败退出码、安装后 add/list | 登录自启服务和长期运行验证；取消未确认时需停机排查后恢复 |

## 本机验证

- `pnpm build` 通过。
- 最终全量回归 **96 个测试文件、662 个测试全部通过**；测试日志 `/tmp/pulse-cancellation-tests.log`。
- `pnpm eval:validate` 通过（24 项），`pnpm eval:dry` 明确返回 `qualityBaselineCreated: false`。
- 使用独立临时目录重新打包；验包覆盖 archive 启动、Mock 任务、安装后启动、定时任务 add/list、卸载及用户数据保留。
- 包与验包日志分别为 `/tmp/pulse-cancellation-artifacts/pulse-0.1.11.tar.gz`、`/tmp/pulse-cancellation-package.log`。临时产物不作为正式 release。
- `git diff --check` 通过。

未执行真实 Provider 72 次基线、Windows/Linux 真机测试、长期 daemon 压测，因此不签署“全部计划完成”或“成熟 Agent 已验收”。

## 剩余计划实施进展（本次后续实现）

- 用量：Provider attempt 元数据保留每次 fallback 的独立 attempt ID；RunUsage 写入 `usage.json` 和 `outcome.json`，随 JSONL 完成结果及 TUI 显示。配置模型价格可计算带版本的估算费用，缺失用量/费用仍明确未知。
- 评测：24 项数据集增加 JavaScript/Python 沙箱行为检查和研究链接可追溯检查；真实评测强制 token 预算，限制每任务调用、输出 token 和时间；网络任务以外强制关闭网络。费用由 Provider 报告时在任务间检查；单次任务内无法严格预先截断费用，因此报告不声称费用硬上限已保证。
- MCP/模板/服务：增加 `mcp doctor`、按远端工具名显式 `toolPolicies`、环境变量引用 `envFrom`，以及 4 个版本化任务模板和 `template list/show/run`。新增三平台用户服务命令和 CI OS 矩阵；没有安装或启动 OS 服务。
- 2026-09-25 开始将普通执行改为默认事件驱动并发：移除新启动流程的 `executionMode` 开关，允许独立工具调用同轮提交，并为 `fs.read`、`fs.write`、`fs.apply_patch` 增加路径级资源锁。不同任务阶段的并行调度及同文件非重叠 patch 合批仍未完成。
- 仍未完成：Provider attempt 级跨 Lane 调用预算和 Token/费用耗尽测试；任务计划/取消整棵任务树/审批差异/服务状态的完整 TUI；多 Lane 质量与耗时对比；后台服务日志轮转和凭据环境保护；安装后真实 Browser/Jarvis E2E、真实 72 次 Provider 评测、三平台 shell/服务长测。以上仍阻止整份计划完成。
- 后续本机验证：构建通过；最终全量回归 **96 个测试文件、664 项全部通过**（需要本机 loopback/隔离 socket 权限）；评测数据校验 24 项通过，dry-run 明确不产生质量基线；新增并行 Lane 及共享预算耗尽冒烟通过；重新打包后包内运行、Mock 任务、安装/卸载及用户数据保留通过，包位于 `/tmp/pulse-plan-final-artifacts4/pulse-0.1.11.tar.gz`。MCP doctor 在无启用服务时按预期提示未配置并返回非零；service status 在未安装时按预期报告未安装。行为 grader 的 code-01 沙箱冒烟在获取本地隔离 socket 权限后通过。

## 2026-09-24 本地 DeepSeek 冒烟

用户授权使用正在运行的开发版 CLI 与已配置的 `deepseek-flash` 凭据。评测入口新增 `--cli <本地入口文件>`，可直接执行 watch 产物而不重建、不干扰 watch；每条记录现在保留输入/输出/缓存 token 和 Provider 回传费用，费用未知时保持 `null`。凭据仅检查了环境变量是否存在，没有读取或记录密钥。首次受限环境的请求因网络权限失败，没有消耗可观测 token；后续在允许 API 请求后完成下列尝试。

| 类别样本 | Runtime / 任务验收 | 行为评分 | 用量 | 结果 |
| --- | --- | ---: | --- | --- |
| code-01，3 轮 | `MAX_TURNS_REACHED`，验收未完成 | 4/4 | 11,261 输入、683 输出、完整 | 文件行为正确，但预算在 Runtime 验收前用尽 |
| code-01，8 轮重试 | `PROVIDER_RESPONSE_INVALID: INVALID_TOOL_ARGUMENTS` | 0/4 | 3,379 输入、62 输出、部分 | Provider 工具参数失败，没有产物 |
| files-01 | Runtime `succeeded`，TaskOutcome `unverifiable`，Provider verifier `HTTP 400` | 4/4 | 21,585 输入、1,588 输出、部分 | CSV 工件通过机械检查，但端到端命令退出非零，不能计为任务成功 |
| research-01，10 轮 | `MAX_TURNS_REACHED`，验收未完成 | 0/5 | 54,953 输入、1,968 输出、完整 | 未形成可评分来源工件 |

本次总计可观测 95,479 个输入/输出 token；没有任何 Provider 成本字段，因此费用未知，不能宣称已执行费用硬限额。三类真实 Provider 样本的 TaskOutcome accepted 数为 **0/3**，静态评分合计 **8/13**；静态分数不代表任务成功。运行记录和隔离工件在 `/tmp/pulse-real-smoke-20260924/`。评测验证与专用 `eval-status` 测试通过；一次默认沙箱全量回归受本机策略限制，20 项需要 loopback 或 sandbox socket 的测试无法启动，其余 644 项通过。真实 72 次评测仍待修正 Provider/验收问题后执行。

本次真实调用暴露的阻塞：DeepSeek Chat Completions 文档把 `response_format` 限定为 `text/json_object`，而通用适配器先前对验收请求发送 `json_schema`，与观测到的 verifier `HTTP 400` 一致。适配器现对 DeepSeek 改用 `json_object`，在提示中附上 schema，并继续由 Runtime 本地校验结构；OpenAI 仍使用 strict `json_schema`。源码定向测试和一次 DeepSeek 真实结构化输出请求通过。用户正在使用的开发 CLI 产物仍旧于该源码修正，因此完整文件任务需要等 watch 产物刷新后复测。`INVALID_TOOL_ARGUMENTS` 仍是独立的模型工具调用失败，需靠重试与更多样本评估。官方文档：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

## 重新编译后的端到端复测

用户确认 watch 已停止后运行 `pnpm build`，构建成功，且本地 CLI 加载的 adapters 产物已含 DeepSeek JSON mode 修正。随后重新运行三类任务各一项：

- `files-01`：**succeeded / accepted**，6 项验收标准全部通过，行为评分 4/4；20,168 输入、1,571 输出 token，完整用量，费用未知。
- `code-01`：失败，未创建目标文件，评分 0/4；Runtime 记录为 `unverifiable`，9,127 输入、1,597 输出 token，完整用量。模型输出了计划和重规划评估，但未执行文件写入。
- `research-01`：失败，20 轮后 `MAX_TURNS_REACHED`，未创建研究文件，评分 0/5；152,834 输入、6,032 输出 token，完整用量。模型多次报告页面抓取没有内容并重复尝试，未得到可引用来源。

本轮三类样本中 **1/3 accepted**，机械评分 **4/13**，合计 191,329 个输入/输出 token；Provider 成本仍未返回。修正后的结构化验收已由真实 `files-01` 端到端确认；代码生成与研究质量、研究网络检索和真实 72 次评测仍未通过。构建、DeepSeek 结构化输出 live 测试、适配器定向测试、评测状态测试、24 项数据集校验和 `git diff --check` 通过。重编译后全量回归 **96 个测试文件、664 项全部通过**（在允许 loopback 与 sandbox socket 的本机权限下）。
