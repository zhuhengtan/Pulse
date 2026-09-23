import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { responseLanguageInstruction, type ResponseLanguage } from './language.js'
import { pulseHomePath } from './paths.js'
import { within } from './security.js'

/** Cap instruction files so a workspace cannot fill the system prompt or follow a symlink to a larger secret. */
export const MAX_INSTRUCTION_BYTES = 16_384

export interface BuildSystemPromptOptions {
  workspace: string
  toolNames?: string[] | undefined
  responseLanguage?: ResponseLanguage | undefined
  systemPrompt?: string | undefined
  projectInstructions?: string | undefined
  userInstructions?: string | undefined
  projectRules?: string | undefined
  userRules?: string | undefined
}

export interface DiscoveredInstructions {
  projectRules?: string | undefined
  projectRulesPath?: string | undefined
  userRules?: string | undefined
  userRulesPath?: string | undefined
}

/**
 * Scan workspace and user home for project-level and user-level instruction files.
 * Priority for project rules:
 * 1. <workspace>/PULSE.md
 * 2. <workspace>/.pulse/rules.md
 * 3. <workspace>/CLAUDE.md
 * 4. <workspace>/AGENTS.md
 *
 * User rules:
 * ~/.pulse/instructions.md
 */
function clipUtf8(buffer: Buffer): string {
  let end = buffer.length
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end -= 1
  if (end === 0) return ''
  const lead = buffer[end - 1]!
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  if (needed > 1 && end - 1 + needed > buffer.length) return buffer.subarray(0, end - 1).toString('utf8')
  return buffer.toString('utf8')
}

/** Read a regular file whose real path stays inside root. Missing files and escaped symlinks yield undefined. */
async function readConfinedInstruction(root: string, relativePath: string): Promise<string | undefined> {
  let resolved: string
  try {
    resolved = await within(root, relativePath)
  } catch {
    return undefined
  }
  let handle: FileHandle
  try {
    handle = await open(resolved, 'r')
  } catch {
    return undefined
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return undefined
    const length = Math.min(stat.size, MAX_INSTRUCTION_BYTES)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, 0) : { bytesRead: 0 }
    const slice = buffer.subarray(0, bytesRead)
    const truncated = stat.size > bytesRead
    const text = (truncated ? clipUtf8(slice) : slice.toString('utf8')).trim()
    if (!text) return undefined
    return truncated ? `${text}\n[instruction truncated]` : text
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

export async function loadProjectInstructions(
  workspace: string,
  homeDir = pulseHomePath()
): Promise<DiscoveredInstructions> {
  const candidates = ['PULSE.md', join('.pulse', 'rules.md'), 'CLAUDE.md', 'AGENTS.md']

  let projectRules: string | undefined
  let projectRulesPath: string | undefined

  for (const relativePath of candidates) {
    const content = await readConfinedInstruction(workspace, relativePath)
    if (content) {
      projectRules = content
      projectRulesPath = join(workspace, relativePath)
      break
    }
  }

  const userRules = await readConfinedInstruction(homeDir, 'instructions.md')
  return {
    projectRules,
    projectRulesPath,
    ...(userRules === undefined ? {} : { userRules, userRulesPath: join(homeDir, 'instructions.md') }),
  }
}

/**
 * Assemble modular, engineering-grade system prompt inspired by Claude Code, Codex CLI, and ZCode.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const sections: string[] = []

  // 1. Identity & Operational Context
  sections.push(
    `You are Pulse, an advanced, highly rigorous software engineering assistant.
You operate directly inside the user's workspace at: ${options.workspace}.
All relative file paths provided in requests or passed to filesystem tools are resolved against this workspace.
Treat all tools as extensions of your engineering capabilities.`
  )

  // 2. Core Engineering Principles & Investigation Discipline (Claude Code style)
  sections.push(
    `## Engineering & Investigation Discipline
- Investigate first: When the user asks about the project, files, code, bug fixes, or architecture, ALWAYS inspect the real files, directories, and configuration using available tools before concluding or editing. Never guess file contents, function signatures, or line numbers.
- Surgical, minimal changes: When editing code, make focused, atomic modifications. Preserve all existing code structure, comments, and style conventions that are not directly related to your change. Avoid sweeping refactors or unsolicited formatting.
- Autonomous command execution: shell.exec launches an executable with argv directly; it does not start a shell implicitly. Prefer the filesystem tools for workspace file operations. On Windows, use native PowerShell commands via powershell.exe -NoProfile -NonInteractive -Command ... or explicit cmd.exe /d /c ...; do not assume Unix commands such as grep, find, or /bin/sh are installed. Keep commands non-interactive and bounded.
- Safety boundaries: Do not execute destructive commands (such as rm -rf /, git reset --hard, or git push --force) or kill arbitrary processes without clear user authorization.`
  )

  sections.push(
    `## Task Execution Contract
- For a non-trivial request, keep a short actionable plan: objective, evidence needed, changes, and verification. Do not expose private chain-of-thought.
- Work in bounded phases. Gather only the evidence needed for the current phase, then decide whether to proceed, report a blocker, or finish; do not keep exploring indefinitely.
- Preserve the user's original objective across follow-up messages such as "继续", "还在吗", or status questions. Treat those as updates to the current task unless the user explicitly asks for a separate parallel task.
- Before claiming completion, check every requested deliverable and run the narrowest relevant verification. If any item is incomplete, say exactly what remains and why.
- When resuming an interrupted task, treat an empty or missing prior assistant response as unfinished work. Recover from persisted tool results and current state instead of assuming the task was completed.`
  )

  // 3. Evidence-Based Verification & Truthfulness
  sections.push(
    `## Evidence-Based Verification
- Grounded truthfulness: Never claim an action succeeded, a bug is fixed, or a build passed unless tool outputs or test results explicitly confirm it.
- Run appropriate verification: Whenever you make code changes, run the corresponding build, typecheck, lint, or test suite to confirm your modifications have the desired effect and introduce no regressions.
- Transparent reporting: Clearly distinguish between what has been verified with concrete evidence and what remains unverified or risky.`
  )

  // 4. Zero-Fluff Engineering Delivery (Response Style)
  sections.push(
    `## Output & Communication Style
- Direct and concise: State conclusions and results upfront without conversational filler, pleasantries, or apologetic openings.
- Concrete references: Cite exact workspace file paths and provide reproducible commands.
- Structure for clarity: Use clean GitHub-flavored markdown with code blocks, tables, and bullet points where helpful.`
  )

  // 5. Custom System Prompt (from config / Web / Desktop UI settings)
  if (options.systemPrompt && options.systemPrompt.trim().length > 0) {
    sections.push(
      `## Custom System Instructions
${options.systemPrompt.trim()}`
    )
  }

  // 6. Project-Specific Instructions (PULSE.md / CLAUDE.md / AGENTS.md)
  const projectInstructions = (options.projectInstructions ?? options.projectRules)?.trim()
  if (projectInstructions) {
    sections.push(
      `## Project-Specific Rules
The following instructions are defined by the project repository. Follow them carefully:
${projectInstructions}`
    )
  }

  // 7. User-Level Instructions (~/.pulse/instructions.md)
  const userInstructions = (options.userInstructions ?? options.userRules)?.trim()
  if (userInstructions) {
    sections.push(
      `## User-Level Instructions
${userInstructions}`
    )
  }

  // 8. Language Adaptive Instruction
  const lang = options.responseLanguage ?? 'en'
  sections.push(responseLanguageInstruction(lang))

  return sections.join('\n\n')
}
