import { renderToolCalls } from './tool-view.js'

export interface ApprovalToolInput {
  name: string
  input: Record<string, unknown>
}

export interface ApprovalToolPreview {
  name: string
  body: string
  truncated: boolean
}

export function describeApprovalTool(tool: ApprovalToolInput): ApprovalToolPreview {
  const view = renderToolCalls([{
    id: 'approval',
    name: tool.name,
    arguments: tool.input,
    status: 'running',
  }], { width: 100 })
  const hidden = Math.max(0, view.totalChars - view.shownChars)
  const notice = view.truncated
    ? `\n… 还有 ${hidden} 个字符未显示。批准会执行完整内容（共 ${view.totalChars} 个字符）。`
    : ''
  return { name: tool.name, truncated: view.truncated, body: `${view.lines.join('\n')}${notice}` }
}
