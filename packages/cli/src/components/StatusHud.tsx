import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { LaneDisplay } from '../types.js';

interface Props {
  cwd: string;
  model: string;
  provider: string;
  approvalMode: 'read-only' | 'ask' | 'auto';
  currentStep?: string | null;
  lanes: LaneDisplay[];
}

function laneLabel(lane: LaneDisplay): string {
  const goal = lane.goal.length > 34 ? `${lane.goal.slice(0, 34)}…` : lane.goal;
  return `${lane.id.slice(0, 8)} ${lane.status}${lane.activity ? ` · ${lane.activity}` : ''}${goal ? ` · ${goal}` : ''}`;
}

export function StatusHud({ cwd, model, provider, approvalMode, currentStep, lanes }: Props) {
  const activeLanes = lanes.filter((lane) => !['succeeded', 'failed', 'cancelled'].includes(lane.status));
  const approvalLabel = approvalMode === 'auto' ? 'auto' : approvalMode === 'read-only' ? '只读' : 'ask';

  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={theme.border} flexDirection="column" paddingTop={1}>
      <Box gap={1}>
        <Text color={theme.primary} bold>STATUS</Text>
        <Text color={theme.dim}>model:{model}</Text>
        <Text color={theme.dim}>provider:{provider}</Text>
        <Text color={approvalMode === 'auto' ? theme.warning : theme.dim}>approval:{approvalLabel}</Text>
        <Text color={activeLanes.length ? theme.accent : theme.dim}>lanes:{activeLanes.length}/{lanes.length}</Text>
        {currentStep && <Text color={theme.dim}>· {currentStep}</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>workspace:{cwd}</Text>
      </Box>
      {lanes.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {lanes.slice(-4).map((lane) => (
            <Text key={lane.id} color={lane.status === 'failed' ? theme.error : lane.status === 'succeeded' ? theme.success : theme.dim}>
              {laneLabel(lane)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
