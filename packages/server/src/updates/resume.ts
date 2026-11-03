import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { atomicJson } from './store.js'
export interface UpdateResumeJournal {
  schema: 1; id: string; fromVersion: string; toVersion: string; targetBackend: string;
  runs: Array<{ conversationId: string; runId: string; status: 'pending' | 'resuming' | 'resumed' | 'finished' | 'blocked'; error?: string }>
}
export const updateResumePath = (dataDir: string) => join(dataDir, '.update-resume.json')
export async function readUpdateResume(dataDir: string): Promise<UpdateResumeJournal | undefined> {
  const value = await readFile(updateResumePath(dataDir), 'utf8').then(text => JSON.parse(text) as UpdateResumeJournal).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (value && (value.schema !== 1 || !Array.isArray(value.runs) || value.runs.some(run => !/^[A-Za-z0-9._:-]{1,200}$/.test(run.conversationId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(run.runId)))) throw new Error('UPDATE_RESUME_JOURNAL_INVALID')
  return value
}
export const saveUpdateResume = (dataDir: string, journal: UpdateResumeJournal) => atomicJson(updateResumePath(dataDir), journal)
