import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../../src/browser.ts'
import { discoverBrowserExecutable } from '../../src/browser-discovery.ts'
import { createHtmlDeck } from '../../src/html.ts'
import { writePptOutline } from '../../src/outline.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'

const owner = { agentId: 'html-agent', sessionId: 'html-session' }

function deckHtml(extraCss = ''): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:#fff}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter;background:#fff;color:#111}
    .title{position:absolute;left:80px;top:70px;width:1120px;height:90px;font-size:52px;line-height:1.1}
    .body{position:absolute;left:80px;top:200px;width:900px;height:160px;font-size:28px;line-height:1.4}
    ${extraCss}</style></head><body><section class="ppt-slide" data-page="1">
      <h1 class="title" data-ppt-id="title" data-ppt-kind="text" data-ppt-z="2">Validated HTML</h1>
      <p class="body" data-ppt-id="body" data-ppt-kind="text" data-ppt-z="1">A concise supporting statement.</p>
    </section></body></html>`
}

describe('HTML browser preview and layout validation', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let browser: BrowserRuntime
  let outlinePath: string

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-html-')
    const result = await writePptOutline(workspace.root, 'HTML Preview', [{
      page: 1, type: 'content', title: 'Validated HTML', content: [{ kind: 'point', text: 'A concise supporting statement.' }],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Simple' },
    }])
    outlinePath = result.outline_path
    resources = new SessionResourceRegistry()
    const found = await discoverBrowserExecutable()
    if (found.executable === undefined) throw new Error('Chrome/Chromium is required')
    browser = new BrowserRuntime(resources, found.executable)
  })

  afterEach(async () => {
    await browser.dispose()
    await resources.dispose()
    await workspace.cleanup()
  })

  it('commits deck.html only after rendering a 1280x720 page preview', async () => {
    const result = await createHtmlDeck(browser, owner, workspace.root, outlinePath, deckHtml())
    expect(result).toMatchObject({ page_count: 1, external_resources: 'none', fonts: ['Liter'] })
    expect(result.preview_paths).toHaveLength(1)
    expect(await readFile(`${workspace.root}/${result.html_path}`, 'utf8')).toContain('data-ppt-id="title"')
  })

  it('replaces deck.html on a repeated call instead of refusing', async () => {
    // deck.html is this tool's own deterministic output; forcing the caller to
    // delete it between HTML edits turned every iteration into busywork.
    const first = await createHtmlDeck(browser, owner, workspace.root, outlinePath, deckHtml())
    const second = await createHtmlDeck(browser, owner, workspace.root, outlinePath, deckHtml('.body{color:#123456}'))
    expect(second.html_path).toBe(first.html_path)
    expect(await readFile(`${workspace.root}/${second.html_path}`, 'utf8')).toContain('#123456')
  })

  it('rejects text overflow and element bounds before committing deck.html', async () => {
    const overflowing = deckHtml('.body{width:20px;height:20px;white-space:nowrap}.title{left:1250px;width:200px}')
    await expect(createHtmlDeck(browser, owner, workspace.root, outlinePath, overflowing))
      .rejects.toMatchObject({ code: 'HTML_CREATE_VALIDATION_FAILED' })
  })

  it('renders a directed deck and persists browser-backed design fidelity evidence', async () => {
    const directedOutline = await writePptOutline(workspace.root, 'Directed HTML Preview', [{
      page: 1, type: 'content', title: 'Directed HTML', content: [{ kind: 'point', text: 'A deliberate visual anchor.' }],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Editorial hero' },
    }], 'ppt-output', undefined, MINIMAL_ART_DIRECTION)
    const directed = `<!doctype html><html><head><style>
      html,body{margin:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter;background:#F7F5F0;color:#111318}
      .anchor{position:absolute;left:80px;top:150px;width:720px;height:280px;font-size:56px;line-height:1.1}
    </style></head><body><section class="ppt-slide" data-page="1" data-art-composition="hero" data-art-density="low" data-art-background="base">
      <h1 class="anchor" data-ppt-id="anchor" data-ppt-kind="text" data-art-role="visual-anchor">A deliberate visual anchor.</h1>
    </section></body></html>`
    const result = await createHtmlDeck(
      browser, owner, workspace.root, directedOutline.outline_path, directed, undefined, directedOutline.design_plan_path,
    )
    expect(result).toMatchObject({ design_status: 'directed', design_findings: [] })
    const evidence = JSON.parse(await readFile(`${workspace.root}/${result.design_validation_path}`, 'utf8'))
    expect(evidence).toMatchObject({ mode: 'directed', pages: [{ page: 1, frameCount: 0 }] })
  })
})
