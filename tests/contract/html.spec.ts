import { describe, expect, it } from 'vitest'
import { createHtmlDeck, validateDeckHtmlSource } from '../../src/html.ts'
import { validateArtDirection } from '../../src/art-direction.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'

function html(body: string, css = ''): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter}
    ${css}</style></head><body>${body}</body></html>`
}

async function outline(workspace: string): Promise<string> {
  return (await writePptOutline(workspace, 'HTML Contract', [{
    page: 1, type: 'content', title: 'Content', content: [{ kind: 'point', text: 'Point' }],
    style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Simple' },
  }])).outline_path
}

describe('constrained HTML contract', () => {
  it('validates directed page attributes, roles, anchors, and strict design warnings', async () => {
    const workspace = await createTestWorkspace()
    try {
      const plan = validateArtDirection(MINIMAL_ART_DIRECTION, 1)
      const directed = html(`<section class="ppt-slide" data-page="1" data-art-composition="hero" data-art-density="low" data-art-background="base">
        <h1 data-ppt-id="title" data-ppt-kind="text" data-art-role="title">Title</h1>
        <div data-ppt-id="anchor" data-ppt-kind="text" data-art-role="visual-anchor">Anchor</div>
      </section>`)
      const result = await validateDeckHtmlSource(workspace.root, workspace.root, directed, 1, plan)
      expect(result.designFindings).toEqual([])

      const wrong = directed.replace('data-art-composition="hero"', 'data-art-composition="layered"')
      await expect(validateDeckHtmlSource(workspace.root, workspace.root, wrong, 1, plan))
        .rejects.toMatchObject({ code: 'HTML_CREATE_VALIDATION_FAILED' })

      const noAnchor = directed.replace(' data-art-role="visual-anchor"', '')
      await expect(validateDeckHtmlSource(workspace.root, workspace.root, noAnchor, 1, plan))
        .rejects.toMatchObject({ code: 'HTML_CREATE_VALIDATION_FAILED' })
    } finally { await workspace.cleanup() }
  })

  it('rejects page order, duplicate IDs, unknown kinds, and unmarked visible text', async () => {
    for (const body of [
      '<section class="ppt-slide" data-page="2"><h1 data-ppt-id="title" data-ppt-kind="text">Title</h1></section>',
      '<section class="ppt-slide" data-page="1"><h1 data-ppt-id="same" data-ppt-kind="text">A</h1><p data-ppt-id="same" data-ppt-kind="text">B</p></section>',
      '<section class="ppt-slide" data-page="1"><div data-ppt-id="x" data-ppt-kind="chart">Chart</div></section>',
      '<section class="ppt-slide" data-page="1">Loose text</section>',
    ]) {
      const workspace = await createTestWorkspace()
      try {
        await expect(createHtmlDeck({} as never, { agentId: 'a', sessionId: 'a' }, workspace.root, await outline(workspace.root), html(body)))
          .rejects.toMatchObject({ code: 'HTML_CREATE_VALIDATION_FAILED' })
      } finally { await workspace.cleanup() }
    }
  })

  it('rejects scripts, remote resources, missing assets, unauthorized fonts, and unsupported CSS', async () => {
    for (const source of [
      html('<section class="ppt-slide" data-page="1"><h1 data-ppt-id="t" data-ppt-kind="text">T</h1><script>alert(1)</script></section>'),
      html('<section class="ppt-slide" data-page="1"><img data-ppt-id="i" data-ppt-kind="image" src="https://example.com/a.png"></section>'),
      html('<section class="ppt-slide" data-page="1"><img data-ppt-id="i" data-ppt-kind="image" src="assets/missing.png"></section>'),
      html('<section class="ppt-slide" data-page="1"><h1 data-ppt-id="t" data-ppt-kind="text">T</h1></section>', '.ppt-slide{font-family:Papyrus}'),
      html('<section class="ppt-slide" data-page="1"><h1 data-ppt-id="t" data-ppt-kind="text">T</h1></section>', '#t{transform:scale(2)}'),
    ]) {
      const workspace = await createTestWorkspace()
      try {
        await expect(createHtmlDeck({} as never, { agentId: 'b', sessionId: 'b' }, workspace.root, await outline(workspace.root), source))
          .rejects.toMatchObject({ code: 'HTML_CREATE_VALIDATION_FAILED' })
      } finally { await workspace.cleanup() }
    }
  })
})
