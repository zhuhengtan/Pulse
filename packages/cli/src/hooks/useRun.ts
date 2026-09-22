import { useState, useRef, useCallback, useEffect } from 'react';
import type { LocalHost, RunHandle } from '@hunterzhu/pulse-server';
import type { ApprovalRequest, DisplayMessage, ToolCallDisplay } from '../types.js';

function toolStatus(value: unknown): ToolCallDisplay['status'] {
  if (value === 'succeeded' || value === 'failed' || value === 'running') return value;
  return 'running';
}

export function useRun({
  host,
  conversationId,
  addAssistantMessage,
}: {
  host: LocalHost | null;
  conversationId: string | null;
  addAssistantMessage: (msg: DisplayMessage) => void;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);

  const runRef = useRef<RunHandle | null>(null);

  const consumeRun = useCallback(
    async (run: RunHandle) => {
      runRef.current = run;
      const assistantMessage: DisplayMessage = {
        id: run.id,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        toolCalls: [],
        runId: run.id,
      };
      addAssistantMessage({ ...assistantMessage, toolCalls: [] });

      for await (const event of run.events) {
        switch (event.type) {
          case 'text':
            assistantMessage.text += String(event.data ?? '');
            addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls?.map((call) => ({ ...call })) });
            break;
          case 'observation': {
            const obs = event.data as Record<string, unknown> | undefined;
            if (obs && typeof obs === 'object' && typeof obs.tool === 'string') {
              const id = String(obs.toolCallId ?? obs.tool);
              const nextCall: ToolCallDisplay = {
                id,
                name: obs.tool,
                arguments: obs.args && typeof obs.args === 'object' && !Array.isArray(obs.args)
                  ? obs.args as Record<string, unknown>
                  : {},
                status: toolStatus(obs.status),
                ...(obs.result === undefined ? {} : { result: obs.result }),
              };
              const calls = assistantMessage.toolCalls ?? [];
              const index = calls.findIndex((call) => call.id === id);
              assistantMessage.toolCalls = index >= 0
                ? calls.map((call, callIndex) => callIndex === index ? { ...call, ...nextCall } : call)
                : [...calls, nextCall];
              addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls.map((call) => ({ ...call })) });
            }
            break;
          }
          case 'waiting': {
            const payload =
              event.data && typeof event.data === 'object' && !Array.isArray(event.data)
                ? (event.data as Record<string, unknown>)
                : {};
            const effectId = typeof payload.effectId === 'string' ? payload.effectId : '';
            const input =
              payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
                ? (payload.input as Record<string, unknown>)
                : {};
            const tools = Array.isArray(input.tools)
              ? input.tools.flatMap((tool) => {
                  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
                  const item = tool as Record<string, unknown>;
                  return [{
                    name: String(item.toolName ?? item.name ?? '系统操作'),
                    ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
                    input: item.input && typeof item.input === 'object' && !Array.isArray(item.input)
                      ? item.input as Record<string, unknown>
                      : {},
                  }];
                })
              : [];
            const firstTool = tools[0];
            setApprovalRequest({
              effectId,
              toolName: tools.length === 1 ? firstTool!.name : `${tools.length || 1} 个系统操作`,
              toolArgs: firstTool?.input ?? {},
              prompt: typeof input.prompt === 'string' ? input.prompt : '是否批准执行？',
              ...(typeof input.digest === 'string' ? { digest: input.digest } : {}),
              ...(tools.length ? { tools } : {}),
            });
            setCurrentStep('等待用户审批...');
            break;
          }
          case 'fact':
            if (typeof event.data === 'string') {
              setCurrentStep(event.data);
            } else if (event.data && typeof event.data === 'object') {
              setCurrentStep('正在执行...');
            }
            break;
          case 'error':
            setError(String(event.data ?? '发生未知错误'));
            setIsRunning(false);
            setCurrentStep(null);
            setApprovalRequest(null);
            break;
          case 'complete':
            setIsRunning(false);
            setCurrentStep(null);
            break;
        }
      }
    },
    [addAssistantMessage]
  );

  const finishRun = useCallback(() => {
    setIsRunning(false);
    setCurrentStep(null);
    setApprovalRequest(null);
    runRef.current = null;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!host || !conversationId || runRef.current) return;
      setIsRunning(true);
      setError(null);
      setCurrentStep('思考中...');

      try {
        const run = await host.sendMessage(conversationId, { text });
        await consumeRun(run);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        finishRun();
      }
    },
    [host, conversationId, consumeRun, finishRun]
  );

  const resumeActive = useCallback(
    async () => {
      if (!host || !conversationId || runRef.current) return;
      setIsRunning(true);
      setError(null);
      setCurrentStep('正在恢复未完成的运行...');
      try {
        const run = await host.resumeRun(conversationId);
        await consumeRun(run);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        finishRun();
      }
    },
    [host, conversationId, consumeRun, finishRun]
  );

  useEffect(() => () => {
    const run = runRef.current;
    if (run) void run.cancel('USER_INTERRUPT');
  }, []);

  const approveAction = useCallback(async (effectId: string, approved: boolean, reason?: string) => {
    if (!effectId || !runRef.current) return;
    await runRef.current.reply(effectId, { approved, ...(approved ? {} : { reason: reason || '拒绝执行' }) });
    setApprovalRequest(null);
    setCurrentStep('审批已提交，正在继续...');
  }, []);

  const cancelRun = useCallback(async () => {
    if (runRef.current) {
      await runRef.current.cancel('USER_CANCELLED');
      setIsRunning(false);
      setCurrentStep('已取消');
    }
  }, []);

  return {
    isRunning,
    currentStep,
    error,
    approvalRequest,
    sendMessage,
    resumeActive,
    approveAction,
    cancelRun,
  };
}
