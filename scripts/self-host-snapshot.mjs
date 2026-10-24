#!/usr/bin/env node
/**
 * self-host-snapshot.mjs — 把当前已构建、正在运行的 Pulse 固化成 --cwd 之外可独立启动的代码胶囊。
 *
 * 边界：
 *  - 只复制代码：不读取、不创建、不复制 data-dir / 配置 / 凭据 / 会话 / 数据库 / 浏览器数据 / 环境变量。
 *  - 文件本体一律物理复制（绝不使用硬链接），仅在快照内部重建依赖链接；链接不得指向快照外部。
 *  - manifest 记录每个运行文件的 sha256/大小/权限、每个链接目标、依赖节点与边，以及两个入口路径。
 *  - verify 只读快照自身与 manifest，不访问被修复工作区或原源码，且逐包校验全部依赖而非仅入口。
 */

import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const TOOL_FILE = fileURLToPath(import.meta.url)
export const MANIFEST_DIR = '.pulse-snapshot'
export const MANIFEST_NAME = 'manifest.json'
export const MANIFEST_VERSION = 1
export const SUPERVISOR_FILE_NAME = 'self-host.mjs'
export const TOOL_FILE_NAME = 'self-host-snapshot.mjs'
export const CODE_DIR = 'code'
export const STORE_DIR = '.pulse-store'

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  boundary: 3,
  closure: 4,
  exists: 5,
  verify: 6,
}

/** 外部包内不属于运行时的目录，复制时跳过（包本体已经是构建产物）。 */
const SKIP_DIRS = new Set([
  '.git',
  '.github',
  '.vscode',
  '.idea',
  'test',
  'tests',
  '__tests__',
  '__test__',
  'coverage',
  'docs',
  'example',
  'examples',
  'benchmark',
  'benchmarks',
  '.turbo',
  '.cache',
])

/** 内部工作区包只复制这些已构建产物目录，绝不带整个仓库。 */
const INTERNAL_RUNTIME_DIRS = [
  'dist',
  'build',
  'out',
  'bin',
  'lib',
  'prebuilds',
  'native',
  'assets',
  'resources',
  'public',
  'static',
  'templates',
  'prompts',
  'schema',
  'schemas',
  'locales',
  'helpers',
  'scripts',
  'skills',
  'workflows',
]

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.map', '.md', '.markdown'])

export class SnapshotError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'SnapshotError'
    this.code = code
    this.details = details ?? null
  }
}

const USAGE = `self-host-snapshot.mjs — 把已构建的 Pulse 固化成 cwd 之外的独立代码胶囊

用法:
  node scripts/self-host-snapshot.mjs snapshot --cli-entry <file> --snapshot <dir> --cwd <dir> [选项]
  node scripts/self-host-snapshot.mjs verify --snapshot <dir> [--cwd <dir>] [--json]
  node scripts/self-host-snapshot.mjs --help

snapshot 必需:
  --cli-entry <file>   现有已构建 Pulse CLI 入口真实文件；允许位于 --cwd 之内（只读复制）
  --snapshot <dir>     目标快照目录，必须尚不存在；复制结果必须落在 --cwd 之外
  --cwd <dir>          被修复的工作区

输入 / 输出边界（重要）:
  - 输入：--cli-entry 及其全部源依赖允许位于 --cwd 之内（例如 Pulse 自己的工作区），
    只按实际安装闭包只读复制，不修改任何输入文件。
  - 输出：复制后的入口、依赖节点、内部链接与 manifest 必须全部落在 --cwd 之外，
    因此可以直接用 Pulse 自身构建第一个稳定快照。
  - 目标尚不存在时正常创建；边界判断解析目标已存在的父目录，绝不 realpath 尚不存在的 target。

snapshot 选项:
  --data-dir <dir>     调用者现有 data-dir，仅用于生成可复制命令，本工具不读取也不复制它
  --output <dir>       仅用于生成可复制命令（self-host.mjs 的 --output）
  --task-file <file>   仅用于生成可复制命令
  --checks-file <file> 仅用于生成可复制命令
  --json               以 JSON 输出结果

verify 选项:
  --snapshot <dir>     已生成的快照目录（只读本快照，不访问原工作区）
  --cwd <dir>          额外的边界断言：快照内任何真实路径都不得落在该目录内

退出码: 0 成功, 2 用法错误, 3 边界违规, 4 依赖闭包不完整, 5 目标已存在, 6 校验失败, 1 内部错误
`

function realpath(target) {
  return fsSync.realpathSync.native ? fsSync.realpathSync.native(target) : fsSync.realpathSync(target)
}

function expectString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SnapshotError(EXIT.usage, `缺少必需参数 ${name}`)
  }
  return value
}

/** child 是否等于 parent 或位于 parent 之内（按真实路径比较）。 */
function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(await fsp.readFile(file))
  return hash.digest('hex')
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

function requireJson(file) {
  return JSON.parse(fsSync.readFileSync(file, 'utf8'))
}

/** 从某个文件向上找到它所属的包目录（最近一个含 package.json 的祖先）。 */
function findPackageDir(fromFile) {
  let dir = path.dirname(fromFile)
  for (;;) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function slugify(name, version, realDir) {
  const digest = crypto.createHash('sha256').update(realDir).digest('hex').slice(0, 10)
  const safe = name.replace(/[^a-zA-Z0-9._@-]+/g, '-').replace(/^@/, '')
  return `${safe}@${version || '0.0.0'}-${digest}`
}

function fail(code, message, details) {
  return new SnapshotError(code, message, details)
}
/** 解析真实路径；目标尚不存在时，解析最近的已存在祖先再拼回剩余段。 */
function realpathLoose(target) {
  const abs = path.resolve(target)
  const rest = []
  let probe = abs
  while (!fsSync.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    rest.unshift(path.basename(probe))
    probe = parent
  }
  const base = fsSync.existsSync(probe) ? realpath(probe) : probe
  return rest.length === 0 ? base : path.join(base, ...rest)
}

/**
 * child 必须在 parent 之外；返回 child 的真实路径。
 * 允许 child 尚不存在：边界按最近的已存在祖先解析，绝不 realpath 不存在的 target。
 */
function assertOutside(cwdReal, target, label) {
  const real = realpathLoose(target)
  if (isInside(cwdReal, real)) {
    throw fail(EXIT.boundary, `${label} 必须位于被修复 cwd 之外: ${real}`, { target: real, cwd: cwdReal })
  }
  return real
}

/** node_modules 之外的真实目录视为工作区内部包（pnpm 把外部包实体放在 node_modules/.pnpm 下）。 */
function isInternalDir(realDir) {
  return !toPosix(realDir).includes('/node_modules/')
}

/** 从 fromDir 起按 Node 解析顺序向上查找 name 包的真实目录（含 pnpm / nested 变体）。 */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name)
      const pkgJson = path.join(candidate, 'package.json')
      if (fsSync.existsSync(pkgJson)) return { dir: realpath(candidate), packageJson: pkgJson }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function copyFilePreserveMode(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  await fsp.copyFile(from, to)
  const stat = await fsp.stat(from)
  await fsp.chmod(to, stat.mode & 0o7777)
  return { size: stat.size, mode: stat.mode & 0o7777 }
}

