import { rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = process.env.PULSE_HOME ?? process.env.PULSE_INSTALL_ROOT ?? join(homedir(), '.pulse')
const windows = process.platform === 'win32'
const launcher = join(root, 'bin', windows ? 'pulse.cmd' : 'pulse')
const content = await readFile(launcher, 'utf8').catch(() => '')
const managed = windows
  ? content.includes('REM Pulse CLI managed launcher') && content.includes('versions\\pulse\\')
  : content.includes('Pulse CLI managed launcher') && content.includes('versions/pulse/')

if (!managed) {
  console.error('Refusing to remove an unmanaged pulse entry')
  process.exit(1)
}

await rm(launcher, { force: true })
console.log(`Removed ${launcher}; user data was preserved.`)
