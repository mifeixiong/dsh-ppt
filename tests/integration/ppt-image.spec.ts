import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import PptxGenJS from 'pptxgenjs'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PptImageRuntime } from '../../src/ppt-image.ts'
import { SessionResourceRegistry } from '../../src/session-resources.ts'
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts'

const owner = { agentId: 'ppt-image-agent', sessionId: 'ppt-image-session' }

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

describe('PPT image rendering runtime', () => {
  let workspace: TestWorkspace
  let resources: SessionResourceRegistry
  let subprocess: LocalSubprocessRuntime
  let sandbox: LocalSandboxProvider

  beforeEach(async () => {
    workspace = await createTestWorkspace('dsh-ppt-image-')
    resources = new SessionResourceRegistry()
    const context = new Context()
    subprocess = new LocalSubprocessRuntime(context)
    sandbox = new LocalSandboxProvider(context, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 })
  })

  afterEach(async () => {
    await resources.dispose()
    await workspace.cleanup()
  })

  async function makeDeck(pageCount = 2): Promise<string> {
    const path = join(workspace.root, 'artifact', 'deck.pptx')
    await mkdir(join(workspace.root, 'artifact'), { recursive: true })
    const pptx = new PptxGenJS()
    pptx.layout = 'LAYOUT_WIDE'
    for (let page = 1; page <= pageCount; page += 1) {
      const slide = pptx.addSlide()
      slide.background = { color: 'F7F5F0' }
      slide.addText(`第${page}页 / Page ${page}`, { x: 1, y: 1, w: 8, h: 0.7, fontFace: 'Arial', fontSize: 28 })
    }
    await pptx.writeFile({ fileName: path })
    return 'artifact/deck.pptx'
  }

  async function fakeKeynote(exportedPages: number): Promise<{ executable: string; application: string }> {
    const application = join(workspace.root, 'Fake Keynote.app')
    const executable = join(workspace.root, 'fake-osascript')
    const source = join(workspace.root, 'source.png')
    await mkdir(application, { recursive: true })
    await writeFile(source, await sharp({ create: { width: 960, height: 540, channels: 4, background: '#336699' } }).png().toBuffer())
    const copies = Array.from({ length: exportedPages }, (_, index) =>
      `cp ${shellQuote(source)} "$3.${String(index + 1).padStart(3, '0')}.png"`).join('\n')
    await writeFile(executable, `#!/bin/sh\nmkdir -p "$(dirname "$3")"\n${copies}\n`)
    await chmod(executable, 0o755)
    return { executable, application }
  }

  async function fakePowerPointScreen(exportedPages: number): Promise<{ executable: string; application: string; capture: string }> {
    const application = join(workspace.root, 'Fake Microsoft PowerPoint.app')
    const executable = join(workspace.root, 'fake-powerpoint-osascript')
    const capture = join(workspace.root, 'fake-screencapture')
    const source = join(workspace.root, 'screen.png')
    await Promise.all([mkdir(application, { recursive: true }), writeFile(capture, '#!/bin/sh\nexit 0\n')])
    await writeFile(source, await sharp({ create: { width: 1512, height: 982, channels: 4, background: '#224466' } }).png().toBuffer())
    const copies = Array.from({ length: exportedPages }, (_, index) =>
      `cp ${shellQuote(source)} "$3/page-${String(index + 1).padStart(3, '0')}.png"`).join('\n')
    await writeFile(executable, `#!/bin/sh\nmkdir -p "$3"\n${copies}\n`)
    await Promise.all([chmod(executable, 0o755), chmod(capture, 0o755)])
    return { executable, application, capture }
  }

  it('normalizes pages, creates contact sheets, reuses cache, and preserves a complete render after an incomplete retry', async () => {
    const pptxPath = await makeDeck(2)
    const fake = await fakeKeynote(2)
    const runtime = new PptImageRuntime(subprocess, sandbox, resources, {
      osascript: [fake.executable], keynote: [fake.application],
    }, [], 'darwin')
    const first = await runtime.render(owner, workspace.root, pptxPath, { nativeAutomationApproved: true })
    expect(first.status, JSON.stringify(first, null, 2)).toBe('passed')
    expect(first).toMatchObject({ backend: 'keynote', page_count: 2, cached: false })
    expect(first.image_paths).toHaveLength(2)
    expect(first.contact_sheet_paths).toHaveLength(1)
    expect(await sharp(join(workspace.root, first.image_paths[0]!)).metadata()).toMatchObject({ width: 1280, height: 720 })

    const cached = await runtime.render(owner, workspace.root, pptxPath, { nativeAutomationApproved: true })
    expect(cached).toMatchObject({ status: 'passed', cached: true })

    const incomplete = await fakeKeynote(1)
    const failing = new PptImageRuntime(subprocess, sandbox, resources, {
      osascript: [incomplete.executable], keynote: [incomplete.application],
    }, [], 'darwin')
    const retried = await failing.render(owner, workspace.root, pptxPath, { backend: 'keynote', force: true, nativeAutomationApproved: true })
    expect(retried.status).toBe('failed')
    expect(retried.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ backend: 'keynote', status: 'failed' })]))
    await expect(access(join(workspace.root, first.image_paths[1]!))).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(join(workspace.root, first.manifest_path!), 'utf8')).page_count).toBe(2)
  })

  it('reports missing renderers and honours cancellation', async () => {
    const pptxPath = await makeDeck(1)
    const unavailable = new PptImageRuntime(subprocess, sandbox, resources, {
      soffice: [join(workspace.root, 'missing-soffice')], pdftoppm: [join(workspace.root, 'missing-pdftoppm')],
    }, [], 'linux')
    await expect(unavailable.render(owner, workspace.root, pptxPath)).resolves.toMatchObject({
      status: 'not_available', attempts: [expect.objectContaining({ backend: 'libreoffice', status: 'not_available' })],
    })
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(unavailable.render(owner, workspace.root, pptxPath, {}, controller.signal)).rejects.toMatchObject({ code: 'PPT_ABORTED' })
  })

  it('uses macOS PowerPoint screen capture only after clean renderers and center-crops the display', async () => {
    const pptxPath = await makeDeck(2)
    const fake = await fakePowerPointScreen(2)
    const runtime = new PptImageRuntime(subprocess, sandbox, resources, {
      osascript: [fake.executable], keynote: [join(workspace.root, 'missing-keynote')],
      soffice: [join(workspace.root, 'missing-soffice')], pdftoppm: [join(workspace.root, 'missing-pdftoppm')],
      powerpoint: [fake.application], screencapture: [fake.capture],
    }, [], 'darwin')
    const rendered = await runtime.render(owner, workspace.root, pptxPath, {
      force: true, nativeAutomationApproved: true, screenIndex: 1,
    })
    expect(rendered).toMatchObject({ status: 'passed', backend: 'powerpoint', capture_method: 'screen-capture' })
    expect(rendered.attempts.map(attempt => attempt.backend)).toEqual(['keynote', 'libreoffice', 'powerpoint'])
    expect(rendered.warnings.join(' ')).toContain('last-resort')
    expect(await sharp(join(workspace.root, rendered.image_paths[0]!)).metadata()).toMatchObject({ width: 1280, height: 720 })
    const manifest = JSON.parse(await readFile(join(workspace.root, rendered.manifest_path!), 'utf8'))
    expect(manifest).toMatchObject({ version: 2, capture_method: 'screen-capture' })
  })

  it.skipIf(process.platform !== 'darwin' || process.env.DSH_TEST_KEYNOTE !== '1')(
    'exports a real PPTX with Keynote through the DSH subprocess and native-app approval path',
    async () => {
      const requestedPptx = process.env.DSH_TEST_PPTX
      const targetWorkspace = requestedPptx === undefined ? workspace.root : process.cwd()
      const pptxPath = requestedPptx ?? await makeDeck(2)
      const runtime = new PptImageRuntime(subprocess, sandbox, resources)
      const rendered = await runtime.render(owner, targetWorkspace, pptxPath, {
        backend: 'keynote', force: true, nativeAutomationApproved: true,
      })
      expect(rendered.status, JSON.stringify(rendered, null, 2)).toBe('passed')
      expect(rendered).toMatchObject({ backend: 'keynote' })
      expect(rendered.image_paths).toHaveLength(rendered.page_count)
    },
    120_000,
  )
})
