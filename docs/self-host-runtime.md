# 隔离运行版本切换实验

`scripts/self-host-runtime.mjs` 提供 `SelfHostRuntime`，用于验证自举胶囊在**新建隔离实例**之间的启动、空闲切换、健康检查与失败恢复。这不是现有后台的接管入口，也不是签名发布更新器。

## 范围

- `controlRoot` 必须是绝对路径，父目录已存在且为真实路径，目标目录尚不存在。控制器独占创建 `home`、`data`、`state`、`ipc`；即使正常关闭，也不复用该目录。
- 不接受 PID、外部数据目录、任意启动参数、配置、环境变量或 shell 激活钩子。只启动验证胶囊声明的 CLI，使用固定 `self-host-runtime --control-root` 命令。
- 数据 IPC 端点也固定在沙盒内；启动前仍有 writer 锁时拒绝复用旧写入服务。子进程仅继承明确允许的隔离环境，不继承用户 HOME、Provider 凭据、NODE_OPTIONS 或签名更新变量。H5 使用 mock Provider、禁用 Jarvis/外部能力，仅监听 127.0.0.1 随机端口。
- 实验 H5 不提供任务、终端、设备、配置或签名更新控制；HTTP/WebSocket 的可用范围比普通 H5 更窄。空闲门禁仍检查实际服务的任务、消息、审批、上传、终端、自动化及定时任务状态。
- 没有数据库迁移或数据回滚。健康初始化会在合成 data 目录创建数据库和服务元数据；探测通过不代表任意版本共享真实数据库是安全的。

## 胶囊与身份

每个启动目标必须提供独立保存的 `expectedDigest`，并经完整 `verifySnapshot` 验证。CLI package.json 还须声明 `selfHostRuntimeProtocol: 1` 和 `selfHostRuntimeCommand: "self-host-runtime"`；旧 CLI 不通过尝试启动来探测能力。

新胶囊包含 `entries.runtimeController`，控制器字节也参与运行摘要。应从已信任的稳定胶囊加载控制器；本地摘要不是发布签名，也不能防御已被替换的验证器或恶意胶囊。

每次启动生成新的 instanceId/nonce，并绑定由控制器持有的 ChildProcess PID、胶囊摘要及数据目录。IPC 回复还校验真实 H5 的 serverPid、serverInstanceId、端口和版本。持久 journal 不是进程仍活着的证明，`status()` 的 alive 来自本次观察到的子进程状态。

## 调用

```js
import { SelfHostRuntime, PROTOCOL } from './scripts/self-host-runtime.mjs'

const runtime = new SelfHostRuntime({ controlRoot: '/private/tmp/pulse-runtime-unique', timeoutMs: 30_000 })
const first = { capsulePath: '/verified/capsule-a', expectedDigest: '<saved sha256>', protocol: PROTOCOL, version: 1 }
const next = { capsulePath: '/verified/capsule-b', expectedDigest: '<saved sha256>', protocol: PROTOCOL, version: 1 }
await runtime.start(first)
const result = await runtime.switch(next)
console.log(runtime.status())
await runtime.close()
```

路径和摘要须来自已完成构建和验证的实际胶囊，示例中的占位值不能直接运行。`busy: true` 表示旧实例仍运行，应稍后重新评估，不强行停止任务。

## 切换与失败

1. 验证候选外部摘要和静态协议，再请求旧实例同步关闭任务准入并取得空闲维护租约。
2. 原子写切换 journal，包含旧/新目标及阶段历史；协作停止旧的 owned child，确认退出后才允许启动候选。
3. 启动前再次核对摘要；候选先在维护状态完成真实 reader/data 健康验证与 probe。
4. 健康后再次核对摘要，再写 active_committed、发送绑定租约的 resume、确认 active。
5. 候选 probe 失败且维护租约、进程退出状态明确时，先持久记录 rolling_back、失败候选及脱敏原因，确认候选退出后重新验证旧摘要并恢复旧代码。旧代码恢复也必须健康验证，不恢复旧数据库副本。

身份、健康、resume 或停止结果不确定时进入 blocked，保留证据和锁，不启动替代进程，不按任意 PID 杀进程。意外断连由协作子进程关闭自己的 H5/host。遗留锁、blocked 实例和进程崩溃后的状态不自动接管，也不声称具备突然断电下的 fsync 原子性。

主自举监督器的代码合入与此实验控制器仍是分开的步骤。`self-host.mjs` 的成功不自动重启后台，也不把实验结果当成已签名发布、真实模型验收或生产运行版本切换。

## 定向回归

新增 `tests/self-host-runtime.test.ts` 检查控制器的摘要、并发、忙碌、篡改、断连、失败恢复和不确定结果；`tests/self-host-runtime-h5.test.ts` 同时检查真实 H5 与真实 CLI 子进程协议。后者默认使用已构建的 `packages/cli/dist/bin.js`，缺少当前构建会失败，不静默跳过；隔离构建可通过 `PULSE_ISOLATED_RUNTIME_TEST_CLI` 指向其 CLI。

```sh
PULSE_ISOLATED_RUNTIME_TEST_CLI=/isolated/build/packages/cli/dist/bin.js \
  pnpm exec vitest run tests/self-host-runtime.test.ts tests/self-host-runtime-h5.test.ts tests/self-host-snapshot-identity.test.ts
```

这些测试不使用真实 Provider，不接管现有后台。macOS 自行注入的 `__CF_USER_TEXT_ENCODING` 只在格式及当前 UID 校验通过时接受；其他额外环境变量仍拒绝。
