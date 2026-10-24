/**
 * 独立回归：Git 元数据读取例外只覆盖 status / rev-parse / diff。
 *
 * 背景：例外白名单曾包含 `cat-file`，而 `git cat-file --filters` 会启动
 * `.gitattributes` 里 `filter.<name>.smudge` 指定的子程序，该子程序继承本次调用
 * 获得的公共 `.git` 读取，于是仓库外部（worktree 之外）的 `.git/config` 被真实读出。
 *
 * 本文件只用真实仓库的行为断言守边界，不改动任何既有测试：真实临时仓库里
 * status / rev-parse / diff 仍然可用，`cat-file --filters` 与 `config` 拿不到额外
 * `.git` 读取；smudge 与 clean（含带点 driver 名、include.path 引入的配置）子程序
 * 也读不到 worktree 之外的公共 config。
 *
 * 这些用例需要 git 与临时仓库。外层 Pulse shell 不允许嵌套 fixture 创建 .git/IPC 时，
 * 用例会如实失败并暴露该层限制（不跳过、不吞错）；监督端在宿主内核环境独立执行。
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runShell } from '@hunterzhu/pulse-adapters'

const exec = promisify(execFile)

interface GitFixture {
  repo: string
  worktree: string
  /** clean driver 真被启动时写入的标记文件，位于 worktree 内（子沙箱可写）。 */
  marker: string
  cleanup: () => Promise<void>
}

