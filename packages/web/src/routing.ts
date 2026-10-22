import { useCallback, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

export const settingsCategories = ['appearance', 'desktop', 'devices', 'messages', 'models', 'routing', 'front', 'approval', 'jarvis', 'tools', 'mcp', 'network', 'instructions', 'runtime', 'archive', 'advanced'] as const
export const workspaceTabs = ['files', 'git', 'preview', 'terminal', 'automation'] as const
export type WorkspaceTab = typeof workspaceTabs[number]
export type QueryPatch = Record<string, string | number | boolean | undefined>
export type PulseRoute = { page: 'chat' | 'work' | 'settings' | 'archive' | 'pair' | 'missing'; conversationId?: string; newWork: boolean; category?: string; query: URLSearchParams }

const queryKeys = new Set(['project', 'workspace', 'path', 'file', 'offset', 'staged', 'diff', 'terminal', 'automation', 'details', 'artifact', 'artifactRun', 'code', 'previewHidden'])
const pathKeys = new Set(['path', 'file', 'diff', 'artifact'])
export function safeRelativePath(value: string): boolean { return !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..') }

export function parsePulseRoute(pathname: string, search = ''): PulseRoute {
  const query = new URLSearchParams(search)
  for (const key of [...query.keys()]) {
    const value = query.get(key) ?? ''
    if (!queryKeys.has(key) || !value || pathKeys.has(key) && !safeRelativePath(value) || key === 'workspace' && !workspaceTabs.includes(value as WorkspaceTab) || key === 'offset' && !/^\d{1,9}$/.test(value) || ['details', 'staged'].includes(key) && value !== '1') query.delete(key)
  }
  const route: PulseRoute = { page: 'missing', newWork: false, query }
  if (pathname === '/' || pathname === '/chat') route.page = 'chat'
  else if (pathname === '/pair') route.page = 'pair'
  else if (pathname === '/archive') route.page = 'archive'
  else if (pathname === '/settings') route.page = 'settings'
  else if (pathname.startsWith('/settings/')) {
    const category = pathname.slice('/settings/'.length)
    if (settingsCategories.includes(category as typeof settingsCategories[number])) { route.page = 'settings'; route.category = category }
  } else if (pathname === '/work') route.page = 'work'
  else if (pathname === '/work/new') { route.page = 'work'; route.newWork = true }
  else if (/^\/work\/[^/]+$/.test(pathname)) {
    try { route.conversationId = decodeURIComponent(pathname.slice('/work/'.length)); route.page = 'work' } catch { /* Invalid encoded routes render the missing page. */ }
  }
  return route
}

export function workUrl(id?: string, project?: string): string {
  return id ? `/work/${encodeURIComponent(id)}` : `/work/new${project ? `?${new URLSearchParams({ project })}` : ''}`
}

export function usePulseNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  const current = useRef(location.pathname + location.search)
  current.current = location.pathname + location.search
  const go = useCallback((url: string, replace = false, state?: unknown) => {
    if (url === current.current) return
    const previous = current.current
    current.current = url
    const nextState = state === undefined ? replace ? location.state : null : state
    void navigate(url, { replace, state: replace ? nextState : { ...(nextState && typeof nextState === 'object' ? nextState : {}), pulsePrevious: previous } })
  }, [navigate, location.state])
  const patchQuery = useCallback((patch: QueryPatch, replace = false) => {
    const url = new URL(current.current, 'http://pulse.local')
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === false || value === '') url.searchParams.delete(key)
      else url.searchParams.set(key, value === true ? '1' : String(value))
    }
    go(url.pathname + url.search, replace, location.state)
  }, [go, location.state])
  const openPage = (pathname: string) => go(pathname, false, { returnTo: location.pathname + location.search, returnState: location.state })
  const backToSource = (fallback = '/chat') => {
    const source: unknown = location.state?.returnTo
    go(typeof source === 'string' && /^\/(chat|work|settings|archive)(\/|\?|$)/.test(source) ? source : fallback, true, location.state?.returnState ?? null)
  }
  const backToSettings = () => {
    const previous: unknown = location.state?.pulsePrevious
    if (typeof previous === 'string' && parsePulseRoute(previous.split('?')[0]!).page === 'settings') void navigate(-1)
    else go('/settings', true)
  }
  return { location, route: parsePulseRoute(location.pathname, location.search), go, patchQuery, openPage, backToSource, backToSettings }
}
