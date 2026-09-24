import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const out = resolve(process.env.PULSE_CLI_ARTIFACTS_DIR ?? join(repo, 'artifacts/cli'))
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

// The published CLI is self-contained, so copy its production dependency
// closure into the staged node_modules tree. Keeping dependencies nested under
// their owning package preserves pnpm's resolution for duplicate versions.
const dependencyList = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['list', '--prod', '--depth', 'Infinity', '--filter', '@hunterzhu/pulse-cli', '--json'], {
  cwd: repo,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (dependencyList.status !== 0) throw new Error(dependencyList.stderr || 'Unable to inspect CLI production dependencies')
const dependencyRoot = JSON.parse(dependencyList.stdout)[0]
const runtimeRequire = createRequire(import.meta.url)
const copiedDependencies = new Set()
const dependencyNodesByPath = new Map()

function indexDependencyNodes(dependencies) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (dependency?.path) {
      const existing = dependencyNodesByPath.get(dependency.path)
      if (!existing || Object.keys(dependency.dependencies ?? {}).length > Object.keys(existing.dependencies ?? {}).length) {
        dependencyNodesByPath.set(dependency.path, { name, dependency })
      }
      indexDependencyNodes(dependency.dependencies)
    }
  }
}

indexDependencyNodes(dependencyRoot.dependencies)

async function resolveDependencySource(name, parentSource) {
  const treeDependency = dependencyNodesByPath.get(parentSource)?.dependency.dependencies?.[name]
  if (treeDependency?.path) {
    try { return await realpath(treeDependency.path) } catch { /* optional platform package may not be installed here */ }
  }
  try {
    return await realpath(join(parentSource, 'node_modules', name))
  } catch {
    const resolved = runtimeRequire.resolve(name, { paths: [parentSource] })
    let directory = dirname(resolved)
    while (directory !== dirname(directory)) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (manifest.name === name) return directory
      } catch {
        // Keep walking until the package root is found.
      }
      directory = dirname(directory)
    }
    throw new Error(`Unable to locate package root for ${name} from ${parentSource}`)
  }
}

async function copyDependency(name, source, target) {
  if (name.startsWith('@hunterzhu/') || name === 'zod' || name.startsWith('@types/')) return
  const key = `${source}\0${target}`
  if (copiedDependencies.has(key)) return
  copiedDependencies.add(key)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, dereference: true })

  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies }
  for (const dependencyName of Object.keys(dependencies)) {
    if (dependencyName.startsWith('@hunterzhu/') || dependencyName === 'zod' || dependencyName.startsWith('@types/')) continue
    const dependencySource = await resolveDependencySource(dependencyName, source)
    await copyDependency(dependencyName, dependencySource, join(target, 'node_modules', dependencyName))
  }
  for (const dependencyName of Object.keys(manifest.optionalDependencies ?? {})) {
    if (dependencyName.startsWith('@hunterzhu/') || dependencyName === 'zod' || dependencyName.startsWith('@types/')) continue
    try {
      const dependencySource = await resolveDependencySource(dependencyName, source)
      await copyDependency(dependencyName, dependencySource, join(target, 'node_modules', dependencyName))
    } catch {
      // Optional platform integrations may not be installed on this host.
    }
  }
}

for (const [name, dependency] of Object.entries(dependencyRoot.dependencies ?? {})) {
  if (!dependency?.path || name.startsWith('@hunterzhu/') || name === 'zod' || name.startsWith('@types/')) continue
  await copyDependency(name, dependency.path, join(stage, 'pulse/app/node_modules', name))
}

