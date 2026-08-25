const SECRET_KEY = /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|cookie|set-cookie)/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&#\s]+/gi

export function redactText(value: string): string {
  return value
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(QUERY_SECRET, '$1[REDACTED]')
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item, seen))
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item, seen)
  }
  return output
}

export function safeErrorMessage(error: unknown, maxChars = 2_000): string {
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = redactText(raw)
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}…`
}
