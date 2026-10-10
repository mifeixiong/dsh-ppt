import { describe, expect, it } from 'vitest'
import { validateArtDirection } from '../../src/art-direction.ts'
import { validateDeckHtmlSource } from '../../src/html.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'

function source(body: string, css = ''): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter}
    ${css}</style></head><body>${body}</body></html>`
}

/**
 * The hosting surface renders `PptError.message` but not `details`, so static
 * validation has to name the failing rule in the message itself. It used to
 * answer with the constant `HTML static validation failed`, which made every
 * failure an experiment: the caller could only bisect the source by hand.
 */
describe('HTML static validation diagnostics', () => {
  it('names each failing rule in the message', async () => {
    const workspace = await createTestWorkspace()
    try {
      const plan = validateArtDirection(MINIMAL_ART_DIRECTION, 1)
      const broken = source(`<section class="ppt-slide" data-page="1" data-art-composition="hero" data-art-density="low" data-art-background="base">
        <h1 data-ppt-id="title" data-ppt-kind="text" data-art-role="title">Title</h1>
        <p data-ppt-id="title" data-ppt-kind="text">Duplicate</p>
      </section>`)
      await expect(validateDeckHtmlSource(workspace.root, workspace.root, broken, 1, plan))
        .rejects.toThrow(/duplicate data-ppt-id: title/u)
      await expect(validateDeckHtmlSource(workspace.root, workspace.root, broken, 1, plan))
        .rejects.toThrow(/requires exactly one visual-anchor/u)
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the structured issue list in details', async () => {
    const workspace = await createTestWorkspace()
    try {
      const broken = source('<section class="ppt-slide" data-page="1">Loose text</section>')
      const error = await validateDeckHtmlSource(workspace.root, workspace.root, broken, 1).then(
        () => { throw new Error('expected validation to fail') },
        (thrown: unknown) => thrown as { message: string; details?: { issues?: string[] } },
      )
      expect(error.message).toContain('visible text outside a convertible leaf')
      expect(error.message).not.toBe('HTML static validation failed')
      expect(error.details?.issues?.length).toBeGreaterThan(0)
    } finally {
      await workspace.cleanup()
    }
  })
})
