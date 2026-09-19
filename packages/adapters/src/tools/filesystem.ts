import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
export class FilesystemTool {
  constructor(readonly root: string) {}
  private safe(path: string): string { const target = resolve(this.root, path); if (isAbsolute(path) || relative(this.root, target).startsWith('..')) throw new Error('PATH_OUTSIDE_SANDBOX'); return target }
  async read(path: string, signal?: AbortSignal): Promise<string> { if (signal?.aborted) throw new Error('ABORTED'); return readFile(this.safe(path), 'utf8') }
  async list(path = '.', signal?: AbortSignal): Promise<string[]> { if (signal?.aborted) throw new Error('ABORTED'); return readdir(this.safe(path)) }
  async write(path: string, content: string, signal?: AbortSignal): Promise<void> { if (signal?.aborted) throw new Error('ABORTED'); const target = this.safe(path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, 'utf8') }
}
