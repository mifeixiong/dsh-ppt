import { describe, expect, it } from 'vitest'
import { isBlockedIp, validatePublicHttpUrl } from '../../src/browser-security.ts'

describe('browser network policy', () => {
  it('blocks private, link-local, metadata, mapped, and local targets', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00:ec2::254', '::ffff:7f00:1']) {
      expect(isBlockedIp(address), address).toBe(true)
    }
    await expect(validatePublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject({ code: 'BROWSER_URL_BLOCKED' })
    await expect(validatePublicHttpUrl('http://localhost/test')).rejects.toMatchObject({ code: 'BROWSER_URL_BLOCKED' })
    await expect(validatePublicHttpUrl('https://user:secret@example.com/')).rejects.toMatchObject({ code: 'BROWSER_URL_BLOCKED' })
    await expect(validatePublicHttpUrl('https://example.com:8443/')).rejects.toMatchObject({ code: 'BROWSER_URL_BLOCKED' })
  })

  it('accepts public HTTP(S) addresses on standard ports', async () => {
    await expect(validatePublicHttpUrl('https://93.184.216.34/research')).resolves.toMatchObject({ protocol: 'https:' })
  })
})
