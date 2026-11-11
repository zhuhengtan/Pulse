import { expect, it, vi } from 'vitest'
import { DesktopBackend } from '../packages/server/src/automation/desktop.js'
it('reports separate accessibility and screenshot permissions from agent-desktop',async()=>{
 const backend=new DesktopBackend()
 const run=vi.spyOn(backend as any,'run').mockResolvedValue({permissions:{accessibility:{state:'granted'},screen_recording:{state:'denied'}}})
 expect(await backend.call('doctor')).toMatchObject({backend:'agent-desktop',accessibility:true,screenCapture:false,guidance:expect.stringContaining('终端或编辑器')})
 expect(run).toHaveBeenCalledWith(['status'],undefined)
 run.mockRestore()
})
it('requests permission diagnostics without invoking the obsolete helper or silently opening settings',async()=>{
 const backend=new DesktopBackend(),run=vi.spyOn(backend as any,'run').mockResolvedValue({accessibility:{state:'denied'},screen_recording:{state:'unknown'}})
 expect(await backend.call('requestPermissions')).toMatchObject({accessibility:false,screenCapture:false})
 expect(run).toHaveBeenCalledWith(['permissions'],undefined);run.mockRestore()
})
