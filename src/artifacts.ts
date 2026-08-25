import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { atomicWriteJson } from './atomic.ts'
import { PptError } from './errors.ts'
import { resolveWorkspacePath, workspaceRelative } from './paths.ts'

export interface ArtifactPaths {
  root: string
  outline: string
  designPlan: string
  html: string
  pptx: string
  assets: string
  images: string
  sourceManifest: string
  preview: string
  report: string
  visualReview: string
}

export function slugify(value: string): string {
  const slug = value.normalize('NFKC').toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'presentation'
}

export async function allocateArtifactDirectory(
  workspace: string,
  title: string,
  outputRoot = 'ppt-output',
): Promise<ArtifactPaths> {
  const resolvedOutputRoot = await resolveWorkspacePath(workspace, outputRoot, { createParent: true })
  await mkdir(resolvedOutputRoot, { recursive: true })
  const base = slugify(title)
  let root: string | undefined
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const candidate = join(resolvedOutputRoot, suffix === 1 ? base : `${base}-${suffix}`)
    try {
      await mkdir(candidate, { recursive: false })
      root = candidate
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (root === undefined) throw new PptError('PPT_OUTPUT_EXISTS', `could not allocate artifact directory for ${base}`)
  const assets = join(root, 'assets')
  const images = join(assets, 'images')
  const preview = join(root, 'preview')
  await Promise.all([mkdir(images, { recursive: true }), mkdir(preview, { recursive: true })])
  const paths: ArtifactPaths = {
    root,
    outline: join(root, 'outline.json'),
    designPlan: join(root, 'design-plan.json'),
    html: join(root, 'deck.html'),
    pptx: join(root, 'deck.pptx'),
    assets,
    images,
    sourceManifest: join(assets, 'source-manifest.json'),
    preview,
    report: join(root, 'report.json'),
    visualReview: join(root, 'visual-review.json'),
  }
  await atomicWriteJson(paths.sourceManifest, { version: 1, assets: [] })
  return paths
}

export interface SourceAssetRecord {
  original_url: string
  source_page: string
  fetched_at: string
  author: string | null
  license: string
  license_url: string | null
  local_path: string
  sha256: string
}

interface SourceManifestDocument {
  version: 1
  assets: SourceAssetRecord[]
}

export class SourceManifest {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly workspace: string, readonly path: string) {}

  append(record: Omit<SourceAssetRecord, 'local_path' | 'sha256'> & { localFile: string }): Promise<SourceAssetRecord> {
    let resolveResult!: (value: SourceAssetRecord) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<SourceAssetRecord>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    this.queue = this.queue.then(async () => {
      const localFile = await resolveWorkspacePath(this.workspace, record.localFile, { mustExist: true, kind: 'file' })
      const digest = createHash('sha256').update(await readFile(localFile)).digest('hex')
      const item: SourceAssetRecord = {
        original_url: record.original_url,
        source_page: record.source_page,
        fetched_at: record.fetched_at,
        author: record.author,
        license: record.license || 'unknown',
        license_url: record.license_url,
        local_path: workspaceRelative(dirname(this.path), localFile),
        sha256: digest,
      }
      let document: SourceManifestDocument = { version: 1, assets: [] }
      try {
        document = JSON.parse(await readFile(this.path, 'utf8')) as SourceManifestDocument
      } catch {
        // A new manifest is created below.
      }
      document.assets.push(item)
      await atomicWriteJson(this.path, document, { overwrite: true })
      resolveResult(item)
    }).catch(rejectResult)
    return result
  }
}

export async function assertFileLimit(path: string, maxBytes: number): Promise<void> {
  const file = await stat(path)
  if (!file.isFile()) throw new PptError('PPT_PATH_INVALID', `not a regular file: ${basename(path)}`)
  if (file.size > maxBytes) throw new PptError('PPT_RESOURCE_LIMIT', `${basename(path)} exceeds ${maxBytes} bytes`)
}

export function safeAssetFilename(title: string, url: URL, fallback = 'image'): string {
  const requested = basename(url.pathname)
  const extension = extname(requested).toLowerCase()
  const safeExtension = /^\.(?:png|jpe?g|webp|gif|svg)$/.test(extension) ? extension : '.img'
  return `${slugify(title || fallback).slice(0, 60)}${safeExtension}`
}
