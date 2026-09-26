# Pulse Changelog

This file records Pulse release notes in English and is the source for `pulse --version` highlights. See [CHANGELOG.md](CHANGELOG.md) for Chinese. Historical entries are reconstructed from Git tags and commits; early releases use high-level summaries.

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
