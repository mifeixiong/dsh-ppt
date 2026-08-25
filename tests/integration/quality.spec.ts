import { access, chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntime } from '../../src/browser.ts'
import { discoverBrowserExecutable } from '../../src/browser-discovery.ts'
import { createHtmlDeck } from '../../src/html.ts'
import { writePptOutline } from '../../src/outline.ts'
import { createPptx } from '../../src/pptx.ts'
import { applyVisualReview, QualityRuntime } from '../../src/quality.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'
import { MINIMAL_ART_DIRECTION } from '../fixtures/minimal-art-direction.ts'

const owner = { agentId: 'quality-agent', sessionId: 'quality-session' }

describe('final PPTX quality loop', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let browser: BrowserRuntime
  let quality: QualityRuntime
  let subprocess: LocalSubprocessRuntime
  let sandbox: LocalSandboxProvider

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-quality-')
    resources = new SessionResourceRegistry()
    const context = new Context()
    subprocess = new LocalSubprocessRuntime(context)
    sandbox = new LocalSandboxProvider(context, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 })
    quality = new QualityRuntime(subprocess, sandbox, resources)
    const found = await discoverBrowserExecutable()
    if (found.executable === undefined) throw new Error('Chrome/Chromium is required')
    browser = new BrowserRuntime(resources, found.executable)
  })

  afterEach(async () => {
    await browser.dispose()
    await resources.dispose()
    await workspace.cleanup()
  })

  async function makeDeck(title: string, content: string, asset?: Uint8Array, displayText = 'Quality verified deck') {
    const outline = await writePptOutline(workspace.root, title, [{
      page: 1, type: 'content', title, content: [{ kind: 'point', text: 'Quality content' }],
      style: { layout: 'title-content', background: 'light', accent: '#2563EB', title_font: 'Liter', body_font: 'Liter', visual_direction: 'Quality fixture' },
    }], 'ppt-output', undefined, {
      ...MINIMAL_ART_DIRECTION,
      slides: [{ ...MINIMAL_ART_DIRECTION.slides[0], visual_anchor: { ...MINIMAL_ART_DIRECTION.slides[0].visual_anchor, min_area_ratio: 0.05 } }],
    })
    if (asset !== undefined) await writeFile(join(workspace.root, outline.artifact_dir, 'assets', 'images', 'asset.png'), asset)
    const html = `<!doctype html><html><head><style>html,body{margin:0}.ppt-slide{width:1280px;height:720px;position:relative;overflow:hidden;font-family:Liter;background:#FFFFFF;color:#111111}${content}</style></head><body><section class="ppt-slide" data-page="1" data-art-composition="hero" data-art-density="low" data-art-background="base">${content.includes('FULL_IMAGE')
      ? '<img class="full" src="assets/images/asset.png" data-ppt-id="full" data-ppt-kind="image" data-art-role="visual-anchor">'
      : content.includes('BLANK_SHAPE') ? '<div class="blank" data-ppt-id="blank" data-ppt-kind="shape" data-art-role="visual-anchor"></div>'
        : `<h1 class="title" data-ppt-id="title" data-ppt-kind="text" data-art-role="visual-anchor">${displayText}</h1>`}</section></body></html>`
    const css = content.replace('FULL_IMAGE', '').replace('BLANK_SHAPE', '')
    const finalHtml = html.replace(content, css)
    const htmlResult = await createHtmlDeck(browser, owner, workspace.root, outline.outline_path, finalHtml, undefined, outline.design_plan_path)
    const pptxPath = `${outline.artifact_dir}/deck.pptx`
    const conversion = await createPptx(browser, owner, workspace.root, htmlResult.html_path, outline.outline_path, pptxPath)
    return { outline, htmlResult, conversion }
  }

  it('real-renders with isolated LibreOffice, creates page previews/contact sheets, and keeps model review independent', async () => {
    const deck = await makeDeck('Quality normal', '.title{position:absolute;left:100px;top:120px;width:900px;height:100px;margin:0;font-size:48px;line-height:1.1}', undefined, '中文回渲 Quality verified deck')
    const reportPath = `${deck.outline.artifact_dir}/report.json`
    const reviewPath = `${deck.outline.artifact_dir}/visual-review.json`
    const report = await quality.evaluate(
      owner, workspace.root, deck.conversion.pptx_path, deck.htmlResult.preview_paths, reportPath, reviewPath, 1, true,
    )
    expect(report.render_status).toBe('passed')
    expect(report.artifacts.pptx_previews).toHaveLength(1)
    expect(report.artifacts.contact_sheets).toHaveLength(1)
    expect(report.layers.automatic_visual.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CJK_GLYPHS_MISSING' })]))
    expect(report.layers.automatic_visual.design_fidelity).toMatchObject({ mode: 'directed' })
    expect(JSON.parse(await readFile(join(workspace.root, reviewPath), 'utf8')).checklist).toEqual(expect.arrayContaining([expect.stringContaining('Page 1')]))
    expect(report.model_visual_status).toBe('not_performed')
    expect(report.overall_status).not.toBe('verified')
    await expect(access(join(workspace.root, report.artifacts.pptx_previews[0]!))).resolves.toBeUndefined()
    await expect(access(join(workspace.root, report.artifacts.contact_sheets[0]!))).resolves.toBeUndefined()

    const rerun = await quality.evaluate(
      owner, workspace.root, deck.conversion.pptx_path, deck.htmlResult.preview_paths, reportPath, reviewPath, 1, true,
    )
    expect(rerun.render_status).toBe('passed')

    await writeFile(join(workspace.root, reviewPath), `${JSON.stringify({
      version: 1, status: 'failed', checklist: [], reviewed_assets: report.artifacts.contact_sheets,
      findings: [{ page: 1, severity: 'error', message: 'Visual hierarchy failed review' }], completed_at: new Date().toISOString(),
    }, null, 2)}\n`)
    const finalized = await applyVisualReview(workspace.root, reportPath, reviewPath)
    expect(finalized.model_visual_status).toBe('failed')
    expect(finalized.overall_status).toBe('failed')
  }, 90_000)

  it('marks renderer absence unverified and a blank rendered page failed', async () => {
    const normal = await makeDeck('Quality unavailable', '.title{position:absolute;left:100px;top:120px;width:900px;height:100px;margin:0;font-size:48px;line-height:1.1}')
    const missingRuntime = new QualityRuntime(undefined, undefined, resources)
    const unavailable = await missingRuntime.evaluate(
      owner, workspace.root, normal.conversion.pptx_path, normal.htmlResult.preview_paths,
      `${normal.outline.artifact_dir}/report-unavailable.json`, `${normal.outline.artifact_dir}/review-unavailable.json`, 1, false,
    )
    expect(unavailable.layers.structural.findings).toEqual([])
    expect(unavailable).toMatchObject({ overall_status: 'unverified', render_status: 'not_available', model_visual_status: 'not_available' })
    const blank = await makeDeck('Quality blank', 'BLANK_SHAPE.blank{position:absolute;left:0;top:0;width:1280px;height:720px;background:#FFFFFF}')
    const report = await quality.evaluate(
      owner, workspace.root, blank.conversion.pptx_path, blank.htmlResult.preview_paths,
      `${blank.outline.artifact_dir}/report.json`, `${blank.outline.artifact_dir}/visual-review.json`, 1, false,
    )
    expect(report.overall_status).toBe('failed')
    expect(report.layers.automatic_visual.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'BLANK_PAGE' })]))
  }, 90_000)

  it('detects a full-page raster degradation and large HTML/PPTX preview drift', async () => {
    const png = await sharp({ create: { width: 1280, height: 720, channels: 4, background: '#4F46E5' } }).png().toBuffer()
    const deck = await makeDeck('Quality raster', 'FULL_IMAGE.full{position:absolute;left:0;top:0;width:1280px;height:720px;object-fit:cover}', png)
    await sharp({ create: { width: 1280, height: 720, channels: 4, background: '#000000' } }).png().toFile(join(workspace.root, deck.htmlResult.preview_paths[0]!))
    const report = await quality.evaluate(
      owner, workspace.root, deck.conversion.pptx_path, deck.htmlResult.preview_paths,
      `${deck.outline.artifact_dir}/report.json`, `${deck.outline.artifact_dir}/visual-review.json`, 1, false,
    )
    expect(report.layers.structural.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FULL_PAGE_RASTER' })]))
    expect(report.layers.automatic_visual.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LAYOUT_DRIFT' })]))
    expect(report.artifacts.high_risk_previews).toHaveLength(1)
    expect(report.overall_status).toBe('failed')
  }, 90_000)

  it('records a renderer execution failure as failed rather than unavailable', async () => {
    const deck = await makeDeck('Quality render failure', '.title{position:absolute;left:100px;top:120px;width:900px;height:100px;margin:0;font-size:48px;line-height:1.1}')
    const fake = join(workspace.root, 'fake-soffice')
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Fake LibreOffice"; exit 0; fi\necho "conversion failed" >&2\nexit 9\n')
    await chmod(fake, 0o755)
    const failing = new QualityRuntime(subprocess, sandbox, resources, { soffice: [fake] })
    const report = await failing.evaluate(
      owner, workspace.root, deck.conversion.pptx_path, deck.htmlResult.preview_paths,
      `${deck.outline.artifact_dir}/report.json`, `${deck.outline.artifact_dir}/visual-review.json`, 1, true,
    )
    expect(report.render_status).toBe('failed')
    expect(report.layers.render.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RENDER_FAILED' })]))
    expect(report.overall_status).toBe('failed')
  }, 30_000)
})
