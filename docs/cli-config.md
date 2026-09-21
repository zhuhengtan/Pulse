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

例如，使用 OpenAI-compatible Provider：

```json
{
  "provider": {
    "provider": "openai-compatible",
    "model": "your-model",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "approvalMode": "ask",
  "allowNetwork": false
}
```

密钥不写入文件，只通过 `OPENAI_API_KEY` 或配置中指定的环境变量注入。执行：

```bash
export OPENAI_API_KEY="..."
npx @hunterzhu/pulse-cli doctor --live
npx @hunterzhu/pulse-cli
```
