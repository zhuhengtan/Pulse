import { useState } from 'react'
import { Dropdown } from 'antd'
import { Icon } from './Icon.js'
import { PulseButton } from './PulseControls.js'

const modes = [
  { key: 'default', title: '跟随全局设置', label: '质量复核', description: '使用设置中的任务质量复核默认值。', icon: 'settings' as const },
  { key: 'on', title: '本次开启复核', label: '开启复核', description: '本次执行计划、阶段和最终质量复核。', icon: 'audit' as const },
  { key: 'off', title: '本次跳过复核', label: '跳过复核', description: '本次跳过质量复核，工具授权仍按原规则执行。', icon: 'close' as const },
]

export function QualityReviewSelect({ value, disabled, onChange }: { value: boolean | undefined; disabled: boolean; onChange: (value: boolean | undefined) => void }) {
  const [open, setOpen] = useState(false)
  const selected = value === undefined ? 'default' : value ? 'on' : 'off'
  const current = modes.find(mode => mode.key === selected)!
  return <Dropdown trigger={['click']} placement="topLeft" align={{ overflow: { adjustX: true, adjustY: true, shiftX: true } }} open={open} onOpenChange={setOpen} disabled={disabled}
    menu={{ selectable: true, selectedKeys: [selected], items: modes.map(mode => ({ key: mode.key, label: <div className="approval-mode-option">
      <Icon name={mode.icon} size={20}/><span><strong>{mode.title}</strong><small>{mode.description}</small></span><span className="approval-mode-check" aria-hidden="true">{mode.key === selected ? '✓' : ''}</span>
    </div> })), onClick: ({ key }) => { setOpen(false); onChange(key === 'default' ? undefined : key === 'on') } }}
    popupRender={menu => <div className="approval-policy-popup"><div className="approval-policy-heading"><strong>本次任务是否进行质量复核？</strong><small>仅影响本次新任务，工具授权保持不变</small></div>{menu}</div>}>
    <PulseButton type="button" className="approval-policy-select is-borderless" disabled={disabled} aria-label={`本次任务质量复核：${value === undefined ? '跟随全局' : value ? '开启' : '关闭'}`} aria-haspopup="menu" aria-expanded={open} title="仅影响下一次新任务的质量复核；不改变工具授权和安全审批。">
      <Icon name={current.icon} size={16}/><span>{current.label}</span>
    </PulseButton>
  </Dropdown>
}
