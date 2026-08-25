import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { browserSystemCandidates } from './platform.ts'

export interface BrowserDiscoveryResult {
  executable?: string
  source?: 'configured' | 'playwright' | 'system'
  checked: string[]
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function discoverBrowserExecutable(configured?: string): Promise<BrowserDiscoveryResult> {
  const checked: string[] = []
  const candidates: Array<{ path: string; source: BrowserDiscoveryResult['source'] }> = []
  if (configured !== undefined && configured.trim().length > 0) {
    candidates.push({ path: configured, source: 'configured' })
  }
  try {
    candidates.push({ path: chromium.executablePath(), source: 'playwright' })
  } catch {
    // The package can be present without a managed browser path.
  }
  candidates.push(...browserSystemCandidates().map(path => ({ path, source: 'system' as const })))

  for (const candidate of candidates) {
    if (checked.includes(candidate.path)) continue
    checked.push(candidate.path)
    if (await executable(candidate.path)) return { executable: candidate.path, source: candidate.source, checked }
  }
  return { checked }
}
