# CLI 配置

默认配置文件位于当前用户的 home 目录下：

```text
macOS/Linux: $HOME/.pulse/config.json
Windows:     %USERPROFILE%\\.pulse\\config.json
```

程序不会拼接固定的 Unix 路径，而是使用 Node.js `homedir()` 和 `path.join()` 计算实际路径。

所有用户级运行文件都归于同一个 `.pulse` 根目录：

```text
~/.pulse/config.json  用户配置
~/.pulse/data/        会话、运行状态和恢复快照
~/.pulse/logs/        应用日志
```

`PULSE_HOME` 可以移动整个根目录；`PULSE_DATA_DIR` 和 `PULSE_LOG_DIR` 可以分别覆盖数据、日志目录。独立安装包的 `server` 和其他运行代码位于 `~/.pulse/versions/pulse/<version>/`，启动器位于 `~/.pulse/bin/pulse`。通过 npm 在项目中安装时，代码仍由 npm 管理，用户数据仍写入上述 `.pulse` 目录。

旧版本的 `~/.local/share/pulse` 会在默认启动时自动迁移到 `~/.pulse/data`。项目目录下的 `.pulse/config.json` 仍然是项目配置覆盖文件，与用户 home 下的 `.pulse` 根目录分开。

`pulse setup` 会创建这个文件并设置为 `0600`。也可以使用 `--config <path>` 或 `PULSE_CONFIG` 指定其他配置文件。

配置优先级从低到高是：用户配置、当前目录 `.pulse/config.json`、`PULSE_CONFIG`、`--config`，命令行参数和对应环境变量再覆盖配置文件字段。

Pulse 只使用供应商表和模型表这套配置：模型的 `displayName` 必须全局唯一；`modelCode` 才是实际发送给供应商的模型名。

执行 `npm install @hunterzhu/pulse-cli`（或全局安装）时，跨平台的 Node 安装脚本会在当前操作系统的用户主目录下创建 `.pulse/config.json`（macOS/Linux 为 `~/.pulse/config.json`，Windows 为 `%USERPROFILE%\.pulse\config.json`）。初始文件包含 `mock` 默认模型以及 OpenAI、DeepSeek 的示例映射；已有配置不会被覆盖。API Key 只记录环境变量名，不会写入配置。macOS/Linux 使用 `0600` 文件权限；Windows 由当前用户目录的 Windows ACL 管理访问权限。

旧版单 `provider` 配置不会自动迁移。已有用户配置请执行 `npx @hunterzhu/pulse-cli setup --force` 生成新模板，再按下面的格式填写；该命令会覆盖指定的配置文件。

```json
{
  "providers": {
    "openai": {
      "name": "OpenAI",
      "provider": "openai-compatible",
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "deepseek": {
      "name": "DeepSeek",
      "provider": "deepseek",
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "gpt5.6-a": {
      "displayName": "gpt5.6-a",
      "provider": "openai",
      "modelCode": "gpt-5.6"
    },
    "gpt5.6-b": {
      "displayName": "gpt5.6-b",
      "provider": "deepseek",
      "modelCode": "deepseek-chat"
    }
  },
  "activeModel": "gpt5.6-a",
  "approvalMode": "ask",
  "maxTurns": 32,
  "autoCompactPercent": 90,
  "allowNetwork": false
}
```

密钥不写入文件，只通过 `OPENAI_API_KEY` 或配置中指定的环境变量注入。执行：

```bash
export OPENAI_API_KEY="..."
npx @hunterzhu/pulse-cli doctor --live
npx @hunterzhu/pulse-cli
```

`maxContextTokens` 必须填写你所选模型官方支持的上下文窗口大小；它只影响 Pulse 的本地路由准入，不会扩展模型实际能力。`maxOutputTokens` 是预留给模型输出的预算，过大时会减少可用输入空间。

Provider 字段说明：

