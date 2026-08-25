import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { PptError, throwIfAborted } from './errors.ts'

export interface AtomicWriteOptions {
  overwrite?: boolean
  mode?: number
  signal?: AbortSignal
}

export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  throwIfAborted(options.signal)
  const directory = dirname(target)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  let committed = false
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, options.mode ?? 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    throwIfAborted(options.signal)
    if (options.overwrite) {
      await rename(temporary, target)
    } else {
      try {
        await link(temporary, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') throw new PptError('PPT_OUTPUT_EXISTS', `output already exists: ${target}`)
        throw error
      }
      await unlink(temporary)
    }
    committed = true
  } finally {
    if (!committed) await unlink(temporary).catch(() => undefined)
  }
}

export function atomicWriteText(target: string, text: string, options?: AtomicWriteOptions): Promise<void> {
  return atomicWriteFile(target, text, options)
}

export function atomicWriteJson(target: string, value: unknown, options?: AtomicWriteOptions): Promise<void> {
  return atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`, options)
}
