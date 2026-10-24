/**
 * 独立离线回归：Pulse 稳定运行代码快照（scripts/self-host-snapshot.mjs）。
 *
 * 只使用本文件在 os.tmpdir() 下自建的 fixture，不读取、不重命名任何真实项目目录，也不启动任何服务。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error scripts/*.mjs 是没有类型声明的运行脚本
import { createSnapshot, verifySnapshot, EXIT, MANIFEST_DIR, MANIFEST_NAME } from '../scripts/self-host-snapshot.mjs'

let tmp = ''
let fixtureCwd = ''
let entryFile = ''
let capsule = ''

async function put(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body, 'utf8')
}

async function pkg(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await put(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
}

/** fixture：入口包 + 传递依赖 + 同名双变体 + 循环依赖 + 可选缺失 + 配置/会话哨兵。 */
async function buildFixture(root: string): Promise<string> {
  const nm = path.join(root, 'node_modules')
  const app = path.join(nm, '@fx', 'app')
  await pkg(app, {
    name: '@fx/app',
    version: '1.0.0',
    bin: { 'fx-cli': 'cli.js' },
    dependencies: { '@fx/dep-a': '1.0.0', vleft: '1.0.0', vright: '1.0.0', 'cyc-a': '1.0.0' },
    optionalDependencies: { '@fx/absent': '1.0.0' },
  })
  await put(path.join(app, 'cli.js'), [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const parts = [',
    "  require('@fx/dep-a').marker,",
    "  require('vleft').marker,",
    "  require('vright').marker,",
    "  require('cyc-a').marker,",
    "  fs.readFileSync(path.join(__dirname, 'banner.txt'), 'utf8').trim(),",
    ']',
    "process.stdout.write('CLI-OK ' + parts.join('|') + '\\n')",
    '',
  ].join('\n'))
  await put(path.join(app, 'banner.txt'), 'app-banner\n')
  await put(path.join(app, '.env'), 'PULSE_TOKEN=secret\n')
  await put(path.join(app, 'pulse-config.json'), '{"user":"secret"}\n')
  await put(path.join(app, 'sessions.json'), '{"session":"secret"}\n')
  await put(path.join(app, 'sessions', 'sentinel.json'), '{"session":"secret"}\n')

  const depA = path.join(nm, '@fx', 'dep-a')
  await pkg(depA, {
    name: '@fx/dep-a',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { '@fx/dep-b': '1.0.0' },
  })
  await put(path.join(depA, 'index.js'), [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const asset = fs.readFileSync(path.join(__dirname, 'assets', 'banner.txt'), 'utf8').trim()",
    "const inner = require('@fx/dep-b').marker",
    "module.exports = { marker: 'dep-a+' + inner + '/' + asset }",
    '',
  ].join('\n'))
  await put(path.join(depA, 'assets', 'banner.txt'), 'dep-a-asset\n')
  await put(path.join(depA, '.npmrc'), '//registry/:_authToken=secret\n')
  await put(path.join(depA, 'credentials.json'), '{"token":"secret"}\n')
  await put(path.join(depA, 'sessions', 'sentinel.json'), '{"session":"secret"}\n')

  const depB = path.join(nm, '@fx', 'dep-b')
  await pkg(depB, { name: '@fx/dep-b', version: '1.0.0', main: 'index.js' })
  await put(path.join(depB, 'index.js'), "module.exports = { marker: 'dep-b' }\n")

  await pkg(path.join(nm, 'vleft'), {
    name: 'vleft',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { dup: '2.0.0' },
  })
  await put(path.join(nm, 'vleft', 'index.js'), "module.exports = { marker: 'left:' + require('dup').marker }\n")
  await pkg(path.join(nm, 'vleft', 'node_modules', 'dup'), { name: 'dup', version: '2.0.0', main: 'index.js' })
  await put(path.join(nm, 'vleft', 'node_modules', 'dup', 'index.js'), "module.exports = { marker: 'dup2' }\n")

  await pkg(path.join(nm, 'vright'), {
    name: 'vright',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { dup: '1.0.0' },
  })
  await put(path.join(nm, 'vright', 'index.js'), "module.exports = { marker: 'right:' + require('dup').marker }\n")
  await pkg(path.join(nm, 'dup'), { name: 'dup', version: '1.0.0', main: 'index.js' })
  await put(path.join(nm, 'dup', 'index.js'), "module.exports = { marker: 'dup1' }\n")

  await pkg(path.join(nm, 'cyc-a'), {
    name: 'cyc-a',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'cyc-b': '1.0.0' },
  })
  await put(path.join(nm, 'cyc-a', 'index.js'), "module.exports = { marker: 'cyc-a->' + require('cyc-b').marker }\n")
  await pkg(path.join(nm, 'cyc-b'), {
    name: 'cyc-b',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'cyc-a': '1.0.0' },
  })
  await put(path.join(nm, 'cyc-b', 'index.js'), "module.exports = { marker: 'cyc-b' }\n")

  return path.join(app, 'cli.js')
}

