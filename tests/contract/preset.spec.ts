import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import ToolRegistry, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyTools } from '../../src/tools.ts'
import { assertSupportedPlatform } from '../../src/index.ts'
import { PPT_CORE_TOOL_NAMES, PPT_MODE_TOOL_NAMES, PPT_NATIVE_TOOL_NAMES, PPT_OFFICE_TOOL_NAMES } from '../../src/schemas.ts'

interface ToolSurfaceRecord {
  visible: string[]
  missing: string[]
  unexpected: string[]
  office?: { available: boolean; visible: string[]; missing: string[] }
}

function toolContext(
  native = [...PPT_NATIVE_TOOL_NAMES, 'glob'],
  options: { scoped?: boolean; logger?: boolean; loggerThrows?: boolean; runtimeThrows?: boolean } = {},
) {
  const { scoped = true, logger = true, loggerThrows = false, runtimeThrows = false } = options
  const definitions = new Map(native.map(name => [name, { name }]))
  const denied = new Set<string>()
  const scopeSymbol = Symbol('dsh.scope')
  const scopeKey = { id: 'ppt-contract-scope' }
  let recorded: unknown
  let recordCount = 0
  const warnings: string[] = []
  const errors: string[] = []
  let preExecute: ((exec: { name: string; arguments: unknown }, next: () => Promise<{ kind: 'allow' }>) => Promise<{ kind: string; reason?: string }>) | undefined
  let toolChange: (() => void) | undefined
  const effectDisposers: Array<() => void> = []
  const context = {
    ...(scoped ? { [scopeSymbol]: scopeKey } : {}),
    ...(logger
      ? {
        logger: {
          warn: (text: string) => {
            // A logger on a fiber that is already unwinding throws the way any
            // cordis service does. The reporter must not turn that into the
            // failure it was only meant to describe.
            if (loggerThrows) throw new Error('logger is not usable')
            warnings.push(text)
          },
          error: (text: string) => errors.push(text),
        },
      }
      : {}),
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
        const deny = filter.deny ?? []
        // The real registry refuses a restriction that names the reserved PTC
        // transport, so the fixture refuses it too.
        if (deny.includes('run_code')) {
          throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"')
        }
        for (const name of deny) denied.add(name)
        return () => { for (const name of deny) denied.delete(name) }
      },
      schemas() {
        return [...definitions.values()].filter(definition => !denied.has(definition.name))
      },
    },
    pptRuntime: {
      recordToolSurface(value: unknown) {
        // Model a host runtime that is not usable at this instant. The audit's
        // caller must contain the failure either way.
        if (runtimeThrows) throw new Error('ppt runtime is not usable')
        recorded = value
        recordCount += 1
      },
    },
  }
  return {
    context, getRecorded: () => recorded as ToolSurfaceRecord | undefined, getRecordCount: () => recordCount,
    getWarnings: () => [...warnings], getErrors: () => [...errors], getDenied: () => [...denied].sort(),
    getDefinitions: () => definitions, getPreExecute: () => preExecute,
    // Another plugin mounted after this preset registering its own tool.
    addExternalTool: (name: string) => { definitions.set(name, { name }) },
    triggerToolChange: () => toolChange?.(),
    disposeEffects: () => { for (const dispose of effectDisposers.reverse()) dispose() },
  }
}

/** Let every queued microtask (dsh-ppt's deferred audit) and their follow-ups run. */
async function settleMicrotasks(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await Promise.resolve()
}

/**
 * Turn an escaping async exception into an assertion failure instead of a dead
 * vitest worker. The listener is process-global, so the caller must remove it.
 */
