# Workspace search semantics and limits

`fs.search` (backed by `searchWorkspace` / `searchFiles` in
`packages/server/src/security.ts`) performs a bounded, read-only,
case-insensitive text search over the workspace. This document records the
exact semantics and the limits that keep a search from stalling or leaking
data outside the workspace.

## Matching

- Matching is case-insensitive: both the query and each line are compared with
  `toLocaleLowerCase()`, so `NEEDLE` matches `Needle here`.
- Each file is split on `\r?\n`; the reported `line` is the 1-based physical
  line number of the match. Line numbers are exact for both single-file and
  directory searches.
- Each returned `text` is the matched line truncated to its first 500
  characters. Truncation of the line text does not change `line`.
- A query must be non-empty (`fs.search` input is `z.string().min(1)`).

## Single file and directory search

- Pointing `path` at a file searches only that file; the returned `path` is the
  requested path (for example `README.md`).
- Pointing `path` at a directory walks it recursively; the returned `path` for
  each match is relative to the search root (for example `pkg/notes.txt`).
- A single-file search and a directory search that reaches the same file report
  the same `line` and `text`, so the two entry points stay consistent.

## What is skipped

- Files larger than **1,000,000 bytes (1 MB)** are not read: the size is checked
  with `lstat` before any read, so a large file is never loaded whole.
- Binary files (content containing a NUL byte) are skipped, including a
  single file selected directly by path.
- Symbolic links are never followed: an entry that is a symlink is skipped
  during traversal, and a symlink target that resolves outside the workspace is
  rejected by the path boundary with `PATH_OUTSIDE_WORKSPACE`.
- During directory traversal, entries whose name starts with `.` (for example
  `.git`) and any `node_modules` directory are skipped. Traversal continues with
  the remaining entries.
- Hidden entries are only skipped when encountered as children; an explicitly
  requested hidden directory is still searched.

## Bounds that prevent unbounded traversal

| Bound | Value | Meaning |
| --- | --- | --- |
| Depth | `SEARCH_MAX_DEPTH = 8` | Recursion stops below this depth. |
| Visited | `SEARCH_MAX_VISITED = 2_000` | Max entries/files inspected. |
| Results | `SEARCH_MAX_RESULTS = 100` | Max matches collected. |
| File size | `SEARCH_MAX_FILE_BYTES = 1_000_000` | Max bytes read per file. |

## Cancellation

Both entry points accept an optional `AbortSignal`. The signal is checked
before traversal, after resolving a path, after each read, and on each directory
listing. If the signal is aborted the search **throws `SEARCH_ABORTED`**; it
never resolves to an empty result, so a cancelled search cannot be mistaken for
a workspace with no matches.

`fs.search` forwards the tool execution context's `signal`, so cancelling the
run also cancels an in-flight search.

## Distinguishing "no match" from "not finished"

`searchFiles(root, query, directory?, depth?, visited?, matched?, signal?)`
keeps its original signature and returns only the match array, so existing
callers are unaffected.

`searchWorkspace(root, query, directory?, signal?)` returns statistics:

```ts
interface WorkspaceSearchResult {
  matches: SearchMatch[]        // { path, line, text }
  truncated: boolean            // true when a bound stopped the search
  reason: 'depth' | 'visited' | 'results' | null
  visited: number               // entries/files inspected
  matched: number               // matches collected
}
```

- `truncated: false` with `matches: []` means the workspace genuinely has no
  match.
- `truncated: true` means a bound was hit before the search finished; `reason`
  names the first bound reached (`depth`, `visited`, or `results`).

`fs.search` exposes `truncated`, `reason`, `visited`, and `matched` alongside
`matches` so model consumers can tell the two cases apart. No new dependencies
are introduced for any of this.
