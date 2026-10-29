/**
 * The shell tool this host exposes. DSH's stock presets mount `tool-bash` on
 * darwin and linux and `tool-pwsh` on Windows, so the PPT preset follows the same
 * split and its audit expects whichever one is actually available.
 */
export const PPT_SHELL_TOOL_NAME = process.platform === 'win32' ? 'pwsh' : 'bash'

export const PPT_NATIVE_TOOL_NAMES = [
  PPT_SHELL_TOOL_NAME,
  'ask_user_question',
  'edit',
  'read',
  'read_image',
  'todo_write',
  'web_search',
  'write',
] as const

export const PPT_TOOL_NAMES = [
  'browser_click',
  'browser_find',
  'browser_scroll_down',
  'browser_scroll_up',
  'browser_visit',
  'html_create',
  'image_search',
  'ppt_create',
  'ppt_fonts',
  'ppt_image',
  'ppt_outline',
  'ppt_themes',
  'python',
] as const

/**
 * The tools this preset cannot work without: the host natives plus every tool
 * the package registers itself. The surface audit treats exactly this list as
 * required, and the headless runner refuses to start when one is absent.
 */
export const PPT_CORE_TOOL_NAMES = [...PPT_NATIVE_TOOL_NAMES, ...PPT_TOOL_NAMES].sort()

/**
 * The office document lane: tools owned by `dsh-office-tools`, not by this
 * package.
 *
 * The preset inherits them from the host composition and allow-lists them, so
 * one PPT session can write the deck and the Word/Excel material that supports
 * it. They are deliberately *not* mounted by this preset's own row: the tool
 * registry keeps one registration table per scope and refuses a second
 * registration of a name inside the same layer (`tool "x" is already
 * registered in this scope`) while a scoped registration shadows a global one.
 * Inheriting keeps both plugins loadable, and it keeps `ppt_create`
 * unambiguous: inside PPT mode this package's design pipeline owns that name,
 * and the office builder stays reachable in every preset that does not shadow
 * it.
 *
 * The lane is optional at runtime (headless mounts no office bundle), so the
 * audit reports it as a group instead of treating it as a defect.
 */
export const PPT_OFFICE_TOOL_NAMES = [
  'excel_create',
  'excel_read',
  'excel_update',
  'ppt_read',
  'word_create',
  'word_read',
  'word_update',
] as const

/** Every tool name a PPT-mode session may see: the required core plus the office lane. */
export const PPT_MODE_TOOL_NAMES = [...PPT_CORE_TOOL_NAMES, ...PPT_OFFICE_TOOL_NAMES].sort()

export type PptToolName = typeof PPT_TOOL_NAMES[number]
