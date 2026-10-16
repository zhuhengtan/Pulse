import { render } from 'ink';
import React from 'react';
import { App } from '../components/App.js';
import { createLocalHost } from '@hunterzhu/pulse-server';
import type { LocalHostOptions } from '@hunterzhu/pulse-server';
import { closePendingHosts } from '../hooks/useHost.js';
import { runOneShot } from './run.js';

export async function findResumeConversation(
  options: LocalHostOptions,
  conversationId?: string | undefined,
): Promise<string | undefined> {
  const host = createLocalHost(options);
  await host.init();
  try {
    if (conversationId !== undefined) {
      // Validate an explicit ID without creating a conversation. A missing ID
      // must fail loudly instead of silently opening a fresh history.
      try {
        await host.getConversation(conversationId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw Object.assign(new Error(`未找到指定会话：${conversationId}`), { code: 'CONVERSATION_NOT_FOUND' });
        }
        throw error;
      }
      return conversationId;
    }
    const sessions = await host.listConversations();
    return sessions.find((session) => session.activeRunId)?.id ?? sessions[0]?.id;
  } finally {
    await host.close();
  }
}

export async function runInteractive(
  options: LocalHostOptions,
  conversationId?: string | undefined,
  initialTask?: string | undefined,
  version = '0.4.1',
  resumeLatest = false,
): Promise<number> {
  if (!process.stdin.isTTY) {
    if (initialTask) {
      return runOneShot(options, initialTask, 'text', version);
    }
    process.stderr.write('交互模式需要 TTY 终端。非交互执行请使用 "pulse run <task>"。\n');
    return 1;
  }

  const shouldResume = resumeLatest || conversationId !== undefined;
  const selectedConversationId = shouldResume
    ? await findResumeConversation(options, conversationId)
    : undefined;
  const { waitUntilExit, unmount } = render(
    <App
      hostOptions={options}
      conversationId={selectedConversationId}
      initialTask={initialTask}
      resumeOnStart={shouldResume && selectedConversationId !== undefined}
      version={version}
    />,
    {
      // Keep Pulse in its own full-screen buffer so the shell's previous
      // command history does not become part of the chat workspace.
      alternateScreen: true,
      // Ctrl+C is a selection-copy shortcut inside the chat. Exit explicitly
      // through /exit so an accidental keypress cannot drop an active task.
      exitOnCtrlC: false,
    },
  );

  let interrupted = false;
  const onInterrupt = () => {
    // Ignore SIGINT while the interactive app is active; /exit is the exit path.
  };
  const onTerminate = () => {
    interrupted = true;
    unmount();
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  try {
    await waitUntilExit();
    return interrupted ? 130 : 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await closePendingHosts();
  }
}
