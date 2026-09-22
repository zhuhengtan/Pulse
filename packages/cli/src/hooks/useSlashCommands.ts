import { useMemo, useCallback } from 'react';
import type { SlashCommand } from '../types.js';

export interface SlashCommandDependencies {
  onHelp?: () => void | Promise<void>;
  onStatus?: () => void | Promise<void>;
  onTools?: () => void | Promise<void>;
  onArtifacts?: () => void | Promise<void>;
  onExit?: () => void | Promise<void>;
  onQuit?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  onNew?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onSessions?: () => void | Promise<void>;
  onDelete?: (args: string) => void | Promise<void>;
  onExport?: (args: string) => void | Promise<void>;
  onClear?: () => void | Promise<void>;
  onConfig?: () => void | Promise<void>;
  onModel?: (args: string) => void | Promise<void>;
  onCompact?: () => void | Promise<void>;
  onVerbose?: () => void | Promise<void>;
  onQuiet?: () => void | Promise<void>;
  onThinking?: (args: string) => void | Promise<void>;
}

export function useSlashCommands(deps: SlashCommandDependencies) {
  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: '/help', aliases: ['/h'], description: '显示帮助信息', execute: async () => deps.onHelp?.() },
      { name: '/status', description: '查看状态', execute: async () => deps.onStatus?.() },
      { name: '/tools', description: '列出可用工具', execute: async () => deps.onTools?.() },
      { name: '/artifacts', description: '查看当前产物', execute: async () => deps.onArtifacts?.() },
      { name: '/exit', description: '退出程序', execute: async () => deps.onExit?.() },
      { name: '/quit', aliases: ['/q'], description: '退出程序', execute: async () => deps.onQuit?.() },
      { name: '/cancel', aliases: ['/stop'], description: '取消当前运行（保留会话）', execute: async () => deps.onCancel?.() },
      { name: '/new', description: '开启新会话', execute: async () => deps.onNew?.() },
      { name: '/resume', description: '恢复上一次会话或未完成运行', execute: async () => deps.onResume?.() },
      { name: '/sessions', description: '查看所有会话', execute: async () => deps.onSessions?.() },
      { name: '/delete', description: '删除会话 [id]', execute: async (args) => deps.onDelete?.(args) },
      { name: '/export', description: '导出会话 [markdown|json]', execute: async (args) => deps.onExport?.(args) },
      { name: '/clear', description: '清空当前屏幕', execute: async () => deps.onClear?.() },
      { name: '/config', description: '查看配置', execute: async () => deps.onConfig?.() },
      { name: '/model', description: '切换模型 [name]', execute: async (args) => deps.onModel?.(args) },
      { name: '/compact', description: '调用模型压缩对话历史上下文', execute: async () => deps.onCompact?.() },
      { name: '/verbose', description: '开启详细输出模式', execute: async () => deps.onVerbose?.() },
      { name: '/quiet', description: '开启精简输出模式', execute: async () => deps.onQuiet?.() },
      { name: '/thinking', description: '设置模型思考深度 [low|medium|high|off]', execute: async (args) => deps.onThinking?.(args) },
    ],
    [deps]
  );

  const isSlashCommand = useCallback((input: string) => {
    return input.trim().startsWith('/');
  }, []);

  const executeCommand = useCallback(
    async (input: string): Promise<boolean> => {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return false;

      const parts = trimmed.split(' ');
      const cmdName = parts[0]?.toLowerCase();
      const args = parts.slice(1).join(' ').trim();

      const command = commands.find(
        (c) => c.name === cmdName || c.aliases?.includes(cmdName!)
      );

      if (command) {
        await command.execute(args);
        return true;
      }

      return false;
    },
    [commands]
  );

  return {
    commands,
    isSlashCommand,
    executeCommand,
  };
}
