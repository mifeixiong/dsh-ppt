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
})
