import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeShellSandbox } from '../packages/adapters/src/tools/sandbox-initialization.js'
import { runShell } from '../packages/adapters/src/tools/shell.js'
import { verifiedWindowsSrt } from '../packages/adapters/src/tools/windows-srt-path.js'

const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
const { SandboxManager } = await import(pathToFileURL(adapterRequire.resolve('@anthropic-ai/sandbox-runtime')).href)

it.skipIf(process.platform !== 'win32')('cleans up every native ACL batch after a later batch fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-native-acl-batches-'))
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const files = Array.from({ length: 24 }, (_, i) => join(root, `private-${i}.txt`))
    await Promise.all(files.map((file, i) => writeFile(file, `private-${i}`)))
    // Denies on hardlinked files are deliberately refused by the native broker.
    // Two earlier batches must have landed before the third encounters this.
    await link(files[20]!, join(root, 'hardlink.txt'))
    const binary = verifiedWindowsSrt()
    await expect(initializeShellSandbox({
      network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
      filesystem: { allowRead: [workspace, dirname(binary), dirname(process.execPath)], allowWrite: [workspace], denyRead: files, denyWrite: [] },
      windows: { srtWin: { path: binary } },
    })).rejects.toMatchObject({ code: 'acl_stamp_failed' })
    await SandboxManager.reset()
    // File 12 belonged to the manually applied second batch, outside the SDK's
    // initial cached list. A fresh workspace grant cannot override a leaked
    // explicit deny on that file, so this exercises the real holder-ledger reset.
    const result = await runShell('node', ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', files[12]!], { cwd: root, timeoutMs: 30_000 })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('private-12')
  } finally {
    await SandboxManager.reset()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 240_000)
