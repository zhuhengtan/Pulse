import { stripTerminalControls } from './ansi.js'

const previewLimit = 1_000

export interface ApprovalToolInput {
  name: string
  input: Record<string, unknown>
}

export interface ApprovalToolPreview {
  name: string
  body: string
  truncated: boolean
}

function clip(value: string): { text: string; truncated: boolean } {
  const clean = stripTerminalControls(value)
  if (clean.length <= previewLimit) return { text: clean, truncated: false }
  const hidden = clean.length - previewLimit
  return {
    truncated: true,
    text: `${clean.slice(0, previewLimit)}\n… 还有 ${hidden} 个字符未显示。批准会执行完整内容（共 ${clean.length} 个字符）。`,
  }
}

function textField(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
}

export function describeApprovalTool(tool: ApprovalToolInput): ApprovalToolPreview {
  if (tool.name === 'fs.write') {
    const content = clip(textField(tool.input, 'content'))
    const path = stripTerminalControls(textField(tool.input, 'path'))
    return {
      name: tool.name,
      truncated: content.truncated,
      body: `路径: ${path}\n内容（${textField(tool.input, 'content').length} 个字符）:\n${content.text}`,
    }
  }
  if (tool.name === 'fs.apply_patch') {
    const find = clip(textField(tool.input, 'find'))
    const replace = clip(textField(tool.input, 'replace'))
    const path = stripTerminalControls(textField(tool.input, 'path'))
    const all = tool.input.all === true ? '全部匹配' : '第一处匹配'
    return {
      name: tool.name,
      truncated: find.truncated || replace.truncated,
      body: `路径: ${path}\n范围: ${all}\n- ${find.text}\n+ ${replace.text}`,
    }
  }
  if (tool.name === 'shell.exec') {
    const command = stripTerminalControls(textField(tool.input, 'command'))
    const args = Array.isArray(tool.input.args) ? tool.input.args.map((arg) => stripTerminalControls(String(arg))) : []
    const cwd = stripTerminalControls(textField(tool.input, 'cwd') || '.')
    return {
      name: tool.name,
      truncated: false,
      body: `命令: ${command}\n参数: ${args.join(' ') || '（无）'}\n目录: ${cwd}`,
    }
  }
  const serialized = clip(JSON.stringify(tool.input, null, 2))
  return { name: tool.name, truncated: serialized.truncated, body: serialized.text }
}
