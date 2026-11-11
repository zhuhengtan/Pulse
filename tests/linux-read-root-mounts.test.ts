import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
const adapterRequire = createRequire(new URL('../packages/adapters/package.json', import.meta.url))
const { wrapCommandWithSandboxLinux } = await import(pathToFileURL(adapterRequire.resolve('@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js')).href)
const { quote } = await import(pathToFileURL(adapterRequire.resolve('@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js')).href)

// Native filesystem/seccomp coverage, independent of Linux network namespace
// availability. The full runShell/network boundary remains in shell-multi-root.
describe.runIf(process.platform === 'linux')('Linux overlapping read/write mounts', () => {
  it.each([false, true])('preserves child grants and explicit denies (readonly primary: %s)', async (readonly) => {
    const base = await mkdtemp(join(tmpdir(), 'pulse-linux-roots-'))
    const outer = join(base, 'sources'), primary = join(outer, 'primary'), peer = join(outer, 'peer'), privateRoot = join(base, 'private')
    try {
      for (const path of [primary, peer, privateRoot, join(primary, 'sealed'), join(primary, 'hidden'), join(primary, '.git', 'hooks')]) await mkdir(path, { recursive: true })
      await writeFile(join(peer, 'asset'), 'reference')
      await writeFile(join(privateRoot, 'secret'), 'private')
      await writeFile(join(primary, 'hidden', 'secret'), 'hidden')
      await symlink(privateRoot, join(primary, 'escape'))
      await symlink(peer, join(primary, 'peer-link'))
      await symlink(primary, join(outer, 'primary-link'))
      const script = `
        const fs = require('node:fs');
        const [primary, outer, peer, privateRoot] = process.argv.slice(1);
        const denied = action => { try { action(); return false } catch { return true } };
        const put = root => fs.writeFileSync(root + '/written', 'yes');
        console.log(JSON.stringify({
          primaryDenied: denied(() => put(primary)),
          parentDenied: denied(() => put(outer)),
          peerDenied: denied(() => put(peer)),
          peerRead: fs.readFileSync(peer + '/asset', 'utf8'),
          privateDenied: denied(() => fs.readFileSync(privateRoot + '/secret')),
          escapeDenied: denied(() => fs.readFileSync(primary + '/escape/secret')),
          peerLinkDenied: denied(() => put(primary + '/peer-link')),
          primaryLinkDenied: denied(() => put(outer + '/primary-link')),
          sealedDenied: denied(() => put(primary + '/sealed')),
          hiddenDenied: denied(() => fs.readFileSync(primary + '/hidden/secret')),
          hooksDenied: denied(() => put(primary + '/.git/hooks')),
          hooksParentRenameDenied: denied(() => fs.renameSync(primary + '/.git', primary + '/moved-git')),
        }));
      `
      // Both input orders used to bury a writable child under a restored
      // readonly ancestor. No rewrite of the resulting shell command occurs.
      for (const reads of [[primary, peer, outer], [outer, peer, primary]]) {
        const command = await wrapCommandWithSandboxLinux({
          command: quote([process.execPath, '-e', script, primary, outer, peer, privateRoot]),
          needsNetworkRestriction: false,
          readConfig: { denyOnly: [base, join(primary, 'hidden')], allowWithinDeny: reads },
          writeConfig: { allowOnly: readonly ? [] : [primary], denyWithinAllow: [join(primary, 'sealed'), join(primary, '.git', 'hooks')] },
          binShell: '/bin/bash',
        })
        const result = await promisify(execFile)('/bin/bash', ['-c', command], { cwd: outer, timeout: 30_000 })
        expect(JSON.parse(result.stdout)).toEqual({
          primaryDenied: readonly, parentDenied: true, peerDenied: true, peerRead: 'reference',
          privateDenied: true, escapeDenied: true, peerLinkDenied: true, primaryLinkDenied: readonly,
          sealedDenied: true, hiddenDenied: true, hooksDenied: true, hooksParentRenameDenied: true,
        })
      }
      if (!readonly) expect(await readFile(join(primary, 'written'), 'utf8')).toBe('yes')
      expect(await readFile(join(peer, 'asset'), 'utf8')).toBe('reference')
    } finally { await rm(base, { recursive: true, force: true }) }
  }, 120_000)
})
