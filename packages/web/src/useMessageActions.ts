import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

const menuEvent = 'pulse-message-menu-open'
const interactive = 'a, button, input, textarea, select, [role="button"], .code-block, .table-scroll'

/** Touch gestures stay independent of message streaming and never capture scrolling. */
export function useMessageActions(identity: string) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchor, setAnchor] = useState({ x: 16, y: 12 })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const press = useRef<{ id: number; x: number; y: number } | undefined>(undefined)
  const triggered = useRef(false)
  const cancelPress = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    press.current = undefined
  }, [])
  const close = useCallback(() => { cancelPress(); setMenuOpen(false) }, [cancelPress])
  const open = useCallback(() => {
    window.dispatchEvent(new CustomEvent(menuEvent, { detail: identity }))
    setMenuOpen(true)
  }, [identity])

  useEffect(() => {
    close()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    const otherMenu = (event: Event) => { if ((event as CustomEvent<string>).detail !== identity) close() }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener(menuEvent, otherMenu)
    window.addEventListener('keydown', escape)
    window.addEventListener('pointerup', cancelPress)
    window.addEventListener('pointercancel', close)
    window.visualViewport?.addEventListener('resize', close)
    return () => {
      cancelPress()
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener(menuEvent, otherMenu)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('pointerup', cancelPress)
      window.removeEventListener('pointercancel', close)
      window.visualViewport?.removeEventListener('resize', close)
    }
  }, [identity, close, cancelPress])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    cancelPress()
    triggered.current = false
    if (!event.isPrimary || (event.pointerType !== 'touch' && event.pointerType !== 'pen') ||
      (event.target as Element).closest(interactive)) return
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    const rect = event.currentTarget.getBoundingClientRect()
    setAnchor({ x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) })
    timer.current = setTimeout(() => {
      triggered.current = true
      open()
    }, 450)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = press.current
    if (start && (event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10)) close()
  }
  return {
    menuOpen, close, open, setMenuOpen, anchor, setAnchor,
    gesture: {
      onPointerDown, onPointerMove,
      onPointerUp: cancelPress,
      onPointerCancel: close,
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
        if (!(event.target as Element).closest(interactive) && (press.current || triggered.current)) event.preventDefault()
      },
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (triggered.current) {
          triggered.current = false
          if (!(event.target as Element).closest(interactive)) { event.preventDefault(); event.stopPropagation() }
        }
      },
    },
  }
}
