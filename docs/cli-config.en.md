# CLI configuration

[简体中文](cli-config.md)

The default configuration file is under the current user's home directory:

```text
macOS/Linux: $HOME/.pulse/config.json
Windows:     %USERPROFILE%\.pulse\config.json
```

The program does not concatenate a fixed Unix path. It uses Node.js `homedir()` and `path.join()` to calculate the actual location.

All user-level runtime files live under the same `.pulse` root:

```text
~/.pulse/config.json  user configuration
~/.pulse/data/        sessions, run state, and recovery snapshots
~/.pulse/logs/        application logs
```

Set `PULSE_HOME` to move the entire root directory; `PULSE_DATA_DIR` and `PULSE_LOG_DIR` override the data and log directories separately. The standalone package's `server` and other runtime code live in `~/.pulse/versions/pulse/<version>/`; its launcher is `~/.pulse/bin/pulse` (`pulse.cmd` on Windows). When installed into a project through npm, npm continues to manage the code while user data remains in the `.pulse` directory above.

On default startup, data in the legacy `~/.local/share/pulse` directory is migrated to `~/.pulse/data`. A project-level `.pulse/config.json` remains a project configuration override and is separate from the `.pulse` root in the user's home directory.

`pulse setup` creates the file with permissions `0600`. You can also use `--config <path>` or `PULSE_CONFIG` to select a different file.

Configuration precedence, from lowest to highest, is: user config, `.pulse/config.json` in the current directory, `PULSE_CONFIG`, and `--config`. Command-line arguments and their corresponding environment variables then override fields from config files.

Pulse uses a Provider table and a model table. A model's `displayName` must be globally unique; `modelCode` is the actual model name sent to the Provider.

When running `npm install @hunterzhu/pulse-cli --foreground-scripts` (or installing globally), the cross-platform Node install script creates `.pulse/config.json` in the current operating system user's home directory (macOS/Linux: `~/.pulse/config.json`; Windows: `%USERPROFILE%\.pulse\config.json`) and displays a bilingual welcome message. The initial file includes the `mock` default model and example OpenAI and DeepSeek mappings; an existing config is never overwritten. API Keys are represented only by environment variable names and are not written to config. On macOS/Linux the file permissions are `0600`; on Windows access is managed by the current user's Windows ACL.

