// Isolated native-ASR acceptance; no chat model or user microphone is used by the runner.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { RichComposer, emptyComposerDraft } from '../src/RichComposer.js'
import { browserTransport } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/composer.css'
function Preview(){
 const[draft,setDraft]=useState(emptyComposerDraft),[sent,setSent]=useState('')
 return <main style={{maxWidth:850,margin:'80px auto',padding:20}}><h1>聊天语音输入</h1><p>此页面仅用于隔离验收。</p><RichComposer surfaceMode="chat" transport={browserTransport} draft={draft} onChange={update=>setDraft(current=>update(current))} onSend={async payload=>{setSent(payload.text);return true}}/><output data-testid="sent">{sent}</output></main>
}
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><Preview/></PulseDesignSystem>)
