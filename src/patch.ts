/**
 * Per-page repackaging for the deterministic lanes.
 *
 * Why this exists: `ppt_create` renders the whole deck, so a one-word change on
 * page 4 used to mean re-laying out every page — and rewriting bytes for pages
 * nobody touched, including any hand edit made in PowerPoint afterwards. This
 * module keeps that from happening. The caller rebuilds a *reference* deck from
 * the edited outline (cheap: the fast lane is deterministic), and only the named
 * pages are spliced into the existing package:
 *
 *   ppt/slides/slideN.xml            replaced
 *   ppt/slides/_rels/slideN.xml.rels replaced (media targets re-pointed)
 *   ppt/notesSlides/notesSlideN.xml  replaced
 *   ppt/media/*                      added when new, reused by content hash,
 *                                    pruned when nothing references them
 *
 * Every other part — every unpatched slide above all — keeps its exact bytes.
 * That is the property the tests assert and the property a reviewer wants: a
 * page patch that silently rewrote page 1 would be worse than a full rebuild.
 *
 * Limits are deliberate. Pages cannot be added, removed, or reordered here: the
 * slide-count and part-shape checks below reject that and the caller falls back
 * to a full rebuild. Notes parts must participate in both packages for the same
 * reason — a package whose notes layout differs is not the same template.
 */
