import { networkInterfaces } from 'node:os'

/**
 * Returns the best candidate IPv4 address for local network access.
 * Re-evaluated dynamically on each call so changing Wi-Fi networks
 * or interfaces requires no server restart.
 */
function readInterfaces(): ReturnType<typeof networkInterfaces> {
  try {
    return networkInterfaces()
  } catch {
    return {}
  }
}

export function getLocalNetworkIp(): string {
  const interfaces = readInterfaces()
  const candidates: Array<{ name: string; address: string; score: number }> = []

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue

      let score = 0
      const iface = name.toLowerCase()

      // Deprioritize virtual, tunnel, or docker interfaces
      if (/utun|tun|tap|docker|veth|br-|tailscale|wireguard|vmnet|vbox/.test(iface)) {
        score -= 50
      }

      // Prioritize standard Wi-Fi and Ethernet interfaces
      if (/^(en0|eth0|wlan0)$/.test(iface)) {
        score += 30
      } else if (/^(en\d+|eth\d+|wlan\d+)$/.test(iface)) {
        score += 20
      }

      // Prioritize standard private LAN subnets
      if (addr.address.startsWith('192.168.')) {
        score += 25
      } else if (addr.address.startsWith('10.')) {
        score += 20
      } else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr.address)) {
        score += 15
      }

      candidates.push({ name, address: addr.address, score })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address ?? '127.0.0.1'
}

/**
 * Checks if a remote IP address belongs to loopback (local machine only).
 */
export function isLoopbackIp(ip?: string): boolean {
  if (!ip) return false
  const normalized = ip.replace(/^::ffff:/, '')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

/** Host header hostname, without a port and without IPv6 brackets. */
export function hostHeaderHostname(hostHeader: string | undefined): string {
  const value = hostHeader?.trim().toLowerCase() ?? ''
  if (!value) return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end <= 1 ? '' : value.slice(1, end).split('%')[0] ?? ''
  }
  const colon = value.lastIndexOf(':')
  if (colon > 0 && value.indexOf(':') === colon && /^\d+$/.test(value.slice(colon + 1))) {
    return value.slice(0, colon)
  }
  return value.split('%')[0] ?? ''
}

/**
 * Exact host allow-list for the H5 server.
 * Only localhost and addresses currently assigned to this machine are accepted.
 * Prefix checks such as `10.` would allow a DNS name like `10.attacker.example`.
 */
export function isAllowedH5Host(hostHeader: string | undefined): boolean {
  const name = hostHeaderHostname(hostHeader)
  if (!name) return false
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true
  const allowed = new Set<string>()
  for (const addrs of Object.values(readInterfaces())) {
    if (!addrs) continue
    for (const addr of addrs) {
      const bare = addr.address.toLowerCase().split('%')[0]
      if (bare) allowed.add(bare)
    }
  }
  return allowed.has(name)
}
