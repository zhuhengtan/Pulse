# Pulse lane 连续性修复与本地验收

日期：2026-10-16。执行者：Codex。真实模型调用：**0**。不提交、推送、发布，不重启正式服务。

## 已实现

新运行默认使用 `pulse.assistant@14`，保留 v5–13 程序注册供原快照恢复；等待中的历史运行不自动迁移。新运行记录 `controllerVersion: "14"` 和 `deliveryProtocol: 1`，旧运行不因新增交付查询工具而改变其工具目录指纹。

1. **同一交付链延续同一 lane。** Host 将依赖相连的阶段归入同一个交付。只有一条交付链时直接使用控制器 lane；有多条互不相关的交付时使用独立 carrier（最多四个并发）。每个 carrier 串行执行自己的阶段，分支和汇合也保留在该交付中。这是以连续性优先的保守调度，不是自然语言任务相似度分类。
2. **阶段重试保持 lane 存活。** 阶段验收、具体纠正和重试在同一 lane 推进；只重置本阶段/本次尝试的工作轮数，不重置完整运行的实际模型调用预算。已完成写入、证据、历史与用户回答保留。最终仍逐项核查原始需求，失败检查不能靠删引用变成通过。
3. **并行交付使用持久检查点。** 阶段状态存在 carrier 的 lane Context 内，由 Runtime 原子持久化。Root 汇合时核对原始阶段归属、goal/check/criterionIds，保留已结算工具回执和实际请求计数；不会用一段完成摘要替代证据。未完成/失败 carrier 的原始检查点同样可以保留。
4. **模型真正能看到连续历史。** 原 `explicitContext` 同时隐藏 Global、lane 控制状态和历史，单纯复用 lane 不足以保持模型连续性。新增独立 `includeLaneHistory`，v14 显式开启历史，同时保持控制状态不隐式注入。历史证据正文每个请求只出现一次，当前目录使用 `{id, fromHistory:true}` 指向它；模型内部推理/continuation 不作为普通历史正文注入。压缩使用明确的历史序号，保留最近轮次及既有可见性/隐私约束。
5. **只传有界交付清单。** 交付 v1 包含 stageId、ownerLaneId、状态、摘要、原始证据引用与文件版本/窗口/退出码。单条清单不超过 **4 KiB**、摘要不超过 **200 字符**、索引项不超过 **12**，明确列出总数与省略数，不复制源码正文、整段日志或完整聊天记录。
6. **细节按需取回。** `task.delivery({stageId,offset})` 每页返回最多 16 个可见 public 原始证据引用；offset 是条目位置。`task.evidence({ref,offset})` 读取某一原始回执，包括实际命令、参数和完整内容。省略项有可查询的入口，禁止靠重新执行操作来重建上下文。验收仍使用完整原始证据及当前文件新鲜度。

## 本轮发现并修正的关联问题

- 检查点钩子和步骤处理器在同一个纯 Step 中重复设置同一 lane 字段，会产生 `CONTEXT_PATH_CONFLICT`。DSL 现在将可安全合并的重复 lane 赋值编译为最终赋值；原始 Global/ContextDelta 冲突及 append/父子路径冲突仍交给 Admission 拒绝。原 draft-proxy 操作契约保留。
- `Summarize original fixture write receipts` 被误判成 edit，第二页索引读取被 `FILE_EDIT_REQUIRED` 拦住。先前怀疑压缩丢失操作，经 Runtime 轨迹核实后排除。汇总/解释已有写入回执现在属于分析；明确新增输出文件或“然后更新文件”的要求仍是编辑。
- 旧模拟器按整个提示词中的关键字选响应，加入连续历史后误把历史规划指令当成当前请求。模拟器已按当前请求路由，并支持从历史证据解析 `{fromHistory:true}`。历史 v13 分阶段行为测试显式固定在 v13，保留其原断言；新增 v14 回归直接检查 lane 身份和历史。

## 本地回归

新增 **13 项**回归：

