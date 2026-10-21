import { useCallback, useEffect, useRef, useState } from 'react'
import { Dropdown } from 'antd'
import { Icon } from './Icon.js'
import { PulseButton } from './PulseControls.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

type ApprovalPolicy = 'manual' | 'delegate'
const modes = [
  { key: 'manual' as const, title: '人工审核', description: '需要审批的操作由你确认后执行。', icon: 'audit' as const },
  { key: 'delegate' as const, title: '自动审核', description: '由本机模型代审；风险不明或审核不可用时交给你确认。', icon: 'shield' as const },
]

export function useApprovalPolicy(transport: PulseWebTransport, enabled: boolean) {
  const [policy, setPolicy] = useState<ApprovalPolicy>('manual')
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [reload, setReload] = useState(0)
  const saving = useRef(false)
  const revision = useRef(0)
  useEffect(() => {
    if (!enabled) return
    let stopped = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (saving.current) return
      const version = ++revision.current
      try {
        const result = await apiJson<{ policy: ApprovalPolicy }>(transport, '/api/approval-policy')
        if (!stopped && version === revision.current && (result.policy === 'manual' || result.policy === 'delegate')) {
          setPolicy(result.policy); setReady(true)
        }
      } catch { /* Keep the last confirmed policy while disconnected. */ }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh() }
    const changed = () => {
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh() }, 500)
    }
    void refresh()
    const off = transport.onChange?.(changed)
    const offConnection = transport.onConnection?.(connected => { if (connected) void refresh() })
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; clearTimeout(refreshTimer); off?.(); offConnection?.(); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [transport, enabled, reload])
  const save = useCallback(async (next: ApprovalPolicy) => {
    if (saving.current) return false
    saving.current = true; ++revision.current; setPending(true)
    try {
      const result = await apiJson<{ policy: ApprovalPolicy }>(transport, '/api/approval-policy', jsonRequest('PUT', { policy: next }))
      if (result.policy !== next) throw new Error('APPROVAL_POLICY_NOT_SAVED')
      setPolicy(result.policy); setReady(true)
      return true
    } finally { saving.current = false; setPending(false) }
  }, [transport])
  return { policy, ready, pending, save, retry: () => setReload(value => value + 1) }
}

export function ApprovalPolicySelect({ value, disabled = false, unavailable = false, onRetry, onChange, borderless = false }: { value: ApprovalPolicy; disabled?: boolean; unavailable?: boolean; onRetry?: () => void; onChange: (value: ApprovalPolicy) => void; borderless?: boolean }) {
  const [open, setOpen] = useState(false)
  const current = modes.find(mode => mode.key === value)!
  return <Dropdown trigger={['click']} placement="topLeft" align={{ overflow: { adjustX: true, adjustY: true, shiftX: true } }} open={open} onOpenChange={setOpen} disabled={disabled}
    menu={{ selectable: true, selectedKeys: unavailable ? [] : [value], items: modes.map(mode => ({ key: mode.key, disabled: unavailable, label: <div className="approval-mode-option">
      <Icon name={mode.icon} size={20}/><span><strong>{mode.title}</strong><small>{mode.description}</small></span><span className="approval-mode-check" aria-hidden="true">{!unavailable && mode.key === value ? '✓' : ''}</span>
    </div> })), onClick: ({ key }) => { setOpen(false); onChange(key as ApprovalPolicy) } }}
    popupRender={menu => <div className="approval-policy-popup"><div className="approval-policy-heading"><strong>如何审核 Pulse 的操作？</strong><small>全局生效，切换会话和重启后保留</small>{unavailable && <div className="approval-policy-retry" role="status">尚未读取审核设置<PulseButton type="button" onClick={onRetry}>重试</PulseButton></div>}</div>{menu}</div>}>
    <PulseButton type="button" className={`approval-policy-select ${borderless ? 'is-borderless' : ''}`} disabled={disabled} aria-label={`审核模式：${unavailable ? '尚未读取' : current.title}`} aria-haspopup="menu" aria-expanded={open}>
      <Icon name={current.icon} size={16}/><span>{unavailable ? '审核方式' : current.title}</span>
    </PulseButton>
  </Dropdown>
}
