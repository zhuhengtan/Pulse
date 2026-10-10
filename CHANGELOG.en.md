# Pulse Changelog

This file records Pulse release notes in English and is the source for `pulse --version` highlights. See [CHANGELOG.md](CHANGELOG.md) for Chinese. Historical entries are reconstructed from Git tags and commits; early releases use high-level summaries.

## [0.4.6] - 2026-10-10

### Added

- Jarvis sessions, project context, execution events, and candidate memories can be enabled through CLI flags, environment variables, or user configuration; integration is off by default and execution continues independently if the service is unavailable.

### Fixed

- Tool events send only execution identifiers, tool names, and statuses to keep credentials in arguments, file contents, and outputs out of memory; outbound text redacts common credential forms.
- Persist each run's Jarvis session, context, and recorded events so restored runs retain context without replaying recorded events.
- Event recording no longer depends on UI consumption, and completion waits for the current run's writes; concurrent runs do not wait for each other's memory writes.
- Candidate memory titles are normalized to a single line and capped in length; only accepted tasks are recorded as successful, and workspace configuration cannot enable Jarvis or override its endpoint.

## [0.4.5] - 2026-10-10

### Improved

- Complex tasks are no longer cut off by a run-wide model-call ceiling; stage limits, runtime limits, and loop detection still bound execution, while older sessions retain their original budget semantics.
- Large-task context expands on demand from the current objective and stage along dependencies, evidence, and file paths, while preserving user requirements and the latest exchange.
- The CLI displays each tool call's status, file-edit diff, and command or read preview to make parallel execution and approval contents easier to inspect.

### Fixed

- Context expansion can continue from previously reached nodes after session restoration; remaining messages and file paths in the objective can be retrieved correctly.
- Final acceptance feeds invalid evidence-reference errors back into retries to avoid repeatedly submitting the same result.
- Staged writes and appends include approval previews; long diffs retain tail edits, and hidden content and blank lines are correctly marked as truncated.

## [0.4.4] - 2026-10-07

### Fixed

- Multi-stage tasks receive complete tool definitions and retain verified evidence across retries and dependencies; verification or report corrections no longer force redundant file edits.
- Added validation progress checkpoints to reduce repeated completed checks; new files favor small creation steps, and uncommitted drafts do not count as finished work.
- Final acceptance no longer treats unverifiable results as success, missing deliverables can recover, and final reports retain the actual delivered content.
- Improved DeepSeek tool-call and structured-output recovery, read-only task recognition, and baseline testing before edits.
- `pulse resume` inherits the original task and keeps previous-run summaries read-only; runtime limits can be set through `--max-runtime-ms`, an environment variable, or configuration.

## [0.4.3] - 2026-09-29

### Added

- OpenAI-compatible requests send the configured reasoning effort, and o1/o3 models use `max_completion_tokens`. If one model rejects that parameter, only that model is disabled and the request is retried.
- The DeepSeek protocol still uses JSON object mode with schema guidance. Other protocols keep JSON schema even when the model name contains deepseek.

## [0.4.2] - 2026-09-29

### Fixed

- Stage acceptance requires every cited reference to be valid. Stages that touch files, commands, or tests need successful tool evidence, while pure writing stages can still pass on the candidate result.
- DeepSeek recovery no longer treats unnamed JSON as a file write or shell command. Trailing text stays text, and invalid DSML parameters are treated as truncation.
- Staged writes and commits reject `.pulse` paths. Listing a missing directory returns ENOENT, while an existing empty directory still returns an empty list.
- Command splitting respects quotes. Commands launched through shells such as `sh -c` or `bash -c` are rejected.
- `pulse resume` returns to the interactive screen on a terminal. A non-interactive run that already has a task no longer waits on idle stdin, and explicit mock flags can override `PULSE_MODEL`.

## [0.4.1] - 2026-09-26

### Added

- Added on-demand Skill discovery and invocation to keep unrelated instructions out of task context.
- Polished the installation welcome screen and version page with bilingual product information and release highlights.
- Added separate Chinese and English changelogs and bilingual user documentation, with validation for version highlights.
- Licensed all five npm packages under PolyForm Noncommercial 1.0.0 and included package-level license notices.

## [0.4.0] - 2026-09-25

### Changed

- Uses an asynchronous, parallel event loop by default so model requests, tool calls, and other effects can progress concurrently.

## [0.3.0] - 2026-09-25

### Added

- Improved CLI interaction with text selection and copying, reasoning-usage attribution, streamed task progress, and resumable sessions.

## [0.2.1] - 2026-09-24

### Added

- Added the post-install welcome screen and improved the shared cross-platform local and cloud CI entry point.

## [0.2.0] - 2026-09-24

### Improved

- Expanded CLI and Host capabilities with resumable sessions, human interaction, tool calls, and improved Windows sandbox and release validation.

## [0.1.11] - 2026-09-23

### Fixed

- Fixed loading the packaged CLI entry point on Windows and improved cross-platform installation and release validation.

## [0.1.10] - 2026-09-23

### Maintenance

- Maintenance release; no separate user-facing changes were recorded.

## [0.1.9] - 2026-09-23

### Maintenance

- Maintenance release; no separate user-facing changes were recorded.

## [0.1.8] - 2026-09-23

### Added

- Added first-run configuration initialization after npm installation.

## [0.1.7] - 2026-09-23

### Added

- Added a full-screen CLI workspace, model configuration, and interactive session capabilities.

## [0.1.6] - 2026-09-22

### Added

- Added human-input arbitration and active CLI interaction, while strengthening context, persistence, and streamed tool calls.

## [0.1.5] - 2026-09-22

### Improved

- Improved compatibility of tool names across providers.

## [0.1.4] - 2026-09-22

### Fixed

- Fixed adapter handling for provider-safe tool names.

## [0.1.3] - 2026-09-22

### Improved

- Improved CLI tool exposure, user-file locations, and provider error reporting.

## [0.1.2] - 2026-09-22

### Fixed

- Fixed CLI reporting of the installed package version.

## [0.1.1] - 2026-09-22

### Improved

- Improved first-run configuration setup and basic npm workspace usage.

## [0.1.0] - 2026-09-22

### Added

- Established the initial Pulse CLI npm package and repository release metadata.
