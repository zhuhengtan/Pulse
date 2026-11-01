# Windows sandbox native corrections

Pulse builds `srt-win` from sandbox-runtime 0.0.77's exact source commit and
applies the native portion of upstream PR #523. `SOURCE.json` records both
commits and SHA-256 hashes. The source archive and patch must match those hashes.
The upstream Apache-2.0 license is retained here and in the packaged binary folder.
The owned-fixture round-trip test permits only Windows Server's documented
`D:(` to `D:AI(` canonicalization; all other descriptor bytes remain exact.
Parallel unit fixtures add a per-process atomic suffix to their timestamp so
Windows clock resolution cannot make them share an ACL-test directory. A frozen-clock
concurrency regression exercises this allocation without relaxing the ACL checks.

The patch makes parent delete-child guards object-local and avoids rewriting
unrelated descendants for object-only ACL changes. Full deny/grant propagation,
legacy cleanup, holder accounting, rollback and isolation remain enabled.

The same hash-verified patch also includes a Pulse stdin correction. After the
length-prefixed launch spec, the broker forwards caller input byte-for-byte until
EOF; the runner reads only the exact spec bytes without buffered prefetch. This
lets the sandboxed PTY bridge receive input rather than immediately observing EOF
and killing its target. Native pipe tests cover binary forwarding, EOF and a spec
coalesced with target input. The real Agent PTY test still requires input ACK,
target output and successful target/broker exits; cancellation and all restricted
token, Job, ACL and WFP boundaries remain in place.

On Windows, `pnpm desktop:build` runs the native ACL tests and builds the patched
binary into `packages/adapters/dist/native`. That directory is included in npm
packages and CLI archives. The release workflow transfers the same build from
the Windows job; it does not silently fall back to the original binary.

Remove this patch when a reviewed upstream release includes the equivalent fix,
after rerunning native tests and the complete cross-platform release gates.
