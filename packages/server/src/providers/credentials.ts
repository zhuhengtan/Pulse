import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export interface ProviderCredentialSource { provider: string; apiKeyEnv?: string; credentialRef?: string }

/** Separate from config and its backups. Entries are immutable so old task snapshots stay valid. */
export class ProviderCredentialStore {
  readonly path: string
  constructor(configPath: string) { this.path = join(dirname(configPath), 'provider-credentials.json') }
  private async read(): Promise<Record<string, string>> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid credential store')
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error('invalid credential store')
      return value as Record<string, string>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('PROVIDER_CREDENTIAL_STORE_UNAVAILABLE')
    }
  }
  async get(ref: string): Promise<string> {
    if (!/^credential-[a-f0-9-]{36}$/.test(ref)) throw new Error('PROVIDER_CREDENTIAL_REFERENCE_INVALID')
    const value = (await this.read())[ref]
    if (!value) throw new Error('PROVIDER_CREDENTIAL_MISSING')
    return value
  }
  private async protect(path: string): Promise<void> {
    if (process.platform !== 'win32') { await chmod(path, 0o600); return }
    const identity = await execute('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = identity.stdout.match(/S-1-[\d-]+/)?.[0]
    if (!sid) throw new Error('PROVIDER_CREDENTIAL_PERMISSIONS_FAILED')
    await execute('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true })
  }
  private async change(update: (entries: Record<string, string>) => void): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const lockPath = `${this.path}.lock`
    let lock: Awaited<ReturnType<typeof open>> | undefined
    const deadline = Date.now() + 5000
    while (!lock) {
      try { lock = await open(lockPath, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw new Error('PROVIDER_CREDENTIAL_STORE_BUSY')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      const entries = await this.read()
      update(entries)
      const file = await open(temporary, 'wx', 0o600)
      try { await this.protect(temporary); await file.writeFile(JSON.stringify(entries)); await file.sync() } finally { await file.close() }
      await rename(temporary, this.path)
    } catch { throw new Error('PROVIDER_CREDENTIAL_STORE_UNAVAILABLE') }
    finally { await rm(temporary, { force: true }); await lock.close(); await rm(lockPath, { force: true }) }
  }
  async add(apiKey: string): Promise<string> {
    if (!apiKey.trim() || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey)) throw new Error('PROVIDER_API_KEY_INVALID')
    const ref = `credential-${randomUUID()}`
    await this.change(entries => { entries[ref] = apiKey.trim() })
    return ref
  }
  async remove(ref: string): Promise<void> { await this.change(entries => { delete entries[ref] }) }
}

export async function resolveProviderApiKey(source: ProviderCredentialSource, configPath: string): Promise<string | undefined> {
  if (source.credentialRef !== undefined) return new ProviderCredentialStore(configPath).get(source.credentialRef)
  if (source.apiKeyEnv) return process.env[source.apiKeyEnv]
  if (source.provider === 'mock' || source.provider === 'ollama') return undefined
  if (source.provider === 'ollama-cloud') return process.env.OLLAMA_API_KEY
  if (source.provider === 'ollama-remote') return undefined
  return process.env[source.apiKeyEnv ?? (source.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')]
}
