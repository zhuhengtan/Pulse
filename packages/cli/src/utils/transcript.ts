import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import type { DisplayMessage, Verbosity } from '../types.js';
import { stripTerminalControls } from './ansi.js';
import { renderMarkdownToAnsi } from './markdown.js';

/** One shared rendering and wrapping path; scroll offsets are actual terminal rows. */
export function transcriptLines(messages: DisplayMessage[], width: number, verbosity: Verbosity = 'normal'): string[] {
  const blocks = messages.map((message) => {
    const text = stripTerminalControls(message.text);
    if (message.role === 'user') return chalk.cyan(`你 › ${text}`);
    if (message.role === 'system') return chalk.dim(text);
    const parts: string[] = [];
    const tools = message.toolCalls ?? [];
    if (verbosity !== 'quiet' && tools.length) {
      const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'cancelled');
      parts.push(chalk.dim(`工具 · ${tools.filter((tool) => tool.status === 'succeeded').length}/${tools.length} 已完成${failed.length ? ` · ${failed.length} 未成功` : ''}`));
      for (const tool of verbosity === 'verbose' ? tools : failed) {
        const detail = `${tool.name} · ${tool.status}${verbosity === 'verbose' ? `\n${JSON.stringify(tool.arguments ?? {}, null, 2)}` : ''}${tool.result === undefined ? '' : `\n${typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}`}`;
        parts.push(chalk.dim(stripTerminalControls(detail)));
      }
    }
    if (text) parts.push(chalk.cyan.bold('Pulse'), renderMarkdownToAnsi(text));
    return parts.join('\n');
  }).filter(Boolean);
  return wrapAnsi(blocks.join('\n\n'), Math.max(8, width), { hard: true, trim: false }).split('\n');
}

export function scrollAction(input: string, key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean; meta?: boolean; upArrow?: boolean; downArrow?: boolean }): 'up' | 'down' | 'bottom' | undefined {
  if (key.pageUp || (key.ctrl && input === 'p')) return 'up';
  if (key.pageDown || (key.ctrl && input === 'n')) return 'down';
  if (key.ctrl && input === 'g') return 'bottom';
  return undefined;
}