/** 任何包内都绝不复制进快照的配置/凭据类文件（显式排除，而非仅靠扩展名白名单）。 */
const SENTINEL_FILES = new Set([
  '.env',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmrc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'credentials.json',
  'cookies.json',
  'sessions.json',
  'pulse-config.json',
  'pulse.config.json',
])

/** 用户数据/会话/数据库/浏览器数据目录名：一律不进入快照。 */
const SENTINEL_DIRS = new Set([
  'sessions',
  'session-store',
  'databases',
  'browser-data',
  'browserdata',
  'user-data',
  'userdata',
  'credentials',
  'secrets',
])

const SENTINEL_SUFFIX = ['.sqlite', '.sqlite3', '.db', '.pem', '.key', '.p12', '.pfx']

/** 路径（相对包根）是否命中必须排除的配置/凭据/会话/数据库哨兵。 */
function isSentinelPath(rel) {
  const segments = toPosix(rel).split('/').filter((segment) => segment !== '')
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (SENTINEL_FILES.has(lower)) return true
    if (SENTINEL_DIRS.has(lower)) return true
    if (lower.startsWith('.env.') || lower.endsWith('.env')) return true
  }
  const base = segments.length > 0 ? segments[segments.length - 1].toLowerCase() : ''
  return SENTINEL_SUFFIX.some((suffix) => base.endsWith(suffix))
}

/** 外部包：除哨兵文件外的运行资产全部保留，绝不按扩展名丢弃运行文件。 */
function keepExternalFile(rel, name) {
  return !isSentinelPath(rel || name)
}

/** 内部工作区包里属于开发/测试/文档的顶层目录：绝不复制。 */
const INTERNAL_SKIP_TOP = new Set([
  'src',
  'test',
  'tests',
  '__tests__',
  'spec',
  'docs',
  'examples',
  'benchmarks',
  'coverage',
])

/** 内部工作区包保留的运行产物：脚本、资源、元数据、模板与 Markdown 技能说明。 */
const RUNTIME_EXT = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.node', '.wasm', '.json',
  '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.txt', '.sh', '.cmd', '.ps1', '.yml', '.yaml',
  '.md', '.markdown', '.hbs', '.handlebars', '.tpl',
])

/**
 * 内部包运行文件判定：
 *  - 开发目录与 *.test/spec 排除，配置/凭据/会话/数据库哨兵排除；
 *  - 扩展名白名单保留脚本、资源、Markdown 模板与 skills 说明；
 *  - 无扩展名的原生运行文件（预编译二进制、启动脚本）一律保留，不被白名单静默丢弃。
 */
function isRuntimeFile(rel, name) {
  const normalised = toPosix(rel)
  const top = normalised.split('/')[0]
  if (INTERNAL_SKIP_TOP.has(top)) return false
  if (isSentinelPath(normalised)) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false
  const ext = path.extname(name).toLowerCase()
  if (ext === '') return true
  return RUNTIME_EXT.has(ext)
}

/** 递归物理复制（copyFile，绝不硬链接）；返回相对 destRoot 的文件清单。 */
async function copyRuntimeTree(srcRoot, destRoot, options) {
  const collected = []
  async function visit(srcDir, relBase) {
    const entries = await fsp.readdir(srcDir, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        const target = await fsp.realpath(srcPath).catch(() => null)
        if (!target) continue
        const stat = await fsp.stat(target).catch(() => null)
        if (!stat || !stat.isFile()) continue
        if (!options.keepFile(rel, entry.name)) continue
        const copied = await copyFilePreserveMode(target, path.join(destRoot, rel))
        collected.push({ rel, ...copied })
        continue
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        if (options.skipDir && options.skipDir(entry.name, rel)) continue
        await visit(srcPath, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!options.keepFile(rel, entry.name)) continue
      const copied = await copyFilePreserveMode(srcPath, path.join(destRoot, rel))
      collected.push({ rel, ...copied })
    }
  }
  await visit(srcRoot, '')
  return collected
}

/** 内部包必须保留的声明路径：package.json、files、main/module/browser、bin 与 exports 实际入口。 */
function internalKeepSet(info) {
  const keep = new Set(['package.json'])
  const addPath = (value) => {
    if (typeof value !== 'string' || value === '') return
    const normalised = toPosix(value).replace(/^\.\//, '')
    if (normalised === '' || normalised.startsWith('..')) return
    keep.add(normalised)
  }
  const visitExports = (value) => {
    if (typeof value === 'string') addPath(value)
    else if (Array.isArray(value)) for (const item of value) visitExports(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) visitExports(item)
  }
  addPath(info.main)
  addPath(info.module)
  addPath(info.browser)
  addPath(info.types)
  if (typeof info.bin === 'string') addPath(info.bin)
  for (const value of Object.values(info.bin ?? {})) addPath(value)
  visitExports(info.exports)
  for (const entry of Array.isArray(info.files) ? info.files : []) addPath(entry)
  return keep
}

/**
 * 内部包：package.json + 发布 files/入口声明 + 已构建产物目录 + 根级运行资源。
 * 按真实发布内容保留（CLI 的 package.files 含 scripts、Markdown 模板/skills、无扩展名原生文件），
 * 绝不复制整个仓库、src、测试或用户数据。
 */
async function copyInternalPackage(realDir, destDir) {
  const files = []
  const info = requireJson(path.join(realDir, 'package.json'))
  const declared = internalKeepSet(info)
  const pkg = await copyFilePreserveMode(path.join(realDir, 'package.json'), path.join(destDir, 'package.json'))
  files.push({ rel: 'package.json', ...pkg })

  const keepDir = (name) => {
    if (INTERNAL_RUNTIME_DIRS.includes(name)) return true
    if (declared.has(name)) return true
    for (const item of declared) if (item.startsWith(`${name}/`)) return true
    return false
  }

  const entries = await fsp.readdir(realDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'package.json' || entry.name === 'node_modules') continue
    if (isSentinelPath(entry.name)) continue
    const srcPath = path.join(realDir, entry.name)
    if (entry.isDirectory()) {
      if (!keepDir(entry.name)) continue
      const sub = await copyRuntimeTree(srcPath, path.join(destDir, entry.name), {
        skipDir: (dirName) => dirName === 'node_modules' || SENTINEL_DIRS.has(dirName.toLowerCase()),
        keepFile: (rel, name) => isRuntimeFile(`${entry.name}/${rel}`, name),
      })
      for (const item of sub) files.push({ rel: `${entry.name}/${item.rel}`, size: item.size, mode: item.mode })
      continue
    }
    if (!entry.isFile()) continue
    if (!isRuntimeFile(entry.name, entry.name)) continue
    const copied = await copyFilePreserveMode(srcPath, path.join(destDir, entry.name))
    files.push({ rel: entry.name, ...copied })
  }
  return files
}

