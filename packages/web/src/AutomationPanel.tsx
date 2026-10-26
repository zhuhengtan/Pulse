import { createPulseSocket } from './transport.js'
import { createRequestId } from './requestId.js'
import { PulseButton, PulseInput, PulseSelect, PulseTextArea } from './PulseControls.js'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { apiJson, jsonRequest, ApiError, type PulseWebTransport } from './transport.js'

const stateLabels:Record<string,string>={ai:'AI 操作中',paused:'已暂停',human:'人工接管',closed:'已停止',unknown:'结果待核对'}
export function describeAutomationError(reason:unknown):string {
 const message=String(reason)
 const messages:Record<string,string>={NATIVE_BROWSER_REQUIRED:'请在 Electron 客户端中打开内置浏览器。',NATIVE_BROWSER_DISCONNECTED:'桌面浏览器已断开，请重新连接本机后台后接管。',BROWSER_LOAD_FAILED:'网页加载失败，请检查网址和网络后重试。',AUTOMATION_CAPABILITY_DISABLED:'浏览器或桌面自动化尚未启用，请在设置 → 工具与技能中启用对应能力。',STALE_AUTOMATION_FRAME:'画面已变化，请等待新截图后重新操作。',AUTOMATION_CONTROL_BUSY:'其他设备正在接管，请先释放控制权。',AUTOMATION_CONTROL_REQUIRED:'请先接管当前会话，再进行操作。',SCREEN_RECORDING_PERMISSION_REQUIRED:'请在主机系统设置中为 Pulse 开启屏幕录制权限。',ACCESSIBILITY_PERMISSION_REQUIRED:'请在主机系统设置中为 Pulse 开启辅助功能权限。',DESKTOP_HELPER_NOT_INSTALLED:'桌面组件尚未安装，请在主机运行 pulse automation doctor。',BROWSER_NETWORK_NOT_ALLOWED:'此网址未获得网络访问权限，请在本机设置中添加目标主机。',AUTOMATION_RECONNECT_REQUIRED:'这是恢复的会话，请先接管或交还 AI，再获取新画面。',STALE_BROWSER_TABS:'网页标签已变化，请等待刷新后重试。',AUTOMATION_SESSION_SCOPE_CONFLICT:'浏览器的工作目录或连接模式不同，请先停止旧连接。',AUTOMATION_GEOMETRY_CHANGED:'窗口或页面已变化，请重新观察后操作。'}
 return Object.entries(messages).find(([code])=>message.includes(code))?.[1]??'操作未完成，请刷新状态并检查主机上的浏览器或系统授权。'
}
export interface AutomationSession { mode?: string; conversationId?: string; tabs?: { revision: string; items: Array<{ index: number; title: string; url: string; active: boolean }> }; reconnectRequired?: boolean; id: string; kind: string; state: string; frameId?: string; frameWidth?: number; frameHeight?: number; controller?: string; title?: string; url?: string; actionCount: number; error?: string }
export interface BrowserController { selectTab(index: number, revision: string): void; closeTab(index: number, revision: string): void }
export interface BrowserWorkspaceState { session: AutomationSession | undefined; canControl: boolean; busy: boolean }
type Session = AutomationSession
export function AutomationPanel(props: Parameters<typeof ComputerAutomationPanel>[0]) {
  if (!window.pulseDesktop?.nativeBrowser) return <p>请在 Electron 客户端中使用桌面控制。</p>
  return <ComputerAutomationPanel {...props} />
}
function ComputerAutomationPanel({ transport, projectId, conversationId, localAdmin, selectedSession, onSelectSession, browserOnly = false, workspace = false, initialLease, controllerRef, onBrowserState }: { transport: PulseWebTransport; projectId?: string | undefined; conversationId?: string | undefined; browserOnly?: boolean; workspace?: boolean; initialLease?: string | undefined; controllerRef?: Ref<BrowserController> | undefined; onBrowserState?: ((state: BrowserWorkspaceState) => void) | undefined; localAdmin: boolean; selectedSession?: string | undefined; onSelectSession?: ((id: string, replace?: boolean) => void) | undefined }) {
  const [sessions,setSessions]=useState<Session[]>([]),[localSelected,setSelected]=useState(''),[error,setError]=useState(''),[lease,setLease]=useState(initialLease ?? ''),[image,setImage]=useState(''),[text,setText]=useState(''),[keys,setKeys]=useState('Enter'),[mode,setMode]=useState('dedicated'),[enabled,setEnabled]=useState<string[]>([]),[busy,setBusy]=useState(false),[readOnly,setReadOnly]=useState(false),[diagnostic,setDiagnostic]=useState(''),[manualBrowser,setManualBrowser]=useState(false)
  const selected = onSelectSession ? selectedSession ?? '' : localSelected
  const selectionRef = useRef(selected); selectionRef.current = selected
  const selectSession = (id: string, replace = false) => { if (onSelectSession) onSelectSession(id, replace); else setSelected(id) }
  const session=sessions.find(item=>item.id===selected)
  const imageRef=useRef(''),requesting=useRef(false),pointer=useRef<{x:number;y:number}|undefined>(undefined),frameRef=useRef(''),leaseRef=useRef(''),pendingFrame=useRef<{url:string;id:string}|undefined>(undefined)
  const base=selected ? `/api/automation/sessions/${encodeURIComponent(selected)}` : ''
  leaseRef.current=lease
  async function load() {
    try { const result=await apiJson<{sessions:Session[];enabled:string[];approvalMode:string;manualBrowser?:boolean}>(transport,'/api/automation/sessions');setSessions(result.sessions.filter(item=>item.kind==='computer'));setEnabled(result.enabled);setManualBrowser(result.manualBrowser===true);setReadOnly(result.approvalMode==='read-only');(()=>{const requested=selectionRef.current;if(requested&&!result.sessions.some(item=>item.id===requested)){setError('这个自动化会话不存在或已结束。');return}if(!requested){const next=result.sessions.find(item=>item.state!=='closed' && item.kind==='computer')?.id;if(next)selectSession(next,true)}})() }
    catch(reason){setError(reason instanceof ApiError && reason.status===403?'此设备未获自动化控制权限，请在本机授权。':String(reason))}
  }
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),2000);return()=>window.clearInterval(timer)},[transport,conversationId,browserOnly])
  useEffect(()=>{setLease(initialLease ?? '');setImage('');frameRef.current=''},[selected,initialLease])
  useEffect(()=>{if(!lease||!selected)return;const timer=window.setInterval(()=>{void apiJson(transport,`${base}/heartbeat`,jsonRequest('POST',{lease})).catch(()=>setLease(''))},10000);return()=>window.clearInterval(timer)},[lease,selected,transport])
  useEffect(()=>{if(session && session.state!=='human')setLease('')},[session?.state])
  useEffect(()=>{
    if(typeof WebSocket==='undefined')return
    const socket=createPulseSocket('/api/automation/socket')
    socket.onmessage=event=>{try{const message=JSON.parse(String(event.data));if(message.type==='automation')setSessions(message.sessions.filter((item:Session)=>item.kind==='computer'))}catch{}}
    return()=>socket.close()
  },[transport,conversationId,browserOnly])
  useEffect(()=>()=>{if(imageRef.current) URL.revokeObjectURL(imageRef.current)},[])
  useEffect(()=>{
    if(!selected || !session || session.kind!=='computer' || session.state==='closed')return
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
      }catch(reason){if(active)setError(describeAutomationError(reason))}finally{requesting.current=false}
    }
    // AI observations belong to the executing task. Do not invalidate them by
    // taking a second observer screenshot while the AI holds control.
    if(session?.state==='human'||session?.state==='paused')void refresh()
    else if(session?.frameId)void transport.request(`${base}/frame`).then(async response=>{if(!response.ok)return;const blob=await response.blob();if(active){const next=URL.createObjectURL(blob);if(imageRef.current)URL.revokeObjectURL(imageRef.current);imageRef.current=next;pendingFrame.current={url:next,id:session?.frameId??''};frameRef.current='';setImage(next)}})
    const timer=window.setInterval(()=>{if(leaseRef.current && !requesting.current)void refresh()},1000)
    return()=>{active=false;window.clearInterval(timer)}
  },[selected,initialLease,session?.state,session?.state==='ai'?session?.frameId:undefined,transport])
  async function run(operation:()=>Promise<unknown>){if(busy)return;setBusy(true);setError('');try{await operation();await load()}catch(reason){setError(describeAutomationError(reason))}finally{setBusy(false)}}
  async function control(action:string){await run(async()=>{const result=await apiJson<Session&{lease?:string}>(transport,`${base}/control`,jsonRequest('POST',{action}));setLease(result.lease??'');frameRef.current='';setSessions(items=>items.map(item=>item.id===selected?result:item))})}
  async function input(action:unknown){if(!lease||!frameRef.current||requesting.current)return;await run(async()=>{requesting.current=true;try{await apiJson(transport,`${base}/input`,jsonRequest('POST',{action,frameId:frameRef.current,lease,requestId:createRequestId('input')}));const result=await apiJson<Session>(transport,`${base}/observe`,jsonRequest('POST',{}));const response=await transport.request(`${base}/frame`);if(!response.ok)throw new Error('截图读取失败');const next=URL.createObjectURL(await response.blob());if(imageRef.current)URL.revokeObjectURL(imageRef.current);imageRef.current=next;pendingFrame.current={url:next,id:result.frameId??''};frameRef.current='';setImage(next);setSessions(items=>items.map(item=>item.id===selected?result:item))}finally{requesting.current=false}})}
  async function command(method:string,params:Record<string,unknown>){await run(()=>apiJson(transport,`${base}/command`,jsonRequest('POST',{lease,method,params})))}
  const reportState = useRef(onBrowserState); reportState.current = onBrowserState
  useEffect(() => { reportState.current?.({ session, canControl: Boolean(lease) && !readOnly, busy }) }, [session, lease, busy, readOnly])
  useImperativeHandle(controllerRef, () => ({
    selectTab: (index, revision) => { if (lease && !readOnly) void command('selectTab', { index, revision }) },
    closeTab: (index, revision) => { if (lease && !readOnly) void command('closeTab', { index, revision }) },
  }), [lease, readOnly, busy, base, transport])
  const inputControls = <div className="automation-controls browser-inputbar"><PulseTextArea aria-label="输入到主机" value={text} onChange={e=>setText(e.target.value)}/><PulseButton disabled={busy} onClick={()=>void input({type:'type',text})}>发送文本</PulseButton><PulseInput aria-label="快捷键" value={keys} onChange={e=>setKeys(e.target.value)} placeholder="Control+s"/><PulseButton disabled={busy} onClick={()=>void input({type:'key',keys:keys.split('+')})}>发送按键</PulseButton></div>
  const point=(event:ReactPointerEvent<HTMLImageElement>)=>{const b=event.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(event.clientY-b.top)/b.height))}}
  return <section className={`automation-panel ${workspace ? 'browser-workspace' : ''}`} aria-label="桌面控制">
    {!workspace && <details className="automation-setup" open={!browserOnly || !session}><summary>{browserOnly ? '浏览器连接与设置' : '自动化连接与设置'}</summary>
    <div className="automation-controls"><PulseSelect aria-label="自动化会话" value={selected} onChange={e=>selectSession(e)}><option value="">选择会话</option>{sessions.filter(s=>s.state!=='closed').map(s=><option key={s.id} value={s.id}>{s.kind==='browser'?'浏览器':'桌面'} · {s.title||'未命名会话'} · {stateLabels[s.state]??s.state}</option>)}</PulseSelect>{(['computer']).map(kind=><PulseButton key={kind} disabled={busy||readOnly||(kind==='browser'?!manualBrowser&&!enabled.includes(kind):!projectId||!enabled.includes(kind))} onClick={()=>void run(async()=>{const result=await apiJson<Session>(transport,'/api/automation/sessions',jsonRequest('POST',{kind,mode,projectId,conversationId,...(kind==='browser'?{manual:true}:{})}));selectSession(result.id)})}>{kind==='browser'?'打开浏览器':'连接桌面'}</PulseButton>)}</div>
    <div className="automation-controls"><PulseButton disabled={busy} onClick={()=>void run(async()=>{const report=await apiJson<{browser:{installed:boolean};desktop:{installed?:boolean;accessibility?:boolean;screenCapture?:boolean;error?:string}}>(transport,'/api/automation/doctor');setDiagnostic(`${report.browser.installed?'浏览器组件已就绪':'浏览器组件未安装'}；${!report.desktop.installed?'桌面组件未安装':report.desktop.error?'桌面环境尚未就绪':report.desktop.screenCapture===false||report.desktop.accessibility===false?'桌面组件已安装，需要在主机授权屏幕录制或辅助功能':'桌面组件已就绪，首次连接可能需要系统确认'}`)})}>检查主机能力</PulseButton>{localAdmin&&<PulseButton disabled={busy} onClick={()=>void run(async()=>{const report=await apiJson<{guidance?:string;applicationPath?:string;screenCapture?:boolean;accessibility?:boolean}>(transport,'/api/automation/permissions',jsonRequest('POST',{}));setDiagnostic(report.guidance?`${report.guidance}${report.applicationPath?' 应用位置：'+report.applicationPath:''}`:report.screenCapture&&report.accessibility?'Pulse 的屏幕录制和辅助功能权限已开启。':'请在主机系统设置中完成授权，再检查主机能力。')})}>申请系统权限</PulseButton>}</div>{diagnostic&&<p role="status">{diagnostic}</p>}
    <p>操作运行 Pulse 的主机。视觉模型在“设置 → 模型路由 → 视觉执行”选择。</p>
    </details>}
    {error&&<p role="alert">{error}</p>}
    {session?.reconnectRequired && <p role="status">服务已重启，请接管或交还 AI 后重新连接浏览器。</p>}
    {session&&<>{!workspace && <><div className="automation-controls"><strong>{stateLabels[session.state]??session.state} · {session.actionCount} 次操作</strong>{['pause','takeover','resume','close'].map((action,index)=><PulseButton key={action} disabled={busy||readOnly} onClick={()=>void control(action)}>{['暂停','接管','交还 AI','停止'][index]}</PulseButton>)}</div><p>{session.title} {session.url} {session.error}</p></>}{image&&<img className="automation-frame" alt="主机当前界面" tabIndex={workspace && lease ? 0 : undefined} src={image} onLoad={event=>{if(pendingFrame.current?.url===event.currentTarget.src)frameRef.current=pendingFrame.current.id}} draggable={false} style={{touchAction:lease?'none':'auto'}} onContextMenu={e=>e.preventDefault()} onPointerDown={e=>{if(!lease)return;e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);pointer.current=point(e)}} onPointerUp={e=>{if(!lease||!pointer.current)return;const to=point(e),from=pointer.current;pointer.current=undefined;void input(Math.hypot(to.x-from.x,to.y-from.y)>.015?{type:'drag',from,to}:{type:'click',point:to,button:e.button===2?'right':'left',count:1})}} onWheel={e=>{if(!lease)return;const b=e.currentTarget.getBoundingClientRect();void input({type:'scroll',point:{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))},dx:Math.max(-2000,Math.min(2000,Math.round(e.deltaX))),dy:Math.max(-2000,Math.min(2000,Math.round(e.deltaY)))})}}/>}{lease && !workspace && inputControls}</>}
  </section>
}
