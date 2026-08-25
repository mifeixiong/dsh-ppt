import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { PptError, throwIfAborted } from './errors.ts'

export interface CollectedProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface RunCollectedOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
  stdin?: string
  graceMs?: number
}

export async function runCollected(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  options: RunCollectedOptions,
): Promise<CollectedProcessResult> {
  throwIfAborted(options.signal)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new PptError('PPT_RESOURCE_LIMIT', `process timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
  const combined = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal])
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: options.cwd,
      stdio: {
        stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
        stdout: { maxBytes: options.maxOutputBytes },
        stderr: { maxBytes: options.maxOutputBytes },
      },
      graceMs: options.graceMs ?? 2_000,
      signal: combined,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      if (timeout.signal.aborted) throw timeout.signal.reason
      if (options.signal?.aborted) throwIfAborted(options.signal)
      throw error
    }
    if (timeout.signal.aborted) throw timeout.signal.reason
    if (options.signal?.aborted) throwIfAborted(options.signal)
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout?.text ?? '',
      stderr: stderr?.text ?? '',
      stdoutTruncated: stdout?.lossy ?? false,
      stderrTruncated: stderr?.lossy ?? false,
    }
  } finally {
    clearTimeout(timer)
  }
}