/** 外部包：物理整包复制（跳过测试/文档目录与源码扩展名），保留原有权限位。 */
async function copyExternalPackage(realDir, destDir) {
  const files = await copyRuntimeTree(realDir, destDir, {
    skipDir: (dirName) => SKIP_DIRS.has(dirName) || SENTINEL_DIRS.has(dirName.toLowerCase())
      || dirName === 'node_modules',
    keepFile: keepExternalFile,
  })
  if (!files.some((item) => item.rel === 'package.json')) {
    throw fail(EXIT.closure, `外部包缺少 package.json: ${realDir}`)
  }
  return files
}

/**
 * 生产依赖分类：
 *  - dependencies 默认必需；
 *  - optionalDependencies 覆盖同名 dependencies 语义（同名视为真实可选）；
 *  - peerDependencies 默认必需，仅 peerDependenciesMeta[name].optional === true 才允许缺失。
 */
function collectDependencies(info) {
  const deps = []
  const optionalNames = new Set(Object.keys(info.optionalDependencies ?? {}))
  const peerMeta = info.peerDependenciesMeta ?? {}
  const push = (name, spec, optional) => {
    if (typeof name !== 'string' || name.trim() === '') return
    const existing = deps.find((dep) => dep.name === name)
    if (existing) {
      if (optional) existing.optional = true
      return
    }
    deps.push({ name, spec: typeof spec === 'string' ? spec : '', optional })
  }
  for (const [name, spec] of Object.entries(info.dependencies ?? {})) {
    push(name, spec, optionalNames.has(name))
  }
  for (const [name, spec] of Object.entries(info.optionalDependencies ?? {})) push(name, spec, true)
  for (const [name, spec] of Object.entries(info.peerDependencies ?? {})) {
    push(name, spec, peerMeta[name]?.optional === true)
  }
  return deps
}

/** 扫描内部包实时文件时跳过的开发类目录（运行产物在 dist/lib/bin 等目录内）。 */
const IMPORT_SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'test',
  'tests',
  '__tests__',
  '__test__',
  'docs',
  'coverage',
  '.git',
  '.github',
  'examples',
  'benchmarks',
])

const IMPORT_SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.jsx'])

const BACKSLASH = String.fromCharCode(92)

/**
 * 标记运行时代码里“不是代码”的区间（注释、字符串、模板字面量）。
 * 落在这些区间起始位置的 import/require 关键字只是示例文本，不是真实模块引入。
 */
function codeMask(source) {
  const mask = new Uint8Array(source.length)
  const length = source.length
  const mark = (from, to) => {
    const stop = Math.min(to, length)
    for (let i = from; i < stop; i += 1) mask[i] = 1
  }
  let index = 0
  while (index < length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? length : end
      mark(index, stop)
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? length : end + 2
      mark(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      let cursor = index + 1
      while (cursor < length) {
        const current = source[cursor]
        if (current === BACKSLASH) {
          cursor += 2
          continue
        }
        if (current === quote) {
          cursor += 1
          break
        }
        if (quote !== '`' && current === '\n') break
        cursor += 1
      }
      const stop = Math.min(cursor, length)
      mark(index, stop)
      index = stop
      continue
    }
    index += 1
  }
  return mask
}

/** 从一段运行时代码里抽取裸模块标识（静态 import / 动态 import() / require）。 */
function extractModuleSpecifiers(source) {
  const mask = codeMask(source)
  const found = new Set()
  const patterns = [
    /\bimport\s+[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      // 注释、字符串与模板里的示例（如 import('${t}')）不是真实依赖。
      if (mask[match.index] === 1) continue
      found.add(match[1])
    }
  }
  return found
}

/** 裸标识 → 包名；相对路径、绝对路径、包内 #imports 与带协议的标识一律不算依赖包。 */
function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null
  return parts[0] || null
}

/**
 * 内部已构建代码实际 import 但 package.json 未声明的依赖包。
 * 只读扫描，不修改输入；已声明依赖与 Node 内置模块不重复计算。
 */
