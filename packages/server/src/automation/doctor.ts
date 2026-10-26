import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { DesktopBackend } from './desktop.js'
import type { AutomationConfig } from './types.js'

/** Resolve the native sibling bundle, never the outer Electron Pulse.app. */
export function macosPermissionApplication(helperPath: string): string | undefined {
  return ['Pulse.app', 'Pulse Desktop Helper.app'].map(name => resolve(dirname(helperPath), name)).find(path => statSync(path, { throwIfNoEntry: false })?.isDirectory())
}

export async function automationDoctor(config: AutomationConfig = {}): Promise<Record<string, unknown>> {
  const helperPath = config.computer?.helperPath ?? resolve(import.meta.dirname, `../../native/${process.platform}-${process.arch}/pulse-desktop-helper` + (process.platform === 'win32' ? '.exe' : ''))
  let browserInstalled = false
  try { createRequire(import.meta.url).resolve('@playwright/mcp/package.json'); browserInstalled = true } catch { /* diagnostic only */ }
  let desktop: unknown = { installed: false, error: 'DESKTOP_HELPER_NOT_INSTALLED', build: 'pnpm desktop:build' }
  if (existsSync(helperPath)) {
    const backend = new DesktopBackend(helperPath, config.computer?.displayId)
    try { desktop = { installed: true, ...(await backend.call('doctor', {})) } }
    catch (error) { desktop = { installed: true, error: error instanceof Error ? error.message : 'DESKTOP_DIAGNOSTIC_FAILED' } }
    finally { await backend.close() }
  }
  return { platform: process.platform, arch: process.arch, browser: { installed: browserInstalled, version: browserInstalled ? createRequire(import.meta.url)('@playwright/mcp/package.json').version : null, existingMode: 'Chrome/Edge with Playwright extension' }, desktop }
}

export async function requestAutomationPermissions(config: AutomationConfig = {}): Promise<unknown> {
  const helperPath = config.computer?.helperPath ?? resolve(import.meta.dirname, `../../native/${process.platform}-${process.arch}/pulse-desktop-helper` + (process.platform === 'win32' ? '.exe' : ''))
  const backend = new DesktopBackend(helperPath, config.computer?.displayId)
  try {
    if (process.platform !== 'darwin') return await backend.call('doctor', {})
    const permissions = await backend.call('requestPermissions', {})
    const report = { ...permissions, ...(await backend.call('doctor', {})) }
    const applicationPath = macosPermissionApplication(helperPath)
    return { ...report, manualAuthorizationRequired: !report.screenCapture || !report.accessibility, ...(applicationPath ? { applicationPath } : {}), ...(!report.screenCapture ? { guidance: '在系统设置 → 隐私与安全性 → 录屏与系统录音中点击“＋”，按返回的 applicationPath 选择对应的 Pulse 应用并开启权限（新版文件为 Pulse.app；旧版可能为 Pulse Desktop Helper.app）。系统可能不弹出申请窗口。' } : {}) }
  } finally { await backend.close() }
}
