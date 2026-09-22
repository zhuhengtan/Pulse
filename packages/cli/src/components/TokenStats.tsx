import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { formatDuration, formatTokenCount, formatCost } from '../utils/format.js';

export interface TokenStatsProps {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCost?: number | undefined;
}

export function TokenStats({ inputTokens, outputTokens, durationMs, estimatedCost }: TokenStatsProps) {
  const duration = formatDuration(durationMs);
  const totalTokens = formatTokenCount(inputTokens + outputTokens);
  const inT = formatTokenCount(inputTokens);
  const outT = formatTokenCount(outputTokens);

  let text = `⏱ ${duration} · 📊 ${totalTokens} tokens (in: ${inT} · out: ${outT})`;
  if (estimatedCost !== undefined) {
    text += ` · 💰 ~${formatCost(estimatedCost)}`;
  }

  return (
    <Box marginTop={1}>
      <Text color={theme.stats} dimColor>{text}</Text>
    </Box>
  );
}
