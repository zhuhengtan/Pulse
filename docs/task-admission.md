# 跨进程任务准入

Pulse 默认允许同一操作系统用户同时运行 2 个受控任务，另有最多 32 个任务等待。用户级配置中的 `taskAdmission.maxRunning`（整数 1–16）和 `taskAdmission.maxQueued`（整数 0–256）指定容量；0 个排队位置表示满载时直接拒绝新任务。项目配置无权修改这些限制，`--trust-workspace` 也不例外。默认值由准入存储提供，不需要重写已有配置。限额统一持久化；首次初始化后，实例构造时若指定的限额与存储冲突，将拒绝准入，不会自动提高容量。修改已持久化限额须通过显式配置操作统一完成，不能仅让某个实例携带不同参数。

## 适用边界

协调仅覆盖同一用户下使用此准入协议的 Pulse 实例。旧版本、手工启动的外部程序、独立模型客户端以及其他操作系统用户不受此机制限制。这不是操作系统级资源隔离，也不是对所有模型调用或子进程数量的保证。

## 后台排队与取消

后台任务在取得运行名额之前保持排队，不启动后台工作进程的任务模型。提交工作前的意图识别仍可能进行一次受限的控制模型请求；准入并不保证排队前完全没有模型请求。运行名额释放后才可启动后续任务。队列已满时明确拒绝新请求，不在客户端隐藏重试。排队期间可取消任务；取消后不能再被分配启动。已运行任务的取消必须等待实际工作停止并确认释放，不能仅修改界面状态就让另一个任务复用名额。

## 启动结果未知与恢复

进程启动和记录落盘之间可能发生崩溃或失联。无法确定工作是否已经启动时，任务进入隔离状态，并保守占用名额，避免重复启动造成超额执行或重复副作用。需要人工检查相关进程、任务日志和实际外部结果后再处理；不要直接删除准入记录来腾出名额。

异常、失联及未知启动均不自动重试任务。重启 Pulse 不等于授权重新执行已经可能产生副作用的工作。先确认原工作是否仍在运行及是否已经完成，再决定取消、恢复或明确提交新任务。

## English summary

Defaults are 2 running tasks and 32 waiting tasks per OS user, shared only by Pulse instances implementing this admission protocol. Host-owned `taskAdmission` accepts integer `maxRunning` values from 1–16 and `maxQueued` from 0–256; workspace config cannot override them, even when trusted. Persisted limits are shared: conflicting constructor settings fail closed rather than raising capacity; changes require an explicit configuration operation. Background tasks wait before starting worker model execution, but submission can first make one bounded intent-classification model request. Queued tasks can be cancelled, and a full queue rejects new work. Uncertain launches are quarantined conservatively until a human checks the actual process and effects. No automatic task retry occurs after failure or an uncertain launch. Do not delete admission records to bypass a held slot.

## 检查、调整与隔离恢复

本机管理员会话可通过 `GET /api/task-admission` 查看当前全局额度和任务摘要。响应不包含私有 owner token。普通已配对手机会话不能访问管理接口。

显式调整使用同源 `PATCH /api/task-admission`，请求字段为 `maxRunning`、`maxQueued`。额度保存在用户级准入存储中，降低运行额度不会杀掉现有任务，只会暂停新增发放。多个进程的构造配置若与该持久额度冲突，会明确拒绝准入，不允许各自放宽全局限制。宿主配置文件中若已写有 `taskAdmission`，调整后应同步这些值再重启，避免配置冲突。

人工核实相关工作、后代进程和外部副作用均已停止后，可向 `POST /api/task-admission/:jobId/recover` 提交 `confirmedStopped: true` 和刚读取的 `expectedUpdatedAt`。接口只接受隔离记录且版本必须仍相同；成功后记录变为 `interrupted` 并释放名额，不会重新执行任务。不能把这个确认用作强制杀进程或自动重试。检查与修改接口均要求本机管理员，修改还要求同源请求。

服务进程消失时，仍纯排队的请求标记为中断，不在服务重启后悄悄执行；已发放启动许可但停止未获证实的任务进入隔离。运行中的审批等待仍占运行名额，控制聊天、回答和取消不占后台整任务名额。前置意图识别另有跨进程最多 2 个请求的控制通道，等候超时明确报告忙碌。

`startH5WorkWorker` 是供协议夹具及底层集成使用的裸 IPC 原语，本身不提供准入。生产工作入口使用 `startAdmittedH5WorkWorker` 或事先由 `LocalHost.scheduleTask` 取得许可。不能把直接调用裸原语的旧集成计入受控保证。

控制通道的隔离也可检查和恢复：读取 `GET /api/task-admission?channel=intent`，人工核实停止后在同一 recover 接口请求中增加 `channel: "intent"`。控制通道与后台任务分别计数，恢复同样要求版本匹配且不会重跑请求。
