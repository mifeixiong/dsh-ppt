/**
 * Load-bearing check for the office-lane merge documented in src/schemas.ts.
 *
 * Inside PPT mode this package registers its own `ppt_create`, while the host
 * composition already registered a global `ppt_create` from dsh-office-tools.
 * The merge works because DSH keeps one registration table per scope: "Scoped
 * tools shadow globals; duplicates within one layer and the reserved
 * `run_code` name fail." This spec pins that behaviour against the real
 * @deepseek-ai/dsh-tools registry, so an upgrade that turned a cross-layer
 * duplicate into a mount-time failure fails here instead of in the host.
 */
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolRegistry, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

function fixtureTool(name: string, marker: string): ToolDefinition {
  return {
    name,
    description: `${marker} ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: () => Promise.resolve(`${marker}:${name}`),
  }
}

describe('tool registry scoping probe', () => {
  it('lets a scoped registration shadow the same global name', async () => {
    const ctx = new Context()
    ctx.provide('systemPrompt', {
      tools() { return () => undefined },
      section() { return () => undefined },
    } as never)
    await ctx.plugin(ToolRegistry).await()

    // Host level: dsh-office-tools registers ppt_create globally.
    ctx.tools.register(fixtureTool('ppt_create', 'office'))
    ctx.tools.register(fixtureTool('ppt_read', 'office'))
    ctx.tools.register(fixtureTool('word_create', 'office'))

    const key = { agentPreset: 'ppt-fixture' }
    let scope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, key)
    }, { inject: ['tools'] })).await()

    // Preset level: dsh-ppt registers its own ppt_create in the agent scope.
    expect(() => scope.ctx.tools.register(fixtureTool('ppt_create', 'dsh-ppt'))).not.toThrow()

    const visible = ctx.tools.schemas(key)
    const create = visible.filter(item => item.name === 'ppt_create')
    expect(create).toHaveLength(1)
    expect(create[0]!.description).toContain('dsh-ppt')
    const read = visible.find(item => item.name === 'ppt_read')
    expect(read?.description).toContain('office')

    // And restrict() still names globals only, so denying the office pair does
    // not remove the preset's own registration.
    expect(() => scope.ctx.tools.restrict({ deny: ['ppt_read', 'word_create'] })).not.toThrow()
    const afterDeny = ctx.tools.schemas(key).map(item => item.name).sort()
    expect(afterDeny).toContain('ppt_create')
    expect(afterDeny).not.toContain('ppt_read')
    expect(afterDeny).not.toContain('word_create')
  })
})
