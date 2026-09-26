# @hunterzhu/pulse-cli

[English](README.md)

[更新日志](https://github.com/zhuhengtan/Pulse/blob/main/CHANGELOG.md)

**面向编程、研究与文件工作的 AI 助手。**

Pulse 在项目目录中运行，将对话保存在本机，并可恢复未完成的工作。需要 Node.js 22+。

## 安装

全局安装 CLI，让 `pulse` 命令加入 `PATH`：

```bash
npm install -g @hunterzhu/pulse-cli --foreground-scripts
pulse --version
```

临时运行可使用 `npx @hunterzhu/pulse-cli`。以下命令假设已全局安装。

## 配置模型与 API Key

创建初始配置：

```bash
pulse setup
```

配置位于 `~/.pulse/config.json`（Windows：`%USERPROFILE%\.pulse\config.json`）。新配置包含 DeepSeek Provider 和 `deepseek-chat` 模型。将 `activeModel` 设为 `deepseek-chat`，或像下面这样使用 `--model deepseek-chat`。默认的 `mock` 模型不会发起 API 请求。

在 Shell 中设置 API Key；DeepSeek Provider 使用 `apiKeyEnv: "DEEPSEEK_API_KEY"` 读取它：

```bash
export DEEPSEEK_API_KEY="your-key"
# Windows PowerShell: $env:DEEPSEEK_API_KEY="your-key"
```

## 使用

```bash
pulse --model deepseek-chat                        # 交互会话
pulse run "Summarize this project" --model deepseek-chat
pulse sessions
pulse resume <conversation-id> "Continue" --model deepseek-chat
pulse doctor
pulse --read-only
```

运行 `pulse --help` 查看全部选项。

## 许可证

此包采用 [PolyForm Noncommercial 1.0.0](./LICENSE)。商业用途需要另行获得许可。这是源码可见的非商业许可证，不是 OSI 认可的开源许可证。

## 链接

- [完整 CLI 配置指南](https://github.com/zhuhengtan/Pulse/blob/main/docs/cli-config.md)
- [源码与文档](https://github.com/zhuhengtan/Pulse)
