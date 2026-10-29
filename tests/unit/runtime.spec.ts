import { describe, expect, it } from 'vitest'
import { createPptRuntime } from '../../src/runtime.ts'

describe('PPT runtime lifecycle', () => {
  it('ignores a late tool-surface audit after disposal', async () => {
    const runtime = createPptRuntime()
    runtime.recordToolSurface({ visible: ['ppt_outline'], missing: [], unexpected: [] })
    const recorded = runtime.toolSurface

    await runtime.dispose()

    expect(() => runtime.recordToolSurface({ visible: [], missing: ['ppt_outline'], unexpected: [] })).not.toThrow()
    expect(runtime.toolSurface).toBe(recorded)
  })

  it('snapshots and freezes the office group so a later audit cannot rewrite it', async () => {
    const runtime = createPptRuntime()
    const officeVisible = ['word_create', 'word_read']
    const officeMissing = ['ppt_read']
    runtime.recordToolSurface({
      visible: ['ppt_outline', ...officeVisible],
      missing: [],
      unexpected: [],
      office: { available: true, visible: officeVisible, missing: officeMissing },
    })
    const surface = runtime.toolSurface

    // The caller's arrays are copied, not aliased: mutating them afterwards must
    // not reach the recorded status.
    officeVisible.push('injected_later')
    officeMissing.push('injected_later')
    expect(surface?.office?.visible).toEqual(['word_create', 'word_read'])
    expect(surface?.office?.missing).toEqual(['ppt_read'])
    expect(Object.isFrozen(surface)).toBe(true)
    expect(Object.isFrozen(surface?.office)).toBe(true)
    expect(Object.isFrozen(surface?.office?.visible)).toBe(true)
    expect(Object.isFrozen(surface?.office?.missing)).toBe(true)

    await runtime.dispose()
  })

  it('omits the office group entirely when the audit reports no lane', async () => {
    const runtime = createPptRuntime()
    runtime.recordToolSurface({ visible: ['ppt_outline'], missing: [], unexpected: [] })

    expect(runtime.toolSurface).not.toHaveProperty('office')

    await runtime.dispose()
  })
})
