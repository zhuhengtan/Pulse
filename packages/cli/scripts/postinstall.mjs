import { ensurePulseUserConfig, defaultPulseConfigPath } from '../dist/config.js'

// Install-time welcome screen. Colors stay off for piped or captured install
// logs and can be forced with FORCE_COLOR for debugging.
const colorEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY === true || process.env.FORCE_COLOR !== undefined)

const paint = (code) => (text) => (colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text)
const cyan = paint('36')
const bold = paint('1')
const dim = paint('2')

const banner = [
  '██████╗ ██╗   ██╗██╗     ███████╗███████╗',
  '██╔══██╗██║   ██║██║     ██╔════╝██╔════╝',
  '██████╔╝██║   ██║██║     ███████╗█████╗  ',
  '██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  ',
  '██║     ╚██████╔╝███████╗███████║███████╗',
  '╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝',
].map((line) => cyan(line)).join('\n')

function printWelcome({ configPath, error } = {}) {
  const lines = [
    '',
    banner,
    '',
    `  ${bold('Pulse')} - a neural-signal like AI assistant for coding, research and file tasks.`,
    '',
    `  ${dim('Get started:')}`,
    `    ${cyan('cd project_dir')}`,
    `    ${cyan('pulse')}`,
    '',
  ]

  if (configPath) {
    // Print the fully resolved absolute path on its own, uncolored line so it
    // can be copied straight out of the terminal without ANSI escape codes.
    lines.push(`  ${dim('Config ready at')}`)
    lines.push(`    ${configPath}`)
  } else {
    lines.push(`  ${dim('Config not created:')} ${error}`)
    lines.push(`  ${dim('Run "pulse setup" later to create it.')}`)
  }

  lines.push('')
  console.log(lines.join('\n'))
}

try {
  const configPath = defaultPulseConfigPath()
  await ensurePulseUserConfig(configPath)
  printWelcome({ configPath })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  printWelcome({ error: message })
}
