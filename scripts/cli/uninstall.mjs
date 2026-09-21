import { rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
const root = process.env.PULSE_HOME ?? process.env.PULSE_INSTALL_ROOT ?? join(homedir(), '.pulse'); const link = join(root, 'bin/pulse'); const content = await readFile(link, 'utf8').catch(() => ''); if (!content.includes('versions/pulse/') || !content.includes('exec node')) { console.error('Refusing to remove an unmanaged pulse entry'); process.exit(1) } await rm(link, { force: true }); console.log(`Removed ${link}; user data was preserved.`)
