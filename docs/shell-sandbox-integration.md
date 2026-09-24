# Shell sandbox integration

Pulse uses @anthropic-ai/sandbox-runtime, with no unsandboxed fallback.

## Local toolchain

The installation containing the Node executable running Pulse is readable inside
SRT. The host's PNPM_HOME, when configured to a specific installation directory,
is also readable. Arbitrary PATH directories are not automatically granted access.
Node's bin directory and the workspace's node_modules/.bin are placed on PATH.
On Windows, supported npm/Corepack/pnpm JavaScript entrypoints beside Node are
invoked using Node directly, avoiding cmd-script argument reinterpretation.

On macOS, git is resolved through /usr/bin/xcrun --find git before sandbox entry,
so the command does not need to write xcrun caches outside its permitted paths.

POSIX commands use a temporary HOME/config/cache directory. User global Git
configuration and credentials are not imported. Workspace Git configuration is
still used. Commit identity, authenticated remotes, and extra external SDKs require
explicit integration; a working git status does not establish those capabilities.
The temporary directory is removed after execution. The workspace remains writable;
other user files and sibling workspaces remain restricted. SRT's Windows sandbox
account retains its own isolated profile.

## Windows prerequisites

`pulse doctor` includes SRT's dependency probe. Windows requires SRT's one-time
sandbox account and WFP setup. If the probe reports missing provisioning, follow
the upstream installation instruction (requires Windows elevation):

```
npx @anthropic-ai/sandbox-runtime@0.0.77 windows-install
```

Pulse does not run this privileged installation automatically. A failed setup
stops execution; it does not launch commands outside isolation.

## Verification recorded locally

On macOS: Node and pnpm by name, nested Node subprocess, Git init/status, and
pnpm exec tsc -b pass inside SRT. Contract tests include spaces/Chinese in paths,
output bounds, cancellation, timeout, and denied sibling-file access. Windows
entrypoint support and CI test coverage are implementation evidence only until
Windows execution results are available.
