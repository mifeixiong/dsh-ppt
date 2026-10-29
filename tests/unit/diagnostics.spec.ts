import { describe, expect, it } from 'vitest'
import { diagnosePptRuntime } from '../../src/diagnostics.ts'
import { PPT_CORE_TOOL_NAMES, PPT_OFFICE_TOOL_NAMES } from '../../src/schemas.ts'

type Surface = {
  visible: string[]
  missing: string[]
  unexpected: string[]
  office?: { available: boolean; visible: string[]; missing: string[] }
}

/** A complete core surface, so each case isolates the office lane. */
const completeCore: Surface = { visible: [...PPT_CORE_TOOL_NAMES], missing: [], unexpected: [] }

function runtimeWith(toolSurface: Surface) {
  return {
    options: { context: { get() { return undefined } } as never },
    toolSurface,
  }
}

async function toolsCheck(toolSurface: Surface) {
  const report = await diagnosePptRuntime(runtimeWith(toolSurface))
  return report.checks.find(check => check.id === 'tools')
}

describe('startup diagnostics', () => {
  it('reports missing attachments, subprocess and tool surface explicitly', async () => {
    const report = await diagnosePptRuntime(runtimeWith({ visible: ['read'], missing: ['read_image'], unexpected: [] }))
    expect(report.status).toBe('failed')
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tools', status: 'failed' }),
      expect.objectContaining({ id: 'python', status: 'failed' }),
      expect.objectContaining({ id: 'attachments', status: 'failed' }),
    ]))
  })

  it('treats a composition without an office bundle as a healthy core surface', async () => {
    const check = await toolsCheck({ ...completeCore, office: { available: false, visible: [], missing: [...PPT_OFFICE_TOOL_NAMES] } })
    expect(check?.status).toBe('ready')
    expect(check?.message).toContain(`All ${PPT_CORE_TOOL_NAMES.length} PPT core tools are visible`)
    expect(check?.message).toContain('office document lane not mounted')
  })

  it('reports a complete office lane in the ready message', async () => {
    const check = await toolsCheck({
      ...completeCore,
      visible: [...completeCore.visible, ...PPT_OFFICE_TOOL_NAMES],
      office: { available: true, visible: [...PPT_OFFICE_TOOL_NAMES], missing: [] },
    })
    expect(check?.status).toBe('ready')
    expect(check?.message).toContain(`office document lane complete (${PPT_OFFICE_TOOL_NAMES.length}/${PPT_OFFICE_TOOL_NAMES.length})`)
    expect(check?.details).toMatchObject({ office: { available: true, missing: [] } })
  })

  it('downgrades a half-mounted office lane to degraded instead of calling it ready', async () => {
    const mounted = PPT_OFFICE_TOOL_NAMES.filter(name => name !== 'ppt_read')
    const check = await toolsCheck({
      ...completeCore,
      visible: [...completeCore.visible, ...mounted],
      office: { available: true, visible: [...mounted], missing: ['ppt_read'] },
    })
    expect(check?.status).toBe('degraded')
    expect(check?.message).toContain('office document lane partial (6/7; missing ppt_read)')
  })

  it('keeps an incomplete core surface failed even when the office lane is complete', async () => {
    const check = await toolsCheck({
      visible: PPT_CORE_TOOL_NAMES.filter(name => name !== 'ppt_create'),
      missing: ['ppt_create'],
      unexpected: [],
      office: { available: true, visible: [...PPT_OFFICE_TOOL_NAMES], missing: [] },
    })
    expect(check?.status).toBe('failed')
    expect(check?.message).toBe('PPT mode tool surface is incomplete')
  })
})
