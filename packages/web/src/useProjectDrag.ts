import { useRef, useState, type DragEvent, type PointerEvent, type MouseEvent } from 'react'

/** Native desktop drag plus a touch/pen grip on the folder icon. */
export function useProjectDrag(onMove: (source: string, target: string, after: boolean) => void, disabled: boolean) {
  const active = useRef<string | undefined>(undefined)
  const [dragging, setDragging] = useState<string>()
  const [over, setOver] = useState<{ id: string; after: boolean }>()
  const touch = useRef<{ id: string; x: number; y: number; moved: boolean; target?: string | undefined; after?: boolean } | undefined>(undefined)
  const suppressClick = useRef(false)
  const clear = () => { active.current = undefined; setDragging(undefined); setOver(undefined) }
  const position = (node: Element, y: number) => y > node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2
  return {
    dragging, over,
    row: (id: string) => ({
      draggable: !disabled,
      onDragStart: (event: DragEvent<HTMLDivElement>) => { if (disabled) { event.preventDefault(); return }; active.current = id; setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) },
      onDragOver: (event: DragEvent<HTMLDivElement>) => { if (!active.current || active.current === id) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver({ id, after: position(event.currentTarget, event.clientY) }) },
      onDrop: (event: DragEvent<HTMLDivElement>) => { if (!active.current) return; event.preventDefault(); event.stopPropagation(); if (active.current !== id) onMove(active.current, id, position(event.currentTarget, event.clientY)); clear() },
      onDragEnd: clear,
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false } },
    }),
    grip: (id: string) => ({
      onPointerDown: (event: PointerEvent<HTMLSpanElement>) => { if (disabled || event.pointerType === 'mouse') return; event.currentTarget.setPointerCapture(event.pointerId); touch.current = { id, x: event.clientX, y: event.clientY, moved: false } },
      onPointerMove: (event: PointerEvent<HTMLSpanElement>) => {
        const state = touch.current
        if (!state || Math.hypot(event.clientX - state.x, event.clientY - state.y) < 6 && !state.moved) return
        state.moved = true; setDragging(state.id)
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-project-id]')
        if (target && target.dataset.projectId !== id) { state.target = target.dataset.projectId; state.after = position(target, event.clientY); setOver({ id: state.target!, after: state.after }) }
      },
      onPointerUp: () => { const state = touch.current; if (state?.moved) { suppressClick.current = true; if (state.target) onMove(state.id, state.target, state.after ?? false) }; touch.current = undefined; clear() },
      onPointerCancel: () => { touch.current = undefined; clear() },
    }),
  }
}