- `providers`：供应商注册表，key 是供应商 code；`provider` 是适配器/协议 id，`apiKeyEnv` 只保存环境变量名。
- `models`：全局模型注册表，key 或 `displayName` 是 Pulse 内显示名，`provider` 引用供应商 code，`modelCode` 是实际传给供应商的模型名。
- `activeModel`：当前使用的 Pulse 模型显示名。交互界面中可用 `/model gpt5.6-a` 切换。
- `baseURL`：Provider API 根地址。DeepSeek 当前 OpenAI 格式地址是 `https://api.deepseek.com`。
- `apiKeyEnv`：API Key 所在的环境变量名，值本身不会写进配置文件。
- `maxContextTokens`：Pulse 本地路由使用的上下文窗口声明。
- `maxOutputTokens`：每次模型响应的输出预算。
- `reasoningEffort`：`low`、`medium` 或 `high`；是否被 Provider 接受由适配器处理。
- `toolChoice`：`auto`、`required`、`none`，或指定一个函数工具。
- `approvalMode`：`ask` 每次副作用由你确认；`read-only` 禁止写入和 shell；`auto` 对 workspace 内的 `fs.write`、`fs.apply_patch`、`fs.move` 使用工具自身的 workspace 权限和路径校验直接执行，其他外部副作用再由独立的 Pulse safety reviewer 审查。审查回复必须整段就是 `APPROVE` 才会放行，`DENY`、解释句，以及「不允许」「不批准」都不会放行。
- `systemPrompt`：自定义系统指令文本。也可通过 `--system-prompt` 或 `PULSE_SYSTEM_PROMPT` 注入。未加 `--trust-workspace` 时，工作区 `.pulse/config.json` 里的此项会被忽略。
- `systemPromptFile`：从文件载入自定义系统指令。也可通过 `--system-prompt-file` 或 `PULSE_SYSTEM_PROMPT_FILE` 注入。未加 `--trust-workspace` 时，工作区配置不能指定这个路径。
- `maxTurns`：一次 ReAct 运行允许的最大模型/工具轮数，默认 32，命令行可用 `--max-turns` 或 `PULSE_MAX_TURNS` 覆盖，最大 256。
- `autoCompactPercent`：自动压缩阈值，按 `maxContextTokens` 的百分比估算。默认 90，可用 `--auto-compact-percent` 或 `PULSE_AUTO_COMPACT_PERCENT` 覆盖，超过 90 会降到 90，给摘要请求留出空间。达到阈值后，下一条消息发送前会调用已配置模型压缩历史，并在会话里留下 `[自动压缩]` 提示；原记录备份为 `messages.jsonl.bak`。估算会加上系统提示词的体积。更早内容如果已经只剩一条历史摘要，则不再重复压缩。摘要留在对话记录里，适配器会把它当作上下文，而不会并入系统提示词。`mock` provider 不会自动压缩。会话中也可以随时执行 `/compact` 手动压缩。

## 系统提示词与规则自动发现

Pulse 采用模块化系统提示词基座（参考 Claude Code、OpenAI Codex CLI 与 ZCode），由工程调查铁律、基于证据的闭环验证铁律、零废话工程交付规范、自定义提示词、项目规则、用户规则与自适应语言指令组合而成。

### 规则自动发现机制

每次执行时，Pulse 会自动扫描并按优先级加载规则文件：

1. **项目级规则（优先使用首个命中）**：
   - `<workspace>/PULSE.md`
   - `<workspace>/.pulse/rules.md`
   - `<workspace>/CLAUDE.md`（兼容 Claude Code 规则）
   - `<workspace>/AGENTS.md`（兼容通用 Agent 规则）

   规则文件的真实路径必须留在工作区内。指向工作区外的符号链接会被跳过，并继续尝试下一优先级。单个文件最多读入 16 KB。
2. **用户全局规则**：
   - `~/.pulse/instructions.md`
3. **自定义提示词（来自配置、CLI 参数或 API）**：
   - 配置文件 `systemPrompt` / `systemPromptFile`
   - CLI 参数 `--system-prompt` / `--system-prompt-file`
   - API：服务层 `LocalHost` 提供 `getSystemPrompt()` / `setSystemPrompt(prompt)`，支持未来 Web 端与桌面端设置界面动态热更新。

模型可以使用 `ask.choice`、`ask.multi` 和 `ask.input` 向你发起交互。它们属于 `ask.*` 命名空间，分别对应单选、多选和文本输入。提问最多 2000 字、50 个选项。回答必须落在给出的选项里，单选列表到顶或到底后不会环绕。回答会作为下一轮模型上下文的一部分继续运行。

当前适配器没有把 `temperature`、`top_p`、`presence_penalty` 等采样参数暴露为统一配置；Agent CLI 通常优先控制模型、推理强度、工具和权限，而不是覆盖采样参数。
