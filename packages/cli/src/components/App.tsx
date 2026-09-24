import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { LocalHostOptions } from '@hunterzhu/pulse-server';

import { Header } from './Header.js';
import { Welcome } from './Welcome.js';
import { MessageList } from './MessageList.js';
import { StatusHud } from './StatusHud.js';
import { Spinner } from './Spinner.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { AskPrompt } from './AskPrompt.js';
import { InputArea } from './InputArea.js';
import { SessionList } from './SessionList.js';
import { HelpView } from './HelpView.js';

import { useHost } from '../hooks/useHost.js';
import { useConversation } from '../hooks/useConversation.js';
import { useRun } from '../hooks/useRun.js';
import { useTokenStats } from '../hooks/useTokenStats.js';
import { useSlashCommands } from '../hooks/useSlashCommands.js';
import { copyToClipboard, isCopyShortcut } from '../utils/clipboard.js';
import { emptyInputHistory, navigateInputHistory, rememberInput } from '../utils/inputHistory.js';
import type { AppMode } from '../types.js';

export interface AppProps {
  hostOptions: LocalHostOptions;
  conversationId?: string | undefined;
  initialTask?: string | undefined;
  resumeOnStart?: boolean | undefined;
  version: string;
}

export function App({
  hostOptions,
  conversationId: initialConversationId,
  initialTask,
  resumeOnStart = false,
  version,
}: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalRows, setTerminalRows] = useState(stdout.rows || 24);
  useEffect(() => { const resize = () => setTerminalRows(stdout.rows || 24); stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  const [mode, setMode] = useState<AppMode>('chat');
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const [selectedText, setSelectedText] = useState('');
  const [inputHistory, setInputHistory] = useState(emptyInputHistory);
  const inputHistoryRef = useRef(inputHistory);
  inputHistoryRef.current = inputHistory;
  const [showThinking, setShowThinking] = useState(false);
  const [verbosity, setVerbosity] = useState<'normal' | 'verbose' | 'quiet'>('normal');
  const [sessionsList, setSessionsList] = useState<Array<{ id: string; title: string; updatedAt: string; cwd: string }>>([]);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [approvalChoiceFocused, setApprovalChoiceFocused] = useState(false);
  const [approvalInputMode, setApprovalInputMode] = useState(false);
  const startedTask = useRef(false);
  const startedResume = useRef(false);

  const { host, error: hostError, ready: hostReady } = useHost(hostOptions);

  const {
    conversation,
    messages,
    addUserMessage,
    addAssistantMessage,
    clearMessages,
    switchConversation,
    newConversation,
    createConversation,
    error: conversationError,
  } = useConversation({ host, conversationId: initialConversationId });

  const {
    isRunning,
    error: runError,
    approvalRequest,
    askRequest,
    lanes,
    approvalSubmitting,
    sendMessage,
    resumeActive,
    approveAction,
    replyAsk,
    cancelRun,
  } = useRun({
    host,
    conversationId: conversation?.id ?? null,
    addAssistantMessage,
  });

  const { cumulative } = useTokenStats();

  const rememberUserInput = useCallback((text: string) => {
    const next = rememberInput(inputHistoryRef.current, text);
    inputHistoryRef.current = next;
    setInputHistory(next);
  }, []);
  const navigateUserInputHistory = useCallback((direction: 'up' | 'down', currentValue: string) => {
    const result = navigateInputHistory(inputHistoryRef.current, direction, currentValue);
    inputHistoryRef.current = result.state;
    setInputHistory(result.state);
    return result.value;
  }, []);

  useEffect(() => { setSelectedText(''); }, [conversation?.id]);

  const copySelectedText = useCallback(async () => {
    if (!selectedText) return;
    try {
      await copyToClipboard(selectedText);
      addAssistantMessage({ id: `copy-${Date.now()}`, role: 'system', text: `已复制选中的内容（${selectedText.length.toLocaleString()} 个字符）。`, createdAt: new Date().toISOString() });
    } catch {
      addAssistantMessage({ id: `copy-${Date.now()}`, role: 'system', text: '复制失败：当前系统没有可用的剪贴板工具。', createdAt: new Date().toISOString() });
    }
  }, [selectedText, addAssistantMessage]);

  useEffect(() => {
    if (approvalRequest) {
      setApprovalChoiceFocused(true);
      setApprovalInputMode(false);
    } else {
      setApprovalChoiceFocused(false);
      setApprovalInputMode(false);
    }
  }, [approvalRequest?.effectId]);

  useEffect(() => {
    if (!hostReady || !resumeOnStart || !conversation || isRunning || startedResume.current) return;
    startedResume.current = true;
    if (conversation.summary.activeRunId) {
      void resumeActive(conversation.id);
    } else {
      addAssistantMessage({
        id: `resume-ready-${Date.now()}`,
        role: 'system',
        text: `已进入上次会话：${conversation.summary.title}`,
        createdAt: new Date().toISOString(),
      });
    }
  }, [hostReady, resumeOnStart, conversation, isRunning, resumeActive, addAssistantMessage]);

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
    if (!hostReady || isRunning || !initialTask || startedTask.current) return;
    if (conversation?.summary.activeRunId) {
      startedTask.current = true;
      addAssistantMessage({
        id: `resume-hold-${Date.now()}`,
        role: 'system',
        text: '此会话有未完成的运行。请使用 /resume 恢复运行；这次附带的新任务没有发送。',
        createdAt: new Date().toISOString(),
      });
      return;
    }
    startedTask.current = true;
    void (async () => {
      const target = conversation ?? await createConversation();
      if (!target) return;
      addUserMessage(initialTask);
      await sendMessage(initialTask, target.id);
    })();
  }, [hostReady, conversation, initialTask, isRunning, addUserMessage, addAssistantMessage, createConversation, sendMessage]);

  const { executeCommand, isSlashCommand } = useSlashCommands({
    onMouse: (arg) => setMouseEnabled((current) => arg === 'off' ? false : arg === 'on' ? true : !current),
    onCopy: async () => {
      if (selectedText) { await copySelectedText(); return }
      const latest = [...messages].reverse().find((message) => message.role === 'assistant' && message.text.trim() && message.streamStatus !== 'streaming' && message.streamStatus !== 'incomplete')
      const payload = latest?.text || ''
      if (!payload) { addAssistantMessage({ id: `copy-${Date.now()}`, role: 'system', text: '请先拖动选择内容，或发送一条消息后再复制回复。', createdAt: new Date().toISOString() }); return }
      try {
        await copyToClipboard(payload)
        addAssistantMessage({ id: `copy-${Date.now()}`, role: 'system', text: `已复制最近一条完整回复（${payload.length.toLocaleString()} 个字符）。`, createdAt: new Date().toISOString() })
      } catch {
        addAssistantMessage({ id: `copy-${Date.now()}`, role: 'system', text: '复制失败：当前系统没有可用的剪贴板工具。可试试 /mouse off 后用终端选择文本。', createdAt: new Date().toISOString() })
      }
    },
    onHelp: () => setMode('help'),
    onSessions: async () => {
      await loadSessions();
      setMode('sessions');
    },
    onClear: () => clearMessages(),
    onNew: async () => {
      await newConversation();
    },
    onResume: async () => {
      if (!host) return;
      if (isRunning) {
        addAssistantMessage({
          id: `resume-busy-${Date.now()}`,
          role: 'system',
          text: '当前已有运行中的任务，请先等待完成或使用 /cancel。',
          createdAt: new Date().toISOString(),
        });
        return;
      }
      try {
        const sessions = await host.listConversations();
        const target = sessions.find((item) => item.activeRunId) ?? sessions[0];
        if (!target) {
          addAssistantMessage({
            id: `resume-empty-${Date.now()}`,
            role: 'system',
            text: '还没有可恢复的会话。发送第一条消息后会自动创建会话。',
            createdAt: new Date().toISOString(),
          });
          return;
        }
        await switchConversation(target.id);
        if (target.activeRunId) {
          await resumeActive(target.id);
        } else {
          addAssistantMessage({
            id: `resume-done-${Date.now()}`,
            role: 'system',
            text: `已恢复上一次会话：${target.title}`,
            createdAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        addAssistantMessage({
          id: `resume-error-${Date.now()}`,
          role: 'system',
          text: `恢复会话失败: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(),
        });
      }
    },
    onExit: () => exit(),
    onCancel: async () => {
      if (!isRunning) {
        addAssistantMessage({
          id: `cancel-${Date.now()}`,
          role: 'system',
          text: '当前没有正在运行的任务。',
          createdAt: new Date().toISOString(),
        });
        return;
      }
      await cancelRun();
    },
    onConfig: () => {
      addAssistantMessage({
        id: `config-${Date.now()}`,
        role: 'system',
        text: JSON.stringify({
          cwd: hostOptions.cwd ?? process.cwd(),
          dataDir: hostOptions.dataDir ?? '默认 ~/.pulse/data',
          provider: hostOptions.provider?.provider ?? 'mock',
          model: host?.getModel() ?? hostOptions.provider?.defaultModel ?? '默认',
          providerProfiles: Object.keys(hostOptions.providerProfiles ?? {}),
          approvalMode: hostOptions.approvalMode ?? 'ask',
          maxTurns: hostOptions.maxTurns ?? 32,
          autoCompactPercent: hostOptions.autoCompactPercent ?? 90,
          allowNetwork: hostOptions.allowNetwork ?? false,
          networkHosts: hostOptions.networkHosts ?? [],
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
      const selection = name?.trim();
      try {
        if (selection && host) {
          const separator = selection.includes('/') ? '/' : selection.includes(':') ? ':' : undefined;
          if (separator) {
            const [providerName, ...modelParts] = selection.split(separator);
            const selectedModel = modelParts.join(separator).trim();
            if (providerName && selectedModel) host.setProvider(providerName, selectedModel);
          } else if (hostOptions.providerModels?.[selection]) {
            host.setModel(selection);
          } else if (hostOptions.providerProfiles?.[selection]) {
            host.setProvider(selection);
          } else {
            host.setModel(selection);
          }
        }
      } catch (error) {
        addAssistantMessage({
          id: `model-error-${Date.now()}`,
          role: 'system',
          text: `模型切换失败: ${error instanceof Error ? error.message : String(error)}`,
          createdAt: new Date().toISOString(),
        });
        return;
      }
      const currentProvider = host?.getProvider() || hostOptions.activeProviderCode || hostOptions.provider?.provider || '默认';
      const currentModel = host?.getModel() || hostOptions.provider?.defaultModel || '默认';
      addAssistantMessage({
        id: `model-${Date.now()}`,
        role: 'system',
        text: selection
          ? `当前模型设置为: ${currentProvider}/${currentModel}`
          : `当前模型: ${currentModel}\n可用模型: ${Object.keys(hostOptions.providerModels ?? {}).join(', ') || '当前模型'}\n切换示例: /model gpt5.6-a`,
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
        const target = conversation ?? await createConversation();
        if (!target) return;
        addUserMessage(text);
        await sendMessage(text, target.id);
      }
    },
    [isSlashCommand, executeCommand, conversation, createConversation, addUserMessage, sendMessage]
  );

  useInput((input, key) => {
    if (isCopyShortcut(input, key)) {
      if (selectedText) void copySelectedText();
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
    if (approvalRequest && input === '\t') {
      setApprovalInputMode((inputMode) => {
        const nextInputMode = !inputMode;
        setApprovalChoiceFocused(!nextInputMode);
        return nextInputMode;
      });
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
        <Text dimColor>输入 /exit 退出。</Text>
      </Box>
    );
  }

  if (!hostReady) {
    return (
      <Box padding={1}>
        <Spinner label="正在初始化 Pulse 运行时..." />
      </Box>
    );
  }

  if (conversationError && !conversation) {
    return (
      <Box padding={1} flexDirection="column">
        <Text color="red">会话加载失败：{conversationError}</Text>
        <Text dimColor>按 n 新建会话，输入 /exit 退出。</Text>
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

  const cwd = conversation?.summary.cwd ?? hostOptions.cwd ?? process.cwd();
  const title = conversation?.summary.title ?? 'New conversation';
  const modelName = host?.getModel() || hostOptions.provider?.defaultModel || hostOptions.provider?.provider || 'default';
  const providerName = host?.getProvider() || hostOptions.activeProviderCode || hostOptions.provider?.provider || 'default';

  return (
    <Box flexDirection="column" width="100%" height={terminalRows}>
      <Header title={title} cwd={cwd} model={modelName} approvalMode={hostOptions.approvalMode ?? 'ask'} />

      {messages.length === 0 && !isRunning && (
        <Welcome cwd={cwd} model={modelName} version={version} />
      )}

      {messages.length > 0 && (
      <MessageList mouseEnabled={mouseEnabled} messages={messages} showThinking={showThinking} verbosity={verbosity} isRunning={isRunning} onSelectionChange={setSelectedText} />
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

      <StatusHud isRunning={isRunning} cwd={cwd} model={modelName} provider={providerName} approvalMode={hostOptions.approvalMode ?? 'ask'} lanes={lanes} />

      {approvalRequest ? (
        <ApprovalPrompt
          request={approvalRequest}
          inputMode={approvalInputMode}
          isFocused={approvalChoiceFocused && !approvalSubmitting}
          onApprove={() => {
            void approveAction(approvalRequest.effectId, true);
          }}
          onDeny={(reason) => {
            void approveAction(approvalRequest.effectId, false, reason);
          }}
          onInput={() => {
            setApprovalChoiceFocused(false);
            setApprovalInputMode(true);
          }}
        />
      ) : askRequest ? (
        <AskPrompt
          key={askRequest.effectId}
          request={askRequest}
          disabled={approvalSubmitting}
          onReply={(value) => void replyAsk(askRequest.effectId, value)}
        />
      ) : (
        <Box marginTop={1}>
          <InputArea
            onSubmit={(txt) => void handleSubmit(txt)}
            onRememberInput={rememberUserInput}
            onNavigateHistory={navigateUserInputHistory}
            disabled={approvalSubmitting}
            focus={!approvalSubmitting}
            placeholder={isRunning ? '运行中也可以输入；/cancel 可取消当前运行...' : '输入消息或 /help...'}
          />
        </Box>
      )}
    </Box>
  );
}

export default App;
