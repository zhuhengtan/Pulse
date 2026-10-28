# 模型厂商接入

在桌面客户端或本机 Web 的「设置 → 模型与服务商」点击「添加服务商」，选择厂商、站点和套餐，按需填写 API Key，再获取模型。支持 Ollama、DeepSeek、MiniMax、智谱、OpenAI、Anthropic、Gemini、百炼、火山方舟、Moonshot、SiliconFlow、OpenRouter 和自定义 OpenAI 兼容接口。

模型目录中的对话模型会全部导入，搜索和分页只影响显示。明确属于向量、重排或媒体生成的模型会排除。没有远程目录的接入类型使用标明日期与来源的官方预设清单，也可手动补充模型代码。静态清单不会被当作密钥验证成功。

选择一个测试模型后，验证最多发起三次低 Token 模型请求：流式聊天、一次无副作用的 `pulse_echo` 调用、工具结果续接与 JSON 输出。测试不会访问项目文件或执行真实本地工具，但厂商可能收取少量调用费用。未测试的模型始终保留未验证状态；也可以显式保存未验证配置。明确不支持工具的模型只能选择为聊天模型。

普通 API、编程套餐和不同站点的 Key 需要对应使用。套餐连接失败不会切换到按量计费接口。智谱 Coding Plan 当前仅支持官方指定工具，Pulse 预留入口但不开放使用。

## Ollama

Ollama 提供三种接入类型：

| 类型 | 地址 | Key |
| --- | --- | --- |
| 本机 Ollama | 默认 `http://127.0.0.1:11434/v1`，可调整本机端口 | 不需要 |
| 官方 Ollama Cloud | `https://ollama.com/v1` | 在 [Ollama 设置](https://ollama.com/settings/keys)创建 API Key |
| 远程自托管 Ollama | 显式填写服务器地址，支持 HTTPS 和内网 HTTP | 网关要求时填写；不自动借用官方云端 Key |

模型发现读取对应服务的 `/api/tags`，保留模型完整名称并排除可识别的 embedding 模型。不自动安装、启动 Ollama 或下载模型；本机无模型时请先在 Ollama 安装模型。

官方云端不依赖本机安装或登录 Ollama。若通过本机 Ollama 使用云模型，需要先按 [Ollama 官方说明](https://docs.ollama.com/cloud)登录；这类云模型和远程服务器不会被标记为纯本地模型，不能用于本机 Ollama 审批复核。

Ollama 云端目前[不支持原生结构化输出](https://docs.ollama.com/capabilities/structured-outputs)，Pulse 使用提示约束和 JSON 校验。连接探测通过 `reasoning_effort: none` 关闭思考，避免思考内容耗尽小额探测输出额度；日常任务仍使用已配置的模型参数。兼容参数的自动重试也计入每次探测最多三次的请求上限。

## 凭据与兼容

- 新 Key 存在当前用户配置文件旁的 `provider-credentials.json` 中；配置 JSON 只保存 `credentialRef`。这是本机受权限保护的文件存储，不是加密保险库。macOS／Linux 文件权限为 `0600`，Windows 限当前用户访问。
- 现有 `apiKeyEnv` 配置继续可用。有 `credentialRef` 时使用该引用；引用损坏或丢失会报错，不会悄悄借用环境变量中的其他 Key。
- 多个账号和套餐各有独立的服务商 ID 与凭据。更新 Key 会生成新引用；旧引用保留，以支持进行中的任务和配置备份。删除服务商不会自动清理历史凭据。
- CLI、任务路由、助理聊天、即时预回复及现有 DeepSeek 审批模型共用凭据解析。切换配置只影响新任务。
- 「更新 Key / 刷新模型」留空 Key 即复用原凭据；刷新保留人工修改、模型引用及目录中已消失的旧模型。
- 配对设备不能读取完整配置或管理凭据。Key 不进入浏览器持久存储、API 响应、配置备份或对话导出。复制配置文件到另一台机器时，需要重新接入或通过自己的安全渠道迁移凭据。

## 接口

四个接口均要求本机管理会话，POST 还要求同源：

| 接口 | 行为 |
| --- | --- |
| `GET /api/provider-presets` | 获取厂商、站点、套餐、文档和可用状态 |
| `POST /api/providers/discover` | 临时 Key 或保存的服务商 ID 获取模型目录 |
| `POST /api/providers/probe` | 验证选中模型，返回聊天、工具往返和结构化输出分项状态 |
| `POST /api/providers/connect` | 携带配置版本、服务商信息、模型清单及默认模型选择，保存并应用 |

配置冲突返回 `409`。其他错误返回稳定错误码，不包含厂商原始响应或凭据。保存失败会清理新凭据条目；已经提交的配置仍能解析对应凭据。验证结果在服务端按端点、Key 和模型绑定，十分钟内可随接入结果保存。

## 验证命令

```sh
pnpm exec vitest run tests/provider-onboarding.test.ts tests/provider-continuation.test.ts
pnpm --filter @hunterzhu/pulse-web exec vitest run tests/provider-wizard.test.tsx
pnpm exec tsc -b --pretty false
pnpm --filter @hunterzhu/pulse-web check
pnpm web:build
node scripts/web/verify-provider-onboarding.mjs
node scripts/web/verify-provider-onboarding.mjs --electron
```

界面验收脚本使用临时配置、数据目录和模拟模型 HTTP 服务，覆盖完整保存与 CLI 读取链路，不修改正式配置。截图和结果位于 `artifacts/provider-onboarding-20261028/`；它们证明界面和本地链路，不替代各厂商的真实调用验收。
