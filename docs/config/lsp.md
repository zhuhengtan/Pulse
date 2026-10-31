# Read-only code intelligence

The Host exposes `code.definition`, `code.references`, `code.symbols`, and
`code.diagnostics` for new runs. With no enabled server they report
`CODE_SERVER_UNAVAILABLE`; search, file reads and compiler checks remain available.
Existing saved runs retain their original tool surface.

Configure an **already installed** server in your user Pulse config. Workspace
config cannot enable LSP, including with `--trust-workspace`. No servers or
packages are downloaded. `languages` maps extensions to LSP language IDs:

```json
{"lsp":{"enabled":true,"servers":{
  "typescript":{"command":"typescript-language-server","args":["--stdio"],"languages":{".ts":"typescript",".tsx":"typescriptreact",".js":"javascript",".jsx":"javascriptreact"}},
  "python":{"command":"pylsp","languages":{".py":"python"}},
  "go":{"command":"gopls","languages":{".go":"go"}},
  "rust":{"command":"rust-analyzer","languages":{".rs":"rust"},"initializationOptions":{"checkOnSave":false}}
}}}
```

`enabled` must be the boolean `true`. Any other type is rejected and does not
start a server. Only enable entries you have installed. A run keeps the
configuration captured when it started; later host edits do not retarget that
run, and server entries cannot replace the workspace root.

Optional `readRoots` are explicit, read-only toolchain directories. The
filesystem root, the canonical home, and any ancestor of that home are rejected.
Windows compares those paths case-insensitively, without treating a sibling
prefix as a parent. Each process is scoped to one run/workspace/configuration,
reused between reads, and stopped with that run. The target gets temporary
HOME/cache directories, no workspace writes, no provider credentials and no
external network access. Servers that require compilation/cache writes in the
workspace are deliberately unsupported. There is no server-initiated edit,
command or dynamic registration support.

Inputs use one-based UTF-16 line/column; returned LSP ranges are zero-based.
Symbol results keep their hierarchy up to 100 nodes and 8 levels; extra nodes
set `truncated`. Flat symbol locations also keep name and kind. Other results
are bounded to 100 items. Parent paths, UNC paths, and remote file URLs are
rejected before they are opened; an in-workspace symlink is still resolved and
then rejected if its target leaves the workspace. Documents are bounded
to 2 MiB and 32 open documents per server. Protocol headers over 8192 bytes are
rejected whether or not the header is already complete; bodies stay within 2
MiB. Results include source hash/version and freshness. Unversioned push
results are `unverified`; changed documents are `stale`. Diagnostics are advisory,
not proof of successful builds. Navigation never grants full-file read coverage,
CAS authority or acceptance evidence. Use ordinary reads/checks for those.
