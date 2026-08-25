import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { PptError } from './errors.ts'

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined
}

export function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!
  const v4 = ipv4Parts(normalized)
  if (v4 !== undefined) {
    const a = v4[0]!
    const b = v4[1]!
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
      || a === 100 && b >= 64 && b <= 127 || a >= 224
  }
  if (isIP(normalized) === 6) {
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
    if (mapped !== null) {
      const high = Number.parseInt(mapped[1]!, 16)
      const low = Number.parseInt(mapped[2]!, 16)
      return isBlockedIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') || normalized.startsWith('fe9')
      || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('fc') || normalized.startsWith('fd')
      || normalized.startsWith('ff') || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.') || normalized === 'fd00:ec2::254'
  }
  return true
}

export async function validatePublicHttpUrl(input: string): Promise<URL> {
  if (input.length > 2_048) throw new PptError('BROWSER_URL_BLOCKED', 'URL exceeds 2048 characters')
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new PptError('BROWSER_URL_BLOCKED', `invalid URL: ${input}`, { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PptError('BROWSER_URL_BLOCKED', `only public HTTP(S) URLs are allowed: ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') throw new PptError('BROWSER_URL_BLOCKED', 'URLs containing credentials are blocked')
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new PptError('BROWSER_URL_BLOCKED', `non-standard port is blocked: ${url.port}`)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new PptError('BROWSER_URL_BLOCKED', `local hostname is blocked: ${hostname}`)
  }
  const literal = isIP(hostname)
  const addresses = literal === 0 ? await lookup(hostname, { all: true, verbatim: true }) : [{ address: hostname }]
  if (addresses.length === 0 || addresses.some(entry => isBlockedIp(entry.address))) {
    throw new PptError('BROWSER_URL_BLOCKED', `URL resolves to a blocked or non-public address: ${hostname}`)
  }
  return url
}
