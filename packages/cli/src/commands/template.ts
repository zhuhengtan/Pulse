import type { LocalHostOptions } from '@hunterzhu/pulse-server'
import { runOneShot } from './run.js'

type TaskTemplate = { version: 1; name: string; description: string; parameters: string[]; deliverables: string[]; acceptance: string[]; prompt: string }
const templates: TaskTemplate[] = [
  { version: 1, name: 'code-review', description: '审查当前工作区中的代码变更并给出有证据的问题清单。', parameters: ['focus'], deliverables: ['按严重程度排序的 findings', '文件路径与行号'], acceptance: ['每条问题有可复核代码证据', '不把风格偏好列作缺陷'], prompt: '审查当前工作区代码变更。重点：{{focus}}。只报告能从源码证明的问题，按严重度排序，给出路径和行号；若没有发现，说明审查范围和未覆盖部分。' },
  { version: 1, name: 'research', description: '围绕问题检索资料并整理可追溯结论。', parameters: ['question', 'sources'], deliverables: ['结论摘要', '来源及支持的主张'], acceptance: ['区分事实与推断', '每项关键结论附来源'], prompt: '研究问题：{{question}}。优先使用这些来源范围：{{sources}}。给出结论、证据链接、更新时间和不确定性；无法核验的内容标明未知。' },
  { version: 1, name: 'file-organization', description: '按规则整理工作区文件，先规划并遵守工具审批。', parameters: ['rules'], deliverables: ['整理后的文件', '移动清单'], acceptance: ['不覆盖已有目标', '总结每次移动'], prompt: '按以下规则整理当前工作区文件：{{rules}}。先检查现状并制定计划，再执行获批的移动；遇到目标冲突时跳过并报告。' },
  { version: 1, name: 'project-health', description: '检查项目入口、构建、测试和近期变更，报告健康状态。', parameters: ['scope'], deliverables: ['检查结果', '风险与建议'], acceptance: ['运行检查前说明具体命令', '区分已验证和推测'], prompt: '检查项目健康状态，范围：{{scope}}。阅读项目脚本与文档，运行适用的本地只读检查，汇报证据、失败和未覆盖项；不得安装、发布或修改文件。' },
]
function render(template: TaskTemplate, values: string[]): string {
  if (values.length !== template.parameters.length) throw new Error(`TEMPLATE_ARGUMENTS_REQUIRED:${template.name}:${template.parameters.join(',')}`)
  let prompt = template.prompt
  template.parameters.forEach((name, index) => { prompt = prompt.replaceAll(`{{${name}}}`, values[index] ?? '') })
  return prompt
}
export async function runTemplateCommand(options: LocalHostOptions, args: string[], format: string, version: string): Promise<number> {
  const [action, name, ...values] = args
  if (action === 'list') { process.stdout.write(templates.map(item => `${item.name}\t${item.description}`).join('\n') + '\n'); return 0 }
  const template = templates.find(item => item.name === name)
  if (!template) throw new Error(action === 'run' || action === 'show' ? `TEMPLATE_NOT_FOUND:${name ?? ''}` : 'TEMPLATE_ACTION_REQUIRED')
  if (action === 'show') { process.stdout.write(`${JSON.stringify(template, null, 2)}\n`); return 0 }
  if (action !== 'run') throw new Error('TEMPLATE_ACTION_REQUIRED')
  return runOneShot(options, render(template, values), format, version)
}
