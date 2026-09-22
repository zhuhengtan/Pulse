import { render } from 'ink';
import React, { useState } from 'react';
import { createLocalHost, type LocalHostOptions } from '@hunterzhu/pulse-server';
import { SessionList } from '../components/SessionList.js';
import { runInteractive } from './interactive.js';

export async function runSessions(
  options: LocalHostOptions,
  format = 'text',
  version = '0.1.4'
): Promise<number> {
  const host = createLocalHost(options);
  try {
    await host.init();
    const sessions = await host.listConversations();

    if (format === 'jsonl') {
      for (const s of sessions) {
        process.stdout.write(`${JSON.stringify(s)}\n`);
      }
      return 0;
    }

    if (!process.stdout.isTTY) {
      if (sessions.length === 0) {
        process.stdout.write('暂无历史会话。\n');
        return 0;
      }
      for (const s of sessions) {
        process.stdout.write(`${s.id}\t${s.updatedAt}\t${s.title}\t${s.cwd}\n`);
      }
      return 0;
    }

    // 交互式终端：使用 SessionList
    let selectedId: string | undefined;
    let closeMenu: () => void = () => undefined;

    const AppContainer = () => {
      const [items, setItems] = useState(sessions);
      const [notice, setNotice] = useState<string | null>(null);
      return (
        <SessionList
          sessions={items}
          notice={notice}
          onSelect={(id) => {
            selectedId = id;
            closeMenu();
          }}
          onDelete={async (id) => {
            try {
              await host.deleteConversation(id);
              setItems((current) => current.filter((session) => session.id !== id));
              setNotice(null);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : String(error));
            }
          }}
          onBack={() => {
            closeMenu();
          }}
        />
      );
    };

    const rendered = render(<AppContainer />);
    closeMenu = rendered.unmount;
    const { waitUntilExit } = rendered;
    await waitUntilExit();

    if (selectedId) {
      return runInteractive(options, selectedId, undefined, version);
    }

    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await host.close();
  }
}
