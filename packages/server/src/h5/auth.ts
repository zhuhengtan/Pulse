import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface H5DeviceRecord {
  automationControl?: boolean
  id: string
  tokenHash: string
  name: string
  createdAt: string
  lastUsedAt: string
  /** Scope is assigned by the server at credential issuance, never by device metadata. */
  scope?: 'local' | 'paired'
}

export interface PairingCodeInfo {
  code: string
  createdAt: number
  expiresAt: number
}

const PAIRING_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

export class H5AuthStore {
  private readonly devicesPath: string
  private devices: H5DeviceRecord[] = []
  private loaded = false
  private activePairingCodes = new Map<string, PairingCodeInfo>()

  constructor(dataDir: string) {
    this.devicesPath = join(dataDir, 'h5-devices.json')
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token.trim()).digest('hex')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.devicesPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        this.devices = parsed.filter(
          (d): d is H5DeviceRecord =>
            Boolean(d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
        ).map(device => ({ ...device, scope: device.scope === 'local' ? 'local' : 'paired' }))
      }
    } catch {
      this.devices = []
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    const tmp = `${this.devicesPath}.tmp-${randomUUID()}`
    await writeFile(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 })
    await rename(tmp, this.devicesPath)
  }

  createPairingCode(): PairingCodeInfo {
    const now = Date.now()
    // Purge expired codes
    for (const [code, info] of this.activePairingCodes.entries()) {
      if (now > info.expiresAt) {
        this.activePairingCodes.delete(code)
      }
    }

    const code = randomBytes(4).toString('hex').toLowerCase()
    const info: PairingCodeInfo = {
      code,
      createdAt: now,
      expiresAt: now + PAIRING_EXPIRY_MS,
    }
    this.activePairingCodes.set(code, info)
    return info
  }

  getPairingCode(code: string): PairingCodeInfo | undefined {
    const info = this.activePairingCodes.get(code.toLowerCase().trim())
    if (!info) return undefined
    if (Date.now() > info.expiresAt) {
      this.activePairingCodes.delete(info.code)
      return undefined
    }
    return info
  }

  async pairDeviceWithCode(
    code: string,
    deviceName: string = 'Mobile Browser'
  ): Promise<{ device: H5DeviceRecord; token: string } | undefined> {
    await this.init()
    const info = this.getPairingCode(code)
    if (!info) return undefined

    // Single use: remove code immediately
    this.activePairingCodes.delete(info.code)

    const token = randomBytes(32).toString('hex')
    const tokenHash = this.hashToken(token)
    const now = new Date().toISOString()

    const device: H5DeviceRecord = {
      id: `dev-${randomUUID()}`,
      tokenHash,
      name: deviceName.slice(0, 80),
      createdAt: now,
      lastUsedAt: now,
      scope: 'paired',
    }

    this.devices.push(device)
    await this.persist()
    return { device, token }
  }

  async getOrCreateLocalDevice(existingToken?: string): Promise<{ device: H5DeviceRecord; token: string }> {
    await this.init()
    const existing = await this.authenticateToken(existingToken)
    if (existing && existing.scope === 'local') return { device: existing, token: existingToken! }
    const token = randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    const device: H5DeviceRecord = {
      id: `dev-${randomUUID()}`,
      tokenHash: this.hashToken(token),
      name: 'Pulse 本机浏览器',
      createdAt: now,
      lastUsedAt: now,
      scope: 'local',
    }
    this.devices.push(device)
    await this.persist()
    return { device, token }
  }

  async authenticateToken(token?: string): Promise<H5DeviceRecord | undefined> {
    if (!token?.trim()) return undefined
    await this.init()
    const hash = this.hashToken(token)
    const device = this.devices.find((d) => d.tokenHash === hash)
    if (!device) return undefined

    // Update lastUsedAt if more than 1 minute since last update
    const last = new Date(device.lastUsedAt).getTime()
    if (Date.now() - last > 60_000) {
      device.lastUsedAt = new Date().toISOString()
      this.persist().catch(() => undefined)
    }
    return device
  }

  async listDevices(): Promise<Array<Omit<H5DeviceRecord, 'tokenHash'>>> {
    await this.init()
    return this.devices.map(({ id, name, createdAt, lastUsedAt, automationControl }) => ({
      id,
      name,
      createdAt,
      lastUsedAt,
      automationControl: automationControl === true,
    }))
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    await this.init()
    const initialLen = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== deviceId)
    if (this.devices.length !== initialLen) {
      await this.persist()
      return true
    }
    return false
  }

  async setAutomationControl(deviceId: string, enabled: boolean): Promise<boolean> {
    await this.init()
    const device = this.devices.find(device => device.id === deviceId)
    if (!device) return false
    device.automationControl = enabled
    await this.persist()
    return true
  }
}
