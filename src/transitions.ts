import { decompressSync, deflateSync, strFromU8, strToU8 } from 'fflate'
import { PptError, asPptError } from './errors.ts'

/**
 * Slide transitions live outside the pptxgenjs feature set, so a deck opts in by
 * declaring a per-page plan and letting the PPTX writer rewrite only the slide XML
 * parts after pptxgenjs produced the package. Every other zip entry is copied
 * verbatim so the result stays byte-comparable with the untouched archive.
 */

export const SLIDE_TRANSITION_TYPES = ['cut', 'fade', 'dissolve', 'push', 'wipe', 'cover', 'pull'] as const
export type SlideTransitionType = typeof SLIDE_TRANSITION_TYPES[number]

export const SLIDE_TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'] as const
export type SlideTransitionDirection = typeof SLIDE_TRANSITION_DIRECTIONS[number]

export const SLIDE_TRANSITION_SPEEDS = ['slow', 'med', 'fast'] as const
export type SlideTransitionSpeed = typeof SLIDE_TRANSITION_SPEEDS[number]

export interface SlideTransition {
  type: SlideTransitionType
  direction?: SlideTransitionDirection
  speed?: SlideTransitionSpeed
  advanceAfterMs?: number
  advanceOnClick?: boolean
}

export interface SlideRhythmPage {
  page: number
  type: string
}

export type SlideTransitionPlan = ReadonlyMap<number, SlideTransition>

export interface ZipEntryInfo {
  name: string
  method: number
  compressed_size: number
  uncompressed_size: number
  local_header_offset: number
}

const PRESENTATION_NAMESPACE = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/u
const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_FLAG_ENCRYPTED = 0x1
const ZIP_FLAG_DESCRIPTOR = 0x8
const ZIP_METHOD_STORE = 0
const ZIP_METHOD_DEFLATE = 8
const ZIP64_SENTINEL = 0xffffffff
const DIRECTIONAL_TYPES: readonly SlideTransitionType[] = ['push', 'wipe', 'cover', 'pull']
const DIRECTION_ATTRIBUTES: Record<SlideTransitionDirection, string> = { left: 'l', right: 'r', up: 'u', down: 'd' }

/** Default rhythm: one transition family per slide role so pacing reads as authored, not uniform. */
const SLIDE_RHYTHM = new Map<string, SlideTransition>([
  ['cover', { type: 'fade', speed: 'slow' }],
  ['agenda', { type: 'push', direction: 'left', speed: 'fast' }],
  ['section', { type: 'cover', direction: 'left', speed: 'med' }],
  ['content', { type: 'dissolve', speed: 'med' }],
  ['comparison', { type: 'wipe', direction: 'left', speed: 'med' }],
  ['timeline', { type: 'cover', direction: 'up', speed: 'med' }],
  ['process', { type: 'push', direction: 'up', speed: 'med' }],
  ['data', { type: 'wipe', direction: 'right', speed: 'med' }],
  ['quote', { type: 'dissolve', speed: 'slow' }],
  ['summary', { type: 'fade', speed: 'med' }],
  ['ending', { type: 'fade', speed: 'slow' }],
])
const DEFAULT_RHYTHM: SlideTransition = { type: 'dissolve', speed: 'med' }

export function isSlideTransitionType(value: string): value is SlideTransitionType {
  return (SLIDE_TRANSITION_TYPES as readonly string[]).includes(value)
}

