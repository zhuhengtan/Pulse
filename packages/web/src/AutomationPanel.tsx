import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { apiJson, jsonRequest, ApiError, type PulseWebTransport } from './transport.js'

const stateLabels:Record<string,string>={ai:'AI 操作中',paused:'已暂停',human:'人工接管',closed:'已停止',unknown:'结果待核对'}
function describeError(reason:unknown):string {
 const message=String(reason)
 const messages:Record<string,string>={STALE_AUTOMATION_FRAME:'画面已变化，请等待新截图后重新操作。',AUTOMATION_CONTROL_BUSY:'其他设备正在接管，请先释放控制权。',AUTOMATION_CONTROL_REQUIRED:'请先接管，或在本机开启此设备的控制权限。',SCREEN_RECORDING_PERMISSION_REQUIRED:'请在主机系统设置中为 Pulse Desktop Helper 开启屏幕录制权限。',ACCESSIBILITY_PERMISSION_REQUIRED:'请在主机系统设置中为 Pulse Desktop Helper 开启辅助功能权限。',DESKTOP_HELPER_NOT_INSTALLED:'桌面组件尚未安装，请在主机运行 pulse automation doctor。',BROWSER_NETWORK_NOT_ALLOWED:'此网址未获得网络访问权限，请在本机设置中添加目标主机。',AUTOMATION_RECONNECT_REQUIRED:'这是恢复的会话，请先接管或交还 AI，再获取新画面。',AUTOMATION_GEOMETRY_CHANGED:'窗口或页面已变化，请重新观察后操作。'}
 return Object.entries(messages).find(([code])=>message.includes(code))?.[1]??'操作未完成，请刷新状态并检查主机上的浏览器或系统授权。'
}
interface Session { id: string; kind: string; state: string; frameId?: string; frameWidth?: number; frameHeight?: number; controller?: string; title?: string; url?: string; actionCount: number; error?: string }
export function AutomationPanel({ transport, projectId, localAdmin }: { transport: PulseWebTransport; projectId?: string | undefined; localAdmin: boolean }) {
  const [sessions,setSessions]=useState<Session[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[lease,setLease]=useState(''),[image,setImage]=useState(''),[text,setText]=useState(''),[keys,setKeys]=useState('Enter'),[mode,setMode]=useState('dedicated'),[url,setUrl]=useState(''),[enabled,setEnabled]=useState<string[]>([]),[busy,setBusy]=useState(false),[readOnly,setReadOnly]=useState(false),[diagnostic,setDiagnostic]=useState('')
  const [devices,setDevices]=useState<Array<{id:string;name:string;automationControl?:boolean}>>([])
  const session=sessions.find(item=>item.id===selected)
  const imageRef=useRef(''),requesting=useRef(false),pointer=useRef<{x:number;y:number}|undefined>(undefined),frameRef=useRef(''),leaseRef=useRef(''),pendingFrame=useRef<{url:string;id:string}|undefined>(undefined)
  const base=selected ? `/api/automation/sessions/${encodeURIComponent(selected)}` : ''
  leaseRef.current=lease
  async function load() {
    try { const result=await apiJson<{sessions:Session[];enabled:string[];approvalMode:string}>(transport,'/api/automation/sessions');setSessions(result.sessions);setEnabled(result.enabled);setReadOnly(result.approvalMode==='read-only');setSelected(current=>current||result.sessions.find(item=>item.state!=='closed')?.id||'') }
    catch(reason){setError(reason instanceof ApiError && reason.status===403?'此设备未获自动化控制权限，请在本机授权。':String(reason))}
  }
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),2000);return()=>window.clearInterval(timer)},[transport])
  useEffect(()=>{setLease('');setImage('');frameRef.current=''},[selected])
  useEffect(()=>{if(!lease||!selected)return;const timer=window.setInterval(()=>{void apiJson(transport,`${base}/heartbeat`,jsonRequest('POST',{lease})).catch(()=>setLease(''))},10000);return()=>window.clearInterval(timer)},[lease,selected,transport])
  useEffect(()=>{if(session && session.state!=='human')setLease('')},[session?.state])
  useEffect(()=>{
    if(typeof WebSocket==='undefined')return
    const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/automation/socket`)
    socket.onmessage=event=>{try{const message=JSON.parse(String(event.data));if(message.type==='automation')setSessions(message.sessions)}catch{}}
    return()=>socket.close()
  },[transport])
  useEffect(()=>()=>{if(imageRef.current) URL.revokeObjectURL(imageRef.current)},[])
  useEffect(()=>{
    if(!selected || session?.state==='closed')return
    let active=true
    const refresh=async()=>{
      if(requesting.current)return
      requesting.current=true
      try{
        const result=await apiJson<Session>(transport,`${base}/observe`,jsonRequest('POST',{}))
        const response=await transport.request(`${base}/frame`)
        if(!response.ok)throw new Error('截图读取失败')
        const blob=await response.blob()
        if(active){const next=URL.createObjectURL(blob);if(imageRef.current)URL.revokeObjectURL(imageRef.current);imageRef.current=next;pendingFrame.current={url:next,id:result.frameId??''};frameRef.current='';setImage(next);setSessions(items=>items.map(item=>item.id===selected?result:item))}
      }catch(reason){if(active)setError(describeError(reason))}finally{requesting.current=false}
    }
    // AI observations belong to the executing task. Do not invalidate them by
    // taking a second observer screenshot while the AI holds control.
    if(session?.state==='human'||session?.state==='paused')void refresh()
    else if(session?.frameId)void transport.request(`${base}/frame`).then(async response=>{if(!response.ok)return;const blob=await response.blob();if(active){const next=URL.createObjectURL(blob);if(imageRef.current)URL.revokeObjectURL(imageRef.current);imageRef.current=next;pendingFrame.current={url:next,id:session?.frameId??''};frameRef.current='';setImage(next)}})
    const timer=window.setInterval(()=>{if(leaseRef.current && !requesting.current)void refresh()},1000)
    return()=>{active=false;window.clearInterval(timer)}
  },[selected,session?.state,session?.state==='ai'?session?.frameId:undefined,transport])
  async function run(operation:()=>Promise<unknown>){if(busy)return;setBusy(true);setError('');try{await operation();await load()}catch(reason){setError(describeError(reason))}finally{setBusy(false)}}
  async function control(action:string){await run(async()=>{const result=await apiJson<Session&{lease?:string}>(transport,`${base}/control`,jsonRequest('POST',{action}));setLease(result.lease??'');frameRef.current='';setSessions(items=>items.map(item=>item.id===selected?result:item))})}
  async function input(action:unknown){if(!lease||!frameRef.current||requesting.current)return;await run(async()=>{requesting.current=true;try{await apiJson(transport,`${base}/input`,jsonRequest('POST',{action,frameId:frameRef.current,lease,requestId:crypto.randomUUID()}));const result=await apiJson<Session>(transport,`${base}/observe`,jsonRequest('POST',{}));const response=await transport.request(`${base}/frame`);if(!response.ok)throw new Error('截图读取失败');const next=URL.createObjectURL(await response.blob());if(imageRef.current)URL.revokeObjectURL(imageRef.current);imageRef.current=next;pendingFrame.current={url:next,id:result.frameId??''};frameRef.current='';setImage(next);setSessions(items=>items.map(item=>item.id===selected?result:item))}finally{requesting.current=false}})}
  const point=(event:ReactPointerEvent<HTMLImageElement>)=>{const b=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(event.clientY-b.top)/b.height))}}
  return <section className="automation-panel" aria-label="浏览器与桌面自动化">
    <div className="automation-controls"><select aria-label="自动化会话" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择会话</option>{sessions.filter(s=>s.state!=='closed').map(s=><option key={s.id} value={s.id}>{s.kind==='browser'?'浏览器':'桌面'} · {s.title||'未命名会话'} · {stateLabels[s.state]??s.state}</option>)}</select><select aria-label="浏览器连接模式" value={mode} onChange={e=>setMode(e.target.value)}><option value="dedicated">专用浏览器</option><option value="existing">现有 Chrome/Edge</option></select>{['browser','computer'].map(kind=><button key={kind} disabled={busy||readOnly||!projectId||!enabled.includes(kind)} onClick={()=>void run(async()=>{const result=await apiJson<Session>(transport,'/api/automation/sessions',jsonRequest('POST',{kind,mode,projectId}));setSelected(result.id)})}>{kind==='browser'?'打开浏览器':'连接桌面'}</button>)}</div>
    <div className="automation-controls"><button disabled={busy} onClick={()=>void run(async()=>{const report=await apiJson<{browser:{installed:boolean};desktop:{installed?:boolean;accessibility?:boolean;screenCapture?:boolean;error?:string}}>(transport,'/api/automation/doctor');setDiagnostic(`${report.browser.installed?'浏览器组件已就绪':'浏览器组件未安装'}；${!report.desktop.installed?'桌面组件未安装':report.desktop.error?'桌面环境尚未就绪':report.desktop.screenCapture===false||report.desktop.accessibility===false?'桌面组件已安装，需要在主机授权屏幕录制或辅助功能':'桌面组件已就绪，首次连接可能需要系统确认'}`)})}>检查主机能力</button>{localAdmin&&<button disabled={busy} onClick={()=>void run(async()=>{const report=await apiJson<{guidance?:string;applicationPath?:string;screenCapture?:boolean;accessibility?:boolean}>(transport,'/api/automation/permissions',jsonRequest('POST',{}));setDiagnostic(report.guidance?`${report.guidance}${report.applicationPath?' 应用位置：'+report.applicationPath:''}`:report.screenCapture&&report.accessibility?'Pulse Desktop Helper 的屏幕录制和辅助功能权限已开启。':'请在主机系统设置中完成授权，再检查主机能力。')})}>申请系统权限</button>}</div>{diagnostic&&<p role="status">{diagnostic}</p>}
    <p>操作运行 Pulse 的主机。视觉模型在“设置 → 模型路由 → 视觉执行”选择。</p>
    {error&&<p role="alert">{error}</p>}
    {session&&<><div className="automation-controls"><strong>{stateLabels[session.state]??session.state} · {session.actionCount} 次操作</strong>{['pause','takeover','resume','close'].map((action,index)=><button key={action} disabled={busy||readOnly} onClick={()=>void control(action)}>{['暂停','接管','交还 AI','停止'][index]}</button>)}</div><p>{session.title} {session.url} {session.error}</p>{image&&<img className="automation-frame" alt="主机当前界面" src={image} onLoad={event=>{if(pendingFrame.current?.url===event.currentTarget.src)frameRef.current=pendingFrame.current.id}} draggable={false} style={{touchAction:lease?'none':'auto'}} onContextMenu={e=>e.preventDefault()} onPointerDown={e=>{if(!lease)return;e.currentTarget.setPointerCapture(e.pointerId);pointer.current=point(e)}} onPointerUp={e=>{if(!lease||!pointer.current)return;const to=point(e),from=pointer.current;pointer.current=undefined;void input(Math.hypot(to.x-from.x,to.y-from.y)>.015?{type:'drag',from,to}:{type:'click',point:to,button:e.button===2?'right':'left',count:1})}} onWheel={e=>{if(!lease)return;const b=e.currentTarget.getBoundingClientRect();void input({type:'scroll',point:{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))},dx:Math.max(-2000,Math.min(2000,Math.round(e.deltaX))),dy:Math.max(-2000,Math.min(2000,Math.round(e.deltaY)))})}}/>}{lease&&<div className="automation-controls">{session.kind==='browser'&&<><input aria-label="浏览器网址" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://example.com"/><button disabled={busy} onClick={()=>void run(()=>apiJson(transport,`${base}/command`,jsonRequest('POST',{lease,method:'navigate',params:{url}})))}>打开网址</button></>}<textarea aria-label="输入到主机" value={text} onChange={e=>setText(e.target.value)}/><button disabled={busy} onClick={()=>void input({type:'type',text})}>发送文本</button><input aria-label="快捷键" value={keys} onChange={e=>setKeys(e.target.value)} placeholder="Control+s"/><button disabled={busy} onClick={()=>void input({type:'key',keys:keys.split('+')})}>发送按键</button></div>}</>}
    {localAdmin&&<details><summary onClick={()=>void apiJson<typeof devices>(transport,'/api/devices').then(setDevices)}>配对设备控制权限</summary>{devices.map(device=><label key={device.id}><input type="checkbox" checked={device.automationControl===true} onChange={e=>void run(async()=>{await apiJson(transport,`/api/devices/${encodeURIComponent(device.id)}/automation`,jsonRequest('POST',{enabled:e.target.checked}));setDevices(await apiJson(transport,'/api/devices'))})}/>{device.name}</label>)}</details>}
  </section>
}
