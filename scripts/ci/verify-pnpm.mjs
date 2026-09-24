import { access } from 'node:fs/promises'
import { join } from 'node:path'

// action-setup owns this location. Do not infer pnpm's version-specific package layout.
const home = process.env.PNPM_HOME
if (!home) throw new Error('pnpm/action-setup did not expose PNPM_HOME')
const shim = join(home, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
await access(shim)
console.log(`Verified pnpm sandbox shim: ${shim}`)
