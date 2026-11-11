import path from 'node:path'

// Kept in parity with the standalone capsule controller's builder. Do not import
// repository scripts here: this module must also work in the published package.
export function isolatedRuntimeEnvironment(root: string, platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const home = paths.join(root, 'home')
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PULSE_DATA_DIR: paths.join(root, 'data'), PULSE_DATA_IPC_ROOT: paths.join(root, 'ipc'), PULSE_MANAGED: '0', PULSE_SELF_HOST_RUNTIME_V1: '1' }
  if (platform === 'win32') {
    const keys = Object.keys(source).filter(key => key.toUpperCase() === 'SYSTEMROOT')
    const systemRoot = keys.length === 1 ? source[keys[0]!] : undefined
    // The controller inherits only the OS installation directory, never PATH,
    // user/domain identity or temporary/profile directories. No UNC, relative,
    // device paths or normalization aliases may enter the child contract.
    if (!systemRoot || !/^[A-Za-z]:\\[^\\/:*?"<>|\x00-\x1f]+(?:\\[^\\/:*?"<>|\x00-\x1f]+)*$/.test(systemRoot) || paths.normalize(systemRoot) !== systemRoot || systemRoot.split('\\').some(part => /[ .]$/.test(part))) throw new Error('ISOLATED_SYSTEM_ROOT_INVALID')
    Object.assign(env, { HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), LOGONSERVER: '', PATH: '', SYSTEMDRIVE: systemRoot.slice(0, 2), SYSTEMROOT: systemRoot, TEMP: home, TMP: home, USERDOMAIN: '', USERNAME: '', WINDIR: systemRoot })
  }
  return env
}

export function validateIsolatedRuntimeEnvironment(root: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, systemRoot?: string): void {
  const expected = isolatedRuntimeEnvironment(root, platform, systemRoot === undefined ? {} : { SYSTEMROOT: systemRoot })
  const actual = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    const name = platform === 'win32' ? key.toUpperCase() : key
    if (actual.has(name)) throw new Error('ISOLATED_ENV_NOT_CLEAN')
    actual.set(name, value)
  }
  const cfEncoding = env.__CF_USER_TEXT_ENCODING
  if (platform === 'darwin' && cfEncoding !== undefined && /^0x[0-9a-f]{1,8}:0x[0-9a-f]{1,8}:0x[0-9a-f]{1,8}$/i.test(cfEncoding) && Number(cfEncoding.split(':')[0]) === process.getuid?.()) expected.__CF_USER_TEXT_ENCODING = cfEncoding
  if ([...actual.keys()].some(key => !Object.hasOwn(expected, key))) throw new Error('ISOLATED_ENV_NOT_CLEAN')
  for (const [key, value] of Object.entries(expected)) {
    if (actual.get(key) !== value) throw new Error('ISOLATED_ENV_INVALID')
  }
}
