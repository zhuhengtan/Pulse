import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
it('pins all shipping agent-desktop archives and does not invoke the retired Cargo helper',async()=>{
 const source=await readFile('scripts/automation/build-desktop.mjs','utf8')
 expect(source).toContain("version = '1.2.0'")
 for(const target of ['darwin-arm64','win32-x64','linux-x64'])expect(source).toContain(target)
 expect(source).toContain("createHash('sha256').update(bytes).digest('hex') !== expected")
 expect(source).not.toContain('cargo');expect(source).not.toContain('pulse-desktop-helper')
})
