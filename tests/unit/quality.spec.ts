import { describe, expect, it } from 'vitest'
import { computeOverallStatus, fontconfigDocument, type QualityLayerStatus } from '../../src/quality.ts'

function report(statuses: [QualityLayerStatus, QualityLayerStatus, QualityLayerStatus, QualityLayerStatus]) {
  const [structural_status, render_status, automatic_visual_status, model_visual_status] = statuses
  return { structural_status, render_status, automatic_visual_status, model_visual_status }
}

describe('quality overall status', () => {
  it('marks only four passed gates verified', () => {
    expect(computeOverallStatus(report(['passed', 'passed', 'passed', 'passed']))).toBe('verified')
  })

  it('keeps unavailable or unperformed work unverified and propagates failures', () => {
    expect(computeOverallStatus(report(['passed', 'not_available', 'not_available', 'not_performed']))).toBe('unverified')
    expect(computeOverallStatus(report(['passed', 'passed', 'failed', 'passed']))).toBe('failed')
  })

  it('builds an isolated cross-platform fontconfig file with a writable cache', () => {
    const document = fontconfigDocument(['/System/Library/Fonts', 'C:\\Windows\\Fonts', '/fonts/a&b'], '/tmp/font-cache')
    expect(document).toContain('<dir>/System/Library/Fonts</dir>')
    expect(document).toContain('<dir>C:/Windows/Fonts</dir>')
    expect(document).toContain('<dir>/fonts/a&amp;b</dir>')
    expect(document).toContain('<cachedir>/tmp/font-cache</cachedir>')
  })
})
