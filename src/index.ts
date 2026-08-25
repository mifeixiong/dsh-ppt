/** DeepSeek Harness host-plane entry for the PPT design plugin. */
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from 'schemastery'
import { atomicWriteText } from './atomic.ts'
import { PptError, PPT_ERROR_CODES, type PptErrorCode } from './errors.ts'
import { isSupportedPlatform } from './platform.ts'
import { createPptRuntime, type PptRuntime, type PptRuntimeOptions } from './runtime.ts'
import { PPT_MODE_TOOL_NAMES, PPT_TOOL_NAMES, type PptToolName } from './schemas.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pptRuntime: PptRuntime
  }
}

export { createPptRuntime, PptError, PPT_ERROR_CODES, PPT_MODE_TOOL_NAMES, PPT_TOOL_NAMES }
export type { PptErrorCode, PptRuntime, PptRuntimeOptions, PptToolName }

export const name = 'dsh-ppt'
export const inject = ['sandbox', 'subprocess']

export interface Config {
  presetId: string
  installPreset: boolean
  pythonExecutable: string
  browserExecutable: string
  fontDirs: string[]
  outputRoot: string
}

export const Config = z.object({
  presetId: z.string().pattern(/^[a-z0-9][a-z0-9-]*$/).default('ppt'),
  installPreset: z.boolean().default(true),
  pythonExecutable: z.string().default(process.platform === 'win32' ? 'python' : 'python3'),
  browserExecutable: z.string().default(''),
  fontDirs: z.array(z.string()).default([]),
  outputRoot: z.string().default('ppt-output'),
})

export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const selected = configured === undefined || configured.length === 0 ? join(homedir(), '.dsh') : configured
  return resolve(selected.startsWith('~/') ? join(homedir(), selected.slice(2)) : selected)
}

interface ManagedPresetManifest {
  package: '@yejiming/dsh-ppt'
  version: 1
  files: Record<string, string>
}

export interface PresetInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'conflict'
  targetDir: string
  conflicts: string[]
}

export interface PresetRemovalResult {
  status: 'removed' | 'absent' | 'conflict'
  targetDir: string
  conflicts: string[]
}

const MANAGED_MANIFEST = '.dsh-ppt-managed.json'
const MANAGED_FILES = ['agent.cordis.yml', 'preset.yml'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sourcePresetState(): Promise<{ sourceDir: string; contents: Record<string, string>; manifest: ManagedPresetManifest }> {
  const sourceDir = fileURLToPath(new URL('../preset/ppt/', import.meta.url))
  const contents: Record<string, string> = {}
  for (const file of MANAGED_FILES) contents[file] = await readFile(join(sourceDir, file), 'utf8')
  return {
    sourceDir,
    contents,
    manifest: {
      package: '@yejiming/dsh-ppt',
      version: 1,
      files: Object.fromEntries(Object.entries(contents).map(([file, content]) => [file, sha256(content)])),
    },
  }
}

async function readManagedManifest(targetDir: string): Promise<ManagedPresetManifest | undefined> {
  try {
    const value = JSON.parse(await readFile(join(targetDir, MANAGED_MANIFEST), 'utf8')) as ManagedPresetManifest
    if (value.package !== '@yejiming/dsh-ppt' || value.version !== 1 || typeof value.files !== 'object') return undefined
    return value
  } catch {
    return undefined
  }
}

/** Install or safely update the package-owned PPT preset without overwriting user edits. */
export async function installPreset(presetId = 'ppt', dshHome = resolveDshHome()): Promise<PresetInstallResult> {
  const targetDir = join(dshHome, '.agent-presets', presetId)
  const source = await sourcePresetState()
  try {
    await readFile(join(targetDir, 'agent.cordis.yml'), 'utf8')
  } catch {
    const temporary = `${targetDir}.install-${process.pid}-${randomUUID()}`
    await mkdir(dirname(targetDir), { recursive: true })
    try {
      await cp(source.sourceDir, temporary, { recursive: true, errorOnExist: true })
      await writeFile(join(temporary, MANAGED_MANIFEST), `${JSON.stringify(source.manifest, null, 2)}\n`, { flag: 'wx' })
      await rename(temporary, targetDir)
      return { status: 'installed', targetDir, conflicts: [] }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    }
  }

  const installed = await readManagedManifest(targetDir)
  if (installed === undefined) {
    return { status: 'conflict', targetDir, conflicts: [...MANAGED_FILES] }
  }

  const conflicts: string[] = []
  let changed = false
  for (const file of MANAGED_FILES) {
    const target = join(targetDir, file)
    let current: string
    try {
      current = await readFile(target, 'utf8')
    } catch {
      conflicts.push(file)
      continue
    }
    if (sha256(current) !== installed.files[file]) {
      conflicts.push(file)
      continue
    }
    if (current !== source.contents[file]) {
      await atomicWriteText(target, source.contents[file]!, { overwrite: true })
      changed = true
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', targetDir, conflicts }
  await atomicWriteText(join(targetDir, MANAGED_MANIFEST), `${JSON.stringify(source.manifest, null, 2)}\n`, { overwrite: true })
  return { status: changed ? 'updated' : 'unchanged', targetDir, conflicts: [] }
}

/** Remove only an unchanged package-managed preset directory; user edits are preserved. */
export async function removeManagedPreset(presetId = 'ppt', dshHome = resolveDshHome()): Promise<PresetRemovalResult> {
  const targetDir = join(dshHome, '.agent-presets', presetId)
  const manifest = await readManagedManifest(targetDir)
  if (manifest === undefined) {
    try {
      await readFile(join(targetDir, 'agent.cordis.yml'), 'utf8')
      return { status: 'conflict', targetDir, conflicts: [...MANAGED_FILES] }
    } catch {
      return { status: 'absent', targetDir, conflicts: [] }
    }
  }
  const conflicts: string[] = []
  for (const file of MANAGED_FILES) {
    try {
      if (sha256(await readFile(join(targetDir, file), 'utf8')) !== manifest.files[file]) conflicts.push(file)
    } catch {
      conflicts.push(file)
    }
  }
  if (conflicts.length > 0) return { status: 'conflict', targetDir, conflicts }
  await rm(targetDir, { recursive: true, force: true })
  return { status: 'removed', targetDir, conflicts: [] }
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!isSupportedPlatform(platform)) {
    throw new PptError('PPT_PLATFORM_UNSUPPORTED', `PPT mode supports macOS, Linux, and Windows; unsupported platform: ${platform}`)
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  assertSupportedPlatform()
  const runtime = createPptRuntime({
    context: ctx,
    pythonExecutable: config.pythonExecutable,
    browserExecutable: config.browserExecutable || undefined,
    fontDirs: config.fontDirs,
    outputRoot: config.outputRoot,
  })
  ctx.provide('pptRuntime', runtime)
  ctx.effect(() => () => runtime.dispose(), 'dsh-ppt: dispose runtime resources')

  if (config.installPreset) {
    const result = await installPreset(config.presetId)
    if (result.status === 'conflict') {
      ctx.logger.warn('dsh-ppt: preserved user-edited preset at %s; conflicts: %s', result.targetDir, result.conflicts.join(', '))
    } else {
      ctx.logger.info('dsh-ppt: preset "%s" %s at %s', config.presetId, result.status, result.targetDir)
    }
  }
}
