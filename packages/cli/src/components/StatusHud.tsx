import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import { theme } from '../theme.js';
import type { LaneDisplay } from '../types.js';
interface Props { isRunning?: boolean; cwd: string; model: string; provider: string; approvalMode: 'read-only' | 'ask' | 'auto'; lanes: LaneDisplay[] }
export function StatusHud({ isRunning, approvalMode, lanes }: Props) {
  const active = lanes.filter((lane) => !['succeeded', 'failed', 'cancelled'].includes(lane.status));
  return <Box flexShrink={0} gap={1}>{isRunning && <Spinner />}<Text color={theme.dim} wrap="truncate-end">{isRunning ? '任务进行中 · 详细进度显示在对话里 · /cancel 停止' : '就绪'} · {approvalMode === 'auto' ? '自动审批' : approvalMode === 'read-only' ? '只读' : '操作前询问'}{active.length > 1 ? ` · ${active.length} 个子任务` : ''} · /help 帮助 · /exit 退出</Text></Box>;
}
