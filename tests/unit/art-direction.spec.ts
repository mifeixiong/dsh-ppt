import { describe, expect, it } from 'vitest'
import { artDirectionFindings, artDirectionReviewChecklist, validateArtDirection } from '../../src/art-direction.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'

describe('Art Direction contract', () => {
  it('rejects unknown fields and missing page coverage', () => {
    expect(() => validateArtDirection({ ...MINIMAL_ART_DIRECTION, unknown: true }, 1))
      .toThrow(expect.objectContaining({ code: 'PPT_ART_DIRECTION_INVALID' }))
    expect(() => validateArtDirection(MINIMAL_ART_DIRECTION, 2))
      .toThrow(expect.objectContaining({ code: 'PPT_ART_DIRECTION_INVALID' }))
  })

  it('warns about accidental composition runs but honors intentional repetition', () => {
    const second = { ...MINIMAL_ART_DIRECTION.slides[0], page: 2 }
    const base = {
      ...MINIMAL_ART_DIRECTION,
      rhythm: { ...MINIMAL_ART_DIRECTION.rhythm, background_sequence: ['base', 'base'] },
      slides: [MINIMAL_ART_DIRECTION.slides[0], second],
    }
    expect(artDirectionFindings(validateArtDirection(base, 2))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ART_COMPOSITION_REPEATED', page: 2 }),
    ]))
    const allowed = { ...base, slides: [base.slides[0], { ...second, allow_intentional_repeat: true }] }
    expect(artDirectionFindings(validateArtDirection(allowed, 2))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ART_COMPOSITION_REPEATED' }),
    ]))
  })

  it('creates page-specific model review checks', () => {
    expect(artDirectionReviewChecklist(validateArtDirection(MINIMAL_ART_DIRECTION, 1)))
      .toEqual(expect.arrayContaining([expect.stringContaining('Page 1')]))
  })
})

/**
 * The hosting surface renders `PptError.message` but not its `details`, so a
 * zod failure must name the offending JSON paths in the message itself. Outline
 * validation already does this; art direction validation answered with the
 * constant `PPT art direction validation failed`, which left the caller
 * guessing the schema one field at a time.
 */
describe('Art Direction diagnostics', () => {
  interface CapturedError {
    code?: string
    message: string
    details?: { issues?: Array<{ path: string; message: string }> }
  }

  function capture(fn: () => unknown): CapturedError {
    try {
      fn()
    } catch (error) {
      return error as CapturedError
    }
    throw new Error('expected validateArtDirection to throw')
  }

  it('names the offending JSON paths for a schema violation', () => {
    const broken = {
      ...MINIMAL_ART_DIRECTION,
      rhythm: { ...MINIMAL_ART_DIRECTION.rhythm, max_same_composition_run: 99 },
    }
    const error = capture(() => validateArtDirection(broken, 1))
    expect(error.code).toBe('PPT_ART_DIRECTION_INVALID')
    expect(error.message).not.toBe('PPT art direction validation failed')
    expect(error.message).toContain('rhythm.max_same_composition_run')
    expect(error.details?.issues?.length).toBeGreaterThan(0)
  })

  it('keeps structured issues alongside the rendered page-count line', () => {
    const error = capture(() => validateArtDirection(MINIMAL_ART_DIRECTION, 2))
    expect(error.message).toContain('expected 2 pages, received 1')
    expect(error.details?.issues).toEqual([expect.objectContaining({ path: 'slides' })])
  })

  it('truncates long issue lists and counts the remainder', () => {
    const broken = {
      ...MINIMAL_ART_DIRECTION,
      rhythm: { ...MINIMAL_ART_DIRECTION.rhythm, background_sequence: Array.from({ length: 12 }, () => 'base' as const) },
      slides: Array.from({ length: 12 }, () => ({ page: 'x' })),
    }
    const error = capture(() => validateArtDirection(broken, 12))
    expect(error.message).toMatch(/; \+\d+ more$/u)
    expect(error.message.length).toBeLessThan(2_000)
  })
})
