import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installPreset, removeManagedPreset } from '../../src/index.ts'
import { createTestWorkspace } from '../helpers/workspace.ts'

describe('managed PPT preset installation', () => {
  it('installs idempotently and removes only unchanged managed files', async () => {
    const workspace = await createTestWorkspace()
    try {
      await expect(installPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'installed' })
      await expect(installPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'unchanged' })
      await expect(removeManagedPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'removed' })
      await expect(removeManagedPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'absent' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('preserves user-edited preset files and unrelated PPT output', async () => {
    const workspace = await createTestWorkspace()
    try {
      await installPreset('ppt', workspace.dshHome)
      const presetFile = join(workspace.dshHome, '.agent-presets', 'ppt', 'agent.cordis.yml')
      await writeFile(presetFile, `${await readFile(presetFile, 'utf8')}\n# user edit\n`)
      const output = join(workspace.root, 'ppt-output', 'kept.txt')
      await mkdir(join(workspace.root, 'ppt-output'), { recursive: true })
      await writeFile(output, 'kept')
      await expect(installPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'conflict', conflicts: ['agent.cordis.yml'] })
      await expect(removeManagedPreset('ppt', workspace.dshHome)).resolves.toMatchObject({ status: 'conflict' })
      expect(await readFile(presetFile, 'utf8')).toContain('# user edit')
      expect(await readFile(output, 'utf8')).toBe('kept')
    } finally {
      await workspace.cleanup()
    }
  })
})
