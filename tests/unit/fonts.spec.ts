import { describe, expect, it } from 'vitest'
import {
  buildFontCatalog, FONT_REGISTRY, fontFallbackCandidates, registeredFont, resolveRegisteredFont, summarizeFontAvailability,
  type DiscoveredFont,
} from '../../src/fonts.ts'

function discovered(name: string, characters: string): DiscoveredFont {
  const codePoints = new Set([...characters].map(character => character.codePointAt(0)!))
  return {
    name, file: `/fonts/${name}.ttf`, sha256: 'a'.repeat(64), familyName: name, postscriptName: null,
    weight: 'Regular', glyphCount: codePoints.size,
    supportsLatin: [...'AaZz09'].every(character => codePoints.has(character.codePointAt(0)!)),
    supportsCjk: [...'中文'].every(character => codePoints.has(character.codePointAt(0)!)), codePoints,
  }
}

describe('cross-platform font governance', () => {
  it('registers portable, native, Linux-compatible, and custom layers with safe aliases', () => {
    expect(new Set(FONT_REGISTRY.map(font => font.layer))).toEqual(new Set(['portable', 'system', 'custom']))
    expect(registeredFont('ArialMT')?.name).toBe('Arial')
    expect(registeredFont('Microsoft YaHei UI')?.name).toBe('Microsoft YaHei')
    expect(registeredFont('NotoSansSC')?.name).toBe('Noto Sans SC')
  })

  it('uses deterministic CJK fallbacks for macOS, Windows, and Linux', () => {
    const text = '中文'
    expect(resolveRegisteredFont('MiSans', text, [discovered('PingFang SC', text)], 'darwin'))
      .toMatchObject({ fallback: true, resolved: { name: 'PingFang SC' } })
    expect(resolveRegisteredFont('MiSans', text, [discovered('Microsoft YaHei', text)], 'win32'))
      .toMatchObject({ fallback: true, resolved: { name: 'Microsoft YaHei' } })
    expect(resolveRegisteredFont('MiSans', text, [discovered('Noto Sans CJK SC', text)], 'linux'))
      .toMatchObject({ fallback: true, resolved: { name: 'Noto Sans CJK SC' } })
    expect(fontFallbackCandidates('MiSans', text, 'darwin')).toContain('PingFang SC')
  })

  it('reports only the approved registry subset and separates layers and roles', () => {
    const summary = summarizeFontAvailability([
      discovered('Arial', 'AaZz09'), discovered('PingFang SC', 'AaZz09中文'), discovered('Liter', 'AaZz09'),
    ], 'darwin')
    expect(summary).toMatchObject({ scope: 'approved_registry', platform: 'darwin', availableFamilies: 3, availableFaces: 3 })
    expect(summary.layers.portable.families).toContain('Arial')
    expect(summary.layers.system.families).toContain('PingFang SC')
    expect(summary.layers.custom.families).toContain('Liter')
    expect(summary.roles['cjk-sans']).toMatchObject({ available: true })
  })

  it('builds a bounded model catalog filtered by text, role, and installation state', () => {
    const catalog = buildFontCatalog([
      discovered('Arial', 'AaZz09'), discovered('PingFang SC', 'AaZz09中文'),
    ], { platform: 'darwin', text: '中文', role: 'cjk-sans' })
    expect(catalog).toMatchObject({
      scope: 'approved_registry', platform: 'darwin', available_families: 2, returned_families: 1,
      filters: { role: 'cjk-sans', layer: 'all', include_unavailable: false, text: '中文' },
    })
    expect(catalog.recommendations['cjk-sans']).toEqual(['PingFang SC'])
    expect(catalog.fonts).toEqual([
      expect.objectContaining({ name: 'PingFang SC', installed: true, covers_text: true, supports_cjk: true }),
    ])
    expect(JSON.stringify(catalog.fonts)).not.toContain('/fonts/')
    expect(JSON.stringify(catalog.fonts)).not.toContain('sha256')

    const unavailable = buildFontCatalog([], { platform: 'win32', layer: 'system', includeUnavailable: true })
    expect(unavailable.fonts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Microsoft YaHei', installed: false }),
    ]))
  })
})
