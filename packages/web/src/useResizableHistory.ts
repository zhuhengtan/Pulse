import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent } from 'react'
const key = 'pulse-web-history-layout'
export const historyLimits = { initial: 260, min: 220, max: 420, collapse: 180 }
export function clampHistoryWidth(width: number, viewport: number): number {
  return Math.max(historyLimits.min, Math.min(width, historyLimits.max, viewport * .4))
}
function readLayout() {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}'); return { width: Number.isFinite(value.width) ? clampHistoryWidth(value.width, Number.POSITIVE_INFINITY) : 260, collapsed: value.collapsed === true } }
  catch { return { width: 260, collapsed: false } }
}
export function useResizableHistory() {
  const [layout, setLayout] = useState(readLayout)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [dragWidth, setDragWidth] = useState<number>()
  const drag = useRef<{ x: number; width: number; restore: number } | null>(null)
  const width = clampHistoryWidth(layout.width, viewport)
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)) } catch { /* Private browsing remains usable. */ } }, [layout])
  useEffect(() => { const resize = () => setViewport(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize) }, [])
  const collapsed = layout.collapsed || dragWidth !== undefined && dragWidth < historyLimits.collapse
  const finish = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const active = drag.current
    if (!active) return
    const value = active.width + event.clientX - active.x
    if (!cancel) setLayout({ width: value < historyLimits.collapse ? active.restore : clampHistoryWidth(value, viewport), collapsed: value < historyLimits.collapse })
    drag.current = null; setDragWidth(undefined)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return {
    collapsed,
    toggle: () => setLayout(value => ({ ...value, collapsed: !value.collapsed })),
    style: { '--history-width': `${collapsed ? 0 : dragWidth === undefined ? width : Math.max(0, Math.min(dragWidth, 420, viewport * .4))}px` } as CSSProperties,
    dragging: dragWidth !== undefined,
    separator: {
      role: 'separator' as const, tabIndex: 0, 'aria-label': '调整会话列表宽度', 'aria-orientation': 'vertical' as const,
      'aria-valuenow': collapsed ? 0 : Math.round(dragWidth ?? width), 'aria-valuemin': 0, 'aria-valuemax': Math.floor(Math.min(420, viewport * .4)),
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width: collapsed ? 0 : width, restore: width }; setDragWidth(collapsed ? 0 : width) },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => { if (drag.current) setDragWidth(drag.current.width + event.clientX - drag.current.x) },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event),
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
      onLostPointerCapture: () => { drag.current = null; setDragWidth(undefined) },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter') { event.preventDefault(); setLayout(value => ({ ...value, collapsed: !value.collapsed })) }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = width + (event.key === 'ArrowLeft' ? -20 : 20); setLayout(value => ({ width: next < 220 ? value.width : clampHistoryWidth(next, viewport), collapsed: next < 220 && event.key === 'ArrowLeft' })) }
      },
    },
  }
}
