# @hunterzhu/pulse-cli

[简体中文](https://github.com/zhuhengtan/Pulse/blob/main/packages/cli/README.zh-CN.md)

**A neural-signal like AI assistant for coding, research and file tasks.**

Pulse runs in your project folder, keeps conversations on your machine, and can resume unfinished work. Requires Node.js 22+.

## Install

Install the CLI globally so the `pulse` command is on your `PATH`:

```bash
npm install -g @hunterzhu/pulse-cli --foreground-scripts
pulse --version
```

For a one-off run, use `npx @hunterzhu/pulse-cli`. Commands below assume a global installation.

## Configure a model and API key

Create a starter configuration:

```bash
pulse setup
```

The configuration lives at `~/.pulse/config.json` (Windows:
`%USERPROFILE%\.pulse\config.json`). A fresh configuration includes the DeepSeek
provider and `deepseek-chat` model. Set `activeModel` to `deepseek-chat`, or use
`--model deepseek-chat` as below. The default `mock` model makes no API calls.

Set the API key in your shell; the DeepSeek provider uses
`apiKeyEnv: "DEEPSEEK_API_KEY"` to read it:

```bash
export DEEPSEEK_API_KEY="your-key"
# Windows PowerShell: $env:DEEPSEEK_API_KEY="your-key"
```

## Usage

```bash
pulse --model deepseek-chat                        # interactive session
pulse run "Summarize this project" --model deepseek-chat
pulse sessions
pulse resume <conversation-id> "Continue" --model deepseek-chat
pulse doctor
pulse --read-only
```

See `pulse --help` for all options.

## Links

- [Full CLI configuration guide](https://github.com/zhuhengtan/Pulse/blob/main/docs/cli-config.md)
- [Source code and documentation](https://github.com/zhuhengtan/Pulse)