// `pnpm list --filter pulse-cli` nests server/runtime/adapter dependencies
// below workspace links. Walk each bundled workspace package explicitly so
// its production dependencies are copied beside the package that imports them.
for (const packageName of ['cli', 'server', 'runtime', 'adapters', 'tool-sdk']) {
  const source = join(repo, `packages/${packageName}`)
  const packageManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const target = join(stage, 'pulse/app/node_modules', packageManifest.name)
  const dependencies = { ...packageManifest.dependencies }
  for (const dependencyName of Object.keys(dependencies)) {
    if (dependencyName.startsWith('@hunterzhu/') || dependencyName === 'zod' || dependencyName.startsWith('@types/')) continue
    const dependencySource = await resolveDependencySource(dependencyName, source)
    await copyDependency(dependencyName, dependencySource, join(target, 'node_modules', dependencyName))
  }
  for (const dependencyName of Object.keys(packageManifest.optionalDependencies ?? {})) {
    if (dependencyName.startsWith('@hunterzhu/') || dependencyName === 'zod' || dependencyName.startsWith('@types/')) continue
    try {
      const dependencySource = await resolveDependencySource(dependencyName, source)
      await copyDependency(dependencyName, dependencySource, join(target, 'node_modules', dependencyName))
    } catch {
      // Keep the package usable on the build host when optional binaries for
      // other operating systems are absent from the local pnpm store.
    }
  }
}

// Keep the launcher outside the package, but load the complete published CLI
// distribution so relative imports such as ./commands/interactive.js resolve
// from the staged package after extraction.
await writeFile(join(stage, 'pulse/app/cli.js'), `#!/usr/bin/env node
import { main } from './node_modules/@hunterzhu/pulse-cli/dist/bin.js'
process.exitCode = await main()
`)
await cp(join(repo, 'packages/cli/dist/config.js'), join(stage, 'pulse/app/config.js'))

await writeFile(join(stage, 'pulse/bin/pulse.js'), `#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
await import(pathToFileURL(join(root, 'app', 'cli.js')).href)
`)
await chmod(join(stage, 'pulse/bin/pulse.js'), 0o755)

await writeFile(join(stage, 'pulse/install.sh'), `#!/bin/sh
set -eu
ROOT="\${PULSE_HOME:-\${PULSE_INSTALL_ROOT:-\$HOME/.pulse}}"
VERSION="\$(node -p "require(\\"./manifest.json\\").version")"
mkdir -p "\$ROOT/versions/pulse/\$VERSION" "\$ROOT/bin"
cp -R . "\$ROOT/versions/pulse/\$VERSION/"
if [ -e "\$ROOT/bin/pulse" ] && ! grep -q "Pulse CLI managed launcher" "\$ROOT/bin/pulse"; then
  echo "Refusing to overwrite an unmanaged entry: \$ROOT/bin/pulse" >&2
  exit 1
fi
printf '#!/bin/sh\\n# Pulse CLI managed launcher\\nexec node "%s/bin/pulse.js" "\$@"\\n' "\$ROOT/versions/pulse/\$VERSION" > "\$ROOT/bin/pulse"
chmod 755 "\$ROOT/bin/pulse"
echo "Installed Pulse \$VERSION to \$ROOT/versions/pulse/\$VERSION"
echo "Ensure \$ROOT/bin is on PATH."
`)
await chmod(join(stage, 'pulse/install.sh'), 0o755)

await writeFile(join(stage, 'pulse/uninstall.sh'), `#!/bin/sh
set -eu
ROOT="\${PULSE_HOME:-\${PULSE_INSTALL_ROOT:-\$HOME/.pulse}}"
if [ -f "\$ROOT/bin/pulse" ] && grep -q "Pulse CLI managed launcher" "\$ROOT/bin/pulse" && grep -q "versions/pulse" "\$ROOT/bin/pulse"; then
  rm "\$ROOT/bin/pulse"
  echo "Removed \$ROOT/bin/pulse; user data was preserved."
else
  echo "Refusing to remove an unmanaged pulse entry" >&2
  exit 1
fi
`)
await chmod(join(stage, 'pulse/uninstall.sh'), 0o755)

