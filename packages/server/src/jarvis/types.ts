export interface PulseJarvisConfig {
  /** Master switch to enable or disable Jarvis cognitive memory architecture. */
  enabled?: boolean
  /** Base URL of the running Jarvis server. Defaults to http://127.0.0.1:7330 */
  apiUrl?: string
  /** Optional bearer token if Jarvis requires auth. */
  token?: string
  /** Max token budget for dynamic context package built by Jarvis. Defaults to 4000. */
  contextTokenBudget?: number
  /** Whether to automatically record candidate memories upon task completion. Defaults to true. */
  autoCandidate?: boolean
  /** Allow an API URL that is not loopback. Defaults to false. */
  allowRemote?: boolean
}

export interface JarvisSession {
  id: string
  projectId: string
  workspace: string
}

export interface JarvisActiveGoal {
  id: string
  projectId?: string
  title: string
  status: 'active' | 'completed' | 'blocked'
}

export interface JarvisMemoryRecord {
  id: string
  scope: 'global' | 'project'
  kind: 'preference' | 'fact' | 'constraint' | 'decision' | 'identity' | 'workflow'
  title: string
  content: string
}

export interface JarvisContextPackage {
  session?: JarvisSession
  text: string
  activeGoal?: JarvisActiveGoal
  memories?: JarvisMemoryRecord[]
  recentEvents?: Array<{ id: string; type: string; content: string }>
}

export interface CandidateMemoryInput {
  scope?: 'global' | 'project'
  kind?: 'preference' | 'fact' | 'constraint' | 'decision' | 'identity' | 'workflow'
  title: string
  content: string
  sourceRefs?: string[]
}

export interface CloseSessionInput {
  result: 'success' | 'failure' | 'partial'
  summary: string
  decisions?: string[]
  failures?: string[]
  nextSteps?: string[]
}
