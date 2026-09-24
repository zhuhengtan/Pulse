# Pulse task-quality evaluation

This directory contains a fixed 24-task set: 8 code tasks, 8 source-backed research tasks, and 8 file-organization tasks. Each task records its goal, prompt, success criteria, scoring method, model capabilities, and declared side effects. The static grader checks only the declared artifact properties; a human must still review code behavior, research accuracy, citations, and ambiguous cases.

Validate the dataset without configuring a model:

```bash
node scripts/eval/validate.mjs
node scripts/eval/run.mjs --dry-run
```

The dry run lists the tasks and explicitly reports `qualityBaselineCreated: false`. It does not call a provider and must not be reported as an agent-quality result.

For a real-provider run, first build and pack the CLI. Configure Pulse with a provider and model, and make the configured provider key available through its environment variable. The runner reads the config but does not print its contents. It runs the packed public CLI entry point with a separate workspace and Pulse data directory for each task trial:

```bash
pnpm cli:build
pnpm cli:pack
node scripts/eval/run.mjs \
  --archive <archive-path-printed-by-cli-pack> \
  --config ~/.pulse/config.json \
  --model "<configured display name>" \
  --trials 3 \
  --out /tmp/pulse-eval-<run-name> \
  --auto-approve
```

`--auto-approve` is mandatory because most tasks need local workspace writes. Tool execution receives auto approval inside those task directories. `shell.exec` runs through the configured OS sandbox runtime on supported hosts; Pulse filesystem tools independently remain limited to the task workspace. The model process itself is outside that shell sandbox, so run evaluations only with a trusted provider configuration. The fixed prompts request local changes and read-only public web research. Network access is enabled only for tasks that declare it.

Each result directory contains `runs.jsonl`, `report.json`, task workspaces, and isolated Pulse data. The CLI currently exposes only status, text, and visible event messages. Therefore `tokenUsage` and `cost` are explicitly `null`, while `traceSummary` describes only visible JSONL events and is not a complete runtime trace. Research tasks receive mechanical presence/content checks, not a truthfulness score. A complete baseline sample means the full 24-task suite ran at least three times; this says the sample exists, not that it passed. Runs selected with `--task` are subsets and always report `qualityBaselineCreated: false`.

Generate a portable Markdown report from saved run rows:

```bash
node scripts/eval/report.mjs /tmp/pulse-eval-<run-name>/runs.jsonl
node scripts/eval/grade.mjs --task files-02 --workspace /tmp/pulse-eval-<run-name>/workspaces/files-02/trial-1
```
