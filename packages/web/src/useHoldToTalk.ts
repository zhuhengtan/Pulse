import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { VoiceInputSession, type DictationPhase, type DictationText } from './voice-input.js'
import type { PulseWebTransport } from './transport.js'

export function useHoldToTalk(options:{enabled:boolean;disabled:boolean;transport:PulseWebTransport;onBegin:()=>void;onText:(value:DictationText)=>void}){
  const [phase,setPhase]=useState<DictationPhase>('idle'),[error,setError]=useState('')
  const latest=useRef(options);latest.current=options
  const session=useRef<VoiceInputSession|undefined>(undefined),hold=useRef<{id:number;x:number;y:number;timer?:ReturnType<typeof setTimeout>}|undefined>(undefined)
  const keyboard=useRef(false)
  const clearHold=()=>{clearTimeout(hold.current?.timer);hold.current=undefined}
  const cancel=()=>{clearHold();keyboard.current=false;const previous=session.current;session.current=undefined;previous?.cancel();setPhase('idle')}
  const stop=()=>{clearHold();keyboard.current=false;session.current?.stop()}
  const start=()=>{
    const current=latest.current;if(!current.enabled || current.disabled || session.current)return
    setError('');current.onBegin()
    const recording=new VoiceInputSession({transport:current.transport,desktop:Boolean(window.pulseDesktop),onText:value=>{if(session.current===recording)latest.current.onText(value)},onError:message=>{if(session.current===recording)setError(message)},onPhase:value=>{if(session.current!==recording)return;setPhase(value);if(value==='idle')session.current=undefined}})
    session.current=recording;void recording.start()
  }
  const pointerDown=(event:ReactPointerEvent,immediate=false)=>{
    if(!latest.current.enabled || latest.current.disabled || session.current || hold.current || event.button!==0 || event.isPrimary===false)return
    const target=event.currentTarget
    const activate=()=>{if(!hold.current)return;try{target.setPointerCapture(event.pointerId)}catch{};window.getSelection()?.removeAllRanges();start()}
    hold.current={id:event.pointerId,x:event.clientX,y:event.clientY}
    if(immediate){event.preventDefault();activate()}else hold.current.timer=setTimeout(activate,450)
  }
  useEffect(()=>{
    const release=(event:PointerEvent)=>{if(hold.current?.id===event.pointerId)stop()}
    const move=(event:PointerEvent)=>{const pending=hold.current;if(pending && pending.id===event.pointerId && !session.current && Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>6)clearHold()}
    const abort=()=>cancel(),hidden=()=>{if(document.hidden)cancel()}
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape' && (hold.current || session.current)){event.preventDefault();cancel()}else if(hold.current && !session.current)clearHold()}
    const keyup=(event:KeyboardEvent)=>{if(keyboard.current && [' ','Enter'].includes(event.key)){event.preventDefault();stop()}}
    window.addEventListener('pointerup',release,true);window.addEventListener('pointermove',move,true);window.addEventListener('pointercancel',abort,true)
    window.addEventListener('blur',abort);window.addEventListener('pagehide',abort);window.addEventListener('keydown',key,true);window.addEventListener('keyup',keyup,true);document.addEventListener('visibilitychange',hidden)
    return()=>{window.removeEventListener('pointerup',release,true);window.removeEventListener('pointermove',move,true);window.removeEventListener('pointercancel',abort,true);window.removeEventListener('blur',abort);window.removeEventListener('pagehide',abort);window.removeEventListener('keydown',key,true);window.removeEventListener('keyup',keyup,true);document.removeEventListener('visibilitychange',hidden);clearHold();const previous=session.current;session.current=undefined;previous?.cancel()}
  },[])
  useEffect(()=>{if(!options.enabled || options.disabled)cancel()},[options.enabled,options.disabled])
  return{phase,error,busy:phase!=='idle',pointerDown,cancel,
    onKeyDown:(event:ReactKeyboardEvent)=>{if([' ','Enter'].includes(event.key)){event.preventDefault();if(!event.repeat && !keyboard.current){keyboard.current=true;start()}}},
    onKeyUp:(event:ReactKeyboardEvent)=>{if(keyboard.current && [' ','Enter'].includes(event.key)){event.preventDefault();stop()}},
    onContextMenu:(event:ReactMouseEvent)=>{if(session.current)event.preventDefault()},
  }
}
