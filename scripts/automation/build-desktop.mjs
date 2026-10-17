import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWindowsSandbox } from './build-srt-win.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const arch = process.env.PULSE_DESKTOP_ARCH ?? process.arch
const target = process.env.PULSE_DESKTOP_TARGET ?? ({darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},win32:{x64:'x86_64-pc-windows-msvc'},linux:{x64:'x86_64-unknown-linux-gnu'}}[process.platform]?.[arch])
if (!target) throw new Error(`Unsupported native target: ${process.platform}/${arch}`)
const destination = resolve(root, `packages/server/native/${process.platform}-${arch}`)
await mkdir(destination, { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
run(process.env.PULSE_CARGO ?? 'cargo', ['build', '--manifest-path', 'native/desktop-helper/Cargo.toml', '--release', '--locked', '--target', target])
const executable = `pulse-desktop-helper${process.platform === 'win32' ? '.exe' : ''}`
await copyFile(resolve(root, `native/desktop-helper/target/${target}/release`, executable), resolve(destination, executable))
if (process.platform === 'darwin') {
  const bundle = resolve(destination, 'Pulse Desktop Helper.app')
  await mkdir(resolve(bundle, 'Contents/MacOS'), { recursive: true })
  await writeFile(resolve(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.hunterzhu.pulse.desktop</string>
<key>CFBundleName</key><string>Pulse Desktop Helper</string>
<key>CFBundleDisplayName</key><string>Pulse Desktop Helper</string>
<key>CFBundleExecutable</key><string>PulseDesktopHelper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Pulse captures screenshots only for desktop automation sessions you authorize.</string>
</dict></plist>\n`)
  run('swiftc', ['-module-cache-path', process.env.TMPDIR ? resolve(process.env.TMPDIR,'pulse-swift-cache') : '/tmp/pulse-swift-cache', '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-parse-as-library', '-O', 'native/desktop-helper/macos.swift', '-o', resolve(bundle, 'Contents/MacOS/PulseDesktopHelper')])
  // Developer ID signing can be supplied by release infrastructure. Local
  // builds use ad-hoc signing and may require renewed consent after a rebuild.
  run('codesign', ['--force', '--sign', process.env.PULSE_MACOS_SIGN_IDENTITY ?? '-', '--identifier', 'com.hunterzhu.pulse.desktop', bundle])
  await rm(resolve(destination, 'pulse-desktop-macos'), { force: true })
}
for (const file of ['windows.ps1','linux.py']) await copyFile(resolve(root, 'native/desktop-helper', file), resolve(destination, file))
async function bundleFiles(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await bundleFiles(resolve(directory, entry.name), file))
    else if (entry.isFile()) result.push(file)
  }
  return result
}
const files = [executable, 'windows.ps1', 'linux.py', ...(process.platform === 'darwin' ? (await bundleFiles(resolve(destination, 'Pulse Desktop Helper.app'))).map(file => `Pulse Desktop Helper.app/${file}`) : [])]
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(resolve(destination, file))).digest('hex')])))
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({protocolVersion:1,platform:process.platform,arch,hashes},null,2)+'\n')
console.log(`Desktop helper built for ${process.platform}/${arch}`)
await buildWindowsSandbox()
