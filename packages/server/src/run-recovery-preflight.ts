export interface RunRecoveryAuthorization { runId: string; from: string; to: string }
export interface RunRecoveryPreflight {
  conversationId: string; runId: string; status: 'ready' | 'confirmation-required' | 'blocked';
  from?: string; to: string; blockers: string[]; toolCheck: 'on-resume';
}
/** Read-only build/policy preflight. Tool compatibility is still checked by the existing restore path. */
export function describeRunRecovery(conversationId: string, runId: string, to: string, previous?: { build: string; policy: string }, policy?: string, blockers: string[] = []): RunRecoveryPreflight {
  const reasons = [...blockers];
  if (previous && policy && previous.policy !== policy) reasons.push('RECOVERY_POLICY_INCOMPATIBLE');
  return { conversationId, runId, to, ...(previous?.build ? { from: previous.build } : {}), blockers: reasons, toolCheck: 'on-resume',
    status: reasons.length ? 'blocked' : previous?.build && previous.build !== to ? 'confirmation-required' : 'ready' };
}
export function recoveryDecision(preflight: RunRecoveryPreflight, value: unknown): RunRecoveryAuthorization | undefined {
  if (preflight.status === 'blocked') throw new Error(preflight.blockers[0] ?? 'RUN_NOT_RESUMABLE');
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const input = body.recovery && typeof body.recovery === 'object' && !Array.isArray(body.recovery) ? body.recovery as Record<string, unknown> : undefined;
  if (preflight.status === 'ready') { if (input) throw new Error('RECOVERY_CONFIRMATION_STALE'); return undefined; }
  if (!input || input.confirmed !== true) throw new Error('RECOVERY_BUILD_MIGRATION_REQUIRED');
  if (input.runId !== preflight.runId || input.from !== preflight.from || input.to !== preflight.to) throw new Error('RECOVERY_CONFIRMATION_STALE');
  return { runId: preflight.runId, from: preflight.from!, to: preflight.to };
}
