import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import type { DisplayMessage, ToolCallDisplay, Verbosity } from '../types.js';
import { stripTerminalControls } from './ansi.js';
import { renderMarkdownToAnsi } from './markdown.js';

/** One shared rendering and wrapping path; scroll offsets are actual terminal rows. */
export function transcriptLines(messages: DisplayMessage[], width: number, verbosity: Verbosity = 'normal'): string[] {
  const blocks = messages.map((message) => {
    const text = stripTerminalControls(message.text);
    const contentWidth = Math.max(8, width - 2);
    if (message.role === 'system') return { id: message.id, role: message.role, lines: wrapAnsi(chalk.dim(`· ${text}`), Math.max(8, width), { hard: true, trim: true }).split('\n') };
    if (message.role === 'user') {
      const body = wrapAnsi(text, contentWidth, { hard: true, trim: false }).split('\n');
      return { id: message.id, role: message.role, lines: [chalk.blue.bold('❯ 你发来'), ...body.map((line) => `  ${line}`)] };
    }
    const parts: string[] = [];
    const tools = message.toolCalls ?? [];
    if (verbosity !== 'quiet' && tools.length) {
      const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'cancelled');
      parts.push(chalk.dim(`工具 · ${tools.filter((tool) => tool.status === 'succeeded').length}/${tools.length} 已完成${failed.length ? ` · ${failed.length} 未成功` : ''}`));
      const statusLabel = { running: '正在调用', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as const;
      if (verbosity === 'verbose') {
        for (const tool of tools) {
          const detail = `${tool.name} · ${statusLabel[tool.status]}\n${JSON.stringify(tool.arguments ?? {}, null, 2)}${tool.result === undefined ? '' : `\n${typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}`}`;
          parts.push(chalk.dim(stripTerminalControls(detail)));
        }
      } else {
        const groups = new Map<string, { name: string; status: ToolCallDisplay['status']; count: number; error?: string }>();
        for (const tool of tools) {
          const result = tool.result && typeof tool.result === 'object' && !Array.isArray(tool.result) ? tool.result as Record<string, unknown> : undefined;
          const error = tool.status === 'failed' || tool.status === 'cancelled'
            ? [result?.code, result?.message].filter((value): value is string => typeof value === 'string').at(-1)
            : undefined;
          const key = `${tool.name}\0${tool.status}\0${error ?? ''}`;
          const group = groups.get(key);
          if (group) group.count++;
          else groups.set(key, { name: tool.name, status: tool.status, count: 1, ...(error ? { error } : {}) });
        }
        for (const group of groups.values()) {
          parts.push(chalk.dim(`${group.name}${group.count > 1 ? ` × ${group.count}` : ''} · ${statusLabel[group.status]}${group.error ? ` · ${group.error}` : ''}`));
        }
      }
    }
    if (text) parts.push(renderMarkdownToAnsi(text));
    const body = wrapAnsi(parts.join('\n'), contentWidth, { hard: true, trim: false }).split('\n');
    const streamLabel = message.streamStatus === 'streaming' ? chalk.yellow(' · 正在生成') : message.streamStatus === 'incomplete' ? chalk.red(' · 未完成') : '';
    return { id: message.id, role: message.role, lines: [chalk.cyan.bold('Pulse') + streamLabel, ...body.map((line) => `  ${line}`)] };
  }).filter((block) => block.lines.length > 0);
  return blocks.flatMap((block, index) => {
    if (index === blocks.length - 1) return block.lines;
    const next = blocks[index + 1]!;
    const isLiveActivity = (item: typeof block) => item.role === 'system' && item.id.startsWith('run-activity-');
    const separator = isLiveActivity(block) || isLiveActivity(next) ? [] : [''];
    return [...block.lines, ...separator];
  });
}

export function scrollAction(input: string, key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean; meta?: boolean; upArrow?: boolean; downArrow?: boolean }): 'up' | 'down' | 'bottom' | undefined {
  if (key.pageUp || (key.ctrl && input === 'p')) return 'up';
  if (key.pageDown || (key.ctrl && input === 'n')) return 'down';
  if (key.ctrl && input === 'g') return 'bottom';
  return undefined;
}
