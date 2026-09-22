import { useState, useCallback } from 'react';
import { TokenStatsData } from '../types.js';

export function useTokenStats() {
  const [current, setCurrent] = useState<TokenStatsData | null>(null);
  const [cumulative, setCumulative] = useState<TokenStatsData>({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    estimatedCost: 0
  });

  const recordRun = useCallback((stats: TokenStatsData) => {
    setCurrent(stats);

    // 累加本次 Run 的数据到总计中
    setCumulative(prev => ({
      inputTokens: prev.inputTokens + stats.inputTokens,
      outputTokens: prev.outputTokens + stats.outputTokens,
      totalTokens: prev.totalTokens + stats.totalTokens,
      durationMs: prev.durationMs + stats.durationMs,
      estimatedCost: (prev.estimatedCost || 0) + (stats.estimatedCost || 0)
    }));
  }, []);

  const reset = useCallback(() => {
    setCurrent(null);
    setCumulative({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      durationMs: 0,
      estimatedCost: 0
    });
  }, []);

  return {
    current,
    cumulative,
    recordRun,
    reset
  };
}
