import { strFromU8, strToU8 } from 'fflate'
import { PptError } from './errors.ts'
import { rewriteZip } from './zip.ts'

/**
 * Low-opacity ghost text is a poster device: a large bilingual watermark sits
 * behind the headline, the way a print layout repeats a word in a lighter ink.
 * The browser carries it as a text leaf with `opacity`, but pptxgenjs has no
 * text-alpha option, so the finished package is rewritten to put an alpha value
 * on every run colour inside that named text shape. The text stays editable.
 */

export interface TextOpacityEntry {
  /** `data-ppt-id`, which is also the PPTX shape name. */
  id: string
  opacity: number
}

export type TextOpacityPlan = ReadonlyMap<number, readonly TextOpacityEntry[]>

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/u
const SHAPE = /<p:sp\b[\s\S]*?<\/p:sp>/gu
const SHAPE_NAME = /<p:cNvPr\b[^>]*\bname="([^"]*)"/u
const TEXT_BODY = /<p:txBody>[\s\S]*?<\/p:txBody>/u
const TEXT_COLOR = /<a:srgbClr\b([^>]*?)\/>/gu

function alphaValue(opacity: number): number {
  return Math.round(Math.max(0, Math.min(1, opacity)) * 100000)
}

function namedShape(xml: string, id: string): { start: number; end: number; text: string } | undefined {
  for (const match of xml.matchAll(SHAPE)) {
    if (SHAPE_NAME.exec(match[0])?.[1] !== id) continue
    return { start: match.index, end: match.index + match[0].length, text: match[0] }
  }
  return undefined
}

export function injectTextOpacity(xml: string, entries: readonly TextOpacityEntry[]): string {
  let output = xml
  for (const entry of entries) {
    const shape = namedShape(output, entry.id)
    if (shape === undefined) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', `slide XML has no text shape named ${entry.id}`)
    }
    const alpha = alphaValue(entry.opacity)
    const patched = shape.text.replace(TEXT_BODY, body => body.replace(
      TEXT_COLOR,
      (_match, attributes: string) => `<a:srgbClr${attributes}><a:alpha val="${alpha}"/></a:srgbClr>`,
    ))
    if (patched === shape.text) continue
    output = `${output.slice(0, shape.start)}${patched}${output.slice(shape.end)}`
  }
  return output
}

export function rewritePptxTextOpacity(data: Uint8Array, plan: TextOpacityPlan): Uint8Array {
  if (plan.size === 0) return data
  const targets = new Map<number, readonly TextOpacityEntry[]>()
  for (const [page, entries] of plan) {
    if (!Number.isInteger(page) || page < 1) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `text opacity page must be a positive integer: ${String(page)}`)
    }
    if (entries.length > 0) targets.set(page, entries)
  }
  if (targets.size === 0) return data
  const injected = new Set<number>()
  const output = rewriteZip(data, {
    transform: (name, read) => {
      const match = SLIDE_PART.exec(name)
      const page = match === null ? undefined : Number(match[1])
      const entries = page === undefined ? undefined : targets.get(page)
      if (page === undefined || entries === undefined) return undefined
      injected.add(page)
      return strToU8(injectTextOpacity(strFromU8(read()), entries))
    },
  })
  for (const page of targets.keys()) {
    if (!injected.has(page)) throw new PptError('PPT_CREATE_INPUT_INVALID', `no slide part matches text opacity page ${page}`)
  }
  return output
}
