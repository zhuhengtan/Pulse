import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
export const focusedCases = {
  patch: {
    prompt: '修复 src/price.mjs 的 total(items)：每个 item 的 quantity 必须为非负整数，price 必须为非负有限数，否则抛出 Error。按分汇总，返回数值美元，例如 3 个 19.99 应为 59.97。保留具名导出，不添加依赖。执行现有测试，报告验证结果。不要修改现有测试。',
    fixtures: {
      'src/price.mjs': 'export function total(items) { return items.reduce((n, i) => n + i.price, 0) }\n',
      'test/price.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from '../src/price.mjs'; test('total',()=>{assert.equal(total([{price:19.99,quantity:3}]),59.97); assert.equal(total([]),0); for(const i of [{price:-1,quantity:1},{price:1,quantity:1.5},{price:NaN,quantity:1},{price:1,quantity:-1}]) assert.throws(()=>total([i]));});\n",
    },
    verify: root => { execFileSync(process.execPath, ['--test', 'test/price.test.mjs'], { cwd: root, stdio: 'pipe' }); return { passed: true, checks: ['frozen behavioral tests'] } },
  },
  svg: {
    prompt: '创建 pelican-bicycle.svg：独立有效 SVG，画一只骑自行车的鹈鹕，含两个车轮、车架、鸟的身体和长喙，并让两个车轮通过 animateTransform 连续旋转。先用 xmllint --noout pelican-bicycle.svg 检查 XML，然后新建 scripts/verify-pelican-svg.mjs 校验 SVG 含上述元素和动画，再运行该脚本验证，最后交付文件及验证结论。不要安装依赖。',
    fixtures: {},
    verify: async root => { const svg = await readFile(join(root, 'pelican-bicycle.svg'), 'utf8'); execFileSync('xmllint', ['--noout', 'pelican-bicycle.svg'], { cwd: root, stdio: 'pipe' }); const animation = (svg.match(/<animateTransform\b/g) ?? []).length >= 2; const script = await readFile(join(root, 'scripts/verify-pelican-svg.mjs'), 'utf8'); return { passed: animation && script.length > 50 && /<svg\b/.test(svg), checks: ['XML parse', 'two animation elements', 'verifier present'], limitations: ['Visual pelican recognition and animation playback require separate rendering acceptance'] } },
  },
  'capability-block': {
    prompt: '请用浏览器打开 https://example.com 并读取真实页面标题。先检查当前浏览器能力是否已启用且可连接。如果当前环境没有这项能力，明确说明具体阻塞和所需配置，保留未完成状态，不要安装或启动外部浏览器，不要把抓取 HTML 当作真实浏览器验证。', fixtures: {},
    verify: (_root, events) => { const operations = events.filter(e => e.type === 'observation' && e.data?.kind !== 'tool_start' && e.data?.tool).map(e => e.data.tool); return { passed: operations.includes('capability.status') && !operations.includes('shell.exec'), checks: ['capability discovery used', 'no install or browser shell fallback'], expectedBlocked: true } },
  },
}
