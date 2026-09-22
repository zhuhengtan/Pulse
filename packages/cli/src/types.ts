import type { ConversationSummary, ArtifactSummary, AssistantEvent, RunHandle } from '@hunterzhu/pulse-server'

export type { ConversationSummary, ArtifactSummary, AssistantEvent, RunHandle }

/** 输出详细程度 */
export type Verbosity = 'verbose' | 'normal' | 'quiet'

/** Slash 命令定义 */
export interface SlashCommand {
  name: string
  aliases?: string[] | undefined
  description: string
  execute: (args: string) => void | Promise<void>
}

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 显示用消息 */
export interface DisplayMessage {
  id: string
  role: MessageRole
  text: string
  runId?: string | undefined
  createdAt: string
  /** 工具调用事件 */
  toolCalls?: ToolCallDisplay[] | undefined
  /** 思考过程 */
  thinking?: string | undefined
  /** Token 统计 */
  tokenStats?: TokenStatsData | undefined
}

/** 工具调用展示数据 */
export interface ToolCallDisplay {
  id: string
  name: string
  arguments?: Record<string, unknown> | undefined
  result?: unknown
  status: 'running' | 'succeeded' | 'failed'
  durationMs?: number | undefined
}

/** Token 统计数据 */
export interface TokenStatsData {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  durationMs: number
  estimatedCost?: number | undefined
}

/** 审批请求数据 */
export interface ApprovalRequest {
  effectId: string
  toolName: string
  toolArgs: Record<string, unknown>
  prompt: string
  digest?: string | undefined
  tools?: Array<{ name: string; toolCallId?: string; input: Record<string, unknown> }> | undefined
}

/** 应用状态模式 */
export type AppMode = 'chat' | 'sessions' | 'help' | 'config'

/** 解析后的命令行参数 */
export interface ParsedArgs {
  command: string
  positionals: string[]
  options: Record<string, string | boolean>
}
