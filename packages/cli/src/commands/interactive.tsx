import { render } from 'ink';
import React from 'react';
import { App } from '../components/App.js';
import { createLocalHost } from '@hunterzhu/pulse-server';
import type { LocalHostOptions } from '@hunterzhu/pulse-server';
import { closePendingHosts } from '../hooks/useHost.js';

export async function findResumeConversation(options: LocalHostOptions): Promise<string | undefined> {
  const host = createLocalHost(options);
  await host.init();
  try {
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
  version = '0.1.4',
  resumeLatest = false,
): Promise<number> {
  const selectedConversationId = resumeLatest
    ? await findResumeConversation(options)
    : conversationId;
  const { waitUntilExit, unmount } = render(
    <App
      hostOptions={options}
      conversationId={selectedConversationId}
      initialTask={initialTask}
      resumeOnStart={resumeLatest && selectedConversationId !== undefined}
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
