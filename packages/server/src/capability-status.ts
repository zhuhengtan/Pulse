import { z } from 'zod'
import { defineTool, type ToolRegistry } from '@hunterzhu/pulse-tool-sdk'
import type { AutomationClient } from './automation/broker.js'

/** A diagnostic never opens a browser, grants a permission, or installs software. */
export function capabilityStatusTool(registry: ToolRegistry, enabled: readonly string[], client: AutomationClient, visionAvailable?: boolean) {
  return defineTool({
    name: 'capability.status', description: 'Check actual task capabilities before planning browser or desktop work. Reports enabled, registered, connection status and blockers. Does not enable, install or open anything.',
    input: z.object({}), output: z.unknown(), sideEffectPolicy: 'read', retrySafety: 'read_only',
    execute: async (_, context) => {
      const tools = registry.list().map(t => t.name)
      let native: boolean | undefined
      if (tools.includes('browser.observe')) {
        try {
          const state = await client.request('capabilities', [], AbortSignal.any([context.signal, AbortSignal.timeout(3000)]))
          if (typeof state?.nativeBrowserConnected === 'boolean') native = state.nativeBrowserConnected
        } catch { /* An old/disconnected broker has unknown readiness, not a missing installation. */ }
      }
      return { schemaVersion: 1, capabilities: ['browser', 'computer'].map(id => {
        const registered = tools.includes(`${id}.observe`), configured = enabled.includes(id)
        return { id, enabled: configured, registered, ...(visionAvailable === undefined ? {} : { visionAvailable, textObservation: id === 'browser' }), connection: !registered ? 'unavailable' : id === 'browser' && native !== undefined ? native ? 'connected' : 'disconnected' : 'unverified',
          reason: !configured ? 'CAPABILITY_DISABLED' : !registered ? 'TOOLS_NOT_REGISTERED_IN_THIS_MODE' : id === 'browser' && native === false ? 'NATIVE_BROWSER_REQUIRED' : id === 'computer' && visionAvailable === false ? 'VISION_MODEL_REQUIRED' : null,
          nextAction: !configured ? `Enable capabilities.enabled entry ${id} in host settings, then start a new work run.` : !registered ? 'Start a work session with the configured capability.' : id === 'browser' && native === false ? 'Connect the desktop internal browser; do not install or switch to an external browser without user direction.' : id === 'computer' && visionAvailable === false ? 'Configure a model with verified image input on the vision route; do not guess or install desktop software.' : 'Observe the target before acting; availability does not grant task authorization.',
        }
      }), toolNames: tools }
    },
  })
}