const windowsInstallScript = [
  "$ErrorActionPreference = 'Stop'",
  "$root = if ($env:PULSE_HOME) { $env:PULSE_HOME } elseif ($env:PULSE_INSTALL_ROOT) { $env:PULSE_INSTALL_ROOT } else { Join-Path $HOME '.pulse' }",
  "$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'manifest.json') | ConvertFrom-Json",
  "if ($manifest.version -notmatch '^\\d+\\.\\d+\\.\\d+([+-][0-9A-Za-z.-]+)?$') { throw 'Invalid Pulse package version' }",
  '$target = Join-Path $root ("versions/pulse/{0}" -f $manifest.version)',
  "$bin = Join-Path $root 'bin'",
  "$launcher = Join-Path $bin 'pulse.cmd'",
  'New-Item -ItemType Directory -Force -Path $target, $bin | Out-Null',
  'if (Test-Path $launcher) {',
  '  $existing = Get-Content -Raw $launcher',
  "  if (-not ($existing.Contains('REM Pulse CLI managed launcher') -and $existing.Contains('versions\\pulse\\'))) {",
  '    throw "Refusing to overwrite unmanaged entry: $launcher"',
  '  }',
  '}',
  "Copy-Item (Join-Path $PSScriptRoot '*') $target -Recurse -Force",
  '$relativeTarget = "..\\versions\\pulse\\{0}\\bin\\pulse.js" -f $manifest.version',
  '$launcherContent = @(\'@echo off\', \'REM Pulse CLI managed launcher\', \'setlocal DisableDelayedExpansion\', "node `"%~dp0$relativeTarget`" %*", \'exit /b %errorlevel%\') -join [Environment]::NewLine',
  'Set-Content -NoNewline -Encoding Ascii $launcher $launcherContent',
  'Write-Output "Installed Pulse $($manifest.version) to $target"',
  'Write-Output "Ensure $bin is on PATH."',
].join('\n')
await writeFile(join(stage, 'pulse/install.ps1'), windowsInstallScript)

const windowsUninstallScript = [
  "$ErrorActionPreference = 'Stop'",
  "$root = if ($env:PULSE_HOME) { $env:PULSE_HOME } elseif ($env:PULSE_INSTALL_ROOT) { $env:PULSE_INSTALL_ROOT } else { Join-Path $HOME '.pulse' }",
  "$launcher = Join-Path $root 'bin/pulse.cmd'",
  "if (-not (Test-Path $launcher)) { throw 'Refusing to remove an unmanaged pulse entry' }",
  '$content = Get-Content -Raw $launcher',
  "if (-not ($content.Contains('REM Pulse CLI managed launcher') -and $content.Contains('versions\\pulse\\'))) {",
  "  throw 'Refusing to remove an unmanaged pulse entry'",
  '}',
  'Remove-Item $launcher',
  'Write-Output "Removed $launcher; user data was preserved."',
].join('\n')
await writeFile(join(stage, 'pulse/uninstall.ps1'), windowsUninstallScript)

await writeFile(join(stage, 'pulse/package.json'), JSON.stringify({ name: 'pulse-cli-runtime', version, type: 'module', engines: { node: '>=22' } }, null, 2))
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim().length > 0
await writeFile(join(stage, 'pulse/manifest.json'), JSON.stringify({ schemaVersion: 1, version, revision, dirty }, null, 2))
await writeFile(join(stage, 'pulse/README.md'), `# Pulse CLI ${version}

Requires Node >=22.

## Run without installing

- macOS/Linux: \`node bin/pulse.js --help\`
- Windows PowerShell: \`node .\\bin\\pulse.js --help\`

## Install for the current user

- macOS/Linux: \`./install.sh\`
- Windows PowerShell: \`pwsh -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1\`

The installer adds a launcher under \`~/.pulse/bin\` (or \`%USERPROFILE%\\.pulse\\bin\`) and keeps user data separate from versioned program files. Add that \`bin\` directory to PATH to run \`pulse\` (Windows: \`pulse.cmd\`). To remove only the managed launcher, run \`./uninstall.sh\` or \`pwsh -NoProfile -ExecutionPolicy Bypass -File .\\uninstall.ps1\`. User data and installed versions are preserved.
`)

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
