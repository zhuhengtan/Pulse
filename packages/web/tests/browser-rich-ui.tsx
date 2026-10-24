/** Isolated, synthetic application fixture. No model calls or production writes. */
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { PulseApp } from '../src/PulseApp.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import { followupFixture } from './fixtures/followup.js'
import type { WebMessage } from '../src/transport.js'
import '../src/style.css'
import '../src/redesign.css'
import '../src/messages.css'
import '../src/composer.css'
const params = new URLSearchParams(location.search), surface = params.get('surface') === 'chat' ? 'chat' : 'work'
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const fixture = followupFixture(surface), original = fixture.transport.request
fixture.conversation.title = '富文本与数学排版'
fixture.conversation.projectId = 'pulse'
if (params.get('busy') !== '1') fixture.finish()
const savedKey = `pulse-rich-fixture-${surface}`
const saved: WebMessage[] = JSON.parse(localStorage.getItem(savedKey) ?? '[]')
const sample: WebMessage = { id: 'rich-ai-sample', role: 'assistant', createdAt: new Date().toISOString(), text: `## 一起把想法写清楚
支持 **重点**、*强调*、~~删除线~~，也能在文字之间放入图片：

![图文混排示例](${location.origin}/tests/rich-ui-image.svg)

### 数学与结构
行内公式 $E = mc^2$，以及分数、积分与矩阵：

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}, \\qquad A = \\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix}
$$

| 功能 | 状态 |
| --- | --- |
| 图文混排 | 支持 |
| 数学公式 | 支持 |

- [x] 支持嵌套列表
  - 引用项目文档 [设计说明](docs/design.md)
- [x] 支持代码高亮

\`\`\`ts
const message = '所见即所得'
\`\`\`
` }
fixture.transport.request = async (path, init) => {
  if (path === '/api/session') return Response.json({ queueScope: `rich-ui-fixture-${surface}`, localAdmin: true })
  if (path === '/api/skills') return Response.json({ skills: [{ id: 'review', name: 'review', description: '代码审查' }] })
  if (path.includes('/files?')) {
    const dir = new URL(path, location.origin).searchParams.get('path')
    return Response.json({ entries: dir === '.' ? [{ name: '中文目录', path: '中文目录', type: 'directory' }, { name: 'src', path: 'src', type: 'directory' }, { name: 'README.md', path: 'README.md', type: 'file' }] : dir === '中文目录/' ? [{ name: '空 文件夹', path: '中文目录/空 文件夹', type: 'directory' }, { name: '设计 文档.md', path: '中文目录/设计 文档.md', type: 'file' }] : dir === 'src/' ? [{ name: 'example.ts', path: 'src/example.ts', type: 'file' }] : [] })
  }
  const response = await original(path, init)
  if (path.endsWith('/messages') && init?.method === 'POST' && response.ok) {
    const body = JSON.parse(String(init.body)), message: WebMessage = { ...body, id: `msg-${body.requestId}`, role: 'user', createdAt: new Date().toISOString() }
    if (!saved.some(item => item.id === message.id)) saved.push(message)
    localStorage.setItem(savedKey, JSON.stringify(saved))
  }
  if ((path.includes('/messages') && !init?.method) || path === '/api/assistant') {
    const data = await response.json(), messages: WebMessage[] = Array.isArray(data) ? data : data.messages
    const combined = [...messages.filter(item => !saved.some(saved => saved.id === item.id)), sample, ...saved]
    return Response.json(Array.isArray(data) ? combined : { ...data, messages: combined })
  }
  return response
}
const router = createMemoryRouter([{ path: '*', element: <PulseApp transport={fixture.transport}/> }], { initialEntries: [surface === 'chat' ? '/chat' : '/work/busy'] })
createRoot(document.getElementById('root')!).render(<PulseDesignSystem><RouterProvider router={router}/></PulseDesignSystem>)
