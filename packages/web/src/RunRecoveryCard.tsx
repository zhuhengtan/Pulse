import { PulseButton } from './PulseControls.js'

export interface RunRecovery {
  conversationId: string
  runId: string
  state: 'interrupted' | 'unknown'
}

/** Recovery belongs to the active run, independently of trace availability. */
export function RunRecoveryCard({ state, pending, resume, end }: { state: RunRecovery['state']; pending?: 'resume' | 'end' | undefined; resume: () => void; end: () => void }) {
  return <section className="run-recovery-card" role="region" aria-label="任务恢复">
    <div role="status"><strong>{state === 'interrupted' ? '任务已中断，没有自动恢复' : '运行状态暂时无法确认'}</strong><p>{state === 'interrupted' ? '可以继续上次任务，或结束本轮。聊天和执行记录会保留。' : '连接恢复后可重试继续；如果任务仍在运行，服务器会保留当前任务。'}</p></div>
    <div className="run-recovery-actions"><PulseButton type="button" className="primary" disabled={Boolean(pending)} aria-busy={pending === 'resume'} onClick={resume}>{pending === 'resume' ? '正在继续…' : '继续任务'}</PulseButton><PulseButton type="button" className="secondary" disabled={Boolean(pending)} aria-busy={pending === 'end'} onClick={end}>{pending === 'end' ? '正在结束…' : '结束本轮'}</PulseButton></div>
  </section>
}
