/** Isolated model-discovery preview; no real credentials or provider requests. */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { ProviderWizard } from '../src/ProviderWizard.js'
import { SettingsPage } from '../src/SettingsPage.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { providerPresets, savedProviderPreset } from '../../server/src/providers/catalog.js'
import { settingsFixture } from './fixtures/settings.js'
import type { PulseWebTransport } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'

document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
const settings = settingsFixture()
const transport: PulseWebTransport = {
  request: async (path, init) => {
    if (path === '/api/provider-presets') return Response.json({ presets: providerPresets })
    if (path.startsWith('/api/provider-presets?')) {
      const id = new URL(path, location.origin).searchParams.get('providerId')!
      const provider = settings.config.providers[id as keyof typeof settings.config.providers]
      return Response.json({ presets: [savedProviderPreset(provider)], selection: { presetId: 'saved', connectionVariant: 'current' } })
    }
    if (path === '/api/providers/discover') return Response.json({ source: 'remote', authenticated: true, models: Array.from({ length: 41 }, (_, index) => ({ modelCode: `preview-model-${index}`, displayName: `预览模型 ${index}`, tools: 'unknown', structuredOutput: 'unknown', imageInput: 'unknown' })) })
    if (path === '/api/providers/probe') return Response.json({ modelCode: JSON.parse(String(init?.body)).modelCode, chat: { status: 'passed' }, tools: { status: 'passed' }, structuredOutput: { status: 'passed' } })
    if (path === '/api/providers/connect') return Response.json({ applied: true })
    if (new URLSearchParams(location.search).get('mode') === 'edit') return settings.transport.request(path, init)
    return Response.json({ error: 'PREVIEW_ONLY' }, { status: 400 })
  },
  subscribe: () => () => {},
}
function Preview() {
  const [open, setOpen] = useState(true)
  if (new URLSearchParams(location.search).get('mode') === 'edit') return <PulseDesignSystem><SettingsPage transport={transport} canEditConfig category="models" onClose={() => {}} /></PulseDesignSystem>
  return <PulseDesignSystem>{open ? <ProviderWizard transport={transport} version="preview" config={{ activeModel: 'existing/model' }} onClose={() => setOpen(false)} onConnected={() => {}} /> : <button onClick={() => setOpen(true)}>添加服务商</button>}</PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<Preview />)
