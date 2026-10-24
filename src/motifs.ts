/**
 * Generative decoration motifs. A theme may name two or three of these; the
 * catalogue renders them into ready-to-paste SVG with the theme's own ink and
 * accent colours. The patterns are deterministic geometry (no random assets, no
 * external files), which is the same generation principle the reference pattern
 * tools use: one seed recipe, many scales, the palette supplied by the deck.
 *
 * Every builder returns SVG primitives only — circle, line, rect, path, polygon.
 * Filters, masks, patterns, foreignObject and script are deliberately absent:
 * the HTML whitelist rejects them and PowerPoint cannot round-trip them.
 */

import { terrainLines } from './terrain.ts'

export interface MotifPalette {
  /** Main line/dot colour; the theme's text colour for that tonal group. */
  ink: string
  /** Accent used sparingly, never as the dominant colour. */
  accent: string
}

export interface MotifDefinition {
  id: string
  /** Bilingual name for the catalogue. */
  name: string
  /** One line saying where this device belongs on a page. */
  placement: string
  description: string
  width: number
  height: number
  build: (palette: MotifPalette) => string
}

function hex(value: string): string {
  return value.toUpperCase()
}

/** Deterministic pseudo-random in 0..1; same seed always gives the same pattern. */
function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return value - Math.floor(value)
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function document(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
}

function concentric(palette: MotifPalette): string {
  const parts: string[] = []
  for (let index = 0; index < 16; index += 1) {
    const radius = 24 + index * 13
    const accent = index === 11
    parts.push(`<circle cx="240" cy="240" r="${radius}" fill="none" stroke="${accent ? hex(palette.accent) : hex(palette.ink)}" stroke-width="${accent ? 2 : 1}" stroke-opacity="${accent ? 0.5 : round(0.08 + index * 0.012, 3)}"/>`)
  }
  parts.push(`<circle cx="240" cy="240" r="3" fill="${hex(palette.accent)}" fill-opacity="0.6"/>`)
  return document(480, 480, parts.join(''))
}

function halftone(palette: MotifPalette): string {
  const parts: string[] = []
  const columns = 24
  const rows = 14
  const cell = 24
  const maxDistance = Math.hypot(columns * cell, rows * cell)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = 12 + column * cell
      const y = 12 + row * cell
      const distance = Math.hypot(x, y)
      const radius = round(1 + 4.2 * (1 - distance / maxDistance), 2)
      const accent = noise(row * 31 + column) > 0.86
      parts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${accent ? hex(palette.accent) : hex(palette.ink)}" fill-opacity="${accent ? 0.42 : 0.2}"/>`)
    }
  }
  return document(columns * cell, rows * cell, parts.join(''))
}

function hudLines(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  const rows = [30, 66, 102, 138, 174, 210]
  rows.forEach((y, index) => {
    const inset = 24 + index * 18
    parts.push(`<line x1="${inset}" y1="${y}" x2="${900 - inset}" y2="${y}" stroke="${ink}" stroke-width="1" stroke-opacity="0.18"/>`)
    for (let x = inset + 24; x < 900 - inset - 12; x += 72) {
      const height = index === 2 ? 10 : 5
      parts.push(`<line x1="${x}" y1="${y - height}" x2="${x}" y2="${y + height}" stroke="${ink}" stroke-width="1" stroke-opacity="0.3"/>`)
    }
  })
  parts.push(`<line x1="24" y1="120" x2="72" y2="120" stroke="${accent}" stroke-width="2" stroke-opacity="0.72"/>`)
  parts.push(`<circle cx="876" cy="120" r="5" fill="none" stroke="${accent}" stroke-width="1.5" stroke-opacity="0.6"/>`)
  parts.push(`<line x1="876" y1="104" x2="876" y2="136" stroke="${accent}" stroke-width="1" stroke-opacity="0.5"/>`)
  parts.push(`<line x1="860" y1="120" x2="892" y2="120" stroke="${accent}" stroke-width="1" stroke-opacity="0.5"/>`)
  return document(900, 240, parts.join(''))
}

