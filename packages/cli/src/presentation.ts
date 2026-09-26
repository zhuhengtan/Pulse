import { releaseHighlights } from './release-highlights.generated.js'

export interface PresentationOptions {
  color?: boolean
}

const bannerLines = [
  '██████╗ ██╗   ██╗██╗     ███████╗███████╗',
  '██╔══██╗██║   ██║██║     ██╔════╝██╔════╝',
  '██████╔╝██║   ██║██║     ███████╗█████╗  ',
  '██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝  ',
  '██║     ╚██████╔╝███████╗███████║███████╗',
  '╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝',
]

function paint(code: string, enabled: boolean, value: string): string {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value
}

export function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return env.NO_COLOR === undefined && env.FORCE_COLOR !== '0' && (isTTY || env.FORCE_COLOR !== undefined)
}

function banner(color: boolean): string {
  return bannerLines.map((line) => paint('36', color, line)).join('\n')
}

export function formatVersionOutput(version: string, options: PresentationOptions = {}): string {
  const color = options.color === true
  const highlights = releaseHighlights[version]
  const lines = [
    banner(color),
    '',
    `  ${paint('1', color, 'Pulse')} ${paint('2', color, `v${version}`)}`,
    '',
    `  ${paint('1', color, '本版本亮点 / What’s new in this version')}`,
  ]

  if (highlights?.length) {
    for (const item of highlights) lines.push(`  • ${item.zh}`, `    ${item.en}`)
  } else {
    lines.push(
      '  暂无此版本的更新亮点记录。',
      '  No release highlights are available for this version yet.',
    )
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

export interface InstallWelcomeOptions extends PresentationOptions {
  version: string
  configPath?: string
  error?: string
}

export function formatInstallWelcome(options: InstallWelcomeOptions): string {
  const { color = false, version, configPath, error } = options
  const cyan = (value: string) => paint('36', color, value)
  const dim = (value: string) => paint('2', color, value)
  const lines = [
    '',
    banner(color),
    '',
    `  ${paint('1', color, 'Pulse')} v${version} — 面向编程、研究与文件工作的 AI 助手`,
    `  ${paint('1', color, 'Pulse')} — an AI assistant for coding, research, and file tasks`,
    '',
    `  ${paint('1', color, '开始使用 / Get started:')}`,
    `    ${cyan('cd project_dir')}`,
    `    ${cyan('pulse')}`,
    '',
  ]

  if (configPath) {
    lines.push(`  ${dim('配置已就绪 / Configuration ready at:')}`, `    ${configPath}`)
  } else {
    lines.push(`  ${dim('配置创建失败 / Configuration could not be created:')} ${error ?? 'Unknown error'}`)
    lines.push(`  ${dim('稍后运行 "pulse setup" 创建配置。 / Run "pulse setup" later to create it.')}`)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}
