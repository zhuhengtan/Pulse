import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

export async function initializeShellSandbox(policy: SandboxRuntimeConfig, platform: NodeJS.Platform = process.platform): Promise<void> {
  try {
    await SandboxManager.initialize(policy, undefined, false)
  } catch (error) {
    // A cold Windows sandbox account can time out during the WFP readiness
    // probe. Retry that probe once after cleanup, before any command is run.
    // A failed isolation check, ACL error, or second timeout still fails closed.
    if (platform !== 'win32' || !error || typeof error !== 'object'
      || !('code' in error) || error.code !== 'srt_win_timeout'
      || !('subcommand' in error) || error.subcommand !== 'wfp') throw error
    await SandboxManager.reset()
    await SandboxManager.initialize(policy, undefined, false)
  }
}