import { createHash } from 'node:crypto'
import { strFromU8, strToU8 } from 'fflate'
import { PptError } from './errors.ts'
import { readEntryBytes, readZipDirectory, rewriteZip, type ZipDirectory } from './zip.ts'

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/u
const MEDIA_PART = /^ppt\/media\/([^/]+)$/u
const MEDIA_TARGET = /((?:\.\.\/)+media\/)([^"']+)/gu
const MEDIA_NAME = /^ppt\/media\/image(\d+)\.[a-z0-9]+$/iu

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  emf: 'image/x-emf', wmf: 'image/x-wmf',
}

export interface PptxPageDigest {
  page: number
  before: string
  after: string
}

export interface PptxPatchReport {
  updated_pages: number[]
  unchanged_pages: number[]
  media: { added: string[]; reused: number; pruned: string[] }
  notes_replaced: number[]
  /** SHA-256 of each patched slide part before and after the splice. */
  slide_digests: PptxPageDigest[]
}

export interface SpliceResult {
  bytes: Uint8Array
  report: PptxPatchReport
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function slidePages(directory: ZipDirectory): number[] {
  return directory.entries
    .map(entry => SLIDE_PART.exec(entry.name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right)
}

/** Declared `Default Extension=` values in `[Content_Types].xml`. */
function declaredExtensions(xml: string): Set<string> {
  const extensions = new Set<string>()
  for (const match of xml.matchAll(/<Default\b[^>]*\bExtension="([^"]+)"/gu)) extensions.add(match[1]!.toLowerCase())
  return extensions
}

function withDefaultExtension(xml: string, extensions: readonly string[]): string {
  const declared = declaredExtensions(xml)
  const missing = extensions.filter(extension => !declared.has(extension) && MIME_BY_EXTENSION[extension] !== undefined)
  if (missing.length === 0) return xml
  const added = missing.map(extension => `<Default Extension="${extension}" ContentType="${MIME_BY_EXTENSION[extension]}"/>`).join('')
  return xml.replace('</Types>', `${added}</Types>`)
}

/**
 * Replace the named pages of `target` with the same pages from `reference`.
 * Both packages must already be valid decks with the same slide count.
 *
 * Throws `PPT_UPDATE_PATCH_UNAVAILABLE` when the packages are not comparable
 * part-for-part; the caller is expected to fall back to a full rebuild rather
 * than guess.
 */
export function splicePptxPages(target: Uint8Array, reference: Uint8Array, pages: readonly number[]): SpliceResult {
  const wanted = [...new Set(pages)].sort((left, right) => left - right)
  if (wanted.length === 0) throw new PptError('PPT_UPDATE_INPUT_INVALID', 'pages must name at least one page to update')
  for (const page of wanted) {
    if (!Number.isInteger(page) || page < 1) throw new PptError('PPT_UPDATE_INPUT_INVALID', `page must be a positive integer: ${String(page)}`)
  }

  const targetDirectory = readZipDirectory(target)
  const referenceDirectory = readZipDirectory(reference)
  const targetEntries = new Map(targetDirectory.entries.map(entry => [entry.name, entry]))
  const referenceEntries = new Map(referenceDirectory.entries.map(entry => [entry.name, entry]))

  const targetPages = slidePages(targetDirectory)
  const referencePages = slidePages(referenceDirectory)
  if (targetPages.length !== referencePages.length) {
    throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `the deck has ${targetPages.length} pages but the rebuilt deck has ${referencePages.length}`)
  }
  for (const page of wanted) {
    if (!targetPages.includes(page)) {
      throw new PptError('PPT_UPDATE_INPUT_INVALID', `page ${page} is out of range 1..${targetPages.length}`)
    }
  }

  // Content-hash index of the media already in the deck: an image that already
  // ships in another page is re-pointed, never duplicated.
  const mediaByHash = new Map<string, string>()
  for (const entry of targetDirectory.entries) {
    const media = MEDIA_PART.exec(entry.name)
    if (media === null) continue
    const hash = digest(readEntryBytes(entry, target))
    if (!mediaByHash.has(hash)) mediaByHash.set(hash, media[1]!)
  }
  let nextMedia = 1
  for (const name of targetEntries.keys()) {
    const match = MEDIA_NAME.exec(name)
    if (match !== null) nextMedia = Math.max(nextMedia, Number(match[1]) + 1)
  }

  const additions = new Map<string, Uint8Array>()
  const replacements = new Map<string, Uint8Array | null>()
  const slideDigests: PptxPageDigest[] = []
  const notesReplaced: number[] = []
  const mediaAdded: string[] = []
  const addedExtensions = new Set<string>()
  let mediaReused = 0

  for (const page of wanted) {
    const slideName = `ppt/slides/slide${page}.xml`
    const targetSlide = targetEntries.get(slideName)
    const referenceSlide = referenceEntries.get(slideName)
    if (targetSlide === undefined) throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `${slideName} is missing from the deck`)
    if (referenceSlide === undefined) throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `${slideName} is missing from the rebuilt deck`)
    const nextSlide = readEntryBytes(referenceSlide, reference)
    replacements.set(slideName, nextSlide)
    slideDigests.push({ page, before: digest(readEntryBytes(targetSlide, target)), after: digest(nextSlide) })

    const relsName = `ppt/slides/_rels/slide${page}.xml.rels`
    const targetRels = targetEntries.get(relsName)
    const referenceRels = referenceEntries.get(relsName)
    if (referenceRels === undefined) {
      if (targetRels !== undefined) replacements.set(relsName, null)
    } else {
      const rewritten = strFromU8(readEntryBytes(referenceRels, reference)).replace(
        MEDIA_TARGET,
        (whole, prefix: string, fileName: string) => {
          const entry = referenceEntries.get(`ppt/media/${fileName}`)
          if (entry === undefined) {
            throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `the rebuilt deck references a media part it does not ship: ${fileName}`)
          }
          const bytes = readEntryBytes(entry, reference)
          const hash = digest(bytes)
          const existing = mediaByHash.get(hash)
          if (existing !== undefined) {
            mediaReused += 1
            return `${prefix}${existing}`
          }
          const extension = (/\.[a-z0-9]+$/iu.exec(fileName)?.[0] ?? '.png').slice(1).toLowerCase()
          const added = `image${nextMedia}.${extension}`
          nextMedia += 1
          additions.set(`ppt/media/${added}`, bytes)
          mediaAdded.push(added)
          addedExtensions.add(extension)
          mediaByHash.set(hash, added)
          return `${prefix}${added}`
        },
      )
      replacements.set(relsName, strToU8(rewritten))
    }

    const notesName = `ppt/notesSlides/notesSlide${page}.xml`
    const targetNotes = targetEntries.get(notesName)
    const referenceNotes = referenceEntries.get(notesName)
    if (referenceNotes === undefined) {
      if (targetNotes !== undefined) {
        throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `${notesName} exists in the deck but not in the rebuilt deck`)
      }
    } else {
      if (targetNotes === undefined) {
        throw new PptError('PPT_UPDATE_PATCH_UNAVAILABLE', `${notesName} exists in the rebuilt deck but not in the deck`)
      }
      replacements.set(notesName, readEntryBytes(referenceNotes, reference))
      const notesRelsName = `ppt/notesSlides/_rels/notesSlide${page}.xml.rels`
      const referenceNotesRels = referenceEntries.get(notesRelsName)
      if (referenceNotesRels !== undefined && targetEntries.has(notesRelsName)) {
        replacements.set(notesRelsName, readEntryBytes(referenceNotesRels, reference))
      }
      notesReplaced.push(page)
    }
  }

  // Which media survive: everything some relationship still points at after the
  // swap, plus everything we are about to add.
  const referenced = new Set<string>()
  for (const entry of targetDirectory.entries) {
    if (!entry.name.endsWith('.rels')) continue
    const replacement = replacements.get(entry.name)
    if (replacement === null) continue
    const xml = replacement === undefined ? strFromU8(readEntryBytes(entry, target)) : strFromU8(replacement)
    for (const match of xml.matchAll(MEDIA_TARGET)) referenced.add(match[2]!)
  }
  const pruned: string[] = []
  const prunedNames = new Set<string>()
  for (const entry of targetDirectory.entries) {
    const media = MEDIA_PART.exec(entry.name)
    if (media === null) continue
    if (referenced.has(media[1]!)) continue
    pruned.push(media[1]!)
    prunedNames.add(entry.name)
  }

  const contentTypes = targetEntries.get('[Content_Types].xml')
  const contentTypesPatch = contentTypes === undefined || addedExtensions.size === 0
    ? undefined
    : withDefaultExtension(strFromU8(readEntryBytes(contentTypes, target)), [...addedExtensions])
  if (contentTypesPatch !== undefined && contentTypesPatch !== strFromU8(readEntryBytes(contentTypes!, target))) {
    replacements.set('[Content_Types].xml', strToU8(contentTypesPatch))
  }

  const bytes = rewriteZip(target, {
    transform: (name) => {
      if (prunedNames.has(name)) return null
      const replacement = replacements.get(name)
      if (replacement !== undefined) return replacement
      return undefined
    },
    ...(additions.size === 0 ? {} : { additions }),
  })

  return {
    bytes,
    report: {
      updated_pages: wanted,
      unchanged_pages: targetPages.filter(page => !wanted.includes(page)),
      media: { added: mediaAdded, reused: mediaReused, pruned },
      notes_replaced: notesReplaced,
      slide_digests: slideDigests,
    },
  }
}

/** Slide numbers present in a deck package; used to sanity-check the outline. */
export function deckPageCount(bytes: Uint8Array): number {
  return slidePages(readZipDirectory(bytes)).length
}
