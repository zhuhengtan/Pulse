import { ensurePulseUserConfig, defaultPulseConfigPath } from '../dist/config.js'

try {
  const configPath = defaultPulseConfigPath()
  await ensurePulseUserConfig(configPath)
  console.log(`Pulse config is ready at ${configPath}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`Pulse could not create its default config: ${message}`)
  console.warn('Run "pulse setup" later to create it.')
}
