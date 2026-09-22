import { render } from 'ink';
import React from 'react';
import { App } from '../components/App.js';
import type { LocalHostOptions } from '@hunterzhu/pulse-server';
import { closePendingHosts } from '../hooks/useHost.js';

export async function runInteractive(
  options: LocalHostOptions,
  conversationId?: string | undefined,
  initialTask?: string | undefined,
  version = '0.1.4'
): Promise<number> {
  const { waitUntilExit, unmount } = render(
    <App
      hostOptions={options}
      conversationId={conversationId}
      initialTask={initialTask}
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
