import { useEffect, useState, type ReactNode } from 'react'
import { ConfigProvider } from 'antd'
import type { PendingInteraction } from './InteractionPanel.js'
import { PulseButton } from './PulseControls.js'
import './chat-surface.css'

export type ChatState = 'idle' | 'running' | 'approval' | 'question' | 'sending' | 'stopping' | 'stopped'
export function deriveChatState({ running, stopping, submitting, interaction, stopped }: { running: boolean; stopping: boolean; submitting: boolean; interaction?: PendingInteraction | undefined; stopped: boolean }): ChatState {
  if (stopping) return 'stopping'
  if (submitting) return 'sending'
  if (interaction) return interaction.interactionKind === 'approval' ? 'approval' : 'question'
  if (running) return 'running'
  return stopped ? 'stopped' : 'idle'
}
function readDark() {
  const preference = document.documentElement.dataset.theme ?? 'system'
  return preference === 'dark' || preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches
}
export function ChatSurface({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(readDark)
  useEffect(() => {
    const update = () => setDark(readDark()), media = window.matchMedia('(prefers-color-scheme: dark)')
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    media.addEventListener('change', update)
    return () => { observer.disconnect(); media.removeEventListener('change', update) }
  }, [])
  return <ConfigProvider getPopupContainer={trigger => trigger?.closest<HTMLElement>('.chat-surface') ?? document.body} theme={{ token: {
    colorPrimary: dark ? '#ededed' : '#202020', colorInfo: dark ? '#ededed' : '#202020', colorText: dark ? '#ededed' : '#202020',
    colorTextSecondary: dark ? '#a3a3a3' : '#707070', colorBgContainer: dark ? '#242424' : '#ffffff', colorBgElevated: dark ? '#292929' : '#ffffff',
    colorBorder: dark ? '#3b3b3b' : '#e5e5e5', controlHeight: 32, borderRadius: 8, fontSize: 14,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  }, components: { Button: { controlHeight: 32, borderRadius: 8, fontWeight: 500 }, Input: { activeShadow: 'none' }, Menu: { itemSelectedBg: dark ? '#353535' : '#f0f0f0', itemSelectedColor: dark ? '#ffffff' : '#202020' } } }}>
    <section className="chat chat-surface" data-chat-theme={dark ? 'dark' : 'light'}>{children}</section>
  </ConfigProvider>
}
export function ChatActionArea({ state, stopError, onRetryStop, className, children }: { state: ChatState; stopError: string; onRetryStop: () => void; className: string; children: ReactNode }) {
  return <footer className={className} data-chat-state={state}>
    {stopError ? <div className="chat-stop-feedback" role="alert"><span>{stopError}</span><PulseButton onClick={onRetryStop}>重试停止</PulseButton></div> : (state === 'stopping' || state === 'stopped') && <div className="chat-stop-feedback" role="status">{state === 'stopping' ? '正在停止…' : '已停止'}</div>}
    {children}
  </footer>
}