| 场景 | 已验证结果 |
|---|---|
| 三阶段交付＋一次仅验证纠正 | 全部尝试只有 1 个 lane；原写入各执行一次，历史继续增长 |
| 两条各含两个阶段的独立交付 | Root＋2 个 carrier；各自后续阶段和重试复用原 carrier，汇合不丢状态 |
| 前置阶段受阻 | 后继尝试数为 0；另一条独立交付仍完成 |
| 单 lane / 多 carrier 等待问题后冷恢复 | 同一问题、选项、lane ID、历史和已完成写入；恢复本身不调用模型、不自动回答 |
| 同 lane 重试中测试失败 | 已完成阶段保留，失败检查不能通过；后续阶段不实施 |
| 有界清单与中文长路径 | 整个序列化清单 ≤4 KiB，省略数明确，无源码正文 |
| 历史显式注入 | 不注入 Global/lane 控制内容；同一正文不重复；隐私路由保留；旧显式上下文行为不变 |
| 压缩历史选择 | 仅选定前缀进入压缩请求，保留近期记录；正常历史条目按追加增长 |
| 汇总写入回执 | 不再要求新写入；明确保存报告和更新文档仍识别为编辑 |
| 原子 lane 赋值 | 重复设置可编译；原始 Global 重复路径仍被拒绝 |
| 真实 Host＋假模型交付索引 | 创建 20 个实际文本文件，分页取回全部 20 个原始回执，再取回其中一个完整回执；文件写入恰好 20 次，阶段 lane ID 相同 |

新增13项定向回归、类型检查和 diff 格式检查均通过。最终完整本地套件：**150 个文件 / 1228 项测试全部通过**（单 worker，226.78 秒）。

### 完整套件过程

- 初始受限环境出现 `EPERM`（本机 socket / shell 隔离初始化），记录保留；后续通过授权的本机测试权限运行，不关闭产品隔离。
- 双 worker 完整本地测试：**150 文件，1227 通过 / 1 超时**，仅未改动的 H5 配对用例在原 10 秒超时。单独运行同一文件、同一断言和超时 **22/22 通过**。
- 最终单 worker 完整复核：**150/150 文件、1228/1228 测试通过**。不增加任何测试超时、不删断言。双 worker 下的 H5 配对超时仍保留为并发执行时的限制，不将其历史失败覆盖成通过。

## 验证边界与剩余限制

本次验证的是实际 Runtime/Host 配合模拟 Provider 的控制流、文件操作、上下文投影、持久化和恢复。未进行真实 DeepSeek、交互 CLI 键盘、安装包、跨平台或实际费用评估；不声称已经测得 paid token 降幅。

依赖相连的分支会串行化，可能增加关键路径延迟。未按任意自然语言“同类型”自动合并没有依赖关系的任务。非 public carrier 检查点不自动搬到 Root；缺少可用检查点时保留原始回执并明确阻塞，而非冒充通过。多个 carrier 的全局新指令仍由 Root 的安全汇合检查点处理，本轮没有改变 Runtime 的在途取消协议。

## 证据与保护

证据目录：`/Users/zhuhengtan/projects/Pulse/.pulse-dev/lane-continuity-repair-20261016/`。

- `new-regressions-final.log`、`isolated-final.log`：定向回归和 H5 原设置隔离复核；最终13项新增用例也包含在完整套件中。
- `typecheck-final.log`：类型检查。
- `full-final-alone.log`：双 worker 完整回归的原失败记录，未覆盖。
- `full-single-worker.log`：最终完整复核。
- `delivery-debug*.log`、`delivery-snapshot.json`：分页探针的失败和定位证据，仅模拟测试资料。
- `before.json`、`preservation.json`：原有 608 个文件基线；592 个与本轮无关的文件内容未变，其余为本轮明确修改的 16 个文件。

历史 LT01 round7 的真实调用账本仍为 **38**；本轮没有再次启动真实评测。原未提交改动、历史评估、配置和会话保留。

复核命令：

```sh
pnpm exec tsc -b --pretty false
pnpm exec vitest run tests/lane-continuity.test.ts tests/lane-delivery-host.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run --exclude 'tests/live/**' --maxWorkers=1 --minWorkers=1
git diff --check
```