The legacy single-`provider` configuration is not migrated automatically. For an existing user config, run `npx @hunterzhu/pulse-cli setup --force` to generate a new template and then fill it in as shown below. This command overwrites the selected configuration file.

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
  "taskRouting": {
    "plan": ["gpt5.6-a", "gpt5.6-b"],
    "verify": ["gpt5.6-b", "gpt5.6-a"]
  },
  "capabilities": {
    "enabled": ["pdf", "spreadsheet", "skills"],
    "trustedSkillRoots": ["/absolute/path/to/.agents/skills"]
  },
  "approvalMode": "ask",
  "maxTurns": 32,
  "autoCompactPercent": 90,
  "allowNetwork": false
}
```

Keys are never written to files; inject them through `OPENAI_API_KEY` or the environment variable specified in config. For example:

```bash
export OPENAI_API_KEY="..."
npx @hunterzhu/pulse-cli doctor --live
npx @hunterzhu/pulse-cli
```

`maxContextTokens` must be set to the context window officially supported by your selected model. It affects Pulse's local routing admission only; it does not expand the model's actual capability. `maxOutputTokens` reserves the model's output budget; setting it too high reduces the available input space.

Provider and model fields:

- `providers`: Provider registry. Keys are Provider codes; `provider` is the adapter/protocol ID, and `apiKeyEnv` stores only the environment variable name.
- `models`: Global model registry. The key or `displayName` is the name shown in Pulse; `provider` references a Provider code and `modelCode` is the model name sent to that Provider.
- `activeModel`: Current Pulse model display name. Use `/model gpt5.6-a` in the interactive UI to switch.
- `taskRouting`: Ordered lists of model display names for `reason`, `plan`, `merge`, and `verify`. Candidates are tried in order with fallback on failure. Tasks without a route use the current model. This applies only to user-level config.
- `capabilities.enabled`: Explicitly enable installed host capability packs. Built-ins include `pdf`, `spreadsheet`, and `skills`; MCP pack names come from `capabilities.mcpServers`. Workspace config cannot start processes or enable host extensions.
- `capabilities.skills`: Optional allowlist of skill directory names. If omitted, all discovered skills are available; an empty list enables none. Names in older config now only restrict the selectable set and do not preload skill content.
- `capabilities.trustedSkillRoots`: Optional list of absolute directories that contain additionally trusted skills. Paths must be absolute; symbolic links are rejected.
- `capabilities.mcpServers`: Registry of user-installed and trusted MCP stdio processes, such as `{"browser":{"command":"node","args":["/absolute/path/server.js"]}}`. This is user-level config only; a server starts only when its corresponding ID is enabled. Remote tools still use Pulse side-effect approval.
- `baseURL`: Provider API root URL. The current OpenAI-compatible DeepSeek endpoint is `https://api.deepseek.com`.
- `apiKeyEnv`: Name of the environment variable containing the API Key. The key itself is never stored in the config file.
- `maxContextTokens`: Context window declaration used for local Pulse routing.
- `maxOutputTokens`: Output budget for each model response.
- `reasoningEffort`: `low`, `medium`, or `high`; the adapter handles whether the Provider accepts the value.
- MCP diagnostics: run `pulse mcp doctor [server-id]` to check startup, handshake, and tool discovery. `mcpServers.<id>.envFrom` maps MCP child-process environment variables to names in Pulse's launch environment, for example `{ "envFrom": { "BROWSER_TOKEN": "BROWSER_MCP_TOKEN" } }`. Only variable names are stored; credentials are not written to config.
- `toolPolicies`: Explicitly mark remote raw tool names as `read`, `write`, or `external`. Unlisted tools default to `external`; read-only mode permits only MCP tools explicitly marked `read`.
- `models.<name>.pricing`: Optional `{ currency, inputPerMillion, outputPerMillion, version }` for local cost estimates. Estimated costs are displayed separately from Provider-reported costs and retain their price version.
- `toolChoice`: `auto`, `required`, `none`, or a specific function tool.
- `approvalMode`: `ask` requests confirmation for each side effect; `read-only` prohibits writes and Shell; `auto` directly runs workspace `fs.write`, `fs.apply_patch`, and `fs.move` using each tool's workspace permissions and path checks, while other external side effects are reviewed by an independent Pulse safety reviewer. The review response must consist of exactly `APPROVE` to allow the operation. `DENY`, explanatory text, and phrases such as “not allowed” or “not approved” do not allow it.
- Runtime scheduling is event-driven by default for asynchronous model requests and tool calls. Independent tool operations can be submitted concurrently. Operations targeting the same file remain protected by path-level locks and baseline hashes; after a conflict, reread the file and plan again.
- `systemPrompt`: Custom system-instruction text. It can also be supplied through `--system-prompt` or `PULSE_SYSTEM_PROMPT`. Without `--trust-workspace`, this field in workspace `.pulse/config.json` is ignored.
- `systemPromptFile`: Load custom system instructions from a file. It can also be supplied through `--system-prompt-file` or `PULSE_SYSTEM_PROMPT_FILE`. Without `--trust-workspace`, workspace config cannot select this path.
- `maxTurns`: Maximum model/tool turns in one ReAct run; default `32`. Override with `--max-turns` or `PULSE_MAX_TURNS`; maximum `256`.
- `autoCompactPercent`: Automatic compaction threshold, estimated as a percentage of `maxContextTokens`. Default `90`; override with `--auto-compact-percent` or `PULSE_AUTO_COMPACT_PERCENT`. Values above 90 are capped at 90 to reserve space for the summary request. Once the threshold is reached, the configured model compacts history before the next message and the session records an `[auto compact]` notice; the original record is backed up as `messages.jsonl.bak`. The estimate includes system-prompt size. If earlier content has already been reduced to one historical summary, it is not compacted again. The summary remains in the conversation history and the adapter treats it as context rather than adding it to the system prompt. The `mock` Provider does not compact automatically. You can also run `/compact` at any time.

