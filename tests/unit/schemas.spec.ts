import { describe, expect, it } from 'vitest'
import {
  PPT_CORE_TOOL_NAMES, PPT_MODE_TOOL_NAMES, PPT_NATIVE_TOOL_NAMES, PPT_OFFICE_TOOL_NAMES, PPT_TOOL_NAMES,
} from '../../src/schemas.ts'

describe('tool surface constants', () => {
  it('keeps the office lane disjoint from the core surface', () => {
    // A duplicate would be counted twice in the `n/7` lane report and, on a host
    // without an office bundle, would make `available` true on its own.
    const core = new Set<string>([...PPT_CORE_TOOL_NAMES, ...PPT_NATIVE_TOOL_NAMES, ...PPT_TOOL_NAMES])
    const overlap = PPT_OFFICE_TOOL_NAMES.filter(name => core.has(name))
    expect(overlap).toEqual([])
    expect(new Set(PPT_MODE_TOOL_NAMES).size).toBe(PPT_MODE_TOOL_NAMES.length)
  })

  it('composes the allowed surface from the required core plus the office lane', () => {
    expect(PPT_CORE_TOOL_NAMES).toHaveLength(21)
    expect(PPT_OFFICE_TOOL_NAMES).toHaveLength(7)
    expect(PPT_MODE_TOOL_NAMES).toEqual([...PPT_CORE_TOOL_NAMES, ...PPT_OFFICE_TOOL_NAMES].sort())
    expect([...PPT_MODE_TOOL_NAMES].sort()).toEqual(PPT_MODE_TOOL_NAMES)
  })

  it('names the office lane exactly as dsh-office-tools registers it', () => {
    expect([...PPT_OFFICE_TOOL_NAMES]).toEqual([
      'excel_create', 'excel_read', 'excel_update', 'ppt_read',
      'word_create', 'word_read', 'word_update',
    ])
  })
})
