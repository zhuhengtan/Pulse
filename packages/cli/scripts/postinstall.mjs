import { createRequire } from 'node:module'
import { ensurePulseUserConfig, defaultPulseConfigPath } from '../dist/config.js'
import { formatInstallWelcome, shouldUseColor } from '../dist/presentation.js'

const { version } = createRequire(import.meta.url)('../package.json')
const color = shouldUseColor(process.env, process.stdout.isTTY === true)

try {
  const configPath = defaultPulseConfigPath()
  await ensurePulseUserConfig(configPath)
  process.stdout.write(formatInstallWelcome({ version, configPath, color }))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(formatInstallWelcome({ version, error: message, color }))
}
