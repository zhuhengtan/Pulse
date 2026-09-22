import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCallCard } from './ToolCallCard.js';
import { TokenStats } from './TokenStats.js';
import { renderMarkdownToAnsi } from '../utils/markdown.js';
import type { ToolCallDisplay, TokenStatsData, Verbosity } from '../types.js';

export interface AssistantMessageProps {
  text: string;
  thinking?: string | undefined;
  showThinking?: boolean | undefined;
  toolCalls?: ToolCallDisplay[] | undefined;
  tokenStats?: TokenStatsData | undefined;
  verbosity?: Verbosity | undefined;
}

export function AssistantMessage({
  text,
  thinking,
  showThinking,
  toolCalls,
  tokenStats,
  verbosity = 'normal',
}: AssistantMessageProps) {
  const renderedText = text ? renderMarkdownToAnsi(text) : '';

  return (
    <Box flexDirection="column" marginY={1}>
      {showThinking && thinking && (
        <ThinkingBlock content={thinking} visible={true} />
      )}

      {verbosity !== 'quiet' && toolCalls && toolCalls.length > 0 && (
        <Box flexDirection="column" gap={1} marginY={1}>
          {toolCalls.map((tc, idx) => (
            <ToolCallCard key={idx} call={tc} />
          ))}
        </Box>
      )}

      {renderedText && (
        <Box>
          <Text>{renderedText}</Text>
        </Box>
      )}

      {verbosity === 'verbose' && tokenStats && (
        <TokenStats
          inputTokens={tokenStats.inputTokens}
          outputTokens={tokenStats.outputTokens}
          durationMs={tokenStats.durationMs}
          estimatedCost={tokenStats.estimatedCost}
        />
      )}
    </Box>
  );
}
