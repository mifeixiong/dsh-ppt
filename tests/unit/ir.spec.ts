import { describe, expect, it } from 'vitest'
import { pxToInches, pxToPoints } from '../../src/ir.ts'
import { inspectPptxPackage } from '../../src/pptx.ts'

describe('slide IR coordinate and package invariants', () => {
  it('maps 1280x720 CSS pixels to exact 13.333333x7.5 inches with stable rounding', () => {
    expect(pxToInches(1280)).toBe(13.333333)
    expect(pxToInches(720)).toBe(7.5)
    expect(pxToInches(96)).toBe(1)
    expect(pxToPoints(16)).toBe(12)
  })

  it('rejects non-ZIP PPTX bytes', () => {
    expect(() => inspectPptxPackage(new TextEncoder().encode('not a zip'), 1))
      .toThrow(expect.objectContaining({ code: 'PPT_CREATE_INVALID_PACKAGE' }))
  })
})
