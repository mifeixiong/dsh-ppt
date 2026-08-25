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
