import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import { theme } from '../theme.js';
import type { LaneDisplay } from '../types.js';
interface Props { isRunning?: boolean; cwd: string; model: string; provider: string; approvalMode: 'read-only' | 'ask' | 'auto'; currentStep?: string | null; lanes: LaneDisplay[] }
export function StatusHud({ isRunning, approvalMode, currentStep, lanes }: Props) {
  const active = lanes.filter((lane) => !['succeeded', 'failed', 'cancelled'].includes(lane.status));
  return <Box flexShrink={0} gap={1}>{isRunning && <Spinner />}<Text color={theme.dim} wrap="truncate-end">{isRunning ? currentStep || '正在执行' : '就绪'} · {approvalMode === 'auto' ? '自动审批' : approvalMode === 'read-only' ? '只读' : '操作前询问'}{active.length > 1 ? ` · ${active.length} 个子任务` : ''} · /help 帮助 · /verbose 详情</Text></Box>;
}