function tickCircle(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = [`<circle cx="220" cy="220" r="180" fill="none" stroke="${ink}" stroke-width="1" stroke-opacity="0.22"/>`]
  for (let index = 0; index < 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2
    const major = index % 6 === 0
    const inner = 180 - (major ? 18 : 9)
    const x1 = 220 + Math.cos(angle) * inner
    const y1 = 220 + Math.sin(angle) * inner
    const x2 = 220 + Math.cos(angle) * 180
    const y2 = 220 + Math.sin(angle) * 180
    parts.push(`<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${major ? accent : ink}" stroke-width="${major ? 1.5 : 1}" stroke-opacity="${major ? 0.55 : 0.22}"/>`)
  }
  parts.push(`<circle cx="220" cy="220" r="126" fill="none" stroke="${ink}" stroke-width="1" stroke-opacity="0.12"/>`)
  parts.push(`<line x1="220" y1="40" x2="220" y2="400" stroke="${ink}" stroke-width="1" stroke-opacity="0.12"/>`)
  parts.push(`<line x1="40" y1="220" x2="400" y2="220" stroke="${ink}" stroke-width="1" stroke-opacity="0.12"/>`)
  return document(440, 440, parts.join(''))
}

/**
 * Code 39, the one ornament in this catalogue that is also a real symbology:
 * nine elements per character (five bars, four spaces), exactly three of them
 * wide, framed by the start/stop character `*`. The table below is the public
 * standard, so the motif needs no barcode font installed and no rasteriser: the
 * bars are drawn on an integer module grid. Typesetting a barcode font instead
 * lands the narrow bars on fractional pixels (at 44 px the narrow module is
 * 2.92 px), and the wide/narrow rhythm stops being exact.
 */
const CODE39_PATTERNS: Readonly<Record<string, string>> = Object.freeze({
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001',
  '5': '100110000', '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100',
  A: '100001001', B: '001001001', C: '101001000', D: '000011001', E: '100011000',
  F: '001011000', G: '000001101', H: '100001100', I: '001001100', J: '000011100',
  K: '100000011', L: '001000011', M: '101000010', N: '000010011', O: '100010010',
  P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001', Y: '110010000',
  Z: '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
  '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100',
})

/** Decorative payload; Code 39 is uppercase, digits, space and `- . $ / + %`. */
export const BARCODE_PAYLOAD = 'DSH 2026'
/** Narrow module in canvas px; three keeps the ten-character payload inside 520 px. */
const BARCODE_MODULE = 3
/** Code 39 wants ten narrow modules of quiet zone on both sides. */
const BARCODE_QUIET_MODULES = 10
const BARCODE_BAR_HEIGHT = 110
const BARCODE_WIDTH = 520
const BARCODE_HEIGHT = 180
/** Wide:narrow ratio. The spec allows 2.0–3.0; 2.25 matches common barcode fonts. */
const BARCODE_RATIO = 2.25

export interface BarcodeBar {
  x: number
  width: number
}

/**
 * Encode a payload into bar rectangles on an integer module grid. Bars only:
 * the spaces between them are the gaps, so the geometry can be rasterised or
 * drawn as SVG without changing the pattern.
 */
export function code39Bars(
  payload: string,
  options: { module: number; quietModules?: number },
): { bars: BarcodeBar[]; width: number } {
  if (!Number.isInteger(options.module) || options.module <= 0) {
    throw new Error(`Code 39 needs a positive integer module, got ${options.module}`)
  }
  const module = options.module
  const quietModules = options.quietModules ?? BARCODE_QUIET_MODULES
  const wide = Math.max(module + 1, Math.round(module * BARCODE_RATIO))
  const characters = `*${payload}*`
  const bars: BarcodeBar[] = []
  let x = quietModules * module
  for (const [index, character] of [...characters].entries()) {
    const pattern = CODE39_PATTERNS[character.toUpperCase()]
    if (pattern === undefined) throw new Error(`Code 39 cannot encode ${JSON.stringify(character)}`)
    for (const [element, bit] of [...pattern].entries()) {
      const width = bit === '1' ? wide : module
      if (element % 2 === 0) bars.push({ x, width })
      x += width
    }
    if (index < characters.length - 1) x += module
  }
  return { bars, width: x + quietModules * module }
}

function barcode(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const { bars, width } = code39Bars(BARCODE_PAYLOAD, { module: BARCODE_MODULE })
  const originX = Math.round((BARCODE_WIDTH - width) / 2)
  const top = Math.round((BARCODE_HEIGHT - BARCODE_BAR_HEIGHT) / 2) - 8
  const parts = bars.map(bar => `<rect x="${originX + bar.x}" y="${top}" width="${bar.width}" height="${BARCODE_BAR_HEIGHT}" fill="${ink}"/>`)
  // The accent rule sits below the bars, outside the quiet zone, so it never
  // touches the pattern.
  const baseline = top + BARCODE_BAR_HEIGHT + 8
  parts.push(`<line x1="${originX + BARCODE_QUIET_MODULES * BARCODE_MODULE}" y1="${baseline}" x2="${originX + width - BARCODE_QUIET_MODULES * BARCODE_MODULE}" y2="${baseline}" stroke="${accent}" stroke-width="2" stroke-opacity="0.55"/>`)
  return document(BARCODE_WIDTH, BARCODE_HEIGHT, parts.join(''))
}

