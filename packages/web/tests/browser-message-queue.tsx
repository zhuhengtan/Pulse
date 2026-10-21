import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'

const params = new URLSearchParams(location.search), surface = params.get('surface') === 'chat' ? 'chat' : 'work'
const fixture = followupFixture(surface, params.get('ask') === '1')
if (params.get('admin') === '0') { const request = fixture.transport.request; fixture.transport.request = (path, init) => path === '/api/session' ? Promise.resolve(Response.json({ queueScope: `followup-fixture-${surface}`, localAdmin: false })) : request(path, init) }
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport} /> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
Object.assign(window, { followupFixture: fixture, followupRouter: router })
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router} /></PulseDesignSystem>)
