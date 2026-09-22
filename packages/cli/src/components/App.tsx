import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { LocalHostOptions } from '@hunterzhu/pulse-server';

import { Header } from './Header.js';
import { Welcome } from './Welcome.js';
import { MessageList } from './MessageList.js';
import { Spinner } from './Spinner.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { InputArea } from './InputArea.js';
import { SessionList } from './SessionList.js';
import { HelpView } from './HelpView.js';

import { useHost } from '../hooks/useHost.js';
import { useConversation } from '../hooks/useConversation.js';
import { useRun } from '../hooks/useRun.js';
import { useTokenStats } from '../hooks/useTokenStats.js';
import { useSlashCommands } from '../hooks/useSlashCommands.js';
import type { AppMode } from '../types.js';

export interface AppProps {
  hostOptions: LocalHostOptions;
  conversationId?: string | undefined;
  initialTask?: string | undefined;
  version: string;
}

export function App({
  hostOptions,
  conversationId: initialConversationId,
  initialTask,
  version,
}: AppProps) {
  const { exit } = useApp();
  const [mode, setMode] = useState<AppMode>('chat');
  const [showThinking, setShowThinking] = useState(false);
  const [verbosity, setVerbosity] = useState<'normal' | 'verbose' | 'quiet'>('normal');
  const [sessionsList, setSessionsList] = useState<Array<{ id: string; title: string; updatedAt: string; cwd: string }>>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const startedTask = useRef(false);
  const resumedConversation = useRef<string | null>(null);

  const { host, error: hostError, ready: hostReady } = useHost(hostOptions);

  const {
    conversation,
    messages,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    switchConversation,
    newConversation,
    error: conversationError,
  } = useConversation({ host, conversationId: initialConversationId });

  const {
    isRunning,
    currentStep,
    error: runError,
    approvalRequest,
    sendMessage,
    resumeActive,
    approveAction,
    cancelRun,
  } = useRun({
    host,
    conversationId: conversation?.id ?? null,
    addAssistantMessage,
  });

  const { cumulative } = useTokenStats();

  const loadSessions = useCallback(async () => {
    if (!host) return;
    try {
      const list = await host.listConversations();
      setSessionsList(list);
    } catch {
      // ignore
    }
  }, [host]);

  useEffect(() => {
    if (!hostReady || !conversation || isRunning) return;
    if (conversation.summary.activeRunId && resumedConversation.current !== conversation.id) {
      resumedConversation.current = conversation.id;
      if (initialTask && !startedTask.current) {
        startedTask.current = true;
        addAssistantMessage({
          id: `resume-hold-${Date.now()}`,
          role: 'system',
          text: '此会话有未完成的运行，已改为恢复该运行。这次附带的新任务没有发送。',
          createdAt: new Date().toISOString(),
        });
      }
      void resumeActive();
      return;
    }
    if (initialTask && !startedTask.current && messages.length === 0 && !conversation.summary.activeRunId) {
      startedTask.current = true;
      addUserMessage(initialTask);
      void sendMessage(initialTask);
    }
  }, [hostReady, conversation, initialTask, messages.length, isRunning, addUserMessage, addAssistantMessage, sendMessage, resumeActive]);

  const { executeCommand, isSlashCommand } = useSlashCommands({
    onHelp: () => setMode('help'),
    onSessions: async () => {
      await loadSessions();
      setMode('sessions');
    },
    onClear: () => clearMessages(),
    onNew: async () => {
      await newConversation();
    },
    onExit: () => exit(),
    onQuit: () => exit(),
    onConfig: () => {
      addAssistantMessage({
        id: `config-${Date.now()}`,
        role: 'system',
        text: JSON.stringify({
          cwd: hostOptions.cwd ?? process.cwd(),
          dataDir: hostOptions.dataDir ?? '默认 ~/.pulse/data',
          provider: hostOptions.provider?.provider ?? 'mock',
          model: hostOptions.provider?.defaultModel ?? '默认',
          approvalMode: hostOptions.approvalMode ?? 'ask',
          allowNetwork: hostOptions.allowNetwork ?? false,
        }, null, 2),
        createdAt: new Date().toISOString(),
      });
    },
    onStatus: () => {
      if (conversation) {
        addAssistantMessage({
          id: `status-${Date.now()}`,
          role: 'system',
          text: `会话 ID: ${conversation.id}\n工作区: ${conversation.summary.cwd}\n更新时间: ${conversation.summary.updatedAt}`,
          createdAt: new Date().toISOString(),
        });
      }
    },
    onTools: async () => {
      if (host) {
        try {
          const doc = await host.doctor();
          addAssistantMessage({
            id: `tools-${Date.now()}`,
            role: 'system',
            text: `已注册工具 (${doc.tools.length}):\n${doc.tools.map((t) => `• ${t}`).join('\n')}`,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          addAssistantMessage({
            id: `tools-${Date.now()}`,
            role: 'system',
            text: `获取工具列表失败: ${String(e)}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    },
    onArtifacts: async () => {
      if (host && conversation) {
        try {
          const artifacts = await host.listArtifacts(conversation.id);
          addAssistantMessage({
            id: `artifacts-${Date.now()}`,
            role: 'system',
            text:
              artifacts.length === 0
                ? '暂无产物文件。'
                : `产物列表 (${artifacts.length}):\n${artifacts.map((a) => `• ${a.path} (${a.bytes} bytes)`).join('\n')}`,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          addAssistantMessage({
            id: `artifacts-${Date.now()}`,
            role: 'system',
            text: `获取产物列表失败: ${String(e)}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    },
    onDelete: async (id?: string) => {
      const targetId = id || conversation?.id;
      if (targetId && host) {
        try {
          await host.deleteConversation(targetId);
          if (targetId === conversation?.id) {
            await newConversation();
          }
          addAssistantMessage({
            id: `del-${Date.now()}`,
            role: 'system',
            text: `已删除会话: ${targetId}`,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          addAssistantMessage({
            id: `del-${Date.now()}`,
            role: 'system',
            text: `删除失败: ${String(e)}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    },
    onExport: async (format?: string) => {
      if (host && conversation) {
        try {
          const modeFormat = format === 'markdown' ? 'markdown' : 'json';
          const content = await host.exportConversation(conversation.id, modeFormat);
          addAssistantMessage({
            id: `export-${Date.now()}`,
            role: 'system',
            text: `会话导出 (${modeFormat}):\n\n${content}`,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          addAssistantMessage({
            id: `export-${Date.now()}`,
            role: 'system',
            text: `导出失败: ${String(e)}`,
            createdAt: new Date().toISOString(),
          });
        }
      }
    },
    onModel: (name?: string) => {
      const model = name?.trim();
      if (model && host) host.setModel(model);
      addAssistantMessage({
        id: `model-${Date.now()}`,
        role: 'system',
        text: `当前模型设置为: ${model || host?.getModel() || hostOptions.provider?.defaultModel || '默认'}`,
        createdAt: new Date().toISOString(),
      });
    },
    onThinking: (arg?: string) => {
      const level = (arg || '').trim().toLowerCase();
      let effort: 'low' | 'medium' | 'high' | undefined;
      if (level === 'high' || level === 'medium' || level === 'low') {
        effort = level;
      } else if (level === 'off' || level === 'none' || level === '0') {
        effort = undefined;
      } else {
        effort = host?.getReasoningEffort() === 'high' ? 'medium' : host?.getReasoningEffort() === 'medium' ? 'low' : 'high';
      }
      if (host) {
        host.setReasoningEffort(effort);
      }
      setShowThinking(Boolean(effort));
      addAssistantMessage({
        id: `thinking-${Date.now()}`,
        role: 'system',
        text: `模型思考深度 (reasoning effort) 已设置为: ${effort || 'off (关闭)'}`,
        createdAt: new Date().toISOString(),
      });
    },
    onVerbose: () => {
      setVerbosity('verbose');
      addAssistantMessage({
        id: `verbose-${Date.now()}`,
        role: 'system',
        text: '已切换为详细输出模式',
        createdAt: new Date().toISOString(),
      });
    },
    onQuiet: () => {
      setVerbosity('quiet');
      addAssistantMessage({
        id: `quiet-${Date.now()}`,
        role: 'system',
        text: '已切换为精简输出模式',
        createdAt: new Date().toISOString(),
      });
    },
    onCompact: async () => {
      if (!host || !conversation) return;
      addAssistantMessage({
        id: `compact-start-${Date.now()}`,
        role: 'system',
        text: '正在调用模型对当前历史上下文进行提炼压缩...',
        createdAt: new Date().toISOString(),
      });
      try {
        const res = await host.compactConversation(conversation.id);
        await switchConversation(conversation.id);
        addAssistantMessage({
          id: `compact-done-${Date.now()}`,
          role: 'system',
          text: `模型上下文压缩完成。替换前的记录已备份为 messages.jsonl.bak。\n\n${res.text}`,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        addAssistantMessage({
          id: `compact-err-${Date.now()}`,
          role: 'system',
          text: `模型压缩上下文失败: ${String(err)}`,
          createdAt: new Date().toISOString(),
        });
      }
    },
  });

  const handleSubmit = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text) return;

      if (isSlashCommand(text)) {
        const handled = await executeCommand(text);
        if (!handled) {
          addAssistantMessage({
            id: `command-${Date.now()}`,
            role: 'system',
            text: `未知命令：${text.split(/\s+/)[0] ?? text}，输入 /help 查看可用命令。`,
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        addUserMessage(text);
        await sendMessage(text);
      }
    },
    [isSlashCommand, executeCommand, addUserMessage, sendMessage]
  );

  useInput((input, key) => {
    if ((hostError || (conversationError && !conversation)) && (input === 'q' || key.escape)) {
      exit();
      return;
    }
    if (conversationError && !conversation && input === 'n') {
      void newConversation();
      return;
    }
    if (isRunning && key.escape) {
      void cancelRun();
      return;
    }
    if (mode === 'help') {
      if (input === 'q' || key.escape || key.return) {
        setMode('chat');
      }
    }
  });

  if (hostError) {
    return (
      <Box padding={1} flexDirection="column">
        <Text color="red">Pulse 初始化失败：{hostError}</Text>
        <Text dimColor>请检查工作目录、配置文件和数据目录权限后重试。</Text>
        <Text dimColor>按 q 退出。</Text>
      </Box>
    );
  }

  if (!hostReady || !conversation) {
    if (conversationError) {
      return (
        <Box padding={1} flexDirection="column">
          <Text color="red">会话加载失败：{conversationError}</Text>
          <Text dimColor>按 n 新建会话，按 q 退出。</Text>
        </Box>
      );
    }
    return (
      <Box padding={1}>
        <Spinner label="正在初始化 Pulse 运行时..." />
      </Box>
    );
  }

  if (mode === 'sessions') {
    return (
      <SessionList
        sessions={sessionsList}
        notice={sessionError}
        onSelect={(id) => {
          void switchConversation(id);
          setMode('chat');
        }}
        onDelete={async (id) => {
          if (!host) return;
          try {
            await host.deleteConversation(id);
            if (id === conversation?.id) await newConversation();
            await loadSessions();
            setSessionError(null);
          } catch (error) {
            setSessionError(error instanceof Error ? error.message : String(error));
          }
        }}
        onBack={() => setMode('chat')}
      />
    );
  }

  if (mode === 'help') {
    return (
      <Box flexDirection="column" padding={1}>
        <HelpView />
        <Box marginTop={1}>
          <Text dimColor>按 Enter 或 q 返回对话模式...</Text>
        </Box>
      </Box>
    );
  }

  const cwd = conversation.summary.cwd;
  const title = conversation.summary.title;
  const modelName = hostOptions.provider?.defaultModel || hostOptions.provider?.provider || 'default';

  return (
    <Box flexDirection="column" width="100%">
      <Header title={title} cwd={cwd} model={modelName} approvalMode={hostOptions.approvalMode ?? 'ask'} />

      {messages.length === 0 && !isRunning && (
        <Welcome cwd={cwd} model={modelName} version={version} />
      )}

      {messages.length > 0 && (
        <MessageList messages={messages} showThinking={showThinking} verbosity={verbosity} />
      )}

      {isRunning && !approvalRequest && (
        <Box marginY={1}>
          <Spinner label={currentStep || '正在思考与执行...'} />
        </Box>
      )}

      {runError && (
        <Box marginY={1}>
          <Text color="red">错误: {runError}</Text>
        </Box>
      )}

      {conversationError && (
        <Box marginY={1}>
          <Text color="red">会话消息加载失败: {conversationError}</Text>
        </Box>
      )}

      {approvalRequest && (
        <ApprovalPrompt
          request={approvalRequest}
          onApprove={() => void approveAction(approvalRequest.effectId, true)}
          onDeny={(reason) => void approveAction(approvalRequest.effectId, false, reason)}
        />
      )}

      <Box marginTop={1}>
        <InputArea
          onSubmit={(txt) => void handleSubmit(txt)}
          disabled={isRunning || !!approvalRequest}
          placeholder={isRunning ? '正在处理中...' : '输入消息或 /help...'}
        />
      </Box>
    </Box>
  );
}

export default App;