function waves(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let line = 0; line < 9; line += 1) {
    const baseline = 40 + line * 20
    const amplitude = 8 + line * 2.4
    const phase = line * 0.55
    const points: string[] = []
    for (let x = 0; x <= 1280; x += 16) {
      const y = baseline + Math.sin(x / 92 + phase) * amplitude
      points.push(`${x === 0 ? 'M' : 'L'}${x} ${round(y)}`)
    }
    parts.push(`<path d="${points.join(' ')}" fill="none" stroke="${line === 6 ? accent : ink}" stroke-width="${line === 6 ? 1.6 : 1}" stroke-opacity="${line === 6 ? 0.5 : round(0.08 + line * 0.008, 3)}"/>`)
  }
  return document(1280, 240, parts.join(''))
}

function repeatLines(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let x = 12; x < 640; x += 12) {
    const accentLine = x === 276 || x === 372
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="360" stroke="${accentLine ? accent : ink}" stroke-width="1" stroke-opacity="${accentLine ? 0.45 : 0.11}"/>`)
  }
  parts.push(`<line x1="0" y1="120" x2="640" y2="120" stroke="${ink}" stroke-width="1" stroke-opacity="0.16"/>`)
  parts.push(`<line x1="0" y1="240" x2="640" y2="240" stroke="${ink}" stroke-width="1" stroke-opacity="0.16"/>`)
  return document(640, 360, parts.join(''))
}

function dotMatrix(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const accentDot = noise(row * 19 + column * 7) > 0.9
      parts.push(`<circle cx="${20 + column * 40}" cy="${20 + row * 40}" r="${accentDot ? 3 : 2}" fill="${accentDot ? accent : ink}" fill-opacity="${accentDot ? 0.5 : 0.22}"/>`)
    }
  }
  return document(640, 360, parts.join(''))
}

function polygonMesh(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const columns = 7
  const rows = 5
  const points: Array<[number, number]> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = 30 + column * 96 + (noise(row * 13 + column) - 0.5) * 34
      const y = 40 + row * 84 + (noise(row * 29 + column * 3) - 0.5) * 30
      points.push([round(x), round(y)])
    }
  }
  const at = (row: number, column: number) => points[row * columns + column]!
  const parts: string[] = []
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = at(row, column)
      const b = at(row, column + 1)
      const c = at(row + 1, column)
      const d = at(row + 1, column + 1)
      parts.push(`<path d="M${a[0]} ${a[1]} L${b[0]} ${b[1]} L${c[0]} ${c[1]} Z" fill="none" stroke="${ink}" stroke-width="1" stroke-opacity="0.2"/>`)
      parts.push(`<path d="M${b[0]} ${b[1]} L${d[0]} ${d[1]} L${c[0]} ${c[1]} Z" fill="none" stroke="${ink}" stroke-width="1" stroke-opacity="0.2"/>`)
    }
  }
  for (const [index, point] of points.entries()) {
    const accentPoint = index % 11 === 4
    parts.push(`<circle cx="${point[0]}" cy="${point[1]}" r="${accentPoint ? 2.6 : 1.4}" fill="${accentPoint ? accent : ink}" fill-opacity="${accentPoint ? 0.6 : 0.3}"/>`)
  }
  return document(640, 420, parts.join(''))
}

function contours(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const width = 760
  const height = 380
  // Fractal Perlin terrain cut into iso-lines. The field is seeded, so every
  // render is byte-identical; the line geometry is simplified to keep the SVG
  // inside the motif size budget.
  const lines = terrainLines({ width, height })
  const parts = lines.map(line => {
    const accentLine = line.level === 7
    const indexLine = line.level % 5 === 0
    const opacity = accentLine ? 0.34 : round(0.045 + line.level * 0.007 + (indexLine ? 0.03 : 0), 3)
    const d = line.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${Math.round(point.x)} ${Math.round(point.y)}`).join(' ')
    return `<path d="${d}" fill="none" stroke="${accentLine ? accent : ink}" stroke-width="${accentLine ? 1.4 : indexLine ? 1.1 : 1}" stroke-opacity="${opacity}"/>`
  })
  return document(width, height, parts.join(''))
}

