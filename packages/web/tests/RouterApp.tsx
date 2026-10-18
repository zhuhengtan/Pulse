import { useEffect, useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp as RoutedPulseApp } from '../src/PulseApp.js'
import type { PulseWebTransport } from '../src/transport.js'

export function PulseApp({ transport }: { transport: PulseWebTransport }) {
  const [router] = useState(() => createMemoryRouter([{ path: '*', element: <RoutedPulseApp transport={transport} /> }], { initialEntries: ['/chat'] }))
  useEffect(() => () => router.dispose(), [router])
  return <RouterProvider router={router}/>
}
