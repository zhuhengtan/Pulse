import { useRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WindowedMessages } from '../src/WindowedMessages.js'

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function History({ count }: { count: number }) {
  const container = useRef<HTMLElement | null>(null), follow = useRef(true)
  return <section ref={container} aria-label="History" onScroll={() => { follow.current = false }}>
    <WindowedMessages items={Array.from({ length: count }, (_, i) => <article key={i}>Message {i}</article>)} container={container} follow={follow}/>
  </section>
}

it('windows loaded history and keeps both ends reachable through scrolling', async () => {
  const view = render(<History count={500}/>)
  expect(screen.getByText('Message 499')).toBeTruthy()
  expect(screen.queryByText('Message 0')).toBeNull()
  expect(view.container.querySelectorAll('article').length).toBeLessThan(120)
  const history = screen.getByLabelText('History')
  history.scrollTop = 0
  fireEvent.scroll(history)
  await waitFor(() => expect(screen.getByText('Message 0')).toBeTruthy())
  expect(screen.queryByText('Message 499')).toBeNull()
})

it('keeps short conversations in ordinary accessible DOM order', () => {
  const view = render(<History count={3}/>)
  expect([...view.container.querySelectorAll('article')].map(node => node.textContent)).toEqual(['Message 0', 'Message 1', 'Message 2'])
})
