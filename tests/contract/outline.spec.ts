import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validatePptOutline, writePptOutline } from '../../src/outline.ts'
import { MINIMAL_OUTLINE } from '../fixtures/minimal-outline.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'
import type { DiscoveredFont } from '../../src/fonts.ts'

function page(overrides: Record<string, unknown> = {}) {
  return {
    page: 1, type: 'content', title: 'Content',
    content: [{ kind: 'point', text: 'A clear point' }],
    style: {
      layout: 'title-content', background: 'light', accent: '#4f46e5',
      title_font: 'Liter', body_font: 'Liter', visual_direction: 'Clear hierarchy and generous whitespace',
    },
    ...overrides,
  }
}

describe('strict PPT outline contract', () => {
  it('normalizes deterministic defaults and writes a non-overwriting outline atomically', async () => {
    const workspace = await createTestWorkspace()
    try {
      const result = await writePptOutline(workspace.root, 'Outline Demo', [page()])
      const stored = JSON.parse(await readFile(`${workspace.root}/${result.outline_path}`, 'utf8'))
      expect(stored[0]).toMatchObject({
        page: 1, style: { accent: '#4F46E5' }, content: [{ level: 1, emphasis: false }],
      })
      expect(result).toMatchObject({ page_count: 1, type_counts: { content: 1 }, blocking_warnings: [] })
      expect(result).toMatchObject({ design_status: 'legacy', warnings: [expect.stringContaining('ART_DIRECTION_MISSING')] })
      const second = await writePptOutline(workspace.root, 'Outline Demo', MINIMAL_OUTLINE)
      expect(second.artifact_dir).toMatch(/outline-demo-2$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('writes a validated design plan beside the outline and rejects page mismatches before allocation', async () => {
    const workspace = await createTestWorkspace()
    try {
      const result = await writePptOutline(workspace.root, 'Directed', MINIMAL_OUTLINE, 'ppt-output', undefined, MINIMAL_ART_DIRECTION)
      expect(result).toMatchObject({ design_status: 'directed', design_plan_path: expect.stringMatching(/design-plan\.json$/u) })
      const stored = JSON.parse(await readFile(`${workspace.root}/${result.design_plan_path!}`, 'utf8'))
      expect(stored).toMatchObject({ version: 1, slides: [{ page: 1, composition: 'hero' }] })

      const invalid = { ...MINIMAL_ART_DIRECTION, slides: [] }
      await expect(writePptOutline(workspace.root, 'Invalid Direction', MINIMAL_OUTLINE, 'ppt-output', undefined, invalid))
        .rejects.toMatchObject({ code: 'PPT_ART_DIRECTION_INVALID' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('writes installed platform fallbacks into both outline and design plan', async () => {
    const workspace = await createTestWorkspace()
    const characters = new Set([...'中文正文AaZz09_{}[]();'].map(character => character.codePointAt(0)!))
    const pingFang: DiscoveredFont = {
      name: 'PingFang SC', file: '/fonts/PingFang.ttc', sha256: 'b'.repeat(64), familyName: 'PingFang SC',
      postscriptName: 'PingFangSC-Regular', weight: 'Regular', glyphCount: characters.size,
      supportsLatin: true, supportsCjk: true, codePoints: characters,
    }
    const chineseOutline = [{
      page: 1, type: 'content', title: '中文', content: [{ kind: 'point', text: '正文' }],
      style: { ...page().style as object, title_font: 'MiSans', body_font: 'MiSans' },
    }]
    const chineseDirection = {
      ...MINIMAL_ART_DIRECTION,
      typography: Object.fromEntries(Object.keys(MINIMAL_ART_DIRECTION.typography).map(role => [role, { family: 'MiSans', weight: 400 }])),
    }
    try {
      const result = await writePptOutline(
        workspace.root, 'Platform Fonts', chineseOutline, 'ppt-output', undefined, chineseDirection,
        { discovered: [pingFang], platform: 'darwin' },
      )
      const storedOutline = JSON.parse(await readFile(`${workspace.root}/${result.outline_path}`, 'utf8'))
      const storedDesign = JSON.parse(await readFile(`${workspace.root}/${result.design_plan_path!}`, 'utf8'))
      expect(storedOutline[0].style).toMatchObject({ title_font: 'PingFang SC', body_font: 'PingFang SC' })
      expect(Object.values(storedDesign.typography)).toEqual(expect.arrayContaining([
        expect.objectContaining({ family: 'PingFang SC' }),
      ]))
      expect(result.fonts).toEqual(['PingFang SC'])
      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('FONT_FALLBACK')]))
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects unknown fields, Unicode boundary overflow, nulls, and non-finite data', () => {
    expect(() => validatePptOutline([{ ...page(), unknown: true }])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({ title: '字'.repeat(61) })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({ title: null })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({ content: [{ kind: 'data', label: 'X', value: Number.POSITIVE_INFINITY }] })]))
      .toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
  })

  it('rejects path traversal and mutually present or absent image sources', () => {
    const image = { kind: 'image', role: 'hero', intent: 'Show a hero' }
    expect(() => validatePptOutline([page({ style: { ...page().style as object, layout: 'hero-image' }, content: [{ ...image, asset: '../secret.png' }] })]))
      .toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({ content: [{ ...image, query: 'city', asset: 'assets/city.png' }] })]))
      .toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({ content: [image] })]))
      .toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
  })

  it('enforces layout, comparison groups, timeline/process counts, and image-background rules', () => {
    expect(() => validatePptOutline([page({ style: { ...page().style as object, layout: 'closing' } })]))
      .toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({
      type: 'comparison', style: { ...page().style as object, layout: 'split' },
      content: [{ kind: 'point', text: 'A' }, { kind: 'point', text: 'B' }],
    })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({
      type: 'timeline', style: { ...page().style as object, layout: 'timeline-horizontal' },
      content: [{ kind: 'point', text: 'A' }, { kind: 'point', text: 'B' }],
    })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    expect(() => validatePptOutline([page({
      style: { ...page().style as object, background: 'image' }, content: [{ kind: 'point', text: 'No background asset' }],
    })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
  })

  it('blocks charts with missing data unless an explicit production note records pending data', async () => {
    const chart = { kind: 'chart', chart_type: 'bar', subject: 'Comparison', takeaway: 'A leads' }
    expect(() => validatePptOutline([page({ content: [chart] })])).toThrow(expect.objectContaining({ code: 'PPT_OUTLINE_INVALID' }))
    const workspace = await createTestWorkspace()
    try {
      const result = await writePptOutline(workspace.root, 'Pending chart', [page({ content: [
        chart, { kind: 'note', purpose: 'production', text: '待补数据，生成HTML前必须核验' },
      ] })])
      expect(result.blocking_warnings).toEqual(['page 1: chart data is explicitly pending'])
    } finally {
      await workspace.cleanup()
    }
  })
})
