import { Children, forwardRef, isValidElement, useEffect, useImperativeHandle, useRef } from 'react'
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { App, Button, Checkbox, Collapse, Input, Select } from 'antd'
import type { InputRef } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea.js'
import './controls.css'

function definedProps<T extends object>(props: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
}

/** Ant Design controls with Pulse's existing layout classes and native form semantics. */
export const PulseButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'>>(function PulseButton({ type = 'submit', className = '', ...props }, ref) {
  return <Button {...definedProps(props)} ref={ref} type="text" htmlType={type} className={`pulse-button ${className}`} />
})

export const PulseInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input>>(function PulseInput({ className = '', ...props }, ref) {
  const input = useRef<InputRef>(null)
  useImperativeHandle(ref, () => input.current!.input!, [])
  return <Input {...props} ref={input} className={`pulse-input ${className}`} />
})

export const PulseTextArea = forwardRef<HTMLTextAreaElement, ComponentProps<typeof Input.TextArea>>(function PulseTextArea({ className = '', ...props }, ref) {
  const input = useRef<TextAreaRef>(null)
  useImperativeHandle(ref, () => input.current!.resizableTextArea!.textArea, [])
  return <Input.TextArea {...props} ref={input} className={`pulse-textarea ${className}`} />
})

export function PulseCheckbox({ className = '', ...props }: ComponentProps<typeof Checkbox>) {
  return <Checkbox {...props} className={`pulse-checkbox ${className}`} />
}

type Option = { value: string; label: ReactNode; disabled?: boolean }
function selectOptions(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child)) return []
    if (child.type === 'option') return [{ value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, ...(child.props.disabled === undefined ? {} : { disabled: child.props.disabled }) }]
    return selectOptions(child.props.children)
  })
}

type PulseSelectProps = Omit<ComponentProps<typeof Select<string>>, 'options' | 'children'> & { children?: ReactNode }
/** Accepts declarative option children while rendering Ant Design's accessible popup. */
export function PulseSelect({ children, className = '', value, defaultValue, onChange, ...props }: PulseSelectProps) {
  return <Select<string> {...props} {...(value === undefined ? {} : { value })} {...(defaultValue === undefined ? {} : { defaultValue })} {...(onChange ? { onChange } : {})} options={selectOptions(children)} className={`pulse-select ${className}`} popupMatchSelectWidth={false} />
}

export function PulseDisclosure({ label, children, className = '', defaultOpen = false, onOpen, open, onToggle }: { label: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean; onOpen?: () => void; open?: boolean; onToggle?: (open: boolean) => void }) {
  return <Collapse ghost className={`pulse-disclosure ${className}`} defaultActiveKey={defaultOpen ? ['content'] : []} {...(open === undefined ? {} : { activeKey: open ? ['content'] : [] })} onChange={keys => { onToggle?.(keys.includes('content')); if (keys.includes('content')) onOpen?.() }} items={[{ key: 'content', label, children }]} />
}

/** Context-aware Ant Design dialogs; cancellation never authorizes a mutation. */
export function usePulseDialogs() {
  const { modal } = App.useApp()
  return {
    alert: (content: string) => { modal.error({ title: '操作未完成', content, okText: '知道了' }) },
    confirm: (content: string) => new Promise<boolean>(resolve => {
      modal.confirm({ title: '请确认', content, okText: '确认', cancelText: '取消', onOk: () => { resolve(true) }, onCancel: () => { resolve(false) } })
    }),
    prompt: (title: string, initialValue = '') => new Promise<string | null>(resolve => {
      let value = initialValue
      const accept = () => { resolve(value); dialog.destroy() }
      const dialog = modal.confirm({ title, icon: null, content: <Input autoFocus defaultValue={initialValue} aria-label={title} onChange={event => { value = event.target.value }} onPressEnter={accept} />, okText: '确认', cancelText: '取消', onOk: () => { resolve(value) }, onCancel: () => { resolve(null) } })
    }),
  }
}

export function PulseToast({ text }: { text: string }) {
  const { message } = App.useApp()
  useEffect(() => {
    void message.open({ key: 'pulse-notice', content: <span role="status">{text}</span>, duration: 3 })
    return () => message.destroy('pulse-notice')
  }, [message, text])
  return null
}
