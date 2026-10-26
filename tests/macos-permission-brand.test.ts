import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { macosPermissionApplication } from '../packages/server/src/automation/doctor.js'
import { writeMacosPermissionBrand } from '../scripts/automation/macos-permission-brand.mjs'

it.each(['com.hunterzhu.pulse.desktop', 'com.hunterzhu.pulse.desktop.development'])('brands the real permission bundle and preserves %s', async id => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-permission-brand-'))
  try {
    const bundle = join(root, 'Pulse.app'), icon = new URL('../packages/desktop/build/icons/icon.icns', import.meta.url)
    await writeMacosPermissionBrand(bundle, id, icon)
    const plist = await readFile(join(bundle, 'Contents/Info.plist'), 'utf8')
    expect(plist).toContain(`<key>CFBundleIdentifier</key><string>${id}</string>`)
    expect(plist).toContain('<key>CFBundleDisplayName</key><string>Pulse</string>')
    expect(plist).toContain('<key>CFBundleName</key><string>Pulse</string>')
    expect(plist).toContain('<key>CFBundleIconFile</key><string>Pulse.icns</string>')
    expect(plist).toContain('<key>CFBundleExecutable</key><string>PulseDesktopHelper</string>')
    expect(await readFile(join(bundle, 'Contents/Resources/Pulse.icns'))).toEqual(await readFile(icon))
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('resolves the native sibling precisely, prefers Pulse.app and supports a legacy payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-native-bundle-'))
  try {
    const helper = join(root, 'native', 'pulse-desktop-helper')
    await mkdir(join(root, 'native', 'Pulse Desktop Helper.app'), { recursive: true })
    await mkdir(join(root, 'Pulse.app')) // An outer app is never the native target.
    expect(macosPermissionApplication(helper)).toBe(join(root, 'native', 'Pulse Desktop Helper.app'))
    await mkdir(join(root, 'native', 'Pulse.app'))
    expect(macosPermissionApplication(helper)).toBe(join(root, 'native', 'Pulse.app'))
    await rm(join(root, 'native', 'Pulse.app'), { recursive: true })
    await rm(join(root, 'native', 'Pulse Desktop Helper.app'), { recursive: true })
    expect(macosPermissionApplication(helper)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'darwin')('checks actual macOS file display names and system-resolved brand pixels without launching an app', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-file-brand-'))
  try {
    const bundle = join(root, 'Pulse.app'), legacy = join(root, 'Pulse Desktop Helper.app')
    const icon = fileURLToPath(new URL('../packages/desktop/build/icons/icon.icns', import.meta.url))
    await writeMacosPermissionBrand(bundle, 'com.hunterzhu.pulse.desktop', icon)
    await writeMacosPermissionBrand(legacy, 'com.hunterzhu.pulse.desktop', icon)
    for (const app of [bundle, legacy]) { const executable = join(app, 'Contents/MacOS/PulseDesktopHelper'); await copyFile('/usr/bin/true', executable); await chmod(executable, 0o755) }
    // macOS can render an application icon with system bevels; compare with an
    // independent minimal app using the original asset through the same public API.
    const reference = join(root, 'reference', 'Pulse.app')
    await mkdir(join(reference, 'Contents/MacOS'), { recursive: true })
    await mkdir(join(reference, 'Contents/Resources'), { recursive: true })
    await copyFile('/usr/bin/true', join(reference, 'Contents/MacOS/fixture'))
    await copyFile(icon, join(reference, 'Contents/Resources/reference.icns'))
    await writeFile(join(reference, 'Contents/Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.hunterzhu.pulse.brand-reference</string><key>CFBundleName</key><string>Pulse</string><key>CFBundleDisplayName</key><string>Pulse</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIconFile</key><string>reference.icns</string></dict></plist>')
    const source = join(root, 'file-brand.swift')
    await writeFile(source, `import AppKit
let current=CommandLine.arguments[1], legacy=CommandLine.arguments[2], asset=CommandLine.arguments[3]
func pixels(_ image:NSImage)->NSBitmapImageRep {
 let rep=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:128,pixelsHigh:128,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:512,bitsPerPixel:32)!
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:rep)
 image.draw(in:NSRect(x:0,y:0,width:128,height:128),from:.zero,operation:.copy,fraction:1)
 NSGraphicsContext.restoreGraphicsState();return rep
}
let actual=pixels(NSWorkspace.shared.icon(forFile:current)),expected=pixels(NSWorkspace.shared.icon(forFile:asset))
var difference=0.0
for i in 0..<(128*128*4) {difference += abs(Double(actual.bitmapData![i])-Double(expected.bitmapData![i]))}
if CommandLine.arguments.count > 4 {
 let out=CommandLine.arguments[4]
 try actual.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:out+"/actual.png"))
 try expected.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:out+"/expected.png"))
}
let result:[String:Any]=["currentDisplayName":FileManager.default.displayName(atPath:current),"legacyDisplayName":FileManager.default.displayName(atPath:legacy),"meanPixelError":difference/Double(128*128*4)]
print(String(data:try JSONSerialization.data(withJSONObject:result),encoding:.utf8)!)
`)
    const result = await promisify(execFile)('swift', ['-module-cache-path', join(root, 'swift-cache'), source, bundle, legacy, reference, ...(process.env.PULSE_BRAND_TEST_EVIDENCE_DIR ? [process.env.PULSE_BRAND_TEST_EVIDENCE_DIR] : [])], { timeout: 45000 })
    const observed = JSON.parse(result.stdout)
    expect(observed.currentDisplayName).toBe('Pulse')
    expect(observed.legacyDisplayName).toBe('Pulse Desktop Helper')
    expect(observed.meanPixelError).toBeLessThan(5)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)


it.skipIf(process.platform !== 'darwin')('rejects reusing a pre-rename supervisor for a swift-only build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-old-supervisor-'))
  try {
    const binary = Buffer.from('synthetic-old-supervisor')
    await writeFile(join(root, 'pulse-desktop-helper'), binary)
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ protocolVersion: 1, platform: process.platform, arch: process.arch, hashes: { 'pulse-desktop-helper': createHash('sha256').update(binary).digest('hex') } }))
    const script = fileURLToPath(new URL('../scripts/automation/build-desktop.mjs', import.meta.url))
    await expect(promisify(execFile)(process.execPath, [script, '--swift-only'], { env: { ...process.env, PULSE_DESKTOP_OUTPUT_DIR: root }, timeout: 10000 })).rejects.toThrow('incompatible with Pulse.app')
  } finally { await rm(root, { recursive: true, force: true }) }
})
