import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import ToolRegistry, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { apply as applyTools } from '../../src/tools.ts'
import { assertSupportedPlatform } from '../../src/index.ts'
import { PPT_MODE_TOOL_NAMES, PPT_NATIVE_TOOL_NAMES } from '../../src/schemas.ts'

function toolContext(native = [...PPT_NATIVE_TOOL_NAMES, 'glob']) {
  const definitions = new Map(native.map(name => [name, { name }]))
  const denied = new Set<string>()
  const scopeSymbol = Symbol('dsh.scope')
  const scopeKey = { id: 'ppt-contract-scope' }
  let recorded: unknown
  let recordCount = 0
  let preExecute: ((exec: { name: string; arguments: unknown }, next: () => Promise<{ kind: 'allow' }>) => Promise<{ kind: string; reason?: string }>) | undefined
  let toolChange: (() => void) | undefined
  const effectDisposers: Array<() => void> = []
  const context = {
    [scopeSymbol]: scopeKey,
    effect(factory: () => Generator<() => void>) {
      const effect = factory()
      const yielded = effect.next()
      if (!yielded.done) effectDisposers.push(yielded.value)
      return () => yielded.done ? undefined : yielded.value()
    },
    on(event: string, listener: unknown) {
      if (event === 'tools/pre-execute') preExecute = listener as typeof preExecute
      if (event === 'tools/change') toolChange = listener as () => void
      return () => {
        if (event === 'tools/change') toolChange = undefined
      }
    },
    tools: {
      register(definition: { name: string }) {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
      restrict(filter: { deny?: string[] }) {
        for (const name of filter.deny ?? []) denied.add(name)
        return () => { for (const name of filter.deny ?? []) denied.delete(name) }
      },
      schemas() {
        return [...definitions.values()].filter(definition => !denied.has(definition.name))
      },
    },
    pptRuntime: {
      recordToolSurface(value: unknown) { recorded = value; recordCount += 1 },
    },
  }
  return {
    context, getRecorded: () => recorded, getRecordCount: () => recordCount,
    getDefinitions: () => definitions, getPreExecute: () => preExecute,
    triggerToolChange: () => toolChange?.(),
    disposeEffects: () => { for (const dispose of effectDisposers.reverse()) dispose() },
  }
}

function fixtureTool(name: string): ToolDefinition {
  return {
    name,
    description: `fixture ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(name),
  }
}

async function mintScope(ctx: Context, key: object): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, key)
  }, { inject: ['tools', 'pptRuntime'] })).await()
  return scope
}

describe('PPT preset contract', () => {
  it('declares the PPT preset as a composition row and mounts the native tool packages plus the package tool entry', async () => {
    const source = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    expect(source).toContain("id: preset-ppt")
    expect(source).toContain("name: '@deepseek-ai/dsh-agent-preset'")
    expect(source).toMatch(/id: preset-ppt[\s\S]*?id: ppt[\s\S]*?order: 5/u)
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-fs'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-bash'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-pwsh'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-ask-user'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-todo'")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-web'")
    expect(source).toContain("name: '@yejiming/dsh-ppt/tools'")
    expect(source).not.toMatch(/dsh-tool-(?:goal|jobs|skill|subagent|fs-search)/u)
    // The shell tool is a platform split: bash off on Windows, pwsh on only Windows.
    expect(source).toMatch(/id: tool-bash[\s\S]*?disabled: !!js process\.platform === 'win32'/u)
    expect(source).toMatch(/id: tool-pwsh[\s\S]*?disabled: !!js process\.platform !== 'win32'/u)
    expect(source).toContain('mode: native')
    expect(source).toContain('fetch: false')
    expect(source).toContain('allowParallelInProgress: false')
  })

  it('registers twelve package tools and denies unexpected inherited tools', () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    const visible = fixture.context.tools.schemas().map(item => item.name).sort()
    expect(visible).toEqual(PPT_MODE_TOOL_NAMES)
    expect(fixture.getRecorded()).toEqual({ visible, missing: [], unexpected: [] })
    const outline = fixture.getDefinitions().get('ppt_outline') as { parameters?: { properties?: { art_direction?: unknown } } }
    const html = fixture.getDefinitions().get('html_create') as { parameters?: { properties?: { design_plan_path?: unknown; strict_design?: unknown } } }
    const pptImage = fixture.getDefinitions().get('ppt_image') as { parameters?: { properties?: Record<string, unknown> } }
    const pptFonts = fixture.getDefinitions().get('ppt_fonts') as { parameters?: { properties?: Record<string, unknown> } }
    expect(outline.parameters?.properties).toHaveProperty('art_direction')
    const slides = (outline.parameters?.properties as { slides?: { items?: { properties?: Record<string, unknown>; additionalProperties?: boolean } } }).slides
    expect(slides?.items?.additionalProperties).toBe(false)
    expect(Object.keys(slides?.items?.properties ?? {}).sort()).toEqual(['content', 'page', 'style', 'title', 'type'])
    expect(html.parameters?.properties).toEqual(expect.objectContaining({ design_plan_path: expect.any(Object), strict_design: expect.any(Object) }))
    expect(pptImage.parameters?.properties).toEqual(expect.objectContaining({
      pptx_path: expect.any(Object), backend: expect.any(Object), force: expect.any(Object), screen_index: expect.any(Object), refresh_quality: expect.any(Object),
    }))
    expect(pptFonts.parameters?.properties).toEqual(expect.objectContaining({
      text: expect.any(Object), role: expect.any(Object), layer: expect.any(Object), include_unavailable: expect.any(Object),
    }))
  })

  it('keeps profile-level tools out of a standing PPT preset and rebound blank session', async () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', {
      tools() { return () => undefined },
      section() { return () => undefined },
    } as never)
    await ctx.plugin(ToolRegistry).await()
    let recorded: unknown
    ctx.provide('pptRuntime', {
      recordToolSurface(value: unknown) { recorded = value },
    } as never)

    for (const name of ['describe_image', 'ssh_exec', 'ssh_upload']) {
      ctx.tools.register(fixtureTool(name))
    }

    const pptKey = { agentPreset: 'ppt-fixture' }
    const standing = await mintScope(ctx, pptKey)
    for (const name of PPT_NATIVE_TOOL_NAMES) standing.ctx.tools.register(fixtureTool(name))
    applyTools(standing.ctx)

    const agentKey = { id: 'blank-web-session' }
    const standardKey = { agentPreset: 'standard-fixture' }
    const standard = await mintScope(ctx, standardKey)
    standard.ctx.tools.register(fixtureTool('standard_local'))
    const binding = bindScopeParent(agentKey, standardKey)
    await mintScope(ctx, agentKey)
    expect(ctx.tools.schemas(agentKey).map(item => item.name)).toContain('ssh_exec')

    binding.rebind(pptKey)
    const visible = ctx.tools.schemas(agentKey).map(item => item.name).sort()
    expect(visible).toEqual(PPT_MODE_TOOL_NAMES)
    expect(recorded).toEqual({ visible: PPT_MODE_TOOL_NAMES, missing: [], unexpected: [] })
  })

  it('records missing read_image instead of treating 18 tools as healthy', () => {
    const fixture = toolContext(PPT_NATIVE_TOOL_NAMES.filter(name => name !== 'read_image'))
    applyTools(fixture.context as never)
    expect(fixture.getRecorded()).toMatchObject({ missing: ['read_image'] })
  })

  it('cancels a queued surface audit when the tool effect is disposed', async () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    expect(fixture.getRecordCount()).toBe(1)

    fixture.triggerToolChange()
    fixture.disposeEffects()
    await Promise.resolve()

    expect(fixture.getRecordCount()).toBe(1)
  })

  it('requires approval before native office automation but not LibreOffice', async () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    const policy = fixture.getPreExecute()
    expect(policy).toBeTypeOf('function')
    const native = await policy!({ name: 'ppt_image', arguments: { backend: 'auto' } }, async () => ({ kind: 'allow' }))
    const libreOffice = await policy!({ name: 'ppt_image', arguments: { backend: 'libreoffice' } }, async () => ({ kind: 'allow' }))
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(native).toMatchObject({ kind: 'ask', reason: expect.stringContaining('Keynote') })
    } else {
      expect(native).toEqual({ kind: 'allow' })
    }
    expect(libreOffice).toEqual({ kind: 'allow' })
  })

  it('supports Windows and rejects unknown platforms with a stable error', () => {
    expect(() => assertSupportedPlatform('win32')).not.toThrow()
    expect(() => assertSupportedPlatform('freebsd')).toThrow(expect.objectContaining({ code: 'PPT_PLATFORM_UNSUPPORTED' }))
  })
})
