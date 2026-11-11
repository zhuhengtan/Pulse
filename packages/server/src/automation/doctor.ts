import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DesktopBackend, agentDesktopPath } from './desktop.js'
import type { AutomationConfig } from './types.js'
/** Legacy sibling app grants are not reused by agent-desktop. */
export function macosPermissionApplication(_path: string): string | undefined { return process.env.PULSE_DESKTOP_APPLICATION_PATH }
export async function automationDoctor(config: AutomationConfig = {}): Promise<Record<string, unknown>> {
  const executable = config.computer?.agentDesktopPath ?? agentDesktopPath()
  let browserInstalled = false
  try { createRequire(import.meta.url).resolve('@playwright/mcp/package.json'); browserInstalled = true } catch { /* diagnostic only */ }
  let desktop: unknown = { installed: false, error: 'AGENT_DESKTOP_NOT_INSTALLED', build: 'pnpm desktop:build' }
  if (existsSync(executable)) {
    const backend = new DesktopBackend(executable, config.computer?.displayId)
    try { desktop = { installed: true, ...(await backend.call('doctor', {})), ...(config.computer?.helperPath ? { legacyHelperIgnored: true } : {}) } }
    catch (error) { desktop = { installed: true, error: error instanceof Error ? error.message : 'DESKTOP_DIAGNOSTIC_FAILED' } }
    finally { await backend.close() }
  }
  return { platform: process.platform, arch: process.arch, browser: { installed: browserInstalled, version: browserInstalled ? createRequire(import.meta.url)('@playwright/mcp/package.json').version : null, existingMode: 'Chrome/Edge with Playwright extension' }, desktop }
}
export async function requestAutomationPermissions(config: AutomationConfig = {}): Promise<unknown> {
  const backend = new DesktopBackend(config.computer?.agentDesktopPath, config.computer?.displayId)
  try { return await backend.call('requestPermissions', {}) } finally { await backend.close() }
}
