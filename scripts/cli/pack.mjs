import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const out = join(repo, 'artifacts/cli')
const stage = join(out, '.stage')
const version = JSON.parse(await readFile(join(repo, 'packages/cli/package.json'), 'utf8')).version

await mkdir(out, { recursive: true })
await rm(stage, { recursive: true, force: true })
await mkdir(join(stage, 'pulse/bin'), { recursive: true })
await mkdir(join(stage, 'pulse/app/node_modules/@hunterzhu'), { recursive: true })
await mkdir(join(stage, 'pulse/LICENSES'), { recursive: true })

for (const name of ['cli', 'server', 'runtime', 'adapters', 'tool-sdk']) {
  const source = join(repo, `packages/${name}`)
  const packageName = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name
  const target = join(stage, 'pulse/app/node_modules', packageName)
  await mkdir(target, { recursive: true })
  await cp(join(source, 'dist'), join(target, 'dist'), { recursive: true })
  await cp(join(source, 'package.json'), join(target, 'package.json'))
}
await cp(join(repo, 'node_modules/zod'), join(stage, 'pulse/app/node_modules/zod'), { recursive: true, dereference: true })
await cp(join(repo, 'node_modules/zod/LICENSE'), join(stage, 'pulse/LICENSES/zod.MIT.txt'))
await cp(join(repo, 'packages/cli/dist/bin.js'), join(stage, 'pulse/app/cli.js'))
await cp(join(repo, 'packages/cli/dist/config.js'), join(stage, 'pulse/app/config.js'))

await writeFile(join(stage, 'pulse/bin/pulse'), `#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
await import(join(root, 'app', 'cli.js'))
`)
await chmod(join(stage, 'pulse/bin/pulse'), 0o755)

await writeFile(join(stage, 'pulse/install.sh'), `#!/bin/sh
set -eu
ROOT="\${PULSE_HOME:-\${PULSE_INSTALL_ROOT:-\$HOME/.pulse}}"
VERSION="\$(node -p "require(\\"./manifest.json\\").version")"
mkdir -p "\$ROOT/versions/pulse/\$VERSION" "\$ROOT/bin"
cp -R . "\$ROOT/versions/pulse/\$VERSION/"
printf '#!/bin/sh\\nexec node "%s/bin/pulse" "\$@"\\n' "\$ROOT/versions/pulse/\$VERSION" > "\$ROOT/bin/pulse"
chmod 755 "\$ROOT/bin/pulse"
echo "Installed Pulse \$VERSION to \$ROOT/versions/pulse/\$VERSION"
echo "Ensure \$ROOT/bin is on PATH."
`)
await chmod(join(stage, 'pulse/install.sh'), 0o755)

await writeFile(join(stage, 'pulse/uninstall.sh'), `#!/bin/sh
set -eu
ROOT="\${PULSE_HOME:-\${PULSE_INSTALL_ROOT:-\$HOME/.pulse}}"
if [ -f "\$ROOT/bin/pulse" ] && grep -q "versions/pulse" "\$ROOT/bin/pulse"; then
  rm "\$ROOT/bin/pulse"
  echo "Removed \$ROOT/bin/pulse; user data was preserved."
else
  echo "Refusing to remove an unmanaged pulse entry" >&2
  exit 1
fi
`)
await chmod(join(stage, 'pulse/uninstall.sh'), 0o755)

await writeFile(join(stage, 'pulse/package.json'), JSON.stringify({ name: 'pulse-cli-runtime', version, type: 'module', engines: { node: '>=22' } }, null, 2))
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim().length > 0
await writeFile(join(stage, 'pulse/manifest.json'), JSON.stringify({ schemaVersion: 1, version, revision, dirty }, null, 2))
await writeFile(join(stage, 'pulse/README.md'), `# Pulse CLI ${version}\n\nRequires Node >=22. Run bin/pulse --help.\n`)

const tar = join(out, `pulse-${version}.tar.gz`)
const tempTar = join(out, `.pulse-${version}.tmp.tar.gz`)
await rm(tempTar, { force: true })
const packed = spawnSync('tar', ['-czf', tempTar, '-C', stage, 'pulse'], { stdio: 'inherit' })
if (packed.status !== 0) process.exit(packed.status ?? 1)
await rename(tempTar, tar)
const digest = createHash('sha256').update(await readFile(tar)).digest('hex')
await writeFile(`${tar}.sha256`, `${digest}  ${tar.split('/').pop()}\n`)
await rm(stage, { recursive: true, force: true })
console.log(tar)
