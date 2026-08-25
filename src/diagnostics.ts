import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { access } from 'node:fs/promises'
import { discoverBrowserExecutable } from './browser-discovery.ts'
import { discoverRegisteredFonts, registeredFont, summarizeFontAvailability } from './fonts.ts'
import {
  appleScriptCandidates, isSupportedPlatform, keynoteCandidates, libreOfficeCandidates,
  pdfToPpmCandidates, powerPointCandidates, powerShellCandidates, screenCaptureCandidates,
} from './platform.ts'
import { safeErrorMessage } from './security.ts'
import { PPT_MODE_TOOL_NAMES } from './schemas.ts'
import { runCollected } from './subprocess.ts'

export type DiagnosticStatus = 'ready' | 'degraded' | 'not_available' | 'failed'

export interface DiagnosticCheck {
  id: 'platform' | 'tools' | 'browser' | 'python' | 'fonts' | 'renderer' | 'attachments' | 'vision_model'
  status: DiagnosticStatus
  message: string
  details?: Readonly<Record<string, unknown>>
}

export interface PptDiagnosticReport {
  status: 'ready' | 'degraded' | 'failed'
  checks: DiagnosticCheck[]
}

interface DiagnosticRuntime {
  options: {
    context?: Context
    pythonExecutable?: string
    browserExecutable?: string
    fontDirs?: readonly string[]
  }
  toolSurface?: { visible: readonly string[]; missing: readonly string[]; unexpected: readonly string[] }
}

async function pythonCheck(runtime: DiagnosticRuntime): Promise<DiagnosticCheck> {
  const subprocess = runtime.options.context?.get('subprocess')
  if (subprocess === undefined) return { id: 'python', status: 'failed', message: 'DSH subprocess service is unavailable' }
  try {
    const executable = await subprocess.resolveExecutable(runtime.options.pythonExecutable ?? (process.platform === 'win32' ? 'python' : 'python3'))
    const result = await runCollected(subprocess, [executable, '-c', 'import matplotlib, PIL, cv2; print("ok")'], {
      cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 8_192,
      env: { MPLBACKEND: 'Agg', PYTHONNOUSERSITE: '1' },
    })
    if (result.exitCode !== 0) {
      return { id: 'python', status: 'failed', message: 'Python dependencies are missing', details: { executable, stderr: result.stderr } }
    }
    return { id: 'python', status: 'ready', message: 'Python analysis runtime is ready', details: { executable } }
  } catch (error) {
    return { id: 'python', status: 'failed', message: safeErrorMessage(error) }
  }
}

async function rendererCheck(runtime: DiagnosticRuntime): Promise<DiagnosticCheck> {
  const subprocess = runtime.options.context?.get('subprocess')
  if (subprocess === undefined) return { id: 'renderer', status: 'not_available', message: 'DSH subprocess service is unavailable' }
  const resolveFirst = async (candidates: readonly string[]) => {
    for (const candidate of candidates) {
      try { return await subprocess.resolveExecutable(candidate) } catch { /* Try the next candidate. */ }
    }
    return undefined
  }
  const existingFirst = async (candidates: readonly string[]) => {
    for (const candidate of candidates) {
      try { await access(candidate); return candidate } catch { /* Try the next candidate. */ }
    }
    return undefined
  }
  const nativeBackends: Array<{ backend: string; launcher?: string; application?: string; capture?: string }> = []
  if (process.platform === 'darwin') {
    const [launcher, keynote, powerpoint, capture] = await Promise.all([
      resolveFirst(appleScriptCandidates()), existingFirst(keynoteCandidates()),
      existingFirst(powerPointCandidates()), resolveFirst(screenCaptureCandidates()),
    ])
    if (launcher !== undefined && keynote !== undefined) nativeBackends.push({ backend: 'keynote', launcher, application: keynote })
    if (launcher !== undefined && powerpoint !== undefined && capture !== undefined) {
      nativeBackends.push({ backend: 'powerpoint', launcher, application: powerpoint, capture })
    }
  } else if (process.platform === 'win32') {
    const [launcher, powerpoint] = await Promise.all([resolveFirst(powerShellCandidates()), existingFirst(powerPointCandidates())])
    if (launcher !== undefined) nativeBackends.push({ backend: 'powerpoint', launcher, application: powerpoint })
  }
  let office: string | undefined
  for (const candidate of libreOfficeCandidates()) {
    try {
      office = await subprocess.resolveExecutable(candidate)
      break
    } catch {
      // Try the next supported path.
    }
  }
  let rasterizer: string | undefined
  for (const candidate of pdfToPpmCandidates()) {
    try {
      rasterizer = await subprocess.resolveExecutable(candidate)
      break
    } catch {
      // Try the next supported path.
    }
  }
  const nativeReady = nativeBackends.length > 0
  const libreOfficeReady = office !== undefined && rasterizer !== undefined
  if (nativeReady || libreOfficeReady) {
    return {
      id: 'renderer', status: 'ready', message: 'PPTX image renderer is available',
      details: {
        native_backends: nativeBackends, libreoffice: office, rasterizer,
      },
    }
  }
  return {
    id: 'renderer', status: 'not_available',
    message: 'No supported PPTX renderer was found; install Keynote or PowerPoint (macOS), PowerPoint (Windows), or LibreOffice with Poppler',
    details: { native_backends: nativeBackends, libreoffice: office, rasterizer },
  }
}

