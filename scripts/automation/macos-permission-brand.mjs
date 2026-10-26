import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Brand the native Pulse.app; its executable and bundle IDs remain stable. */
export async function writeMacosPermissionBrand(bundle, bundleIdentifier, icon) {
  await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true })
  await mkdir(join(bundle, 'Contents/Resources'), { recursive: true })
  await copyFile(icon, join(bundle, 'Contents/Resources/Pulse.icns'))
  await writeFile(join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleName</key><string>Pulse</string>
<key>CFBundleDisplayName</key><string>Pulse</string>
<key>CFBundleIconFile</key><string>Pulse.icns</string>
<key>CFBundleExecutable</key><string>PulseDesktopHelper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Pulse captures screenshots only for desktop automation sessions you authorize.</string>
</dict></plist>\n`)
}
