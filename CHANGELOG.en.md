# Pulse Changelog

This file records Pulse release notes in English and is the source for `pulse --version` highlights. See [CHANGELOG.md](CHANGELOG.md) for Chinese. Historical entries are reconstructed from Git tags and commits; early releases use high-level summaries.

## [0.8.0] - 2026-10-24

### Added

- Added the Pulse desktop client with local conversation storage, model settings, device management, and a native browser, reusing existing projects and conversation data.
- Added a unified tabs panel for documents, images, code diffs, and browser pages; plan confirmation links open previews directly, and the panel stays closed on first launch.
- Added queued follow-up messages and model-directed steering, preserving input order while keeping question replies separate from the message queue.
- Added the Pulse product website and repository download entry points, with macOS, Windows, and Linux clients, version-specific downloads, and SHA-256 checksums in public releases.
- Added development diagnostics, code snapshots, and autonomous-task regression tools to supervise repairs and check actual deliverables and acceptance evidence.

### Fixed

- Question cards show text inputs directly and can be closed without answering; dismissal does not submit drafts, infer choices, or grant execution permission.
- Improved plan criterion identifier normalization, analysis-stage evidence handling, interrupted parallel Lane restoration, and continuation after read or verification failures.
- Data services use a bounded startup-readiness handshake, retain exit and startup diagnostics, confirm writer readiness before reconnecting, and release database files when the last client explicitly closes, avoiding shutdown races, premature cold-start failures, and locked files on Windows.
- Fixed npm lifecycle startup through isolated PATH entries in the macOS sandbox while retaining explicit workspace and environment script-shell settings.
- Reuse message date formatters and Markdown parsers, bound cached syntax trees, and defer unopened message menus to reduce rendering work when switching long histories; fix initial scroll listeners and position restoration after virtual-row height changes.
- Fixed merging ignored data directories from workspaces, tightened Git reads and paired-device permissions, and prevented implicit pnpm dependency reinstalls.
- Fixed truncated equals signs in inline CLI arguments and refined rich-text composition, project navigation, approval menus, and execution progress display.

## [0.7.0] - 2026-10-19

### Added

- Added a rich-text composer with skill and file mentions, pasted and dropped attachments, and conversation-specific drafts.
- Added paginated attachment reading for text, code, PDF, XLSX, and DOCX text; PNG/JPEG continue through image input, with stronger format, size, and parsing limits.
- Added addressable Web pages, conversations, and workspace positions with browser history and refresh restoration; mobile clients can select host files or directories and create project folders.
- Added desktop Web import and export for work conversations, including attachments and recovery state, with sensitive configuration removed and recovery prerequisites rechecked after transfer.
- Review the complete plan for consistency after edits and bind confirmation to its current content, reducing contradictions and repeated revisions.

### Fixed

- Clear submitted drafts immediately, retain retry controls and restore the originating draft on failure, and prevent session switches, asynchronous attachment reads, and queued chat messages from overwriting one another.
- Fixed approval loss during context compaction and task recovery, mobile confirmation failures, tool timeout handling, and missing attachment and reference fields in worker messages.
- Improved mobile header spacing, breadcrumbs, sidebar labels and project folding, refined the stop button, and hid conversation transfer controls on phones.
- Removed the duplicate task panel above work chats while retaining Lane activity and recovery actions in the message list; delivery files now appear compactly below their own turns, with full paths expandable on demand.
- Fixed Windows path and check-inventory formats, line-ending changes in transferred workspaces, send failures caused by briefly locked state files, and result-cleanup races during shutdown; run platform-specific regressions early in CI.


## [0.6.0] - 2026-10-17

### Added

- Added managed browser and desktop automation with page observation, screenshot actions, uploads and downloads, pause, and human takeover through CLI and H5 controls.
- The Web workbench displays task execution traces, stage progress, and tool-call details to make run status and approval requests easier to inspect.

### Fixed

- Improved context compaction, tool-input recovery, loop detection, and budget handling for long tasks, preserving state and call accounting across interrupted runs.
- Schedule independent stages in parallel when explicitly requested, and fix worker state access and dependency evidence propagation.
- Bind execution confirmation to the saved plan and require confirmation again after changes; approvals retain human fallback and operation scope checks.
- Protect original tests and acceptance commands by rejecting destructive patches before writes, while allowing authorized additions and corrections to new tests.
- Fix evidence freshness, recovery from invalid citations, and recognition of passing test supersets that cover earlier failed subsets, reducing redundant checks and false blocks.
- Fix Windows read-only isolation for installed dependencies, read boundaries for adjacent source, script approval path display, and batched sandbox permission initialization; reduce recursive dependency grants for unrelated scripts and improve cross-platform regression checks.
- H5 shutdown waits for assistant launches already in progress to settle and preserves later queued messages; atomic conversation writes prevent concurrent read errors and hanging requests.

## [0.5.1] - 2026-10-13

### Added

- Models are managed under providers, allowing different providers to register the same model name; defaults, assistant chat, task routing, instant replies, and approval review all select registered models.
- Added project sidebar organization and improved workspace trust boundaries and model configuration migration.

### Fixed

- Instant replies use the selected provider's protocol and connection settings; approval review remains restricted to local Ollama and falls back to human review on errors.
- Improved Jarvis experience recording, context filtering, and durable delivery workflows.

## [0.5.0] - 2026-10-12

### Added

- Added a standalone Web workbench for assistant chats, project work sessions, history, settings, and local terminals.
- Project tasks run in separate worker processes and Git worktrees that inherit current project edits and merge accepted results; non-Git projects use exclusive locks for serial execution.
- The assistant can invoke project, work-session, and Jarvis tools, track task status, and recover interrupted interactions through a persistent message inbox.
- Related clarification questions can be answered as one group; retrieved Jarvis context is selected for the current request before execution.

### Fixed

- Workspace delivery compares against the task's starting snapshot, merges already committed results, and supports retries after conflict resolution; non-Git retries retain shared-directory locking.
- Jarvis synchronization preserves observation and result event types and supports older queues; full queues retain undelivered writes and candidates under review, explicitly rejecting new requests that cannot be accepted.
- Improved H5 live messages, tool approvals, device authentication, and worker configuration transfer, and included the complete Web assets in packages.
- Fixed task acknowledgement and service status messages while retaining compatibility with existing run records and tool definitions.

## [0.4.7] - 2026-10-11

### Added

- Added an H5 mobile assistant with QR pairing, device management, live conversations, tool approvals, and background services on macOS and Linux.
- Added local Ollama instant replies and structured task briefs that use recent dialogue to interpret clarification answers.

### Fixed

- Jarvis events, candidate memories, and session completion use a durable outbox and idempotency keys; failed writes can be retried after restoration, and state advances only after acknowledgement.
- Mid-run user input is recorded as Jarvis observation events; candidate memories reference sessions that Jarvis can resolve as evidence.
- Changed the default H5 port to 7332 to avoid conflicts with Jarvis MCP; background services preserve custom ports and reject random ports.
- Fixed mobile event and approval flows, session workspace restrictions, Host validation, and title escaping; network services keep manual approval by default.

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