function captureEscapingExceptions(): { captured: unknown[]; stop: () => void } {
  const captured: unknown[] = []
  const listeners = {
    uncaughtException: (error: unknown) => { captured.push(error) },
    unhandledRejection: (reason: unknown) => { captured.push(reason) },
  }
  // The two events have unrelated listener signatures; the fixture only records.
  const on = process.on.bind(process) as (event: string, listener: (value: unknown) => void) => void
  const off = process.off.bind(process) as (event: string, listener: (value: unknown) => void) => void
  on('uncaughtException', listeners.uncaughtException)
  on('unhandledRejection', listeners.unhandledRejection)
  return {
    captured,
    stop: () => {
      off('uncaughtException', listeners.uncaughtException)
      off('unhandledRejection', listeners.unhandledRejection)
    },
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

  it('registers thirteen package tools and denies unexpected inherited tools', () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    const visible = fixture.context.tools.schemas().map(item => item.name).sort()
    expect(visible).toEqual(PPT_CORE_TOOL_NAMES)
    expect(fixture.getRecorded()).toEqual({
      visible,
      missing: [],
      unexpected: [],
      office: { available: false, visible: [], missing: [...PPT_OFFICE_TOOL_NAMES] },
    })
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
    const themes = fixture.getDefinitions().get('ppt_themes') as { parameters?: { properties?: Record<string, unknown> } }
    expect(themes.parameters?.properties).toEqual(expect.objectContaining({
      scene: expect.any(Object), theme_id: expect.any(Object), page_types: expect.any(Object),
    }))
    expect(outline.parameters?.properties).toHaveProperty('theme_id')
  })

  it('serves the theme catalogue, one theme and a per-page plan through the mounted tool', async () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    const themes = fixture.getDefinitions().get('ppt_themes') as unknown as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<{
        themes: Array<{ id: string; palette_source: string; signature: string; poster_move: string; motif: string; gradient: string }>
        theme?: {
          id: string
          palette: { accent: string; accent_inverted: string }
          decoration: string[]
          signature: string
          poster_moves: string[]
          motifs: Array<{ id: string; name: string; width: number; height: number; placement: string }>
          avoid: string[]
          type_treatment: { label_tracking: string }
          gradients: Array<{ name: string; css: string; fallback: string }>
        }
        pages?: Array<{ page: number; composition: string; colors: { background: string; accent: string }; poster_move?: string; gradient?: { css: string } }>
        motif?: { id: string; name: string; svg_base: string; svg_inverse: string; width: number; height: number }
      }>
    }

    const catalog = await themes.execute({}, {})
    expect(catalog.themes).toHaveLength(12)
    expect(catalog.theme).toBeUndefined()
    expect(catalog.themes.every(theme => theme.palette_source.length > 0)).toBe(true)
    expect(catalog.themes.every(theme => theme.signature.length > 0)).toBe(true)
    expect(catalog.themes.every(theme => theme.poster_move.length > 0)).toBe(true)
    expect(catalog.themes.every(theme => theme.motif.length > 0)).toBe(true)

    const detail = await themes.execute({ theme_id: 'carbon-blueprint' }, {})
    expect(detail.theme?.palette.accent).toBe('#0B57D0')
    expect(detail.theme?.palette.accent_inverted).toBe('#8AB4FF')
    expect(detail.theme?.decoration.length).toBeGreaterThan(0)
    expect(detail.theme?.avoid.length).toBeGreaterThan(0)
    expect(detail.theme?.type_treatment.label_tracking).toBe('0.16em')
    expect(detail.theme?.poster_moves).toHaveLength(3)
    expect(detail.theme?.motifs.length).toBeGreaterThanOrEqual(2)
    expect(detail.theme?.gradients).toEqual([])
    const motif = await themes.execute({ theme_id: 'carbon-blueprint', motif_id: 'square-grid' }, {})
    expect(motif.motif?.svg_base).toContain('<svg')
    expect(motif.motif?.svg_base).toContain('line')
    expect(motif.motif?.svg_inverse).toContain('<svg')
    await expect(themes.execute({ theme_id: 'carbon-blueprint', motif_id: 'not-a-motif' }, {}))
      .rejects.toMatchObject({ code: 'PPT_THEME_INVALID' })

    const planned = await themes.execute({ theme_id: 'midnight-raise', page_types: ['cover', 'content', 'data', 'ending'] }, {})
    expect(planned.pages).toHaveLength(4)
    expect(planned.pages?.map(page => page.page)).toEqual([1, 2, 3, 4])
    // This theme opens on its dark base group, so page one carries the base
    // accent rather than the inverted one.
    expect(planned.pages?.[0]?.colors.accent).toBe('#7FB0FF')
    // The aurora gradient is a poster-page field: the cover gets it, the data
    // page does not.
    expect(planned.pages?.[0]?.gradient?.css).toBe('linear-gradient(160deg, #07111F, #10294D, #0B3A6B)')
    expect(planned.pages?.[2]?.gradient).toBeUndefined()
    // Poster moves belong to the cover and the ending, not the content or data page.
    expect(planned.pages?.[0]?.poster_move).toContain('Poster A')
    expect(planned.pages?.[1]?.poster_move).toBeUndefined()
    expect(planned.pages?.[3]?.poster_move).toContain('Poster B')

    await expect(themes.execute({ theme_id: 'no-such-theme' }, {})).rejects.toMatchObject({ code: 'PPT_THEME_UNKNOWN' })
    await expect(themes.execute({ page_types: ['cover'] }, {})).rejects.toMatchObject({ code: 'PPT_THEME_INVALID' })
    await expect(themes.execute({ theme_id: 'paper-ink', page_types: [] }, {})).rejects.toMatchObject({ code: 'PPT_THEME_INVALID' })
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
    expect(visible).toEqual(PPT_CORE_TOOL_NAMES)
    expect(recorded).toEqual({
      visible: PPT_CORE_TOOL_NAMES,
      missing: [],
      unexpected: [],
      office: { available: false, visible: [], missing: [...PPT_OFFICE_TOOL_NAMES] },
    })
  })

  it('records missing read_image instead of treating the rest of the core as healthy', () => {
    const fixture = toolContext(PPT_NATIVE_TOOL_NAMES.filter(name => name !== 'read_image'))
    applyTools(fixture.context as never)
    expect(fixture.getRecorded()).toMatchObject({ missing: ['read_image'] })
  })

  it('keeps the inherited office document lane visible instead of denying it', () => {
    const fixture = toolContext([...PPT_NATIVE_TOOL_NAMES, 'glob', ...PPT_OFFICE_TOOL_NAMES])
    applyTools(fixture.context as never)
    const visible = fixture.context.tools.schemas().map(item => item.name).sort()

    // The office tools are the document half of the merged surface: the preset
    // sees them because the host mounted dsh-office-tools, and must allow them.
    expect(visible).toEqual(PPT_MODE_TOOL_NAMES)
    expect(fixture.getDenied()).toEqual(['glob'])
    expect(fixture.getRecorded()).toEqual({
      visible,
      missing: [],
      unexpected: [],
      office: { available: true, visible: [...PPT_OFFICE_TOOL_NAMES], missing: [] },
    })
    expect(fixture.getWarnings()).toEqual([])
  })

  it('warns once when only part of the office lane is mounted', () => {
    const mounted = PPT_OFFICE_TOOL_NAMES.slice(0, 3)
    const absent = PPT_OFFICE_TOOL_NAMES.slice(3)
    const fixture = toolContext([...PPT_NATIVE_TOOL_NAMES, ...mounted])
    applyTools(fixture.context as never)

    expect(fixture.getRecorded()).toMatchObject({
      missing: [],
      unexpected: [],
      office: { available: true, visible: [...mounted], missing: [...absent] },
    })
    expect(fixture.getWarnings()).toEqual([`PPT preset sees 3/7 office tool(s); unavailable: ${absent.join(', ')}`])
  })

  it('treats an unmounted office lane as a supported composition, not a defect', () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    expect(fixture.getRecorded()).toMatchObject({
      missing: [],
      unexpected: [],
      office: { available: false, visible: [], missing: [...PPT_OFFICE_TOOL_NAMES] },
    })
    expect(fixture.getWarnings()).toEqual([])
  })

  it('picks up an office lane registered after the preset mounted (the shipped desktop order)', async () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    // The deny list is a snapshot of the global view at apply() time, so an
    // office bundle mounted later is neither denied nor known: the deferred
    // audit has to notice it and flip the lane from absent to complete.
    expect(fixture.getRecorded()).toMatchObject({ office: { available: false } })

    for (const name of PPT_OFFICE_TOOL_NAMES) fixture.addExternalTool(name)
    fixture.triggerToolChange()
    await settleMicrotasks()

    expect(fixture.getRecorded()).toMatchObject({
      missing: [],
      unexpected: [],
      office: { available: true, visible: [...PPT_OFFICE_TOOL_NAMES], missing: [] },
    })
    expect(fixture.getWarnings()).toEqual([])
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

  it('reports a tool registered by a later plugin as a diagnostic instead of throwing from the deferred audit', async () => {
    const fixture = toolContext()
    applyTools(fixture.context as never)
    const firstRecord = fixture.getRecorded()
    expect(firstRecord).toMatchObject({ missing: [], unexpected: [] })

    // DSH Desktop mounts its office composition after the PPT preset, so
    // load_workspace_dependencies (and read_image) appear here. That arrival is
    // outside the preset's control and must not abort the host.
    fixture.addExternalTool('load_workspace_dependencies')
    const escaping = captureEscapingExceptions()
    try {
      fixture.triggerToolChange()
      await settleMicrotasks()
    } finally {
      escaping.stop()
    }

    expect(escaping.captured).toEqual([])
    expect(fixture.getErrors()).toEqual([])
    const recorded = fixture.getRecorded()
    expect(recorded?.unexpected).toEqual(['load_workspace_dependencies'])
    expect(recorded?.missing).toEqual([])
    expect(recorded?.visible).toContain('load_workspace_dependencies')
    expect(recorded?.visible).toContain('ppt_outline')
    expect(fixture.getWarnings().join(' | ')).toContain('load_workspace_dependencies')
  })

  it('reports an unexpected tool inherited at apply() time and still denies it', () => {
    const fixture = toolContext([...PPT_NATIVE_TOOL_NAMES, 'glob', 'ssh_exec'])
    applyTools(fixture.context as never)

    // The preset still locks down what it inherited, but reports the divergence
    // as a diagnostic instead of failing to mount.
    expect(fixture.getDenied()).toEqual(['glob', 'ssh_exec'])
    const recorded = fixture.getRecorded()
    expect(recorded?.visible ?? []).not.toContain('ssh_exec')
    expect(recorded?.missing).toEqual([])
    expect(recorded?.unexpected).toEqual([])
  })

  it('skips the audit without throwing when the context carries no scope', async () => {
    const fixture = toolContext([...PPT_NATIVE_TOOL_NAMES, 'glob'], { scoped: false, logger: false })
    expect(() => applyTools(fixture.context as never)).not.toThrow()
    const escaping = captureEscapingExceptions()
    try {
      fixture.triggerToolChange()
      await settleMicrotasks()
    } finally {
      escaping.stop()
    }
    expect(escaping.captured).toEqual([])
    expect(fixture.getRecorded()).toBeUndefined()
  })

  it('contains an error raised inside the audit instead of letting it abort the mount', async () => {
    // The audit runs once synchronously while the effect starts and again from a
    // queued microtask. Both call sites share one contract: nothing the audit
    // throws may reach the host's uncaught-exception path, because DSH answers an
    // escaping exception by disposing the root cordis fiber, which kills the
    // application mid-boot. The deferred call was guarded first; the synchronous
    // bootstrap call used to be the hole that could still take the host down.
    const fixture = toolContext(undefined, { runtimeThrows: true })
    expect(() => applyTools(fixture.context as never)).not.toThrow()

    const escaping = captureEscapingExceptions()
    try {
      fixture.triggerToolChange()
      await settleMicrotasks()
    } finally {
      escaping.stop()
    }

    expect(escaping.captured).toEqual([])
    expect(fixture.getWarnings().join(' | ')).toContain('ppt runtime is not usable')
    // A failed audit records nothing instead of publishing a partial surface.
    expect(fixture.getRecorded()).toBeUndefined()
  })

  it('mounts when the reserved PTC transport is part of the inherited surface', () => {
    // A host started with DSH_TOOLS_MODE=ptc|both has `run_code` synthesized
    // into every mode-aware view. The registry refuses any restriction that
    // names it, so an unfiltered snapshot would turn that host mode into a
    // mount-time failure; the preset must skip it and keep denying the rest.
    const fixture = toolContext([...PPT_NATIVE_TOOL_NAMES, 'glob', 'run_code'])
    expect(() => applyTools(fixture.context as never)).not.toThrow()

    expect(fixture.getDenied()).toEqual(['glob'])
    const recorded = fixture.getRecorded()
    expect(recorded?.visible).toContain('run_code')
    // The transport is the host's own presentation, not another plugin's tool.
    expect(recorded?.unexpected ?? []).not.toContain('run_code')
    expect(fixture.getWarnings().join(' | ')).not.toContain('run_code')
  })

  it('never lets the reporter itself become the failure it reports', async () => {
    // warn() is called from the audit's catch handler, so a logger that throws
    // while its fiber unwinds would escape exactly where the guard cannot
    // follow -- the same uncaught-exception path that killed the host.
    const fixture = toolContext(undefined, { scoped: false, loggerThrows: true })
    const fallback = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => applyTools(fixture.context as never)).not.toThrow()

      const escaping = captureEscapingExceptions()
      try {
        fixture.triggerToolChange()
        await settleMicrotasks()
      } finally {
        escaping.stop()
      }

      expect(escaping.captured).toEqual([])
      expect(fixture.getWarnings()).toEqual([])
      expect(fallback.mock.calls.flat().join(' | ')).toContain('tool-surface audit')
    } finally {
      fallback.mockRestore()
    }
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
