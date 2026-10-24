import { useEffect, useRef } from 'react'

/** Reveal an overflowing title once per hover at a readable, constant speed. */
export function HoverTitle({ children }: { children: string }) {
  const viewport = useRef<HTMLSpanElement>(null), text = useRef<HTMLSpanElement>(null)
  const animation = useRef<Animation | undefined>(undefined)
  const frame = useRef(0)
  const stop = () => { cancelAnimationFrame(frame.current); animation.current?.cancel(); animation.current = undefined }
  useEffect(() => stop, [children])
  const play = () => {
    stop()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Hover actions change the available width on this frame.
    frame.current = requestAnimationFrame(() => {
      const distance = (text.current?.scrollWidth ?? 0) - (viewport.current?.clientWidth ?? 0)
      if (distance <= 1) return
      animation.current = text.current?.animate?.([{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }], { delay: 800, duration: Math.max(1250, distance / 48 * 1000), easing: 'linear', iterations: 1, fill: 'forwards' })
    })
  }
  return <span ref={viewport} className="history-title" onMouseEnter={play} onMouseLeave={stop}><span ref={text} className="history-title-text">{children}</span></span>
}
