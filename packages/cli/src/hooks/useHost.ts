import { useState, useEffect } from 'react';
import { createLocalHost, LocalHost, LocalHostOptions } from '@hunterzhu/pulse-server';

const pendingHostCloses: Array<Promise<void>> = [];

export function closePendingHosts(): Promise<void> {
  const pending = pendingHostCloses.splice(0, pendingHostCloses.length);
  return Promise.all(pending).then(() => undefined);
}

export function useHost(options: LocalHostOptions) {
  const [host, setHost] = useState<LocalHost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let isMounted = true;
    let localHost: LocalHost | null = null;

    async function initHost() {
      try {
        // 创建本地服务器实例
        localHost = createLocalHost(options);
        await localHost.init();

        if (isMounted) {
          setHost(localHost);
          setReady(true);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    initHost();

    return () => {
      isMounted = false;
      if (localHost) {
        const closing = localHost;
        localHost = null;
        pendingHostCloses.push(closing.close().catch((error: unknown) => {
          console.error(error);
        }));
      }
    };
  }, []); // 仅在组件挂载时初始化一次

  return { host, error, ready };
}
