import { describe, expect, it } from 'vitest'
import {
  appleScriptCandidates, browserSystemCandidates, isSupportedPlatform, keynoteCandidates,
  libreOfficeCandidates, pdfToPpmCandidates, powerPointCandidates, powerShellCandidates,
  pptImageBackendOrder, screenCaptureCandidates, systemFontDirectories,
} from '../../src/platform.ts'

describe('cross-platform runtime discovery', () => {
  it('supports macOS, Linux, and Windows', () => {
    expect(['darwin', 'linux', 'win32'].every(platform => isSupportedPlatform(platform as NodeJS.Platform))).toBe(true)
    expect(isSupportedPlatform('freebsd')).toBe(false)
  })

  it('includes native Windows application and font locations', () => {
    const env = { SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Apps', LOCALAPPDATA: 'D:\\Users\\A\\Local' }
    expect(systemFontDirectories('win32', 'D:\\Users\\A', env)).toContain('D:\\Windows\\Fonts')
    expect(libreOfficeCandidates('win32', env)).toContain('D:\\Apps\\LibreOffice\\program\\soffice.exe')
    expect(pdfToPpmCandidates('win32')).toContain('pdftoppm.exe')
    expect(powerShellCandidates('win32')).toContain('powershell.exe')
    expect(powerPointCandidates('win32', env)).toContain('D:\\Apps\\Microsoft Office\\root\\Office16\\POWERPNT.EXE')
    expect(browserSystemCandidates('win32', 'D:\\Users\\A', env)).toContain('D:\\Apps\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('includes modern macOS downloadable system-font assets', () => {
    expect(systemFontDirectories('darwin', '/Users/a')).toEqual(expect.arrayContaining([
      '/System/Library/Fonts', '/System/Library/AssetsV2/com_apple_MobileAsset_Font8', '/Users/a/Library/Fonts',
    ]))
  })

  it('prefers the platform-native PPT renderer before LibreOffice', () => {
    expect(appleScriptCandidates('darwin')).toContain('/usr/bin/osascript')
    expect(screenCaptureCandidates('darwin')).toContain('/usr/sbin/screencapture')
    expect(keynoteCandidates('darwin', '/Users/a')).toContain('/Applications/Keynote.app')
    expect(powerPointCandidates('darwin', {}, '/Users/a')).toContain('/Applications/Microsoft PowerPoint.app')
    expect(pptImageBackendOrder('darwin')).toEqual(['keynote', 'libreoffice', 'powerpoint'])
    expect(pptImageBackendOrder('win32')).toEqual(['powerpoint', 'libreoffice'])
    expect(pptImageBackendOrder('linux')).toEqual(['libreoffice'])
    expect(pptImageBackendOrder('linux', 'keynote')).toEqual(['keynote'])
  })
})