function commonShapes(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = [
    `<circle cx="150" cy="130" r="92" fill="none" stroke="${ink}" stroke-width="1.2" stroke-opacity="0.24"/>`,
    `<circle cx="150" cy="130" r="54" fill="${accent}" fill-opacity="0.1"/>`,
    `<rect x="300" y="70" width="140" height="140" fill="none" stroke="${ink}" stroke-width="1.2" stroke-opacity="0.2"/>`,
    `<path d="M300 300 L440 300 L370 170 Z" fill="none" stroke="${accent}" stroke-width="1.4" stroke-opacity="0.4"/>`,
    `<path d="M60 300 Q150 210 240 300" fill="none" stroke="${ink}" stroke-width="1.2" stroke-opacity="0.2"/>`,
    `<line x1="300" y1="40" x2="470" y2="40" stroke="${ink}" stroke-width="1" stroke-opacity="0.2"/>`,
  ]
  return document(520, 360, parts.join(''))
}

function nestedPolygons(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let layer = 0; layer < 9; layer += 1) {
    const sides = layer % 2 === 0 ? 3 : 4
    const radius = 210 - layer * 22
    const rotation = (layer * 7 * Math.PI) / 180
    const points: string[] = []
    for (let side = 0; side < sides; side += 1) {
      const angle = rotation + (side / sides) * Math.PI * 2
      points.push(`${round(240 + Math.cos(angle) * radius)},${round(240 + Math.sin(angle) * radius)}`)
    }
    parts.push(`<polygon points="${points.join(' ')}" fill="none" stroke="${layer === 4 ? accent : ink}" stroke-width="${layer === 4 ? 1.6 : 1}" stroke-opacity="${layer === 4 ? 0.5 : round(0.08 + layer * 0.014, 3)}"/>`)
  }
  return document(480, 480, parts.join(''))
}

function wireframeGlobe(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = [`<circle cx="240" cy="240" r="196" fill="none" stroke="${ink}" stroke-width="1.2" stroke-opacity="0.24"/>`]
  for (let index = 1; index < 8; index += 1) {
    const rx = 196 * Math.sin((index / 8) * Math.PI)
    parts.push(`<ellipse cx="240" cy="240" rx="${round(rx)}" ry="196" fill="none" stroke="${index === 4 ? accent : ink}" stroke-width="1" stroke-opacity="${index === 4 ? 0.4 : 0.15}"/>`)
  }
  for (let index = 1; index < 6; index += 1) {
    const ry = 196 * Math.sin((index / 6) * Math.PI)
    parts.push(`<ellipse cx="240" cy="240" rx="196" ry="${round(ry)}" fill="none" stroke="${ink}" stroke-width="1" stroke-opacity="0.15"/>`)
  }
  return document(480, 480, parts.join(''))
}

