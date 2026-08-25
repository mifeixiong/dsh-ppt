import { describe, expect, it } from 'vitest'
import { ImageSearchRuntime } from '../../src/image-search.ts'

describe('live anonymous image providers', () => {
  it.runIf(process.env.PPT_LIVE_IMAGE_SEARCH === '1')('returns a traceable candidate without credentials', async () => {
    const result = await new ImageSearchRuntime().search('modern presentation technology abstract', 1, 'landscape')
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      image_url: expect.stringMatching(/^https?:\/\//),
      source_page: expect.stringMatching(/^https?:\/\//),
      license_verified: false,
    })
  }, 60_000)
})
