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
  } else if (event.type === 'error') {
    process.stderr.write(`\n[错误] ${String(event.data ?? '')}\n`);
  }
}

export async function runOneShot(
  options: LocalHostOptions,
  task: string,
  format = 'text',
  version = '0.1.4'
): Promise<number> {
  // 如果在交互式终端且没有指定 jsonl，启动交互式 Ink 界面直接执行任务
  if (process.stdout.isTTY && format !== 'jsonl') {
    return runInteractive(options, undefined, task, version);
  }

  const host = createLocalHost(options);
  let activeRun: RunHandle | undefined;
  const unbindSignals = bindRunSignals(host, () => activeRun);

  try {
    await host.init();
    const conversation = await host.createConversation(options.cwd ? { cwd: options.cwd } : {});
    const run = await host.sendMessage(conversation.id, {
      text: task,
      format: format === 'jsonl' ? 'jsonl' : 'text',
    });
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

    if (format === 'jsonl') {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          type: 'result',
          runId: run.id,
          status: outcome.status,
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

    return outcome.status === 'succeeded' ? 0 : outcome.status === 'cancelled' ? 3 : 1;
  } finally {
    unbindSignals();
    await host.close();
  }
}