export function normalizeSlideTransition(transition: SlideTransition): SlideTransition {
  const type: string = transition.type
  if (!isSlideTransitionType(type)) {
    throw new PptError('PPT_CREATE_INPUT_INVALID', `unsupported slide transition type: ${type}`, {
      details: { supported: [...SLIDE_TRANSITION_TYPES] },
    })
  }
  if (transition.direction !== undefined) {
    if (!DIRECTIONAL_TYPES.includes(type)) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `slide transition ${type} does not accept a direction`)
    }
    if (!(SLIDE_TRANSITION_DIRECTIONS as readonly string[]).includes(transition.direction)) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `unsupported slide transition direction: ${String(transition.direction)}`)
    }
  }
  if (transition.speed !== undefined && !(SLIDE_TRANSITION_SPEEDS as readonly string[]).includes(transition.speed)) {
    throw new PptError('PPT_CREATE_INPUT_INVALID', `unsupported slide transition speed: ${String(transition.speed)}`)
  }
  if (transition.advanceAfterMs !== undefined && (!Number.isInteger(transition.advanceAfterMs) || transition.advanceAfterMs <= 0)) {
    throw new PptError('PPT_CREATE_INPUT_INVALID', `slide transition advanceAfterMs must be a positive integer: ${String(transition.advanceAfterMs)}`)
  }
  if (transition.advanceOnClick !== undefined && transition.advanceOnClick !== false) {
    throw new PptError('PPT_CREATE_INPUT_INVALID', 'slide transition advanceOnClick may only be set to false')
  }
  const normalized: SlideTransition = { type }
  if (transition.direction !== undefined) normalized.direction = transition.direction
  if (transition.speed !== undefined) normalized.speed = transition.speed
  if (transition.advanceAfterMs !== undefined) normalized.advanceAfterMs = transition.advanceAfterMs
  if (transition.advanceOnClick === false) normalized.advanceOnClick = false
  return normalized
}

export function transitionElementXml(transition: SlideTransition): string {
  const normalized = normalizeSlideTransition(transition)
  const attributes: string[] = []
  if (normalized.advanceOnClick === false) attributes.push('advClick="0"')
  if (normalized.advanceAfterMs !== undefined) attributes.push(`advTm="${normalized.advanceAfterMs}"`)
  if (normalized.speed !== undefined && normalized.type !== 'cut') attributes.push(`spd="${normalized.speed}"`)
  const direction = DIRECTIONAL_TYPES.includes(normalized.type) && normalized.direction !== undefined
    ? ` dir="${DIRECTION_ATTRIBUTES[normalized.direction]}"`
    : ''
  const open = attributes.length === 0 ? '<p:transition>' : `<p:transition ${attributes.join(' ')}>`
  return `${open}<p:${normalized.type}${direction}/></p:transition>`
}

function elementEndOffset(body: string, name: string): number {
  const match = new RegExp(`<${name}\\b[^>]*?(/?)>`, 'u').exec(body)
  if (match === null) return -1
  if (match[1] === '/') return match.index + match[0].length
  const close = body.indexOf(`</${name}>`, match.index + match[0].length)
  if (close < 0) throw new PptError('PPT_CREATE_INVALID_PACKAGE', `slide XML has an unterminated ${name} element`)
  return close + name.length + 3
}

/** CT_Slide order is cSld, clrMapOvr, transition, timing, extLst. */
function transitionInsertionOffset(body: string): number {
  const csldEnd = elementEndOffset(body, 'p:cSld')
  if (csldEnd < 0) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has no p:cSld element')
  const clrMapEnd = elementEndOffset(body, 'p:clrMapOvr')
  return clrMapEnd >= csldEnd ? clrMapEnd : csldEnd
}

export function injectSlideTransition(xml: string, transition: SlideTransition): string {
  const element = transitionElementXml(transition)
  const root = /<p:sld\b[^>]*>/u.exec(xml)
  if (root === null) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML does not contain a p:sld root element')
  const bodyStart = root.index + root[0].length
  const bodyEnd = xml.lastIndexOf('</p:sld>')
  if (bodyEnd < bodyStart) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML has an unterminated p:sld root element')
  const body = xml.slice(bodyStart, bodyEnd)
  if (/<p:transition\b/u.test(body)) {
    throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'slide XML already declares a p:transition element')
  }
  const payload = /xmlns:p=/u.test(root[0]) ? element : element.replace('<p:transition', `<p:transition xmlns:p="${PRESENTATION_NAMESPACE}"`)
  const at = bodyStart + transitionInsertionOffset(body)
  return `${xml.slice(0, at)}${payload}${xml.slice(at)}`
}

