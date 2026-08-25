import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { diagnosePptRuntime, type PptDiagnosticReport } from './diagnostics.ts'
import { SessionResourceRegistry } from './session-resources.ts'
import { BrowserRuntime } from './browser.ts'
import { PythonRuntime } from './python.ts'
import { ImageSearchRuntime } from './image-search.ts'
import { QualityRuntime } from './quality.ts'
import { PptImageRuntime } from './ppt-image.ts'

export interface PptRuntimeOptions {
  context?: Context
  workspaceRoot?: string
  outputRoot?: string
  pythonExecutable?: string
  browserExecutable?: string
  fontDirs?: readonly string[]
}

export interface ToolSurfaceStatus {
  visible: readonly string[]
  missing: readonly string[]
  unexpected: readonly string[]
}

export interface PptRuntime {
  readonly options: Readonly<PptRuntimeOptions>
  readonly toolSurface?: ToolSurfaceStatus
  readonly resources: SessionResourceRegistry
  readonly browser: BrowserRuntime
  readonly python: PythonRuntime
  readonly imageSearch: ImageSearchRuntime
  readonly pptImage: PptImageRuntime
  readonly quality: QualityRuntime
  recordToolSurface(status: ToolSurfaceStatus): void
  canReviewImages(agent?: Agent): Promise<boolean>
  diagnose(agent?: Agent): Promise<PptDiagnosticReport>
  dispose(): Promise<void>
}

class DefaultPptRuntime implements PptRuntime {
  readonly options: Readonly<PptRuntimeOptions>
  toolSurface?: ToolSurfaceStatus
  private disposed = false
  readonly resources = new SessionResourceRegistry()
  readonly browser: BrowserRuntime
  readonly python: PythonRuntime
  readonly imageSearch = new ImageSearchRuntime()
  readonly pptImage: PptImageRuntime
  readonly quality: QualityRuntime

  constructor(options: PptRuntimeOptions) {
    this.options = Object.freeze({ ...options, fontDirs: Object.freeze([...(options.fontDirs ?? [])]) })
    this.browser = new BrowserRuntime(this.resources, options.browserExecutable, options.outputRoot)
    this.python = new PythonRuntime(options.context?.get('subprocess'), options.context?.get('sandbox'), this.resources, options.pythonExecutable)
    this.pptImage = new PptImageRuntime(options.context?.get('subprocess'), options.context?.get('sandbox'), this.resources, {}, options.fontDirs)
    this.quality = new QualityRuntime(options.context?.get('subprocess'), options.context?.get('sandbox'), this.resources, {}, options.fontDirs, this.pptImage)
  }

  recordToolSurface(status: ToolSurfaceStatus): void {
    // Tool registrations can emit a final change event while Cordis is
    // unwinding sibling fibers. A previously queued audit is stale once the
    // runtime starts disposing, so ignore it instead of turning Ctrl-C into an
    // unhandled shutdown error.
    if (this.disposed) return
    this.toolSurface = Object.freeze({
      visible: Object.freeze([...status.visible]),
      missing: Object.freeze([...status.missing]),
      unexpected: Object.freeze([...status.unexpected]),
    })
  }

  async canReviewImages(agent?: Agent): Promise<boolean> {
    const context = this.options.context
    if (context?.get('attachments') === undefined || agent?.options.provider === undefined || agent.options.model === undefined) return false
    const llm = context.get('llm')
    if (llm === undefined) return false
    try {
      const info = await llm.resolveModelInfo(agent.options.provider, agent.options.model)
      return info.inputModalities?.includes('image') ?? false
    } catch {
      return false
    }
  }

  diagnose(agent?: Agent): Promise<PptDiagnosticReport> {
    return diagnosePptRuntime(this, agent)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.browser.dispose()
    await this.resources.dispose()
  }
}

export function createPptRuntime(options: PptRuntimeOptions = {}): PptRuntime {
  return new DefaultPptRuntime(options)
}
