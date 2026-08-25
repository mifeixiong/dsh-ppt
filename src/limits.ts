import { PptError } from './errors.ts'

export const DEFAULT_LIMITS = Object.freeze({
  maxSlides: 60,
  maxElementsPerSlide: 200,
  maxRedirects: 5,
  maxResponseBytes: 16 * 1024 * 1024,
  maxImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxPythonMs: 120_000,
  maxPythonOutputChars: 20_000,
  maxBrowserTextChars: 20_000,
  maxGeneratedFiles: 100,
  maxGeneratedFileBytes: 50 * 1024 * 1024,
  maxToolResultChars: 30_000,
  maxImageSearchResults: 20,
})

export type PptLimits = typeof DEFAULT_LIMITS

export function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new PptError('PPT_RESOURCE_LIMIT', `${name} must be an integer between ${min} and ${max}`)
  }
  return value
}
