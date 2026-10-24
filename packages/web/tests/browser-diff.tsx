// Isolated acceptance fixture: no real projects, conversations or settings are modified.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DiffPreview } from '../src/DiffPreview.js'
import { DiffViewer } from '../src/DiffViewer.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { PulseButton } from '../src/PulseControls.js'
import '../src/style.css'
import '../src/workspace.css'
import '../src/redesign.css'
const patch = 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -5,3 +5,4 @@\n export function greet(name: string) {\n-  return "Hello " + name;\n+  const prefix = "你好";\n+  return `${prefix}, ${name}`;\n }\n@@ -80 +81 @@\n-export const enabled = false;\n+export const enabled = true;\n'
const binary = 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n'
const large = 'diff --git a/large.ts b/large.ts\n--- /dev/null\n+++ b/large.ts\n@@ -0,0 +1,700 @@\n'+Array.from({length:700},(_,i)=>`+export const value${i+1} = ${i+1};`).join('\n')+'\n'
const transport = { request: async () => Response.json({diff: patch}), subscribe: () => () => {} }
function Review() {
  const [visible, setVisible] = useState(true), [scenario, setScenario] = useState('preview')
  return <PulseDesignSystem><header style={{display:'flex',gap:4,flexWrap:'wrap'}}><PulseButton onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}}>切换主题</PulseButton><PulseButton onClick={()=>setVisible(!visible)}>切换挂载</PulseButton>{['preview','multi','large','empty','binary'].map(value=><PulseButton key={value} onClick={()=>setScenario(value)}>{value}</PulseButton>)}</header><main style={{height:'calc(100dvh - 90px)',display:'flex',minWidth:0}}>{visible && (scenario === 'preview' ? <DiffPreview target={{kind:'diff',path:'main.ts',conversationId:'fixture'}} transport={transport}/> : <DiffViewer text={scenario === 'multi' ? patch+binary+large : scenario === 'large' ? large : scenario === 'binary' ? binary : ''}/>)}</main></PulseDesignSystem>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Review/></StrictMode>)