async function discoverUndeclaredImports(node) {
  const builtins = new Set(builtinModules.filter((name) => !name.startsWith('_')))
  const declared = new Set(node.dependencies.map((dep) => dep.name))
  const specifiers = new Map()

  async function visit(dir, relBase) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (IMPORT_SCAN_SKIP_DIRS.has(entry.name)) continue
        await visit(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!IMPORT_SCAN_EXT.has(path.extname(entry.name).toLowerCase())) continue
      // 只扫描实际会被复制进快照的运行文件；未发布的开发源码不作为依赖来源。
      if (!isRuntimeFile(rel, entry.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
      if (isSentinelPath(rel)) continue
      const source = await fsp.readFile(abs, 'utf8').catch(() => '')
      if (!source) continue
      for (const raw of extractModuleSpecifiers(source)) {
        const name = packageNameOf(raw)
        if (!name) continue
        if (builtins.has(name) || name === node.name) continue
        if (declared.has(name)) continue
        const bucket = specifiers.get(name)
        if (bucket) bucket.add(raw)
        else specifiers.set(name, new Set([raw]))
      }
    }
  }

  await visit(node.realDir, '')
  return [...specifiers.entries()]
    .map(([name, set]) => ({ name, specifiers: [...set].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** 解析入口的生产依赖闭包，按真实路径区分同名/peer 变体，支持传递与循环。 */
async function planClosure(entryFile, cwdReal) {
  const nodes = new Map()
  const edges = []
  const queue = []
  const entryPkgDir = findPackageDir(entryFile)
  if (!entryPkgDir) throw fail(EXIT.closure, `CLI 入口不在任何包目录内: ${entryFile}`)

  const addNode = (realDir, packageJsonPath) => {
    const info = requireJson(packageJsonPath)
    const name = typeof info.name === 'string' && info.name ? info.name : path.basename(realDir)
    const version = typeof info.version === 'string' ? info.version : ''
    const slug = slugify(name, version, realDir)
    const existing = nodes.get(slug)
    if (existing) return existing
    const node = { slug, name, version, realDir, internal: isInternalDir(realDir), dependencies: collectDependencies(info) }
    nodes.set(slug, node)
    queue.push(node)
    return node
  }

  const entryRealDir = realpath(entryPkgDir)
  const entryNode = addNode(entryRealDir, path.join(entryRealDir, 'package.json'))
  while (queue.length > 0) {
    const node = queue.shift()
    for (const dep of node.dependencies) {
      const resolved = resolvePackageDir(dep.name, node.realDir)
      if (!resolved) {
        if (dep.optional) {
          edges.push({ from: node.slug, name: dep.name, spec: dep.spec, optional: true, to: null })
          continue
        }
        throw fail(
          EXIT.closure,
          `缺少必需依赖 ${dep.name}（被 ${node.name}${node.version ? `@${node.version}` : ''} 依赖）`,
          { from: node.name, dependency: dep.name, spec: dep.spec, searchedFrom: node.realDir },
        )
      }
      const child = addNode(resolved.dir, resolved.packageJson)
      edges.push({ from: node.slug, to: child.slug, name: dep.name, spec: dep.spec, optional: dep.optional })
    }
    // 内部已构建代码实际 import 但未声明的已安装依赖：按原解析身份纳入闭包；
    // 解析不到且非内置模块时显式失败，绝不出现“构建成功但漏包”。
    if (!node.internal) continue
    for (const extra of await discoverUndeclaredImports(node)) {
      const resolvedExtra = resolvePackageDir(extra.name, node.realDir)
      if (!resolvedExtra) {
        throw fail(
          EXIT.closure,
          `运行时代码 import 了未安装的依赖 ${extra.name}（${node.name} 未在 package.json 声明）`,
          { from: node.name, dependency: extra.name, specifiers: extra.specifiers, searchedFrom: node.realDir },
        )
      }
      node.dependencies.push({ name: extra.name, spec: '', optional: false, discovered: true })
      const child = addNode(resolvedExtra.dir, resolvedExtra.packageJson)
      edges.push({ from: node.slug, to: child.slug, name: extra.name, spec: '', optional: false })
    }
  }

  // 输入（入口及其全部源依赖）允许位于被修复 cwd 之内，只读复制；
  // 边界只约束复制结果，由 createSnapshot 对目标快照与内部链接判定。
  void cwdReal
  return { nodes, edges, entrySlug: entryNode.slug }
}

/** 快照内链接目标一律相对，且必须落在快照内部。 */
function relativeLink(fromPath, toPath) {
  return toPosix(path.relative(path.dirname(fromPath), toPath))
}

/* --------------------------------------------------------------- 快照构建 */

function posixRel(root, abs) {
  return toPosix(path.relative(root, abs))
}

/** 任何写入快照的位置都必须落在快照根内。 */
function assertInsideRoot(snapshotRoot, target, label) {
  const rel = path.relative(snapshotRoot, target)
  if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw fail(EXIT.boundary, `${label} 落在快照之外: ${target}`)
  }
}

/** 目标尚不存在时求其真实绝对路径：解析最近存在的祖先真实路径再拼回剩余段。 */
function resolveNewPath(target) {
  const abs = path.resolve(target)
  const rest = []
  let probe = abs
  while (!fsSync.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    rest.unshift(path.basename(probe))
    probe = parent
  }
  const base = fsSync.existsSync(probe) ? realpath(probe) : probe
  return path.join(base, ...rest)
}

function tempSibling(targetAbs) {
  const suffix = crypto.randomBytes(6).toString('hex')
  return path.join(path.dirname(targetAbs), `.${path.basename(targetAbs)}.tmp-${suffix}`)
}

/** 只在快照内部建立相对符号链接；目标必须在快照内。 */
async function writeInternalLink(linkPath, targetAbs, snapshotRoot) {
  assertInsideRoot(snapshotRoot, targetAbs, '依赖链接目标')
  const rel = toPosix(path.relative(path.dirname(linkPath), targetAbs))
  await fsp.mkdir(path.dirname(linkPath), { recursive: true })
  await fsp.symlink(rel, linkPath, 'dir')
  return rel
}

/** 把解析结果写回每个依赖条目，供清单与校验共用（身份以真实路径对应的 slug 为准）。 */
function attachResolvedSlugs(nodes, edges) {
  for (const edge of edges) {
    if (!edge.to) continue
    const from = nodes.get(edge.from)
    if (!from) continue
    const dep = from.dependencies.find((item) => item.name === edge.name)
    if (dep) dep.resolved = edge.to
  }
  for (const node of nodes.values()) {
    for (const dep of node.dependencies) if (!dep.resolved) dep.resolved = null
  }
}

/** 物理复制每个节点：内部包只取构建产物，外部包整包（保留权限），绝不硬链接。 */
async function copyNodesInto(storeDir, nodes) {
  const absFiles = []
  for (const node of nodes.values()) {
    const destDir = path.join(storeDir, node.slug)
    const files = node.internal
      ? await copyInternalPackage(node.realDir, destDir)
      : await copyExternalPackage(node.realDir, destDir)
    node.files = files.length
    for (const item of files) absFiles.push(path.join(destDir, item.rel))
  }
  return absFiles
}

/** 每个节点的 node_modules 里重建指向快照内部 .store 的相对链接（支持循环与同名变体）。 */
async function createDependencyLinks(snapshotRoot, storeDir, nodes) {
  const links = []
  for (const node of nodes.values()) {
    for (const dep of node.dependencies) {
      if (!dep.resolved) continue
      const target = nodes.get(dep.resolved)
      if (!target) throw fail(EXIT.closure, `依赖身份丢失: ${dep.name}`)
      const linkPath = path.join(storeDir, node.slug, 'node_modules', dep.name)
      const rel = await writeInternalLink(linkPath, path.join(storeDir, target.slug), snapshotRoot)
      links.push({ path: posixRel(snapshotRoot, linkPath), target: rel })
    }
  }
  links.sort((a, b) => (a.path < b.path ? -1 : 1))
  return links
}

async function recordFiles(snapshotRoot, absFiles) {
  const seen = new Set()
  const records = []
  for (const abs of absFiles) {
    const rel = posixRel(snapshotRoot, abs)
    if (seen.has(rel)) continue
    seen.add(rel)
    const stat = await fsp.stat(abs)
    records.push({ path: rel, size: stat.size, mode: stat.mode & 0o7777, sha256: await sha256File(abs) })
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return records
}

function quoteArg(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** 成功后给用户的可复制调用命令：监督入口优先，缺省退回胶囊 CLI 自身。 */
function buildInvocation({ snapshotRoot, manifest, options }) {
  const cli = path.join(snapshotRoot, manifest.entries.cli)
  const argv = ['node']
  if (manifest.entries.supervisor) {
    argv.push(
      path.join(snapshotRoot, manifest.entries.supervisor),
      '--task-file', options.taskFile || '<task-file>',
      '--checks-file', options.checksFile || '<checks-file>',
      '--cwd', options.cwdPath,
      '--cli-entry', cli,
      '--data-dir', options.dataDir || '<existing-data-dir>',
      '--output', options.output || '<output-dir>',
    )
  } else {
    argv.push(cli, '--help')
  }
  return { argv, shell: argv.map(quoteArg).join(' ') }
}

/**
 * 把当前已构建的 Pulse 固化成 cwd 之外的独立代码胶囊。
 * 不读取、不创建、不复制任何 data-dir / 配置 / 凭据 / 会话 / 数据库 / 浏览器数据。
 */
export async function createSnapshot(options = {}) {
  const cliEntry = expectString(options.cliEntry, 'cliEntry')
  const snapshotTarget = expectString(options.snapshot, 'snapshot')
  const cwdInput = expectString(options.cwd, 'cwd')
  const createdAt = new Date().toISOString()

  const cwdStat = await fsp.stat(cwdInput).catch(() => null)
  if (!cwdStat || !cwdStat.isDirectory()) throw fail(EXIT.usage, `--cwd 不是目录: ${cwdInput}`)
  const cwdReal = realpath(cwdInput)

  const entryStat = await fsp.stat(cliEntry).catch(() => null)
  if (!entryStat || !entryStat.isFile()) throw fail(EXIT.usage, `--cli-entry 不是文件: ${cliEntry}`)
  // 输入入口允许位于 cwd 之内，只读复制；不对输入做 cwd 外断言。
  const entryReal = realpath(cliEntry)

  // 全新不存在的 target 正常创建；边界判断解析其已存在的父目录，绝不 realpath 尚不存在的 target。
  const targetAbs = resolveNewPath(snapshotTarget)
  if (fsSync.existsSync(targetAbs)) throw fail(EXIT.exists, `目标快照已存在，拒绝覆盖: ${targetAbs}`)
  const targetParent = path.dirname(targetAbs)
  const parentStat = await fsp.stat(targetParent).catch(() => null)
  if (!parentStat || !parentStat.isDirectory()) {
    throw fail(EXIT.usage, `目标快照的父目录不存在: ${targetParent}`)
  }
  assertOutside(cwdReal, targetAbs, '目标快照')

  const { nodes, edges, entrySlug } = await planClosure(entryReal, cwdReal)
  attachResolvedSlugs(nodes, edges)
  const entryNode = nodes.get(entrySlug)
  const entryRel = path.relative(entryNode.realDir, entryReal)
  if (entryRel === '' || entryRel.startsWith('..') || path.isAbsolute(entryRel)) {
    throw fail(EXIT.closure, `CLI 入口不在其所属包目录内: ${entryReal}`)
  }

  await fsp.mkdir(path.dirname(targetAbs), { recursive: true })
  const tempRoot = tempSibling(targetAbs)
  await fsp.mkdir(tempRoot)

  try {
    const storeDir = path.join(tempRoot, CODE_DIR, STORE_DIR)
    await fsp.mkdir(storeDir, { recursive: true })
    const nodeFiles = await copyNodesInto(storeDir, nodes)
    const links = await createDependencyLinks(tempRoot, storeDir, nodes)

    const codeFiles = []
    const extraCode = [
      { from: path.join(path.dirname(TOOL_FILE), SUPERVISOR_FILE_NAME), to: `supervisor/${SUPERVISOR_FILE_NAME}` },
      { from: TOOL_FILE, to: `supervisor/${TOOL_FILE_NAME}` },
    ]
    for (const item of extraCode) {
      const stat = await fsp.stat(item.from).catch(() => null)
      if (!stat || !stat.isFile()) continue
      const to = path.join(tempRoot, CODE_DIR, item.to)
      await copyFilePreserveMode(item.from, to)
      codeFiles.push(to)
    }

    const cliEntryRel = posixRel(tempRoot, path.join(storeDir, entrySlug, entryRel))
    const files = await recordFiles(tempRoot, [...nodeFiles, ...codeFiles])
    if (!files.some((file) => file.path === cliEntryRel)) {
      throw fail(EXIT.closure, `入口文件未被复制进快照: ${cliEntryRel}`)
    }

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      createdAt,
      generator: { file: TOOL_FILE_NAME, layout: 'code-only' },
      layout: { code: CODE_DIR, store: `${CODE_DIR}/${STORE_DIR}`, manifest: `${MANIFEST_DIR}/${MANIFEST_NAME}` },
      source: { cwd: cwdReal, cliEntry: entryReal, entryPackage: `${entryNode.name}@${entryNode.version}` },
      entries: {
        cli: cliEntryRel,
        supervisor: codeFiles.some((abs) => posixRel(tempRoot, abs) === `${CODE_DIR}/supervisor/${SUPERVISOR_FILE_NAME}`)
          ? `${CODE_DIR}/supervisor/${SUPERVISOR_FILE_NAME}`
          : null,
        tool: `${CODE_DIR}/supervisor/${TOOL_FILE_NAME}`,
      },
      dataPolicy: {
        codeOnly: true,
        copiesDataDir: false,
        copiesConfig: false,
        copiesCredentials: false,
        copiesSessions: false,
        copiesDatabases: false,
        copiesBrowserData: false,
        copiesEnvironment: false,
      },
      nodes: [...nodes.values()].map((node) => ({
        slug: node.slug,
        name: node.name,
        version: node.version,
        path: posixRel(tempRoot, path.join(storeDir, node.slug)),
        internal: node.internal,
        fileCount: node.files ?? 0,
        dependencies: node.dependencies.map((dep) => ({
          name: dep.name,
          spec: dep.spec,
          optional: dep.optional,
          resolved: dep.resolved ?? null,
        })),
      })),
      edges,
      files,
      links,
    }

    await fsp.mkdir(path.join(tempRoot, MANIFEST_DIR), { recursive: true })
    await fsp.writeFile(path.join(tempRoot, MANIFEST_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const selfCheck = await verifySnapshot({ snapshot: tempRoot })
    if (!selfCheck.ok) {
      throw fail(EXIT.verify, '新快照自检未通过', { violations: selfCheck.violations.slice(0, 20) })
    }

    await fsp.rename(tempRoot, targetAbs)
    const snapshotRoot = realpath(targetAbs)
    const invoke = buildInvocation({
      snapshotRoot,
      manifest,
      options: { ...options, cwdPath: cwdReal },
    })
    return {
      ok: true,
      snapshot: snapshotRoot,
      manifest: path.join(snapshotRoot, MANIFEST_DIR, MANIFEST_NAME),
      entries: manifest.entries,
      counts: { nodes: manifest.nodes.length, files: manifest.files.length, links: manifest.links.length, edges: edges.length },
      invoke,
    }
  } catch (error) {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/* --------------------------------------------------------------- 快照校验 */

const MANIFEST_REL = `${MANIFEST_DIR}/${MANIFEST_NAME}`

function normaliseRel(value) {
  return toPosix(value).replace(/^\.\//, '')
}

/** 只读快照自身：按 lstat 收集普通文件与符号链接，绝不跟随链接。 */
async function walkSnapshot(rootReal) {
  const files = new Map()
  const links = new Map()
  async function visit(dirAbs) {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name)
      const rel = posixRel(rootReal, abs)
      const stat = await fsp.lstat(abs).catch(() => null)
      if (!stat) continue
      if (stat.isSymbolicLink()) {
        links.set(rel, abs)
        continue
      }
      if (stat.isDirectory()) {
        await visit(abs)
        continue
      }
      files.set(rel, { abs, stat })
    }
  }
  await visit(rootReal)
  return { files, links }
}

/**
 * manifest 路径必须先证明自己在快照内部：受限相对路径、无 .. 段，
 * 且最近的已存在祖先目录按真实路径仍在快照内（父目录被换成外部符号链接也会被拒）。
 */
async function containedPath(rootReal, value) {
  const rel = normaliseRel(value)
  const parts = rel.split('/')
  if (rel === '' || rel.includes('\u0000') || path.isAbsolute(rel)) return { ok: false, reason: 'shape', rel }
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return { ok: false, reason: 'shape', rel }
  const abs = path.join(rootReal, ...parts)
  if (!isInside(rootReal, abs)) return { ok: false, reason: 'shape', rel }
  let probe = path.dirname(abs)
  for (;;) {
    if (!isInside(rootReal, probe)) return { ok: false, reason: 'escape', rel }
    const stat = await fsp.lstat(probe).catch(() => null)
    if (stat) {
      const real = await fsp.realpath(probe).catch(() => null)
      if (!real || !isInside(rootReal, real)) return { ok: false, reason: 'escape', rel }
      break
    }
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  return { ok: true, rel, abs }
}

/**
 * 只依赖快照自身校验：文件丢失/篡改/新增、硬链接、越界链接、依赖解析身份、
 * 入口路径与（可选）被修复 cwd 边界。不读取被修复工作区或任何原源码。
 */
export async function verifySnapshot(options = {}) {
  const snapshotInput = expectString(options.snapshot, 'snapshot')
  const rootStat = await fsp.lstat(snapshotInput).catch(() => null)
  if (!rootStat || !rootStat.isDirectory()) {
    throw fail(EXIT.usage, `快照目录不存在: ${snapshotInput}`)
  }
  const rootReal = realpath(snapshotInput)
  const violations = []
  const add = (kind, message, details) => {
    violations.push(details === undefined ? { kind, message } : { kind, message, details })
  }

  if (typeof options.cwd === 'string' && options.cwd.trim() !== '') {
    const cwdAbs = path.resolve(options.cwd)
    const cwdResolved = fsSync.existsSync(cwdAbs) ? realpath(cwdAbs) : cwdAbs
    if (isInside(cwdResolved, rootReal)) {
      add('cwd-boundary', `快照位于被修复 cwd 之内: ${rootReal}`, { cwd: cwdResolved })
    }
  }

  const manifestPath = path.join(rootReal, MANIFEST_DIR, MANIFEST_NAME)
  let manifest
  try {
    manifest = requireJson(manifestPath)
  } catch (error) {
    throw fail(EXIT.verify, `快照缺少可读 manifest: ${manifestPath}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw fail(EXIT.verify, `manifest 结构无效: ${manifestPath}`)
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    add('manifest-version', `manifest 版本不匹配: ${String(manifest.manifestVersion)}`)
  }

  const files = Array.isArray(manifest.files) ? manifest.files : []
  const linkEntries = Array.isArray(manifest.links) ? manifest.links : []
  const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : []
  const edges = Array.isArray(manifest.edges) ? manifest.edges : []
  const entries = manifest.entries && typeof manifest.entries === 'object' ? manifest.entries : {}
  if (files.length === 0) add('manifest-empty', 'manifest 未记录任何运行文件')
  if (nodes.length === 0) add('manifest-empty-nodes', 'manifest 未记录任何依赖节点')
  // 合法的无生产依赖单包快照允许 edges 为空；其文件与入口仍逐项校验。

  // 先做路径包含校验：manifest 文件/链接路径在读取正文或哈希之前就必须限定在快照内。
  const guarded = { files: new Map(), links: new Map() }
  const guardPath = async (label, key, value, bucket) => {
    const contained = await containedPath(rootReal, value)
    if (!contained.ok) {
      add('path-boundary', `${label} 路径越界快照: ${contained.rel}`, { reason: contained.reason })
      return null
    }
    bucket.set(key, contained.abs)
    return contained.abs
  }
  for (const file of files) {
    if (file && typeof file.path === 'string') await guardPath('manifest 文件', normaliseRel(file.path), file.path, guarded.files)
  }
  for (const link of linkEntries) {
    if (link && typeof link.path === 'string') await guardPath('manifest 链接', normaliseRel(link.path), link.path, guarded.links)
  }

  const checkMode = process.platform !== 'win32'
  const expectedFiles = new Set()
  for (const file of files) {
    if (!file || typeof file.path !== 'string') {
      add('file-record-invalid', 'manifest 文件记录缺少 path')
      continue
    }
    const rel = normaliseRel(file.path)
    const guardedAbs = guarded.files.get(rel)
    if (!guardedAbs) continue
    expectedFiles.add(rel)
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      add('file-hash-invalid', `manifest 文件记录缺少有效 sha256: ${rel}`)
      continue
    }
    if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
      add('file-size-invalid', `manifest 文件记录缺少有效 size: ${rel}`)
      continue
    }
    const abs = guardedAbs
    const stat = await fsp.lstat(abs).catch(() => null)
    if (!stat) {
      add('missing-file', `运行文件丢失: ${rel}`)
      continue
    }
    if (stat.isSymbolicLink()) {
      add('file-is-link', `运行文件被替换为符号链接: ${rel}`)
      continue
    }
    if (!stat.isFile()) {
      add('file-not-regular', `运行文件不是普通文件: ${rel}`)
      continue
    }
    if (stat.size !== file.size) {
      add('tampered-file', `文件大小与清单不一致: ${rel}`, { expected: file.size, actual: stat.size })
      continue
    }
    const digest = await sha256File(abs)
    if (digest !== file.sha256) add('tampered-file', `文件哈希与清单不一致: ${rel}`, { expected: file.sha256, actual: digest })
    if (stat.nlink > 1) add('hardlink-file', `运行文件是硬链接而不是物理副本（nlink=${stat.nlink}）: ${rel}`)
    if (checkMode && file.mode !== undefined && (stat.mode & 0o7777) !== file.mode) {
      add('mode-mismatch', `权限位与清单不一致: ${rel}`, { expected: file.mode, actual: stat.mode & 0o7777 })
    }
  }

  const expectedLinks = new Map()
  for (const link of linkEntries) {
    if (!link || typeof link.path !== 'string') {
      add('link-record-invalid', 'manifest 链接记录缺少 path')
      continue
    }
    const rel = normaliseRel(link.path)
    const guardedAbs = guarded.links.get(rel)
    if (!guardedAbs) continue
    expectedLinks.set(rel, link)
    const abs = guardedAbs
    const stat = await fsp.lstat(abs).catch(() => null)
    if (!stat) {
      add('missing-link', `依赖链接丢失: ${rel}`)
      continue
    }
    if (!stat.isSymbolicLink()) {
      add('link-is-file', `依赖链接被替换为文件/目录: ${rel}`)
      continue
    }
    const raw = toPosix(await fsp.readlink(abs))
    if (path.isAbsolute(raw)) {
      add('absolute-link', `依赖链接使用绝对路径: ${rel} -> ${raw}`)
      continue
    }
    const targetReal = await fsp.realpath(abs).catch(() => null)
    if (!targetReal) {
      add('dangling-link', `依赖链接目标不存在: ${rel} -> ${raw}`)
      continue
    }
    if (!isInside(rootReal, targetReal)) {
      add('outbound-link', `依赖链接逃逸快照: ${rel} -> ${raw}`, { target: targetReal })
      continue
    }
    if (typeof link.target === 'string' && normaliseRel(link.target) !== raw) {
      add('link-target-mismatch', `依赖链接目标与清单不一致: ${rel}`, { expected: link.target, actual: raw })
    }
  }

  const walked = await walkSnapshot(rootReal)
  for (const [rel] of walked.files) {
    if (rel === MANIFEST_REL) continue
    if (!expectedFiles.has(rel)) add('unexpected-file', `出现清单外的运行文件: ${rel}`)
  }
  for (const [rel, abs] of walked.links) {
    if (expectedLinks.has(rel)) continue
    add('unexpected-link', `出现清单外的链接: ${rel}`)
    const targetReal = await fsp.realpath(abs).catch(() => null)
    if (!targetReal) add('dangling-link', `链接目标不存在: ${rel}`)
    else if (!isInside(rootReal, targetReal)) add('outbound-link', `链接逃逸快照: ${rel}`, { target: targetReal })
  }

  const nodeBySlug = new Map()
  for (const node of nodes) {
    if (!node || typeof node.slug !== 'string' || typeof node.path !== 'string') {
      add('node-record-invalid', 'manifest 依赖节点记录无效')
      continue
    }
    const containedNode = await containedPath(rootReal, node.path)
    if (!containedNode.ok) {
      add('path-boundary', `manifest 依赖节点 路径越界快照: ${containedNode.rel}`, { reason: containedNode.reason })
      continue
    }
    const dirAbs = containedNode.abs
    const dirStat = await fsp.lstat(dirAbs).catch(() => null)
    if (!dirStat) {
      add('missing-node-dir', `依赖节点目录不存在: ${node.slug}`)
      continue
    }
    if (dirStat.isSymbolicLink()) {
      add('node-dir-link', `依赖节点目录是外部符号链接: ${node.slug}`, { path: node.path })
      continue
    }
    const dirReal = await fsp.realpath(dirAbs).catch(() => null)
    if (!dirReal || !isInside(rootReal, dirReal)) {
      add('node-dir-escape', `依赖节点目录真实路径越界快照: ${node.slug}`)
      continue
    }
    nodeBySlug.set(node.slug, node)
    const pkgPath = path.join(dirReal, 'package.json')
    const pkgStat = await fsp.lstat(pkgPath).catch(() => null)
    if (!pkgStat) {
      add('missing-package-json', `依赖节点缺少 package.json: ${node.slug}`)
      continue
    }
    if (pkgStat.isSymbolicLink()) {
      add('package-json-link', `依赖节点 package.json 是符号链接: ${node.slug}`)
      continue
    }
    if (!pkgStat.isFile()) {
      add('missing-package-json', `依赖节点缺少 package.json: ${node.slug}`)
      continue
    }
    const pkgReal = await fsp.realpath(pkgPath).catch(() => null)
    if (!pkgReal || !isInside(rootReal, pkgReal)) {
      add('package-json-escape', `依赖节点 package.json 真实路径越界快照: ${node.slug}`)
      continue
    }
    let info
    try {
      info = requireJson(pkgPath)
    } catch (error) {
      add('invalid-package-json', `依赖节点 package.json 无法解析: ${node.slug}`)
      continue
    }
    if (typeof node.name === 'string' && info && info.name !== node.name) {
      add('node-identity', `依赖节点身份与清单不一致: ${node.slug}`, { expected: node.name, actual: info.name ?? null })
    }
  }

  for (const edge of edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.name !== 'string') {
      add('edge-record-invalid', 'manifest 依赖边记录无效')
      continue
    }
    const from = nodeBySlug.get(edge.from)
    if (!from) {
      add('edge-unknown-source', `依赖边的来源节点不在清单内: ${edge.from}`, { dependency: edge.name })
      continue
    }
    const fromDir = path.join(rootReal, normaliseRel(from.path))
    const linkAbs = path.join(fromDir, 'node_modules', edge.name)
    if (!edge.to) {
      const stray = await fsp.lstat(linkAbs).catch(() => null)
      if (stray) add('optional-dependency-present', `清单标记缺失的可选依赖却存在条目: ${edge.from} -> ${edge.name}`)
      continue
    }
    const target = nodeBySlug.get(edge.to)
    if (!target) {
      add('edge-unknown-target', `依赖边指向清单外节点: ${edge.from} -> ${edge.name}`, { to: edge.to })
      continue
    }
    const stat = await fsp.lstat(linkAbs).catch(() => null)
    if (!stat) {
      add('dependency-missing', `依赖未在快照内解析: ${edge.from} -> ${edge.name}`)
      continue
    }
    if (!stat.isSymbolicLink()) {
      add('dependency-link-required', `依赖条目必须是快照内链接: ${edge.from} -> ${edge.name}`)
      continue
    }
    const resolved = await fsp.realpath(linkAbs).catch(() => null)
    if (!resolved) {
      add('dependency-dangling', `依赖链接目标不存在: ${edge.from} -> ${edge.name}`)
      continue
    }
    if (!isInside(rootReal, resolved)) {
      add('dependency-outbound', `依赖链接逃逸快照: ${edge.from} -> ${edge.name}`, { target: resolved })
      continue
    }
    const expectedAbs = path.join(rootReal, normaliseRel(target.path))
    const expectedReal = await fsp.realpath(expectedAbs).catch(() => null)
    if (!expectedReal || resolved !== expectedReal) {
      add('dependency-identity', `依赖解析身份与清单不一致: ${edge.from} -> ${edge.name}`, {
        expected: target.path,
        actual: posixRel(rootReal, resolved),
      })
    }
  }

  for (const node of nodes) {
    if (!node || typeof node.slug !== 'string') continue
    const declared = Array.isArray(node.dependencies) ? node.dependencies : []
    for (const dep of declared) {
      if (!dep || typeof dep.name !== 'string') continue
      const matching = edges.filter((edge) => edge && edge.from === node.slug && edge.name === dep.name)
      if (matching.length === 0) {
        add('edge-missing', `依赖边缺失: ${node.slug} -> ${dep.name}`)
        continue
      }
      const edgeTo = matching[0].to ?? null
      if ((dep.resolved ?? null) !== edgeTo) {
        add('dependency-resolved-mismatch', `节点依赖与边解析结果不一致: ${node.slug} -> ${dep.name}`)
      }
      if (!dep.optional && !dep.resolved) {
        add('required-dependency-unresolved', `必需依赖未解析到快照: ${node.slug} -> ${dep.name}`)
      }
    }
  }

  for (const [key, rel] of Object.entries(entries)) {
    if (rel === null) continue
    if (typeof rel !== 'string') {
      add('entry-invalid', `manifest 入口 ${key} 不是路径`)
      continue
    }
    const normalised = normaliseRel(rel)
    const containedEntry = await containedPath(rootReal, rel)
    if (!containedEntry.ok) {
      add('path-boundary', `manifest 入口 ${key} 路径越界快照: ${containedEntry.rel}`, { reason: containedEntry.reason })
      continue
    }
    const stat = await fsp.lstat(containedEntry.abs).catch(() => null)
    if (stat && stat.isSymbolicLink()) add('entry-is-link', `manifest 入口被替换为链接: ${key} -> ${rel}`)
    else if (!stat || !stat.isFile()) add('entry-missing', `manifest 入口文件不存在: ${key} -> ${rel}`)
    else if (!expectedFiles.has(normalised)) add('entry-unlisted', `manifest 入口文件未进入文件清单: ${key} -> ${rel}`)
  }
  if (typeof entries.cli !== 'string') add('entry-missing-cli', 'manifest 未给出 CLI 入口路径')

  return {
    ok: violations.length === 0,
    snapshot: rootReal,
    manifest: manifestPath,
    entries,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      files: files.length,
      links: linkEntries.length,
      verifiedFiles: expectedFiles.size,
      verifiedLinks: expectedLinks.size,
      walkedFiles: walked.files.size,
      walkedLinks: walked.links.size,
    },
    violations,
  }
}

/* ----------------------------------------------------------------- CLI */

/** 帮助文本：CLI 与 `--help` 共用；导出以便测试断言真实输出。 */
export const SNAPSHOT_USAGE = `self-host-snapshot.mjs — 把当前已构建的 Pulse 固化成 cwd 之外的纯代码胶囊

用法:
  node scripts/self-host-snapshot.mjs snapshot --cli-entry <file> --snapshot <dir> --cwd <dir> [选项]
  node scripts/self-host-snapshot.mjs verify --snapshot <dir> [--cwd <dir>] [选项]

子命令:
  snapshot              构建新胶囊（省略子命令时的默认行为）。目标已存在则拒绝覆盖。
  verify                只依赖快照自身校验清单：文件丢失/篡改/新增、越界链接、依赖身份。

必需（snapshot）:
  --cli-entry <file>    已构建 Pulse CLI 入口文件真实路径；允许位于 --cwd 内（只读复制）
  --snapshot <dir>      新快照目录，必须不存在，且位于 --cwd 之外
  --cwd <dir>           被修复的工作区；输入（含入口与其源依赖）可位于其中且只读复制，复制结果必须全部在它之外

选项:
  --data-dir <dir>      调用者已有的数据目录；仅用于生成可复制命令，绝不读取或复制
  --output <dir>        监督脚本的运行输出目录；仅用于生成可复制命令
  --task-file <file>    监督脚本的任务文件；仅用于生成可复制命令
  --checks-file <file>  监督脚本的验收命令文件；仅用于生成可复制命令
  --json                以 JSON 输出结果
  -h, --help            显示本帮助

边界:
  - 快照只包含代码：不读取、不创建、不复制 data-dir / 配置 / 凭据 / 会话 / 数据库 /
    浏览器数据 / 环境变量；失败只清理本次创建的临时目录。
  - 依赖按实际安装的生产闭包物理复制（copyFile，绝不硬链接），链接只指向快照内部。
  - manifest 记录每个运行文件的大小/权限/哈希、链接目标、依赖节点与边，以及 CLI 与监督入口路径。
  - 输入 / 输出边界：输入（已构建 CLI 入口及其全部源依赖）允许位于 --cwd 之内，只读复制、
    不修改任何输入；必须位于 --cwd 之外的只是复制结果（复制后的入口、依赖节点、内部链接、
    manifest），因此可以直接用 Pulse 自身生成第一个稳定快照。目标尚不存在时正常创建，
    边界判断只解析目标已存在的父目录，绝不 realpath 尚不存在的 target。
  - 闭包发现：内部已构建代码实际 import 却未写入 package.json 的已安装依赖，按其原解析身份
    纳入闭包；解析不到且非 Node 内置模块时显式失败（EXIT 4），绝不静默漏包。
`

const BOOLEAN_FLAGS = new Set(['--json', '--help', '-h'])
const VALUE_FLAGS = new Set([
  '--cli-entry', '--snapshot', '--target', '--cwd',
  '--data-dir', '--output', '--task-file', '--checks-file',
])

/** 解析 argv：支持 `--flag value` 与 `--flag=value`，子命令可为位置参数。 */
export function parseArgs(argv = []) {
  const options = { command: 'snapshot' }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index])
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === '--json') options.json = true
      else options.help = true
      continue
    }
    if (token.startsWith('--verify')) {
      options.command = 'verify'
      continue
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const separator = token.indexOf('=')
    const flag = separator === -1 ? token : token.slice(0, separator)
    if (!VALUE_FLAGS.has(flag)) throw fail(EXIT.usage, `未知参数: ${flag}`)
    let value
    if (separator === -1) {
      value = argv[index + 1]
      index += 1
    } else {
      value = token.slice(separator + 1)
    }
    if (typeof value !== 'string' || value === '') throw fail(EXIT.usage, `参数 ${flag} 缺少取值`)
    if (flag === '--cli-entry') options.cliEntry = value
    else if (flag === '--snapshot' || flag === '--target') options.snapshot = value
    else if (flag === '--cwd') options.cwd = value
    else if (flag === '--data-dir') options.dataDir = value
    else if (flag === '--output') options.output = value
    else if (flag === '--task-file') options.taskFile = value
    else if (flag === '--checks-file') options.checksFile = value
  }
  if (positional.length > 0) {
    const [command, ...extra] = positional
    if (command !== 'snapshot' && command !== 'verify') throw fail(EXIT.usage, `未知子命令: ${command}`)
    if (extra.length > 0) throw fail(EXIT.usage, `多余参数: ${extra.join(' ')}`)
    options.command = command
  }
  return options
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** CLI 主流程：返回真实退出码；不 fork 进程、不启停任何服务。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${SNAPSHOT_USAGE}\n`)
    return EXIT.ok
  }

  if (options.command === 'verify') {
    const result = await verifySnapshot({ snapshot: options.snapshot, cwd: options.cwd })
    if (options.json) {
      printJson(result)
    } else {
      process.stdout.write(`snapshot: ${result.snapshot}\n`)
      process.stdout.write(`manifest: ${result.manifest}\n`)
      process.stdout.write(
        `nodes=${result.counts.nodes} edges=${result.counts.edges} files=${result.counts.files} links=${result.counts.links}\n`,
      )
      for (const violation of result.violations) {
        process.stdout.write(`VIOLATION ${violation.kind}: ${violation.message}\n`)
      }
      process.stdout.write(result.ok ? 'verify: ok\n' : `verify: failed (${result.violations.length})\n`)
    }
    return result.ok ? EXIT.ok : EXIT.verify
  }

  const result = await createSnapshot(options)
  if (options.json) {
    printJson(result)
  } else {
    process.stdout.write(`snapshot: ${result.snapshot}\n`)
    process.stdout.write(`manifest: ${result.manifest}\n`)
    process.stdout.write(`cli-entry: ${result.entries.cli}\n`)
    process.stdout.write(`supervisor-entry: ${result.entries.supervisor ?? '(未找到 scripts/self-host.mjs)'}\n`)
    process.stdout.write(
      `nodes=${result.counts.nodes} edges=${result.counts.edges} files=${result.counts.files} links=${result.counts.links}\n`,
    )
    process.stdout.write(`可复制调用命令:\n${result.invoke.shell}\n`)
  }
  return EXIT.ok
}

/** 仅当本文件被 node 直接执行时才运行 CLI；被 import 时只暴露 API。 */
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fsSync.realpathSync.native(entry) === fsSync.realpathSync.native(import.meta.filename)
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      const code = Number.isInteger(error?.code) ? error.code : EXIT.internal
      process.stderr.write(`self-host-snapshot: ${error?.message ?? String(error)}\n`)
      if (error?.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`)
      }
      process.exitCode = code
    },
  )
}
