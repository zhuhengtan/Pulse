import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import type { ApprovalRequest } from '../types.js';
import { describeApprovalTool } from '../utils/approval.js';

interface Props {
  request: ApprovalRequest;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
}

export function ApprovalPrompt({ request, onApprove, onDeny }: Props) {
  useInput((input) => {
    if (input.length !== 1) return;
    const char = input.toLowerCase();
    if (char === 'y') {
      onApprove();
    } else if (char === 'n') {
      onDeny('用户拒绝');
    }
  });

  const tools = request.tools ?? [{ name: request.toolName, input: request.toolArgs }];
  const previews = tools.map((tool) => describeApprovalTool(tool));
  const truncated = previews.some((preview) => preview.truncated);

  return (
    <Box borderStyle="round" borderColor={theme.warning} flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={theme.warning} bold>需要批准：{request.toolName}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {previews.map((preview, index) => (
          <Box key={`${preview.name}-${index}`} flexDirection="column" paddingLeft={1}>
            <Text color={theme.tool}>{preview.name}</Text>
            <Text>{preview.body}</Text>
          </Box>
        ))}
      </Box>

      {truncated && (
        <Text color={theme.warning}>预览已截断。按 Y 会批准上面列出的完整操作，而不只是可见片段。</Text>
      )}

      {request.prompt && (
        <Box>
          <Text>{request.prompt}</Text>
        </Box>
      )}

      {request.digest && <Text color={theme.dim}>摘要校验：{request.digest}</Text>}

      <Box marginTop={1}>
        <Text bold>[Y] 批准  [N] 拒绝</Text>
      </Box>
    </Box>
  );
}