async function readManifest(dir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, MANIFEST_DIR, MANIFEST_NAME), 'utf8'))
}

async function writeManifest(dir: string, manifest: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, MANIFEST_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

async function cloneSnapshot(tag: string): Promise<string> {
  const dest = path.join(tmp, 'clone-' + tag)
  await fs.cp(capsule, dest, { recursive: true })
  return dest
}

async function walk(dir: string, base = dir): Promise<Array<{ rel: string; abs: string; kind: string }>> {
  const out: Array<{ rel: string; abs: string; kind: string }> = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = path.relative(base, abs).split(path.sep).join('/')
    if (entry.isSymbolicLink()) out.push({ rel, abs, kind: 'link' })
    else if (entry.isDirectory()) out.push(...(await walk(abs, base)))
    else out.push({ rel, abs, kind: 'file' })
  }
  return out
}

function kinds(check: { violations: Array<{ kind: string }> }): string[] {
  return check.violations.map((violation) => violation.kind)
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-snapshot-'))
  fixtureCwd = path.join(tmp, 'fixture')
  entryFile = await buildFixture(fixtureCwd)
  const created = await createSnapshot({ cliEntry: entryFile, snapshot: path.join(tmp, 'capsule'), cwd: fixtureCwd })
  capsule = created.snapshot
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})
describe('self-host-snapshot：只复制代码的稳定运行胶囊', () => {
  it('manifest 给出 CLI 入口与监督入口路径，且只声明代码策略', async () => {
    const manifest: any = await readManifest(capsule)
    expect(typeof manifest.entries.cli).toBe('string')
    expect(manifest.entries.cli.length).toBeGreaterThan(0)
    expect(manifest.entries.supervisor).toBe('code/supervisor/self-host.mjs')
    expect(manifest.entries.tool).toBe('code/supervisor/self-host-snapshot.mjs')
    await fs.access(path.join(capsule, manifest.entries.cli))
    await fs.access(path.join(capsule, manifest.entries.supervisor))
    expect(manifest.dataPolicy.codeOnly).toBe(true)
    expect(manifest.dataPolicy.copiesDataDir).toBe(false)
    expect(manifest.dataPolicy.copiesSessions).toBe(false)
  })

  it('原始 fixture 目录被重命名后，快照 CLI 仍能启动并加载传递依赖与资源', async () => {
    const root = path.join(tmp, 'detached')
    const fixture = path.join(root, 'fixture')
    const entry = await buildFixture(fixture)
    const created = await createSnapshot({ cliEntry: entry, snapshot: path.join(root, 'capsule'), cwd: fixture })
    const manifest: any = await readManifest(created.snapshot)
    const cli = path.join(created.snapshot, manifest.entries.cli)
    const moved = fixture + '-moved-away'
    await fs.rename(fixture, moved)
    try {
      const run = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('CLI-OK')
      expect(run.stdout).toContain('dep-a+dep-b/dep-a-asset')
      expect(run.stdout).toContain('app-banner')
    } finally {
      await fs.rename(moved, fixture)
    }
    const check = await verifySnapshot({ snapshot: created.snapshot })
    expect(check.ok, JSON.stringify(check.violations)).toBe(true)
  })

  it('快照内链接支持同名依赖变体与内部循环依赖', async () => {
    const manifest: any = await readManifest(capsule)
    const run = spawnSync(process.execPath, [path.join(capsule, manifest.entries.cli)], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('left:dup2')
    expect(run.stdout).toContain('right:dup1')
    expect(run.stdout).toContain('cyc-a->cyc-b')
    const dupEdges = manifest.edges.filter((edge: any) => edge.name === 'dup')
    expect(dupEdges.length).toBe(2)
    expect(dupEdges[0].to).not.toBe(dupEdges[1].to)
    // 循环依赖必须保留两条边：app -> cyc-a 与闭合环 cyc-b -> cyc-a
    const cycleEdges = manifest.edges.filter((edge: any) => edge.name === 'cyc-a')
    expect(cycleEdges.length).toBe(2)
    expect(cycleEdges.every((edge: any) => typeof edge.to === 'string' && edge.to.length > 0)).toBe(true)
    expect(new Set(cycleEdges.map((edge: any) => edge.from)).size).toBe(2)
  })

  it('快照内没有硬链接，也没有指向快照外部的链接', async () => {
    const items = await walk(capsule)
    let links = 0
    for (const item of items) {
      if (item.kind === 'link') {
        links += 1
        const raw = await fs.readlink(item.abs)
        expect(path.isAbsolute(raw)).toBe(false)
        const resolved = await fs.realpath(item.abs)
        expect(resolved === capsule || resolved.startsWith(capsule + path.sep)).toBe(true)
      } else {
        const stat = await fs.stat(item.abs)
        expect(stat.nlink).toBe(1)
      }
    }
    expect(links).toBeGreaterThan(0)
    const manifest: any = await readManifest(capsule)
    for (const file of manifest.files) {
      expect(typeof file.sha256).toBe('string')
      expect(file.sha256.length).toBe(64)
      expect(typeof file.size).toBe('number')
    }
  })

  it('配置、凭据、会话与数据库哨兵不进入快照', async () => {
    const rels = (await walk(capsule)).map((item) => item.rel)
    for (const banned of ['.env', '.npmrc', 'credentials.json', 'sessions.json', 'pulse-config.json']) {
      expect(rels.some((rel) => rel.split('/').includes(banned)), banned).toBe(false)
    }
    expect(rels.some((rel) => rel.split('/').includes('sessions'))).toBe(false)
    expect(rels.some((rel) => rel.endsWith('.sqlite') || rel.endsWith('.db'))).toBe(false)
  })

  it('目标已存在时拒绝覆盖', async () => {
    await expect(createSnapshot({ cliEntry: entryFile, snapshot: capsule, cwd: fixtureCwd }))
      .rejects.toMatchObject({ code: EXIT.exists })
  })

  it('缺少必需依赖时显式失败，不静默漏包', async () => {
    const root = path.join(tmp, 'broken')
    await pkg(path.join(root, 'node_modules', 'broken-app'), {
      name: 'broken-app',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'never-installed': '1.0.0' },
    })
    await put(path.join(root, 'node_modules', 'broken-app', 'index.js'), "module.exports = {}\n")
    await expect(
      createSnapshot({
        cliEntry: path.join(root, 'node_modules', 'broken-app', 'index.js'),
        snapshot: path.join(tmp, 'broken-capsule'),
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: EXIT.closure })
    expect(await fs.readdir(tmp)).not.toContain('broken-capsule')
  })

  it('篡改运行文件被 verify 检出', async () => {
    const clone = await cloneSnapshot('tamper')
    const manifest: any = await readManifest(clone)
    await fs.writeFile(path.join(clone, manifest.entries.cli), 'tampered payload\n', 'utf8')
    const check = await verifySnapshot({ snapshot: clone })
    expect(check.ok).toBe(false)
    expect(kinds(check)).toContain('tampered-file')
  })

  it('运行文件丢失被 verify 检出', async () => {
    const clone = await cloneSnapshot('missing')
    const manifest: any = await readManifest(clone)
    await fs.rm(path.join(clone, manifest.entries.cli))
    const check = await verifySnapshot({ snapshot: clone })
    expect(check.ok).toBe(false)
    expect(kinds(check)).toContain('missing-file')
  })

  it('清单外新增文件被 verify 检出', async () => {
    const clone = await cloneSnapshot('intruder')
    await put(path.join(clone, 'code', 'intruder.js'), 'module.exports = 1\n')
    const check = await verifySnapshot({ snapshot: clone })
    expect(check.ok).toBe(false)
    expect(kinds(check)).toContain('unexpected-file')
  })

  it('manifest 路径穿越与缺哈希记录都被拒绝', async () => {
    const traversal = await cloneSnapshot('traversal')
    const traversalManifest: any = await readManifest(traversal)
    traversalManifest.files[0].path = '../../outside-runtime.js'
    await writeManifest(traversal, traversalManifest)
    const traversalCheck = await verifySnapshot({ snapshot: traversal })
    expect(traversalCheck.ok).toBe(false)
    expect(kinds(traversalCheck)).toContain('path-boundary')

    const noHash = await cloneSnapshot('no-hash')
    const noHashManifest: any = await readManifest(noHash)
    delete noHashManifest.files[0].sha256
    await writeManifest(noHash, noHashManifest)
    const noHashCheck = await verifySnapshot({ snapshot: noHash })
    expect(noHashCheck.ok).toBe(false)
    expect(kinds(noHashCheck)).toContain('file-hash-invalid')
  })

  it('依赖节点目录被替换为外部符号链接时拒绝读取外部正文', async () => {
    const clone = await cloneSnapshot('node-dir')
    const manifest: any = await readManifest(clone)
    const node = manifest.nodes.find((item: any) => item.name === '@fx/dep-a')
    expect(node).toBeTruthy()
    const outside = path.join(tmp, 'outside-node-dir')
    await pkg(outside, { name: '@fx/dep-a', version: '1.0.0', main: 'index.js' })
    await put(path.join(outside, 'index.js'), "module.exports = { marker: 'outside' }\n")
    const nodeDir = path.join(clone, node.path)
    await fs.rm(nodeDir, { recursive: true, force: true })
    await fs.symlink(outside, nodeDir, 'dir')
    const check = await verifySnapshot({ snapshot: clone })
    expect(check.ok).toBe(false)
    expect(kinds(check)).toContain('node-dir-link')
  })

  it('节点 package.json 自身是外部符号链接时拒绝读取外部正文', async () => {
    const clone = await cloneSnapshot('pkg-json')
    const manifest: any = await readManifest(clone)
    const node = manifest.nodes.find((item: any) => item.name === '@fx/dep-b')
    expect(node).toBeTruthy()
    const outsideJson = path.join(tmp, 'outside-pkg', 'package.json')
    await put(outsideJson, JSON.stringify({ name: '@fx/dep-b', version: '1.0.0' }) + '\n')
    const pkgPath = path.join(clone, node.path, 'package.json')
    await fs.rm(pkgPath)
    await fs.symlink(outsideJson, pkgPath)
    const check = await verifySnapshot({ snapshot: clone })
    expect(check.ok).toBe(false)
    expect(kinds(check)).toContain('package-json-link')
  })

  it('无生产依赖的单包快照允许 edges 为空，仍校验文件与入口', async () => {
    const root = path.join(tmp, 'solo')
    await pkg(path.join(root, 'node_modules', 'solo-cli'), {
      name: 'solo-cli',
      version: '1.0.0',
      main: 'index.js',
      bin: { solo: 'index.js' },
    })
    await put(path.join(root, 'node_modules', 'solo-cli', 'index.js'), "module.exports = { solo: true }\n")
    const created = await createSnapshot({
      cliEntry: path.join(root, 'node_modules', 'solo-cli', 'index.js'),
      snapshot: path.join(tmp, 'solo-capsule'),
      cwd: root,
    })
    const manifest: any = await readManifest(created.snapshot)
    expect(manifest.edges.length).toBe(0)
    const check = await verifySnapshot({ snapshot: created.snapshot })
    expect(check.ok, JSON.stringify(check.violations)).toBe(true)
    expect(check.counts.nodes).toBe(1)
    await fs.access(path.join(created.snapshot, manifest.entries.cli))
  })

  it('内部运行时代码 import 的已安装未声明依赖被纳入闭包并可在快照内启动', async () => {
    const root = path.join(tmp, 'undeclared-cwd')
    const appDir = path.join(root, 'pkg', 'app')
    await pkg(appDir, {
      name: 'internal-app',
      version: '1.0.0',
      main: 'index.js',
      files: ['index.js'],
    })
    await put(
      path.join(appDir, 'index.js'),
      [
        "const hidden = require('hidden-dep')",
        "process.stdout.write('UNDECLARED-OK ' + hidden.marker + '\\n')",
        '',
      ].join('\n'),
    )
    await pkg(path.join(root, 'node_modules', 'hidden-dep'), {
      name: 'hidden-dep',
      version: '1.0.0',
      main: 'index.js',
    })
    await put(
      path.join(root, 'node_modules', 'hidden-dep', 'index.js'),
      "module.exports = { marker: 'hidden-marker' }\n",
    )

    const created = await createSnapshot({
      cliEntry: path.join(appDir, 'index.js'),
      snapshot: path.join(tmp, 'undeclared-capsule'),
      cwd: root,
    })
    const manifest: any = await readManifest(created.snapshot)
    expect(manifest.nodes.some((node: any) => node.name === 'hidden-dep')).toBe(true)
    expect(manifest.edges.some((edge: any) => edge.name === 'hidden-dep' && edge.to)).toBe(true)

    const run = spawnSync(process.execPath, [path.join(created.snapshot, manifest.entries.cli)], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('UNDECLARED-OK hidden-marker')

    const check = await verifySnapshot({ snapshot: created.snapshot })
    expect(check.ok, JSON.stringify(check.violations)).toBe(true)
  })

  it('注释与字符串里的 import 示例不会被当成真实依赖', async () => {
    const root = path.join(tmp, 'quiet-cwd')
    const appDir = path.join(root, 'pkg', 'quiet-app')
    await pkg(appDir, {
      name: 'quiet-app',
      version: '1.0.0',
      main: 'index.js',
      files: ['index.js'],
    })
    await put(
      path.join(appDir, 'index.js'),
      [
        "// 文档示例：import('comment-only-pkg') 不是真实引入",
        '/* require("block-comment-pkg") 也只是注释 */',
        "const sample = \"import('${t}')\"",
        'const quoted = \'require("string-only-pkg")\'',
        "process.stdout.write('QUIET-OK ' + sample.length + quoted.length + '\\n')",
        '',
      ].join('\n'),
    )

    const created = await createSnapshot({
      cliEntry: path.join(appDir, 'index.js'),
      snapshot: path.join(tmp, 'quiet-capsule'),
      cwd: root,
    })
    const manifest: any = await readManifest(created.snapshot)
    for (const banned of ['comment-only-pkg', 'block-comment-pkg', 'string-only-pkg', '${t}']) {
      expect(manifest.nodes.some((node: any) => node.name === banned), banned).toBe(false)
      expect(manifest.edges.some((edge: any) => edge.name === banned), banned).toBe(false)
    }
    const run = spawnSync(process.execPath, [path.join(created.snapshot, manifest.entries.cli)], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('QUIET-OK')
  })

  it('真实 --help 同步说明输入与输出边界', async () => {
    const toolPath = fileURLToPath(new URL('../scripts/self-host-snapshot.mjs', import.meta.url))
    const help = spawnSync(process.execPath, [toolPath, '--help'], { encoding: 'utf8' })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('允许位于 --cwd 内')
    expect(help.stdout).toContain('复制结果必须全部在它之外')
  })
})

it('preserves internal declared runtime resources and executable modes, and detects mode tampering', async () => {
  const root = path.join(tmp, 'resources'), app = path.join(root, 'packages/app')
  await pkg(app, { name: 'internal-resource-app', version: '1.0.0', main: 'dist/index.cjs', files: ['dist', 'skills', 'native'] })
  await put(path.join(app, 'dist/index.cjs'), "console.log('resource fixture')\n")
  await put(path.join(app, 'skills/runtime/SKILL.md'), 'Runtime skill content')
  await put(path.join(app, 'native/helper'), '#!/bin/sh\nexit 0\n')
  await fs.chmod(path.join(app, 'native/helper'), 0o755)
  const created = await createSnapshot({ cwd: root, cliEntry: path.join(app, 'dist/index.cjs'), snapshot: path.join(tmp, 'resources-capsule') })
  const manifest: any = await readManifest(created.snapshot)
  const helper = manifest.files.find((f: any) => f.path.endsWith('/native/helper'))
  expect(helper).toBeDefined()
  expect(manifest.files.some((f: any) => f.path.endsWith('/skills/runtime/SKILL.md'))).toBe(true)
  if (process.platform !== 'win32') {
    expect((await fs.stat(path.join(created.snapshot, helper.path))).mode & 0o777).toBe(0o755)
    await fs.chmod(path.join(created.snapshot, helper.path), 0o644)
    expect((await verifySnapshot({ snapshot: created.snapshot })).ok).toBe(false)
  }
})

it('requires non-optional peer dependencies while optional overrides and optional peers may be absent', async () => {
  const root = path.join(tmp, 'peer-fixture'), app = path.join(root, 'node_modules/app')
  await pkg(app, { name: 'peer-app', version: '1.0.0', main: 'index.cjs', peerDependencies: { required: '*' } })
  await put(path.join(app, 'index.cjs'), 'module.exports = 1\n')
  await expect(createSnapshot({ cwd: root, cliEntry: path.join(app, 'index.cjs'), snapshot: path.join(tmp, 'missing-peer-capsule') })).rejects.toThrow(/required/)
  await pkg(app, { name: 'peer-app', version: '1.0.0', main: 'index.cjs', dependencies: { absent: '*' }, optionalDependencies: { absent: '*' }, peerDependencies: { optional: '*' }, peerDependenciesMeta: { optional: { optional: true } } })
  const created = await createSnapshot({ cwd: root, cliEntry: path.join(app, 'index.cjs'), snapshot: path.join(tmp, 'optional-peer-capsule') })
  expect((await verifySnapshot({ snapshot: created.snapshot })).ok).toBe(true)
})