Create scheduled tasks with `pulse schedule add --every 1h --name "Project check" "task description"`; manage them with `list`, `pause <id>`, `resume <id>`, and `remove`. `pulse schedule daemon` polls continuously; `run-once` runs only currently due tasks. Scheduled tasks permit only `read-only` or explicitly configured `auto` approval, and records are saved in `scheduled-tasks.json` under the data directory. This is a foreground Worker; configuring the operating system to start it on login is a separate deployment task.

## System prompts and automatic rule discovery

Pulse uses a modular system-prompt foundation (informed by Claude Code, OpenAI Codex CLI, and ZCode). It combines engineering investigation principles, evidence-based verification practices, concise engineering delivery conventions, custom prompts, project rules, user rules, and adaptive language instructions.

### Automatic rule discovery

On each run, Pulse scans and loads rule files by priority:

1. **Project rules (the first matching file wins):**
   - `<workspace>/PULSE.md`
   - `<workspace>/.pulse/rules.md`
   - `<workspace>/CLAUDE.md` (Claude Code compatibility)
   - `<workspace>/AGENTS.md` (general Agent compatibility)

   The resolved rule file must remain inside the workspace. Symlinks pointing outside are skipped and the next priority is tried. Each file is limited to 16 KB.
2. **User-wide rules:**
   - `~/.pulse/instructions.md`
3. **Custom prompts (from config, CLI arguments, or API):**
   - Config fields `systemPrompt` / `systemPromptFile`
   - CLI options `--system-prompt` / `--system-prompt-file`
   - API: the service-layer `LocalHost` provides `getSystemPrompt()` / `setSystemPrompt(prompt)`, supporting dynamic settings in future Web and desktop UIs.

The model can ask you questions with `ask.choice`, `ask.multi`, and `ask.input`. These belong to the `ask.*` namespace and provide single-choice, multi-choice, and text input. A prompt can contain at most 2,000 characters and 50 options. Answers must be among the provided options, and single-choice lists do not wrap at the top or bottom. Answers continue in the next model context as part of the same run.

The current adapter does not expose sampling parameters such as `temperature`, `top_p`, and `presence_penalty` as shared config. Agent CLIs generally prioritize control of models, reasoning effort, tools, and permissions over overriding sampling parameters.

## Skill search and on-demand loading

When `skills` is enabled, Pulse scans `<name>/SKILL.md` in `~/.pulse/skills` (affected by `PULSE_HOME`) and under `trustedSkillRoots`. Project `.agents/skills` must be listed as an absolute path in user-level config. Scanning checks only directory names and file metadata, saving names in `skills-index.json` in the data directory; it does not read or store skill bodies. The index is refreshed at startup and when `/` is entered. Directories and files are checked again when invoked. Symlinks and skills with duplicate names across directories are excluded.

Type `/` in the input field to search commands and skill names; continue with a name fragment to filter, use ↑/↓ to select, Tab to complete, then enter a task and press Enter:

```text
/review Check the current changes
```

Built-in commands with the same name take precedence. A skill can always be invoked as `/skill:review Check the current changes`. Only the submitted skill body is added to the current task context; a later ordinary message does not inject the skill again. Wait for a task to finish or run `/cancel` before invoking another skill. A single body is limited to 64 KiB; the index is no longer limited by the former 32-loaded-skill cap. Skills provide untrusted reference instructions only; scripts and companion files are not automatically run or loaded.
