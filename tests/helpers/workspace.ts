import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TestWorkspace {
  root: string
  dshHome: string
  cleanup(): Promise<void>
}

export async function createTestWorkspace(prefix = 'dsh-ppt-'): Promise<TestWorkspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const dshHome = join(root, '.dsh')
  await mkdir(dshHome, { recursive: true })
  return {
    root,
    dshHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
