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
  addAssistantMessage: (msg: DisplayMessage, options?: { moveToEnd?: boolean }) => void;
}) {
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingInteractions, setPendingInteractions] = useState<Array<{ kind: 'approval'; request: ApprovalRequest } | { kind: 'ask'; request: AskRequest }>>([]);
  const enqueueInteraction = useCallback((item: { kind: 'approval'; request: ApprovalRequest } | { kind: 'ask'; request: AskRequest }) => {
    setPendingInteractions((current) => current.some((entry) => entry.request.effectId === item.request.effectId) ? current : [...current, item]);
  }, []);
  const removeInteraction = useCallback((effectId: string) => setPendingInteractions((current) => current.filter((entry) => entry.request.effectId !== effectId)), []);
  const activeInteraction = pendingInteractions[0];
  const approvalRequest = activeInteraction?.kind === 'approval' ? activeInteraction.request : null;
  const askRequest = activeInteraction?.kind === 'ask' ? activeInteraction.request : null;
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
        streamStatus: 'streaming',
        createdAt: new Date().toISOString(),
        toolCalls: [],
        runId: run.id,
      };
      let assistantStarted = false;
      let streamedEffectId: string | undefined;
      let streamedAttemptId: string | undefined;
      let lastProgressText = '';
      const addProgress = (key: string, text: string) => {
        if (!text || text === lastProgressText) return;
        lastProgressText = text;
        addAssistantMessage({
          // One live activity cell is updated in place, like Codex/Claude's
          // active-turn transcript, instead of appending every snapshot.
          id: `run-activity-${run.id}`,
          role: 'system',
          text,
          createdAt: new Date().toISOString(),
          runId: run.id,
        }, key === 'finished' ? { moveToEnd: true } : undefined);
      };
      addProgress('received', '已收到任务，正在理解需求并安排步骤…');
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
            if (data.kind === 'task_progress') {
              const tasks = Array.isArray(data.tasks) ? data.tasks : [];
              const visibleText = tasks.length === 0 ? '正在理解需求并规划执行步骤…' : text;
              setCurrentStep(visibleText);
              const active = tasks.find((task) => task && typeof task === 'object' && ['running', 'verifying'].includes(String((task as Record<string, unknown>).status))) as Record<string, unknown> | undefined;
              const stageKey = active ? `${String(active.id)}:${String(active.status)}:${String(active.goal)}` : visibleText.replace(/\s*[·|]\s*(阶段调用|stage calls)\s*\d+.*$/i, '');
              const stageText = visibleText.replace(/\s*[·|]\s*(阶段调用|stage calls)\s*\d+.*$/i, '');
              addProgress(`stage:${stageKey}`, stageText);
              continue;
            }
            addAssistantMessage({
              id: `notice-${run.id}-${event.seq}`,
              role: 'system',
              text,
              createdAt: new Date().toISOString(),
            });
          }
          continue;
        }
        if (event.type !== 'complete' && event.type !== 'error') ensureAssistant();
        switch (event.type) {
          case 'delta': {
            const delta = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
              ? event.data as Record<string, unknown>
              : {};
            const effectId = typeof delta.effectId === 'string' ? delta.effectId : undefined;
            const attemptId = typeof delta.attemptId === 'string' ? delta.attemptId : undefined;
            const text = typeof delta.text === 'string' ? delta.text : '';
            if (!text) break;
            if (effectId !== streamedEffectId || attemptId !== streamedAttemptId) {
              assistantMessage.text = '';
              streamedEffectId = effectId;
              streamedAttemptId = attemptId;
            }
            assistantMessage.text += text;
            assistantMessage.streamStatus = 'streaming';
            addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls?.map((call) => ({ ...call })) });
            setCurrentStep('正在生成回复…');
            break;
          }
          case 'text':
            if (streamedEffectId !== undefined) assistantMessage.text = String(event.data ?? '');
            else assistantMessage.text += String(event.data ?? '');
            streamedEffectId = undefined;
            streamedAttemptId = undefined;
            assistantMessage.streamStatus = 'complete';
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
              setCurrentStep(nextCall.status === 'succeeded' ? `已完成 ${nextCall.name}，正在整理结果…` : nextCall.status === 'failed' ? `${nextCall.name} 未成功，正在处理错误…` : `正在执行 ${nextCall.name}…`);
              addProgress(`tool-result:${id}:${nextCall.status}`, `${nextCall.status === 'succeeded' ? '已完成' : nextCall.status === 'cancelled' ? '已取消' : '执行失败'} · ${nextCall.name}`);
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
              enqueueInteraction({ kind: 'ask', request: {
                effectId,
                toolName: typeof input.toolName === 'string' ? input.toolName : `ask.${input.type}`,
                type: input.type,
                prompt: typeof input.prompt === 'string' ? input.prompt : '请输入你的回答。',
                ...(options && options.length ? { options } : {}),
                ...(typeof input.min === 'number' ? { min: input.min } : {}),
                ...(typeof input.max === 'number' ? { max: input.max } : {}),
                ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {}),
                ...(typeof input.defaultValue === 'string' ? { defaultValue: input.defaultValue } : {}),
              } });
              setCurrentStep('等待你的回答...');
              addProgress(`waiting:${effectId}`, '等待你的回答…');
              break;
            }
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
            enqueueInteraction({ kind: 'approval', request: {
              effectId,
              toolName: tools.length === 1 ? firstTool!.name : `${tools.length || 1} 个系统操作`,
              toolArgs: firstTool?.input ?? {},
              prompt: typeof input.prompt === 'string' ? input.prompt : '是否批准执行？',
              ...(typeof input.digest === 'string' ? { digest: input.digest } : {}),
              ...(tools.length ? { tools } : {}),
            } });
            setCurrentStep('等待用户审批...');
            addProgress(`approval:${effectId}`, `等待审批 · ${tools.map((tool) => tool.name).join('、') || '系统操作'}`);
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
                const activeLanes = (fact.lanes as Array<Record<string, unknown>>).filter((lane) => typeof lane.status === 'string' && !['succeeded', 'failed', 'cancelled'].includes(lane.status));
                const active = activeLanes.find((lane) => lane.activityKind === 'tool') ?? activeLanes[0];
                if (active && typeof active.goal === 'string') {
                  const toolName = active.activityKind === 'tool' && typeof active.activity === 'string' ? active.activity : undefined;
                  const activity = toolName ? `正在调用工具 · ${toolName}` : typeof active.activity === 'string'
                    ? active.activity === 'llm' ? '正在分析需求和已有证据…' : '正在处理任务…'
                    : '正在处理任务…';
                  setCurrentStep(`${activity}：${active.goal}`);
                  const activityId = toolName
                    ? (typeof active.activityEffectId === 'string' ? active.activityEffectId : active.id)
                    : active.activity === 'llm' ? 'analysis' : `${active.id}:${active.status}`;
                  addProgress(`activity:${activityId}`, activity);
                  if (toolName && typeof active.activityToolCallId === 'string') {
                    const id = active.activityToolCallId;
                    const calls = assistantMessage.toolCalls ?? [];
                    const index = calls.findIndex((call) => call.id === id);
                    const nextCall: ToolCallDisplay = { id, name: toolName, status: 'running', arguments: {} };
                    assistantMessage.toolCalls = index >= 0
                      ? calls.map((call, callIndex) => callIndex === index ? { ...call, ...nextCall } : call)
                      : [...calls, nextCall];
                    addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls.map((call) => ({ ...call })) });
                  }
                }
                break;
              }
            }
            // Runtime facts are diagnostic data, not user-facing prose.
            if (typeof event.data === 'string' && event.data.startsWith('human.input.')) setCurrentStep(describeFactStatus(event.data));
            break;
          case 'error':
            addProgress('finished', '运行遇到错误。');
            if (assistantStarted && assistantMessage.text) {
              assistantMessage.streamStatus = 'incomplete';
              addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls?.map((call) => ({ ...call })) });
            }
            setError(String(event.data ?? '发生未知错误'));
            setIsRunning(false);
            setCurrentStep(null);
            setPendingInteractions([]);
            setLanes([]);
            break;
          case 'complete':
            addProgress('finished', event.data && typeof event.data === 'object' && !Array.isArray(event.data) && (event.data as Record<string, unknown>).status === 'succeeded' ? '任务处理完成。' : '任务已结束。');
            setIsRunning(false);
            setCurrentStep(null);
            setPendingInteractions([]);
            if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
              const completion = event.data as Record<string, unknown>;
              const accepted = completion.status === 'succeeded' && (!completion.taskOutcome || (typeof completion.taskOutcome === 'object' && completion.taskOutcome !== null && (completion.taskOutcome as Record<string, unknown>).status === 'accepted'));
              if (assistantStarted && assistantMessage.text) {
                assistantMessage.streamStatus = accepted ? 'complete' : 'incomplete';
                addAssistantMessage({ ...assistantMessage, toolCalls: assistantMessage.toolCalls?.map((call) => ({ ...call })) });
              }
              const usage = completion.usage && typeof completion.usage === 'object' && !Array.isArray(completion.usage)
                ? completion.usage as Record<string, unknown>
                : undefined;
              if (usage) {
                const input = typeof usage.inputTokens === 'number' ? usage.inputTokens.toLocaleString() : '未知';
                const output = typeof usage.outputTokens === 'number' ? usage.outputTokens.toLocaleString() : '未知';
                const reasoning = typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens.toLocaleString() : '未知';
                const visibleChars = typeof usage.visibleOutputChars === 'number' ? usage.visibleOutputChars.toLocaleString() : '未知';
                const modelCalls = typeof usage.modelCalls === 'number' ? usage.modelCalls.toLocaleString() : '未知';
                const truncations = typeof usage.truncationEvents === 'number' ? usage.truncationEvents.toLocaleString() : '未知';
                const costs = Array.isArray(usage.providerCosts) ? usage.providerCosts.filter((item): item is { currency: string; amount: number } => Boolean(item && typeof item === 'object' && typeof (item as { currency?: unknown }).currency === 'string' && typeof (item as { amount?: unknown }).amount === 'number')) : [];
                const estimate = usage.estimatedCost && typeof usage.estimatedCost === 'object' ? usage.estimatedCost as { currency?: unknown; amount?: unknown; pricingVersion?: unknown } : undefined;
                const costLabel = costs.length ? costs.map((item) => `${item.amount} ${item.currency}`).join(', ') : estimate && typeof estimate.amount === 'number' ? `估算 ${estimate.amount} ${String(estimate.currency)} (价格 ${String(estimate.pricingVersion)})` : '费用未知';
                addAssistantMessage({ id: `run-usage-${run.id}`, role: 'system', text: `用量：输入 ${input} · 输出 ${output} · 思考 ${reasoning} · 可见字符 ${visibleChars} · 模型调用 ${modelCalls} · 截断 ${truncations} · ${costLabel}${usage.completeness === 'partial' ? ' · 数据不完整' : ''}`, createdAt: new Date().toISOString(), runId: run.id });
              }
              const taskOutcome = completion.taskOutcome && typeof completion.taskOutcome === 'object' && !Array.isArray(completion.taskOutcome)
                ? completion.taskOutcome as Record<string, unknown>
                : undefined;
              if (taskOutcome && typeof taskOutcome.status === 'string') {
                const labels: Record<string, string> = {
                  accepted: '任务验收通过',
                  incomplete: '任务未完成',
                  unverifiable: '任务结果无法核验',
                  failed: '任务执行失败',
                  cancelled: '任务已取消',
                };
                addAssistantMessage({
                  id: `task-outcome-${run.id}`,
                  role: 'system',
                  text: labels[taskOutcome.status] ?? `任务验收状态：${taskOutcome.status}`,
                  createdAt: new Date().toISOString(),
                  runId: run.id,
                });
              }
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
    [addAssistantMessage, enqueueInteraction]
  );

  const finishRun = useCallback(() => {
    setIsRunning(false);
    setCurrentStep(null);
    setPendingInteractions([]);
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
      setCurrentStep('正在理解你的需求并安排执行步骤…');

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
      setCurrentStep('正在恢复任务进度…');
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
      removeInteraction(effectId);
      setCurrentStep('审批已提交，正在继续...');
      setError(null);
    } catch (e) {
      setError(`审批提交失败: ${e instanceof Error ? e.message : String(e)}`);
      setCurrentStep('审批仍在等待，请重新选择。');
    } finally {
      setApprovalSubmitting(false);
    }
  }, [approvalSubmitting, removeInteraction]);

  const replyAsk = useCallback(async (effectId: string, value: Record<string, unknown>) => {
    if (!effectId || !runRef.current || approvalSubmitting) return;
    setApprovalSubmitting(true);
    try {
      await runRef.current.reply(effectId, value as never);
      removeInteraction(effectId);
      setCurrentStep('回答已提交，正在继续...');
      setError(null);
    } catch (e) {
      setError(`回答提交失败: ${e instanceof Error ? e.message : String(e)}`);
      setCurrentStep('仍在等待你的回答，请重新选择。');
    } finally {
      setApprovalSubmitting(false);
    }
  }, [approvalSubmitting, removeInteraction]);

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