/** 临时仓库：worktree 内 `.git` 指向仓库目录，filter 子程序尝试读取仓库外部 config。 */
async function createFixture(): Promise<GitFixture> {
  const base = await mkdtemp(join(tmpdir(), 'pulse-git-boundary-'))
  const repo = join(base, 'repo')
  const worktree = join(base, 'worktree')
  const git = async (args: string[], cwd: string = repo): Promise<string> => (await exec('git', [
    '-c', 'user.name=Pulse fixture',
    '-c', 'user.email=pulse@example.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })).stdout
  try {
    await mkdir(repo)
    await git(['init', '--quiet'])
    await writeFile(join(repo, 'notes.txt'), 'plain\n')
    await writeFile(join(repo, 'probe.dotted'), 'plain dotted\n')
    await writeFile(join(repo, 'probe.included'), 'plain included\n')
    // 三类 driver 都要被守住：smudge（cat-file --filters）、clean（status 与 diff），
    // 并分别覆盖普通名、带点名 filter.pulse.probe 与 include.path 引入的配置。
    await writeFile(join(repo, '.gitattributes'), '*.txt filter=pulseprobe\n*.dotted filter=pulse.probe\n*.included filter=included\n')
    await git(['add', '.'])
    await git(['commit', '--quiet', '-m', 'fixture'])
    await git(['worktree', 'add', '--quiet', '-b', 'probe', worktree])
    const marker = join(worktree, 'filter-ran.txt')
    const config = join(repo, '.git', 'config')
    const filterScript = join(worktree, 'filter.cjs')
    await writeFile(filterScript, `const fs=require('node:fs');const s=fs.readFileSync(${JSON.stringify(config)},'utf8');console.log(s.includes('OWN_FIXTURE_CONFIG')?'FIXTURE_CONFIG_READ':'NO_READ')\n`)
    // clean driver 把「有没有读到 worktree 之外的 config」追加进标记文件：只有 driver
    // 真被 git 启动、并且真读到仓库目录里的 config 时才会出现 FIXTURE_CONFIG_READ。
    const cleanScript = async (name: string): Promise<string> => {
      const script = join(worktree, `${name}.cjs`)
      await writeFile(script, [
        "const fs = require('node:fs')",
        "let verdict = 'BLOCKED'",
        `try { if (fs.readFileSync(${JSON.stringify(config)}, 'utf8').includes('OWN_FIXTURE_CONFIG')) verdict = 'FIXTURE_CONFIG_READ' } catch {}`,
        `fs.appendFileSync(${JSON.stringify(marker)}, verdict + '\\n')`,
        "process.stdout.write(fs.readFileSync(0, 'utf8'))",
      ].join('\n'))
      await exec(process.execPath, ['--check', script])
      return script
    }
    await git(['config', 'pulse.fixture', 'OWN_FIXTURE_CONFIG'])
    await git(['config', 'filter.pulseprobe.smudge', `${process.execPath} ${filterScript}`])
    await git(['config', 'filter.pulseprobe.clean', `${process.execPath} ${await cleanScript('clean-probe')}`])
    await git(['config', 'filter.pulse.probe.clean', `${process.execPath} ${await cleanScript('clean-dotted')}`])
    // include.path 引入的配置只在启用 --includes 时才会被枚举到，用于覆盖该分支。
    const includedConfig = join(worktree, 'included.cfg')
    await writeFile(includedConfig, `[filter "included"]\n\tclean = ${process.execPath} ${await cleanScript('clean-included')}\n`)
    await git(['config', 'include.path', includedConfig])
    await git(['diff'], worktree)
    await writeFile(join(worktree, 'notes.txt'), 'PLAIN\n')
    await git(['diff'], worktree)
    if (!(await readFile(marker, 'utf8')).includes('FIXTURE_CONFIG_READ')) throw new Error('Fixture clean driver did not execute successfully')
    await rm(marker, { force: true })
    return { repo, worktree, marker, cleanup: async () => { await rm(base, { recursive: true, force: true }) } }
  } catch (error) {
    await rm(base, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

// POSIX 专属：Windows 分支本就不授予公共 `.git` 读取（trustedGitExecutable 直接拒绝），
// 因此只在 win32 静态 skip，其余平台必须真实执行并如实断言。
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('git metadata exception: real worktree boundary', () => {
  let fixture: GitFixture
  const pathEnv = String(process.env['PATH'] ?? '')

  // fixture 建不起来就直接失败：不吞错，也不把环境限制伪装成通过。
  beforeAll(async () => { fixture = await createFixture() }, 120_000)
  afterAll(async () => { await fixture?.cleanup() })

  it('keeps status, rev-parse and diff working on a real worktree', async () => {
    const current = fixture
    for (const args of [['status', '--porcelain'], ['rev-parse', '--git-dir'], ['diff', '--name-only']]) {
      const result = await runShell('git', args, { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
      expect(result.code, `git ${args.join(' ')} 失败：${result.stderr}`).toBe(0)
    }
  }, 90_000)

  it('refuses cat-file --filters so the filter cannot inherit the read', async () => {
    const current = fixture
    const result = await runShell('git', ['cat-file', '--filters', 'HEAD:notes.txt'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.stdout).not.toContain('FIXTURE_CONFIG_READ')
    expect(result.code, `cat-file 不应作为受信任仓库读运行：${result.stdout}${result.stderr}`).not.toBe(0)
  }, 60_000)

  it('refuses other subcommands so no extra `.git` read is handed out', async () => {
    const current = fixture
    const result = await runShell('git', ['config', '--get', 'pulse.fixture'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.stdout.trim()).not.toBe('OWN_FIXTURE_CONFIG')
    expect(result.code, `config 不应获得额外读取：${result.stdout}${result.stderr}`).not.toBe(0)
  }, 60_000)

  // clean driver 会在 status 与 diff 中执行；普通名、带点名与 include.path 引入的
  // 三种写法都必须被中和到「读不到 worktree 之外的 config」，同时命令本身仍可用。
  it('neutralises the clean filter so `git diff` cannot inherit the read', async () => {
    const current = fixture
    await rm(current.marker, { force: true })
    await writeFile(join(current.worktree, 'notes.txt'), 'PLAIN\n')
    const result = await runShell('git', ['diff'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.code, `diff 应仍然可用：${result.stderr}`).toBe(0)
    expect(await markerVerdicts(current.marker)).not.toContain('FIXTURE_CONFIG_READ')
  }, 60_000)

  it('neutralises the clean filter so `git status` cannot inherit the read', async () => {
    const current = fixture
    await rm(current.marker, { force: true })
    await writeFile(join(current.worktree, 'notes.txt'), 'pLaIn\n')
    const result = await runShell('git', ['status', '--porcelain'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.code, `status 应仍然可用：${result.stderr}`).toBe(0)
    expect(await markerVerdicts(current.marker)).not.toContain('FIXTURE_CONFIG_READ')
  }, 60_000)

  it('neutralises a dotted driver name so `git status` cannot inherit the read', async () => {
    const current = fixture
    await rm(current.marker, { force: true })
    await writeFile(join(current.worktree, 'probe.dotted'), 'PLAIN dotted\n')
    const result = await runShell('git', ['status', '--porcelain'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.code, `带点 driver 的 status 应仍然可用：${result.stderr}`).toBe(0)
    expect(await markerVerdicts(current.marker)).not.toContain('FIXTURE_CONFIG_READ')
  }, 60_000)

  it('neutralises a driver introduced through include.path', async () => {
    const current = fixture
    await rm(current.marker, { force: true })
    await writeFile(join(current.worktree, 'probe.included'), 'PLAIN included\n')
    const result = await runShell('git', ['status', '--porcelain'], { cwd: current.worktree, env: { PATH: pathEnv }, timeoutMs: 20_000 })
    expect(result.code, `include.path driver 的 status 应仍然可用：${result.stderr}`).toBe(0)
    expect(await markerVerdicts(current.marker)).not.toContain('FIXTURE_CONFIG_READ')
  }, 60_000)
})

/** 读取标记文件：文件不存在说明 driver 根本没被启动，等价于没有读到外部 config。 */
async function markerVerdicts(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}