function squareGrid(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let x = 0; x <= 640; x += 24) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="360" stroke="${ink}" stroke-width="1" stroke-opacity="0.08"/>`)
  }
  for (let y = 0; y <= 360; y += 24) {
    parts.push(`<line x1="0" y1="${y}" x2="640" y2="${y}" stroke="${ink}" stroke-width="1" stroke-opacity="0.08"/>`)
  }
  parts.push(`<rect x="264" y="120" width="96" height="72" fill="${accent}" fill-opacity="0.12"/>`)
  parts.push(`<rect x="264" y="120" width="96" height="72" fill="none" stroke="${accent}" stroke-width="1.2" stroke-opacity="0.45"/>`)
  return document(640, 360, parts.join(''))
}

function radialRays(palette: MotifPalette): string {
  const ink = hex(palette.ink)
  const accent = hex(palette.accent)
  const parts: string[] = []
  for (let index = 0; index < 60; index += 1) {
    const angle = (index / 60) * Math.PI * 2
    const major = index % 5 === 0
    const inner = major ? 52 : 64
    const outer = major ? 236 : 196
    const accentRay = index === 15
    parts.push(`<line x1="${round(260 + Math.cos(angle) * inner)}" y1="${round(260 + Math.sin(angle) * inner)}" x2="${round(260 + Math.cos(angle) * outer)}" y2="${round(260 + Math.sin(angle) * outer)}" stroke="${accentRay ? accent : ink}" stroke-width="${major ? 1.4 : 1}" stroke-opacity="${accentRay ? 0.6 : major ? 0.26 : 0.12}"/>`)
  }
  parts.push(`<circle cx="260" cy="260" r="30" fill="none" stroke="${accent}" stroke-width="1.4" stroke-opacity="0.5"/>`)
  return document(520, 520, parts.join(''))
}

export const MOTIFS: readonly MotifDefinition[] = [
  { id: 'concentric-circles', name: '同心圆 / concentric circles', placement: 'A 360–520px corner device; one accent ring, the rest hairlines.', description: 'Nested rings with a single accent ring, like a technical target.', width: 480, height: 480, build: concentric },
  { id: 'halftone-dots', name: '半调波点 / halftone dots', placement: 'A 480–720px corner field behind cards; never behind body copy.', description: 'Dot grid whose radius falls off from one corner, the print halftone recipe.', width: 576, height: 336, build: halftone },
  { id: 'hud-lines', name: 'HUD 线条 / HUD lines', placement: 'A full-content-width horizontal strip, top or bottom edge.', description: 'Instrument-panel ticks and crosshairs, drawn as hairlines.', width: 900, height: 240, build: hudLines },
  { id: 'tick-circle', name: '刻度圆 / tick circle', placement: 'A 240–420px corner dial; pair with a metric page.', description: 'A graduated dial: 72 ticks, every sixth one accented.', width: 440, height: 440, build: tickCircle },
  { id: 'barcode', name: '条形码 / barcode', placement: 'A footer strip or a 160–220px side rail.', description: 'A true Code 39 pattern (nine elements per character) on an integer module grid, with a quiet zone and one accent rule beneath it.', width: 520, height: 180, build: barcode },
  { id: 'wave-texture', name: '波浪纹理 / wave texture', placement: 'A full-width lower band, 220–260px tall.', description: 'Nine offset sine lines; one accent line carries the motion.', width: 1280, height: 240, build: waves },
  { id: 'repeat-lines', name: '重复线条 / repeating lines', placement: 'An edge band, one third of the page wide.', description: 'Even vertical hairlines with two accent rules marking a field.', width: 640, height: 360, build: repeatLines },
  { id: 'dot-matrix', name: '点阵 / dot matrix', placement: 'A 320–640px corner field; low contrast only.', description: 'A 16×9 dot grid with a deterministic accent dot.', width: 640, height: 360, build: dotMatrix },
  { id: 'polygon-mesh', name: '多边形网格 / polygon mesh', placement: 'Right half or full-bleed at 0.1–0.2 opacity.', description: 'Jittered triangulation with node dots, like a surface mesh.', width: 640, height: 420, build: polygonMesh },
  { id: 'contour-lines', name: '等高线 / contour lines', placement: 'A full-width deep background field behind a quote or metric; keep it below the text layer.', description: 'Fractal Perlin terrain cut into ten iso-lines, with index contours every fifth level and one accent line.', width: 760, height: 380, build: contours },
  { id: 'common-shapes', name: '常见图形 / common shapes', placement: 'A 320–520px corner cluster; three shapes maximum.', description: 'Circle, square, triangle and arc in one restrained cluster.', width: 520, height: 360, build: commonShapes },
  { id: 'nested-polygons', name: '嵌套多边形 / nested polygons', placement: 'A 320–480px poster mark; one per deck.', description: 'Nested triangles and squares, rotated a few degrees each layer.', width: 480, height: 480, build: nestedPolygons },
  { id: 'wireframe-globe', name: '经纬球 / wireframe globe', placement: 'A 320–480px device at the right edge of a hero page.', description: 'A latitude/longitude wireframe with one accented meridian.', width: 480, height: 480, build: wireframeGlobe },
  { id: 'square-grid', name: '方形网格 / square grid', placement: 'A background field across two thirds of the page.', description: 'A modular grid with one accented cell.', width: 640, height: 360, build: squareGrid },
  { id: 'radial-rays', name: '射线 / radial rays', placement: 'A 320–520px corner burst; never centred behind a title.', description: 'Sixty rays from a centre, every fifth ray longer.', width: 520, height: 520, build: radialRays },
]

export const MOTIF_IDS: readonly string[] = MOTIFS.map(motif => motif.id)

const BY_ID = new Map(MOTIFS.map(motif => [motif.id, motif]))

export function findMotif(id: string): MotifDefinition | undefined {
  return BY_ID.get(id)
}

/** Render one motif for a tonal group; the SVG is self-contained and whitelist-safe. */
export function renderMotif(id: string, palette: MotifPalette): string {
  const motif = BY_ID.get(id)
  if (motif === undefined) throw new Error(`unknown motif: ${id}`)
  return motif.build({ ink: hex(palette.ink), accent: hex(palette.accent) })
}

/** Guard rail for tests and the catalogue: no blocked SVG feature, bounded size. */
export function motifSvgFinding(svg: string): string | undefined {
  if (svg.length > 64 * 1024) return 'motif SVG exceeds 64 KiB'
  if (/<(?:filter|mask|pattern|foreignObject|script|image)\b/iu.test(svg)) return 'motif SVG contains a blocked feature'
  if (/(?:href|url\s*\()/iu.test(svg)) return 'motif SVG references an external resource'
  return undefined
}