export function planSlideTransitions(pages: readonly SlideRhythmPage[]): SlideTransitionPlan {
  const plan = new Map<number, SlideTransition>()
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page < 1) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `slide transition page must be a positive integer: ${String(page.page)}`)
    }
    plan.set(page.page, { ...(SLIDE_RHYTHM.get(page.type) ?? DEFAULT_RHYTHM) })
  }
  return plan
}

const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    value = (value >>> 8) ^ CRC32_TABLE[(value ^ data[index]!) & 0xff]!
  }
  return (value ^ 0xffffffff) >>> 0
}

interface ZipEntry extends ZipEntryInfo {
  flags: number
  version_needed: number
  time: number
  date: number
  crc: number
  local_extra: Uint8Array
  data_offset: number
  header: Uint8Array
  central: Uint8Array
}

interface ZipDirectory {
  entries: ZipEntry[]
  comment: Uint8Array
}

function findEndOfCentralDirectory(view: DataView, length: number): number {
  if (length < 22) throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX is not a readable ZIP package')
  for (let offset = length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_SIGNATURE) continue
    if (offset + 22 + view.getUint16(offset + 20, true) === length) return offset
  }
  throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX is not a readable ZIP package: end of central directory is missing')
}

function readZipDirectory(data: Uint8Array): ZipDirectory {
  try {
    return parseZipDirectory(data)
  } catch (error) {
    throw asPptError(error, 'PPT_CREATE_INVALID_PACKAGE', 'PPTX zip directory is not readable')
  }
}

function parseZipDirectory(data: Uint8Array): ZipDirectory {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const end = findEndOfCentralDirectory(view, data.byteLength)
  const count = view.getUint16(end + 10, true)
  const comment = data.slice(end + 22, end + 22 + view.getUint16(end + 20, true))
  const entries: ZipEntry[] = []
  let cursor = view.getUint32(end + 16, true)
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX zip central directory is malformed')
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const entryCommentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const centralSize = 46 + nameLength + extraLength + entryCommentLength
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0 || (flags & ZIP_FLAG_DESCRIPTOR) !== 0) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX zip entries with encryption or data descriptors are unsupported')
    }
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX zip64 archives are unsupported')
    }
    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new PptError('PPT_CREATE_INVALID_PACKAGE', 'PPTX zip local header is malformed')
    }
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    entries.push({
      name: strFromU8(data.subarray(cursor + 46, cursor + 46 + nameLength)),
      method,
      compressed_size: compressedSize,
      uncompressed_size: uncompressedSize,
      local_header_offset: localOffset,
      flags,
      version_needed: view.getUint16(cursor + 6, true),
      time: view.getUint16(cursor + 12, true),
      date: view.getUint16(cursor + 14, true),
      crc,
      local_extra: data.slice(localOffset + 30 + localNameLength, dataOffset),
      data_offset: dataOffset,
      header: data.slice(localOffset, dataOffset + compressedSize),
      central: data.slice(cursor, cursor + centralSize),
    })
    cursor += centralSize
  }
  return { entries, comment }
}

export function inspectZipEntries(data: Uint8Array): ZipEntryInfo[] {
  return readZipDirectory(data).entries.map(entry => ({
    name: entry.name,
    method: entry.method,
    compressed_size: entry.compressed_size,
    uncompressed_size: entry.uncompressed_size,
    local_header_offset: entry.local_header_offset,
  }))
}

function entryBytes(entry: ZipEntry, data: Uint8Array): Uint8Array {
  const raw = data.subarray(entry.data_offset, entry.data_offset + entry.compressed_size)
  if (entry.method === ZIP_METHOD_STORE) return raw.slice()
  if (entry.method !== ZIP_METHOD_DEFLATE) {
    throw new PptError('PPT_CREATE_INVALID_PACKAGE', `unsupported zip compression method ${entry.method} for ${entry.name}`)
  }
  try {
    // fflate auto-detects gzip, zlib, and raw DEFLATE, so a deflated zip entry needs no format option.
    return decompressSync(raw)
  } catch (error) {
    throw new PptError('PPT_CREATE_INVALID_PACKAGE', `zip entry is not readable: ${entry.name}`, { cause: error })
  }
}

