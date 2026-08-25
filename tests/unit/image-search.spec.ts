import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { allocateArtifactDirectory } from '../../src/artifacts.ts'
import { freezeImageAsset, ImageSearchRuntime } from '../../src/image-search.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const publicUrl = async (value: string) => {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('blocked')
  if (url.hostname === '127.0.0.1') throw new Error('blocked')
  return url
}

describe('zero-configuration image search', () => {
  it('uses Openverse only on sufficient success and caches normalized results', async () => {
    const fetcher = vi.fn(async () => json({ results: [
      { url: 'https://images.example/a.jpg', foreign_landing_url: 'https://source.example/a', title: 'A', width: 1600, height: 900, license: 'cc0' },
      { url: 'https://images.example/b.jpg', foreign_landing_url: 'https://source.example/b', title: 'B', width: 1200, height: 800, license: 'by' },
    ] }))
    const runtime = new ImageSearchRuntime(fetcher, publicUrl)
    const first = await runtime.search('  Future   city  ', 2, 'landscape')
    const second = await runtime.search('Future city', 2, 'landscape')
    expect(first).toMatchObject({ cache_hit: false, providers_used: ['openverse'] })
    expect(first.results).toHaveLength(2)
    expect(first.results[0]?.license_verified).toBe(false)
    expect(second.cache_hit).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('falls back to Commons on rate limit or insufficient primary results', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.openverse.org') return json({}, 429)
      return json({ query: { pages: { 1: {
        title: 'File:Fallback.jpg', fullurl: 'https://commons.example/wiki/File:Fallback.jpg',
        imageinfo: [{ url: 'https://upload.example/fallback.jpg', thumburl: 'https://upload.example/thumb.jpg', width: 1800, height: 1000, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-SA' }, Artist: { value: '<b>Alice</b>' } } }],
      } } } })
    })
    const result = await new ImageSearchRuntime(fetcher, publicUrl).search('architecture', 1, 'landscape')
    expect(result.providers_used).toEqual(['openverse', 'wikimedia-commons'])
    expect(result.warnings).toContain('openverse:rate_limited')
    expect(result.results[0]).toMatchObject({ provider: 'wikimedia-commons', author: 'Alice' })

    const insufficientFetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.openverse.org') return json({ results: [
        { url: 'https://images.example/only.jpg', foreign_landing_url: 'https://source.example/only', title: 'Only', width: 1600, height: 900 },
      ] })
      return json({ query: { pages: { 2: {
        title: 'File:Extra.jpg', fullurl: 'https://commons.example/wiki/File:Extra.jpg',
        imageinfo: [{ url: 'https://upload.example/extra.jpg', width: 1600, height: 900, mime: 'image/jpeg', extmetadata: {} }],
      } } } })
    })
    const supplemented = await new ImageSearchRuntime(insufficientFetcher, publicUrl).search('architecture', 2, 'landscape')
    expect(supplemented.results.map(item => item.provider)).toEqual(['openverse', 'wikimedia-commons'])
  })

  it('filters dangerous, duplicate, adult, and wrong-orientation candidates and classifies double failure', async () => {
    const unsafe = new ImageSearchRuntime(async () => json({ results: [
      { url: 'data:image/png;base64,x', foreign_landing_url: 'https://source.example/a', title: 'bad' },
      { url: 'https://images.example/a.jpg', foreign_landing_url: '', title: 'missing source' },
      { url: 'https://images.example/n.jpg', foreign_landing_url: 'https://source.example/n', title: 'NSFW nude', width: 900, height: 1600 },
      { url: 'https://images.example/p.jpg', foreign_landing_url: 'https://source.example/p', title: 'Portrait', width: 900, height: 1600 },
    ] }), publicUrl)
    const filtered = await unsafe.search('safe topic', 2, 'landscape')
    expect(filtered.results).toHaveLength(0)
    expect(filtered.warnings).toContain('insufficient_results:0/2')

    const failed = new ImageSearchRuntime(async () => json({}, 503), publicUrl)
    await expect(failed.search('safe topic', 1)).rejects.toMatchObject({ code: 'IMAGE_SEARCH_FAILED' })
  })

  it('freezes a selected raster with dimensions, hash, and source record', async () => {
    const workspace = await createTestWorkspace()
    try {
      const paths = await allocateArtifactDirectory(workspace.root, 'Freeze')
      const png = await sharp({ create: { width: 64, height: 32, channels: 4, background: '#336699' } }).png().toBuffer()
      const frozen = await freezeImageAsset(workspace.root, paths.root, {
        image_url: 'https://93.184.216.34/image.png', source_page: 'https://93.184.216.34/source',
        provider: 'openverse', title: 'Frozen image', license: 'CC0', license_verified: false,
      }, async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.byteLength) } }))
      expect(frozen).toMatchObject({ width: 64, height: 32, mime_type: 'image/png' })
      const manifest = JSON.parse(await readFile(paths.sourceManifest, 'utf8')) as { assets: Array<{ sha256: string }> }
      expect(manifest.assets[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('stops streaming an image as soon as the hard byte limit is exceeded', async () => {
    const workspace = await createTestWorkspace()
    try {
      const paths = await allocateArtifactDirectory(workspace.root, 'Oversized stream')
      let chunks = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1
          controller.enqueue(new Uint8Array(1024 * 1024))
          if (chunks >= 25) controller.close()
        },
      })
      await expect(freezeImageAsset(workspace.root, paths.root, {
        image_url: 'https://93.184.216.34/image.png', source_page: 'https://93.184.216.34/source',
        provider: 'openverse', title: 'Oversized image', license: 'unknown', license_verified: false,
      }, async () => new Response(body, { status: 200 }))).rejects.toMatchObject({ code: 'PPT_RESOURCE_LIMIT' })
      expect(chunks).toBeLessThan(25)
    } finally {
      await workspace.cleanup()
    }
  })
})
