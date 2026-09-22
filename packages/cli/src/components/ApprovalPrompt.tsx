import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { theme } from '../theme.js';
import type { ApprovalRequest } from '../types.js';
import { describeApprovalTool } from '../utils/approval.js';

interface Props {
  request: ApprovalRequest;
  isFocused?: boolean;
  inputMode?: boolean;
  onApprove: () => void;
  onDeny: (reason?: string) => void;
  onInput: () => void;
}

export function ApprovalPrompt({ request, isFocused = false, inputMode = false, onApprove, onDeny, onInput }: Props) {
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
        <Text color={theme.warning}>预览已截断。选择“同意”会执行上面列出的完整操作，而不只是可见片段。</Text>
      )}

      {request.prompt && (
        <Box>
          <Text>{request.prompt}</Text>
        </Box>
      )}

      {request.digest && <Text color={theme.dim}>摘要校验：{request.digest}</Text>}

      <Box marginTop={1}>
        <Text bold>
          {isFocused
            ? '审批选择已聚焦（↑↓ 选择，Enter 确认；Tab 切换到输入；默认拒绝）'
            : inputMode
              ? '输入模式：可发送补充信息；按 Tab 返回审批选择'
              : '审批选择处理中...'}
        </Text>
      </Box>
      <SelectInput
        key={request.effectId}
        isFocused={isFocused}
        initialIndex={1}
        items={[
          { label: '同意', value: 'approve' as const },
          { label: '拒绝', value: 'deny' as const },
          { label: '输入', value: 'input' as const },
        ]}
        onSelect={(item) => {
          if (item.value === 'approve') onApprove();
          else if (item.value === 'deny') onDeny('用户拒绝');
          else onInput();
        }}
      />
    </Box>
  );
}
