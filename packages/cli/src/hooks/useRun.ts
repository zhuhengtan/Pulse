import { useState, useRef, useCallback, useEffect } from 'react';
import type { LocalHost, RunHandle } from '@hunterzhu/pulse-server';
import type { ApprovalRequest, AskRequest, DisplayMessage, LaneDisplay, ToolCallDisplay } from '../types.js';

function toolStatus(value: unknown): ToolCallDisplay['status'] {
  if (value === 'succeeded' || value === 'failed' || value === 'running' || value === 'cancelled') return value;
  return 'running';
}

export function describeFactStatus(data: unknown): string {
  if (typeof data === 'string') {
    if (data === 'human.input.received') return '已收到你的输入，正在安排处理...';
    if (data === 'human.input.dispatched') return '已安排优先处理你的输入...';
    if (data === 'human.input.deferred') return '输入已记录，将在当前副作用安全收尾后处理...';
    return data;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '正在执行...';
  const payload = data as Record<string, unknown>;
  const decision = payload.decision ?? payload.action;
  if (typeof payload.inputId === 'string' && decision === undefined) {
    return '已收到你的输入，调度器正在决定如何处理...';
  }
  if (decision === 'spawn') return '已启动优先交互任务，正在处理你的输入...';
  if (decision === 'respond') return '已收到回复，正在继续当前任务...';
  if (decision === 'steer') return '正在根据你的输入调整当前任务...';
  if (decision === 'cancel') return '正在按你的输入取消相关任务...';
  if (decision === 'defer') return '输入已记录，等待安全时机处理...';
  if (typeof payload.reason === 'string') return `输入处理暂缓：${payload.reason}`;
  return '正在执行...';
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
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [lanes, setLanes] = useState<LaneDisplay[]>([]);

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
      let assistantStarted = false;
      const ensureAssistant = () => {
        if (assistantStarted) return;
        assistantStarted = true;
        addAssistantMessage({ ...assistantMessage, toolCalls: [] });
      };

      for await (const event of run.events) {
        if (event.type === 'notice') {
          const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
            ? event.data as Record<string, unknown>
            : {};
          const text = typeof data.text === 'string' ? data.text : '';
          if (text) {
            addAssistantMessage({
              id: `notice-${run.id}-${event.seq}`,
              role: 'system',
              text,
              createdAt: new Date().toISOString(),
            });
          }
          continue;
        }
        ensureAssistant();
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
            if (input.kind === 'ask' && (input.type === 'choice' || input.type === 'multi' || input.type === 'input')) {
              const options = Array.isArray(input.options)
                ? input.options.flatMap((option) => {
                    if (!option || typeof option !== 'object' || Array.isArray(option)) return [];
                    const item = option as Record<string, unknown>;
                    return typeof item.label === 'string' && typeof item.value === 'string' ? [{ label: item.label, value: item.value }] : [];
                  })
                : undefined;
              setApprovalRequest(null);
              setAskRequest({
                effectId,
                toolName: typeof input.toolName === 'string' ? input.toolName : `ask.${input.type}`,
                type: input.type,
                prompt: typeof input.prompt === 'string' ? input.prompt : '请输入你的回答。',
                ...(options && options.length ? { options } : {}),
                ...(typeof input.min === 'number' ? { min: input.min } : {}),
                ...(typeof input.max === 'number' ? { max: input.max } : {}),
                ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
                ...(typeof input.defaultValue === 'string' ? { defaultValue: input.defaultValue } : {}),
              });
              setCurrentStep('等待你的回答...');
              break;
            }
            setAskRequest(null);
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
            if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
              const fact = event.data as Record<string, unknown>;
              if (fact.type === 'lane.snapshot' && Array.isArray(fact.lanes)) {
                setLanes(fact.lanes.flatMap((lane) => {
                  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) return [];
                  const item = lane as Record<string, unknown>;
                  if (typeof item.id !== 'string' || typeof item.status !== 'string' || typeof item.goal !== 'string') return [];
                  return [{
                    id: item.id,
                    status: item.status,
                    goal: item.goal,
                    ...(typeof item.activity === 'string' ? { activity: item.activity } : {}),
                  }];
                }));
                break;
              }
            }
            setCurrentStep(describeFactStatus(event.data));
            break;
          case 'error':
            setError(String(event.data ?? '发生未知错误'));
            setIsRunning(false);
            setCurrentStep(null);
            setApprovalRequest(null);
            setAskRequest(null);
            setLanes([]);
            break;
          case 'complete':
            setIsRunning(false);
            setCurrentStep(null);
            setApprovalRequest(null);
            setAskRequest(null);
            if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
              const completion = event.data as Record<string, unknown>;
              const completionError = completion.error;
              if (completion.status === 'failed' && completionError && typeof completionError === 'object' && !Array.isArray(completionError)) {
                const error = completionError as Record<string, unknown>;
                setError(`${String(error.code ?? 'RUN_FAILED')}: ${String(error.message ?? '运行失败')}`);
              } else if (completion.status === 'failed') {
                setError('RUN_FAILED: 运行失败');
              }
            }
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
    setAskRequest(null);
    runRef.current = null;
  }, []);

  const sendMessage = useCallback(
    async (text: string, targetConversationId?: string) => {
      const activeConversationId = targetConversationId ?? conversationId;
      if (!host || !activeConversationId) return;
      if (runRef.current) {
        try {
          await runRef.current.submitHumanInput(text);
          setError(null);
          setCurrentStep('已接收输入，调度器正在决定如何处理...');
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      setIsRunning(true);
      setError(null);
      setCurrentStep('思考中...');

      try {
        const run = await host.sendMessage(activeConversationId, { text });
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
    async (targetConversationId?: string) => {
      const activeConversationId = targetConversationId ?? conversationId;
      if (!host || !activeConversationId || runRef.current) return;
      setIsRunning(true);
      setError(null);
      setCurrentStep('正在恢复未完成的运行...');
      try {
        const run = await host.resumeRun(activeConversationId);
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
    if (!effectId || !runRef.current || approvalSubmitting) return;
    setApprovalSubmitting(true);
    try {
      await runRef.current.reply(effectId, { approved, ...(approved ? {} : { reason: reason || '拒绝执行' }) });
      setApprovalRequest(null);
      setCurrentStep('审批已提交，正在继续...');
      setError(null);
    } catch (e) {
      setError(`审批提交失败: ${e instanceof Error ? e.message : String(e)}`);
      setCurrentStep('审批仍在等待，请重新选择。');
    } finally {
      setApprovalSubmitting(false);
    }
  }, [approvalSubmitting]);

  const replyAsk = useCallback(async (effectId: string, value: Record<string, unknown>) => {
    if (!effectId || !runRef.current || approvalSubmitting) return;
    setApprovalSubmitting(true);
    try {
      await runRef.current.reply(effectId, value as never);
      setAskRequest(null);
      setCurrentStep('回答已提交，正在继续...');
      setError(null);
    } catch (e) {
      setError(`回答提交失败: ${e instanceof Error ? e.message : String(e)}`);
      setCurrentStep('仍在等待你的回答，请重新选择。');
    } finally {
      setApprovalSubmitting(false);
    }
  }, [approvalSubmitting]);

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
    askRequest,
    lanes,
    approvalSubmitting,
    sendMessage,
    resumeActive,
    approveAction,
    replyAsk,
    cancelRun,
  };
}
