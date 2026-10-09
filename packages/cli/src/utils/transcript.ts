import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import type { DisplayMessage, ToolCallDisplay, Verbosity } from '../types.js';
import { stripTerminalControls } from './ansi.js';
import { renderMarkdownToAnsi } from './markdown.js';
import { renderToolCalls } from './tool-view.js';

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
    const tools = message.toolCalls ?? [];
    const toolLines = tools.length ? toolSummary(tools, verbosity, contentWidth) : [];
    const textLines = text ? wrapAnsi(renderMarkdownToAnsi(text), contentWidth, { hard: true, trim: false }).split('\n') : [];
    const body = [...toolLines, ...(toolLines.length && textLines.length ? [''] : []), ...textLines];
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

function toolSummary(tools: ToolCallDisplay[], verbosity: Verbosity, width: number): string[] {
  if (verbosity === 'quiet') {
    const failed = tools.filter((tool) => tool.status === 'failed' || tool.status === 'cancelled').length;
    const done = tools.filter((tool) => tool.status === 'succeeded').length;
    return [chalk.dim(`工具 · ${done}/${tools.length} 已完成${failed ? ` · ${failed} 未成功` : ''}`)];
  }
  return renderToolCalls(tools, { verbosity, width }).lines;
}

export function scrollAction(input: string, key: { ctrl?: boolean; pageUp?: boolean; pageDown?: boolean; meta?: boolean; upArrow?: boolean; downArrow?: boolean }): 'up' | 'down' | 'bottom' | undefined {
  if (key.pageUp || (key.ctrl && input === 'p')) return 'up';
  if (key.pageDown || (key.ctrl && input === 'n')) return 'down';
  if (key.ctrl && input === 'g') return 'bottom';
  return undefined;
}
