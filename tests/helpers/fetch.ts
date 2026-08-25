export interface FetchFixture {
  url: string | RegExp
  response: Response | (() => Response | Promise<Response>)
}

export function fixtureFetch(fixtures: readonly FetchFixture[]): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const fixture = fixtures.find(item => typeof item.url === 'string' ? item.url === url : item.url.test(url))
    if (fixture === undefined) throw new Error(`unexpected fetch: ${url}`)
    return typeof fixture.response === 'function' ? fixture.response() : fixture.response.clone()
  }
}
