# Pulse CLI

**A local-first AI assistant for coding, research, and everyday file tasks.**

Pulse works in your project folder, keeps conversations on your machine, and can resume unfinished work. Connect an OpenAI-compatible model provider and choose how much freedom it has to make changes.

## Quick start

```bash
npx @hunterzhu/pulse-cli
```

On first run, Pulse creates a config file at `~/.pulse/config.json` (on Windows: `%USERPROFILE%\.pulse\config.json`). Add your provider and model there, then set its API key as an environment variable.

## Useful commands

```bash
pulse run "Review this project and summarize the key risks"
pulse --read-only
pulse sessions
pulse doctor
```

Use `pulse --help` to see all options. Pulse supports interactive conversations, one-shot tasks, session recovery, and scheduled tasks.

## Links

- [Source code and full documentation](https://github.com/zhuhengtan/Pulse)
- [Report an issue](https://github.com/zhuhengtan/Pulse/issues)

### 定时任务取消与恢复

任务保存创建时的工作目录；旧任务缺少目录时需重新创建。执行超时或取消后，若无法确认底层工具已停止，worker 报 `SCHEDULED_TASK_CANCELLATION_UNCONFIRMED` 并停止派发，保留持久化占用。租约到期不会抢占仍存活的 owner，运行中的任务也不能删除。

遇到此错误时先检查并停止原 worker 及其任务子进程，确认旧任务不再执行，再重启 worker；普通中断会在确认 owner 进程退出后恢复；取消未确认的 quarantine 不会自动解除，必须确认 worker 与子进程已停止后执行 `pulse schedule recover <id> --confirm-stopped`。不要手动删 store/claim 绕过隔离。PID 复用等无法确认的情况保守阻塞，已发往外部系统的操作仍需要工具提供幂等保障。

### 模板、MCP 与用户服务

- `pulse template list|show|run <name> ...` 提供版本化内置任务模板。参数按模板声明顺序逐项传入，每项建议用引号包住。
- `pulse mcp doctor [server-id]` 启动已启用的 MCP 服务、完成握手和工具发现，并在退出前关闭进程。未显式为远端工具配置 `toolPolicies` 时，工具按 external 处理；只读工具必须在可信用户配置中明确列为 `read`。
- `pulse service install|status|start|stop|uninstall` 管理当前用户的登录服务。只有显式执行 install 才会注册；安装命令可能立即启动后台 Worker。服务输出由 launchd 文件或 systemd/Windows 服务管理器收集。
