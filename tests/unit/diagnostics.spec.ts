import { describe, expect, it } from 'vitest'
import { diagnosePptRuntime } from '../../src/diagnostics.ts'

describe('startup diagnostics', () => {
  it('reports missing attachments, subprocess and tool surface explicitly', async () => {
    const report = await diagnosePptRuntime({
      options: {
        context: { get() { return undefined } } as never,
      },
      toolSurface: { visible: ['read'], missing: ['read_image'], unexpected: [] },
    })
    expect(report.status).toBe('failed')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tools', status: 'failed' }),
      expect.objectContaining({ id: 'python', status: 'failed' }),
      expect.objectContaining({ id: 'attachments', status: 'failed' }),
    ]))
  })
})
