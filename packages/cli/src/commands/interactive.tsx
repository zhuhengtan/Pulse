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
    />
  );

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    unmount();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await waitUntilExit();
    return interrupted ? 130 : 0;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await closePendingHosts();
  }
}
