import { afterEach, expect, it, vi } from 'vitest'
import { DesktopBackend } from '../packages/server/src/automation/desktop.js'
const window = { id: 'fixture-window', app_name: 'Fixture', pid: 1, process_instance: 'one', title: 'Fixture', is_focused: true, bounds: { x: -100, y: 50, width: 200, height: 100 } }
function fixture() {
 const backend = new DesktopBackend()
 const run = vi.spyOn(backend as any, 'run').mockImplementation(async (args:any) => args[0] === 'list-windows' ? [window] : args[0] === 'snapshot' ? { complete:true, snapshot_id:'snapshot', tree:{role:'window',children:[{ref_id:'@snapshot:e1',states:['focused'],role:'textfield'}]} } : args[0] === 'screenshot' ? {width:400,height:200,data:'image'} : {})
 return {backend,run}
}
afterEach(()=>vi.restoreAllMocks())
it('observes accessibility without screenshots or focus changes',async()=>{
 const {backend,run}=fixture();const observation=await backend.observe(undefined,window.id,false)
 expect(observation.image).toBeUndefined();expect(observation.refs).toEqual(['@snapshot:e1'])
 expect(run.mock.calls.map(call=>(call[0] as string[])[0])).toEqual(['list-windows','snapshot','list-windows'])
 await backend.act({type:'element',ref:'@snapshot:e1',operation:'fill',value:'private text'},observation)
 expect(run).toHaveBeenLastCalledWith(['set-value','@snapshot:e1','--stdin'],undefined,'private text')
 await expect(backend.act({type:'element',ref:'@other:e1',operation:'click'},observation)).rejects.toThrow('STALE')
})
it('requires a screenshot for coordinates and maps pixels through window bounds',async()=>{
 const {backend,run}=fixture(),text=await backend.observe(undefined,window.id,false)
 await expect(backend.act({type:'click',point:{x:.5,y:.5},button:'left',count:1},text)).rejects.toThrow('SCREENSHOT_REQUIRED')
 const picture=await backend.observe(undefined,window.id,true)
 await backend.act({type:'click',point:{x:.5,y:.5},button:'left',count:1},picture)
 expect(run).toHaveBeenLastCalledWith(['--headed','mouse-click','--xy=0,100','--button','left','--count','1'],undefined)
})
it('validates without taking a new snapshot and refuses moved or vanished targets',async()=>{
 const {backend,run}=fixture(),observation=await backend.observe(undefined,window.id,false)
 run.mockClear();await backend.validate(observation)
 expect(run).toHaveBeenCalledOnce();expect(run).toHaveBeenCalledWith(['list-windows'],undefined)
 run.mockResolvedValueOnce([]);await expect(backend.validate(observation)).rejects.toThrow('GEOMETRY_CHANGED')
})