async function fontCheck(runtime: DiagnosticRuntime): Promise<DiagnosticCheck> {
  try {
    const fonts = await discoverRegisteredFonts(runtime.options.fontDirs)
    const availability = summarizeFontAvailability(fonts)
    const english = availability.roles['latin-sans'].available || availability.roles['latin-serif'].available
    const chinese = availability.roles['cjk-sans'].available || availability.roles['cjk-serif'].available
    const summary = fonts.map(font => ({
      name: font.name, file: font.file, sha256: font.sha256, weight: font.weight,
      glyphCount: font.glyphCount, supportsLatin: font.supportsLatin, supportsCjk: font.supportsCjk,
      layer: registeredFont(font.name)?.layer, platforms: registeredFont(font.name)?.platforms,
    }))
    if (!english || !chinese) {
      return {
        id: 'fonts', status: 'failed', message: 'The plugin approved font registry lacks an installed Latin or CJK family',
        details: {
          scope_note: 'This is the plugin approved registry subset, not the host-wide font inventory.',
          english, chinese, availability, fonts: summary,
        },
      }
    }
    return {
      id: 'fonts', status: 'ready',
      message: `${availability.availableFamilies} approved font families are installed; Latin and CJK roles are covered`,
      details: {
        scope_note: 'This is the plugin approved registry subset, not the host-wide font inventory.',
        availability, fonts: summary,
      },
    }
  } catch (error) {
    return { id: 'fonts', status: 'failed', message: safeErrorMessage(error) }
  }
}

async function visionCheck(runtime: DiagnosticRuntime, agent?: Agent): Promise<DiagnosticCheck> {
  const context = runtime.options.context
  if (context?.get('attachments') === undefined) {
    return { id: 'attachments', status: 'failed', message: 'Durable attachment service is unavailable; read_image will not register' }
  }
  if (agent === undefined || agent.options.provider === undefined || agent.options.model === undefined) {
    return { id: 'vision_model', status: 'not_available', message: 'No active agent route was supplied for image-capability diagnosis' }
  }
  const llm = context.get('llm')
  if (llm === undefined) return { id: 'vision_model', status: 'failed', message: 'LLM service is unavailable' }
  try {
    const info = await llm.resolveModelInfo(agent.options.provider, agent.options.model)
    return info.inputModalities?.includes('image')
      ? { id: 'vision_model', status: 'ready', message: 'The active model accepts image input', details: { provider: info.provider, model: info.id } }
      : { id: 'vision_model', status: 'failed', message: 'The active model does not declare image input', details: { provider: info.provider, model: info.id } }
  } catch (error) {
    return { id: 'vision_model', status: 'failed', message: safeErrorMessage(error) }
  }
}

export async function diagnosePptRuntime(runtime: DiagnosticRuntime, agent?: Agent): Promise<PptDiagnosticReport> {
  const checks: DiagnosticCheck[] = []
  checks.push(isSupportedPlatform()
    ? { id: 'platform', status: 'ready', message: `Supported platform: ${process.platform}` }
    : { id: 'platform', status: 'failed', message: `Unsupported platform: ${process.platform}` })
  const surface = runtime.toolSurface
  checks.push(surface !== undefined && surface.missing.length === 0 && surface.unexpected.length === 0
    ? { id: 'tools', status: 'ready', message: `All ${PPT_MODE_TOOL_NAMES.length} PPT mode tools are visible` }
    : { id: 'tools', status: 'failed', message: 'PPT mode tool surface is incomplete', details: surface ?? { missing: ['surface not mounted'] } })
  const browser = await discoverBrowserExecutable(runtime.options.browserExecutable)
  checks.push(browser.executable === undefined
    ? { id: 'browser', status: 'failed', message: 'No compatible Chromium/Chrome executable was found', details: { checked: browser.checked } }
    : { id: 'browser', status: 'ready', message: 'Browser runtime is ready', details: { executable: browser.executable, source: browser.source } })
  checks.push(await pythonCheck(runtime))
  checks.push(await fontCheck(runtime))
  checks.push(await rendererCheck(runtime))
  const attachmentReady = runtime.options.context?.get('attachments') !== undefined
  checks.push(attachmentReady
    ? { id: 'attachments', status: 'ready', message: 'Durable attachment service is available' }
    : { id: 'attachments', status: 'failed', message: 'Durable attachment service is unavailable; read_image will not register' })
  if (attachmentReady) checks.push(await visionCheck(runtime, agent))

  const status = checks.some(check => check.status === 'failed')
    ? 'failed'
    : checks.some(check => check.status !== 'ready') ? 'degraded' : 'ready'
  return { status, checks }
}
