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
  --model "<providerId/modelId>" \
  --max-model-calls 16 \
  --max-turns 32 \
  --max-total-tokens 10000000 \
  --trials 3 \
  --out /tmp/pulse-eval-<run-name> \
  --auto-approve
```

`--auto-approve` is mandatory because most tasks need local workspace writes. Tool execution receives auto approval inside those task directories. `shell.exec` runs through the configured OS sandbox runtime on supported hosts; Pulse filesystem tools independently remain limited to the task workspace. The model process itself is outside that shell sandbox, so run evaluations only with a trusted provider configuration. The fixed prompts request local changes and read-only public web research. Network access is enabled only for tasks that declare it.

Models use the same provider-nested catalog and legacy normalization as Pulse. Prefer an explicit `providerId/modelId`; legacy flat model names and unique display names remain supported. Unknown or ambiguous references fail clearly. The DeepSeek credential default is `DEEPSEEK_API_KEY`; custom `apiKeyEnv` remains supported. Neither credentials nor config contents are printed.

`--max-model-calls` is the cumulative provider-attempt limit for each work run, including planning, approvals, compaction, verification, internal retries and restoration. `--max-calls` is a compatibility alias for this actual-call budget; its old meaning as a turn limit has been removed. `--max-turns` remains independent. Conflicting budget aliases fail. Use a current CLI supporting `--max-model-calls`; the runner cannot make an arbitrary old or third-party CLI enforce a flag.

`--max-total-tokens` reserves a conservative context-plus-output allowance before each trial; it is not an exact token ceiling. The batch stops before further trials if token usage is unavailable. An explicit `--max-cost` also stops on unknown provider prices, rather than treating them as zero. Cost is checked between trials and can exceed its ceiling during a trial. Resume retains original limits and cumulative records.

Each result directory contains `batch.json`, `runs.jsonl`, `report.json`, captured CLI output, task workspaces, and isolated Pulse data. JSONL results expose cumulative `usage` in both run and resume commands. Missing token and cost fields remain unknown. `traceSummary` describes only visible events and is not a complete runtime trace. Research tasks receive mechanical presence/content checks, not a truthfulness score. A complete baseline sample means the full 24-task suite ran at least three times; this says the sample exists, not that it passed. Runs selected with `--task` are subsets and always report `qualityBaselineCreated: false`.

## Resume an interrupted batch

Run the identical command with `--resume` and the same `--out` directory. Dataset, selected tasks, trial count, CLI source, model configuration and budget identity must match. Finished trials, including failed/cancelled/timed-out trials, are retained without rerunning them. Duplicate identical terminal rows are counted once; conflicting or malformed JSONL records fail without silently discarding evidence.

An unfinished trial with saved output resumes grading without calling the model. Otherwise the runner recovers its original Host conversation/run and persisted model budget using `pulse resume <id>` with no new task. Existing files are preserved. If the Host has already finished, saved outcome/usage are graded. Missing identity, a still-running process or a mismatched budget stops with an audit error; the runner never silently starts a replacement run. The original per-trial deadline is retained. Concurrent supervisors are refused; a stale lock can be reclaimed only after its owner process is absent.

Old output directories without `batch.json` cannot safely resume under the new accounting; preserve them for review. They are never auto-migrated into a fresh budget.

For custom SDK programs, see [long-task history configuration and diagnostics](../docs/sdk-long-tasks.md). Host already enables compaction; generic Runtime programs must opt in.

Generate a portable Markdown report from saved run rows:

```bash
node scripts/eval/report.mjs /tmp/pulse-eval-<run-name>/runs.jsonl
node scripts/eval/grade.mjs --task files-02 --workspace /tmp/pulse-eval-<run-name>/workspaces/files-02/trial-1
```

## Six-case long-task follow-up

The long-task harness freezes each independent round. To compare against the
historical maintenance fixtures, preserve the previous output and prepare a new
one with an explicit higher cap (never edit an old `budget.json`):

```sh
node scripts/eval/long-tasks.mjs prepare --out .pulse-dev/long-task-eval-round2-20261015 --sample-calls 64 --fixture-source .pulse-dev/long-task-eval-20261015/source
node scripts/eval/long-tasks.mjs preflight --out .pulse-dev/long-task-eval-round2-20261015
node scripts/eval/long-tasks.mjs run --out .pulse-dev/long-task-eval-round2-20261015
```

Six samples share a 384-request ceiling, with 64 per sample. There is no automatic
retry of finished samples. Both the repaired driver and the increased cap differ
from round one, so improvements cannot be attributed to either variable alone.
The grader requires changed deliverables, a working positive baseline before
negative conflict tests, a conflict-specific error and absence of partial output.
Unknown interview choices persist `pending-question.json` and wait for the owner;
they are neither guessed nor automatically cancelled. Only the confirmed defer
choice is automated at the final implementation gate. Human answers are supplied
in the case's `owner-answer.json` as `{ "effectId": "...", "value": ... }`.
