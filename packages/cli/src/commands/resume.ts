import { createLocalHost, type LocalHostOptions, type AssistantEvent, type RunHandle } from '@hunterzhu/pulse-server';
import { runInteractive } from './interactive.js';
import { bindRunSignals } from './signals.js';

function writeEvent(event: AssistantEvent, format: string): void {
  if (format === 'jsonl') {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.type === 'text') {
    process.stdout.write(String(event.data ?? ''));
  } else if (event.type === 'waiting') {
    process.stdout.write(`\n[需要输入] ${JSON.stringify(event.data ?? '')}\n`);
  } else if (event.type === 'notice') {
    const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as { text?: string } : {};
    process.stderr.write(`\n${data.text ?? ''}\n`);
  } else if (event.type === 'error') {
    process.stderr.write(`\n[错误] ${String(event.data ?? '')}\n`);
  }
}

export async function runResume(
  options: LocalHostOptions,
  conversationId: string,
  task?: string | undefined,
  format = 'text',
  version = '0.1.4'
): Promise<number> {
  // 如果在交互式终端且没有指定 jsonl，启动交互式 Ink 界面直接继续会话
  if (process.stdout.isTTY && format !== 'jsonl') {
    return runInteractive(options, conversationId, task, version);
  }

  const host = createLocalHost(options);
  let activeRun: RunHandle | undefined;
  const unbindSignals = bindRunSignals(host, () => activeRun);

  try {
    await host.init();
    const run = task
      ? await host.sendMessage(conversationId, { text: task, format: format === 'jsonl' ? 'jsonl' : 'text' })
      : await host.resumeRun(conversationId);
    activeRun = run;

    let streamedText = false;
    let approvalCancelled = false;
    for await (const event of run.events) {
      if (event.type === 'text') streamedText = true;
      writeEvent(event, format);
      if (event.type === 'waiting' && !approvalCancelled) {
        approvalCancelled = true;
        process.stderr.write('\n[错误] 此运行处于非交互模式，无法请求工具审批；运行已取消。\n');
        await run.cancel('INTERACTION_REQUIRED');
      }
    }

    const outcome = await run.outcome();
    const taskOutcome = await run.taskOutcome();

    if (format === 'jsonl') {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'result',
          runId: run.id,
          status: outcome.status,
          taskOutcome: taskOutcome ?? null,
          text: outcome.text ?? null,
          error: outcome.error ?? null,
        })}\n`
      );
    } else if (outcome.status === 'failed' && outcome.error) {
      process.stderr.write(`\n[错误] ${outcome.error.code}: ${outcome.error.message}\n`);
    } else if (!streamedText && outcome.text) {
      process.stdout.write(`${outcome.text}\n`);
    } else {
      process.stdout.write(`\n[${outcome.status}]\n`);
    }

    if (outcome.status === 'cancelled') return 3;
    return outcome.status === 'succeeded' && (!taskOutcome || taskOutcome.status === 'accepted') ? 0 : 1;
  } catch (error) {
    process.stderr.write(`[错误] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    unbindSignals();
    await host.close();
  }
}
