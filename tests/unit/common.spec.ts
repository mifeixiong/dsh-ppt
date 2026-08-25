import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteText } from '../../src/atomic.ts'
import { PptError } from '../../src/errors.ts'
import { resolveWorkspacePath } from '../../src/paths.ts'
import { redactText, redactValue } from '../../src/security.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'

describe('shared implementation boundaries', () => {
  it('writes a new file atomically and refuses overwrite by default', async () => {
    const workspace = await createTestWorkspace()
    try {
      const target = join(workspace.root, 'output.json')
      await atomicWriteText(target, 'first')
      await expect(atomicWriteText(target, 'second')).rejects.toMatchObject({ code: 'PPT_OUTPUT_EXISTS' })
      expect(await readFile(target, 'utf8')).toBe('first')
      await atomicWriteText(target, 'second', { overwrite: true })
      expect(await readFile(target, 'utf8')).toBe('second')
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects traversal and symlink escapes', async () => {
    const workspace = await createTestWorkspace()
    try {
      await expect(resolveWorkspacePath(workspace.root, '../escape.txt')).rejects.toBeInstanceOf(PptError)
      await writeFile(join(workspace.root, 'inside.txt'), 'ok')
      await expect(resolveWorkspacePath(workspace.root, 'inside.txt', { mustExist: true, kind: 'file' }))
        .resolves.toBe(join(workspace.root, 'inside.txt'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('redacts secrets in text and structured logs', () => {
    expect(redactText('Authorization: Bearer abc.def token=secret')).not.toContain('abc.def')
    expect(redactValue({ apiKey: 'secret', nested: { url: 'https://x.test/?token=secret' } })).toEqual({
      apiKey: '[REDACTED]',
      nested: { url: 'https://x.test/?token=[REDACTED]' },
    })
  })
})
