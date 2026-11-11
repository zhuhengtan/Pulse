import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCommand, stageNpmPackages } from './npm-stage.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
// An explicit dry-run destination retains inspectable tarballs; publication
// always owns a fresh temporary stage and cannot consume stale artifacts.
const retained = process.env.NPM_DRY_RUN === '1' && process.env.PULSE_NPM_ARTIFACTS_DIR
if (retained) await mkdir(resolve(retained), { recursive: true })
const stage = await mkdtemp(join(retained ? resolve(retained) : tmpdir(), 'pulse-npm-release-'))
try {
  const packages = await stageNpmPackages(repo, stage)
  await writeFile(join(stage, 'artifacts.json'), JSON.stringify(packages.map(({ archive, ...item }) => ({ ...item, filename: archive.split(/[\\/]/).pop() })), null, 2) + '\n')
  // No publish invocation, including dry-run, happens until every package is
  // fully packed and checked. Publish these exact inspected bytes in order.
  for (const item of process.env.NPM_DRY_RUN === '1' ? [] : packages) {
    const args = ['publish', item.archive, '--access', 'public', '--ignore-scripts']
    if (process.env.NPM_PROVENANCE === '1') args.push('--provenance')
    process.stdout.write(npmCommand(args, { cwd: stage }))
  }
  if (retained) console.log(`Verified npm artifacts: ${stage}`)
} finally { if (!retained) await rm(stage, { recursive: true, force: true }) }