function rebuildLocalEntry(entry: ZipEntry, contents: Uint8Array): { header: Uint8Array; crc: number; compressed_size: number; uncompressed_size: number } {
  const name = strToU8(entry.name)
  const payload = entry.method === ZIP_METHOD_DEFLATE ? deflateSync(contents, { level: 6 }) : contents.slice()
  const crc = crc32(contents)
  const header = new Uint8Array(30 + name.byteLength + entry.local_extra.byteLength + payload.byteLength)
  const view = new DataView(header.buffer)
  view.setUint32(0, ZIP_LOCAL_SIGNATURE, true)
  view.setUint16(4, Math.max(entry.version_needed, 20), true)
  view.setUint16(6, entry.flags, true)
  view.setUint16(8, entry.method, true)
  view.setUint16(10, entry.time, true)
  view.setUint16(12, entry.date, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, payload.byteLength, true)
  view.setUint32(22, contents.byteLength, true)
  view.setUint16(26, name.byteLength, true)
  view.setUint16(28, entry.local_extra.byteLength, true)
  header.set(name, 30)
  header.set(entry.local_extra, 30 + name.byteLength)
  header.set(payload, 30 + name.byteLength + entry.local_extra.byteLength)
  return { header, crc, compressed_size: payload.byteLength, uncompressed_size: contents.byteLength }
}

function patchCentralEntry(entry: ZipEntry, offset: number, crc: number, compressedSize: number, uncompressedSize: number): Uint8Array {
  const central = entry.central.slice()
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength)
  view.setUint32(16, crc, true)
  view.setUint32(20, compressedSize, true)
  view.setUint32(24, uncompressedSize, true)
  view.setUint32(42, offset, true)
  return central
}

export function rewritePptxTransitions(data: Uint8Array, plan: SlideTransitionPlan): Uint8Array {
  if (plan.size === 0) return data
  const directory = readZipDirectory(data)
  const targets = new Map<number, SlideTransition>()
  for (const [page, transition] of plan) {
    if (!Number.isInteger(page) || page < 1) {
      throw new PptError('PPT_CREATE_INPUT_INVALID', `slide transition page must be a positive integer: ${String(page)}`)
    }
    targets.set(page, transition)
  }
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  const injected = new Set<number>()
  let offset = 0
  for (const entry of directory.entries) {
    const match = SLIDE_PART.exec(entry.name)
    const page = match === null ? undefined : Number(match[1])
    const transition = page === undefined ? undefined : targets.get(page)
    let header = entry.header
    let crc = entry.crc
    let compressedSize = entry.compressed_size
    let uncompressedSize = entry.uncompressed_size
    if (page !== undefined && transition !== undefined) {
      injected.add(page)
      const rebuilt = rebuildLocalEntry(entry, strToU8(injectSlideTransition(strFromU8(entryBytes(entry, data)), transition)))
      header = rebuilt.header
      crc = rebuilt.crc
      compressedSize = rebuilt.compressed_size
      uncompressedSize = rebuilt.uncompressed_size
    }
    locals.push(header)
    centrals.push(patchCentralEntry(entry, offset, crc, compressedSize, uncompressedSize))
    offset += header.byteLength
  }
  for (const page of targets.keys()) {
    if (!injected.has(page)) throw new PptError('PPT_CREATE_INPUT_INVALID', `no slide part matches transition page ${page}`)
  }
  const centralSize = centrals.reduce((total, entry) => total + entry.byteLength, 0)
  const output = new Uint8Array(offset + centralSize + 22 + directory.comment.byteLength)
  let cursor = 0
  for (const part of [...locals, ...centrals]) {
    output.set(part, cursor)
    cursor += part.byteLength
  }
  const view = new DataView(output.buffer)
  view.setUint32(cursor, ZIP_END_SIGNATURE, true)
  view.setUint16(cursor + 8, directory.entries.length, true)
  view.setUint16(cursor + 10, directory.entries.length, true)
  view.setUint32(cursor + 12, centralSize, true)
  view.setUint32(cursor + 16, offset, true)
  view.setUint16(cursor + 20, directory.comment.byteLength, true)
  output.set(directory.comment, cursor + 22)
  return output
}
