import type { TextMetrics, TextMeasurement } from './text-metrics.ts';
import { type Box } from './svg-geometry.ts';
import type { ShapeSpec } from './svg-ooxml.ts';
/**
 * The SVG deck contract and parser.
 *
 * A deck is one SVG document whose pages are top-level `<g data-page="N">`
 * groups on a 1280x720 viewBox. The accepted subset is intentionally narrow:
 * vector primitives that have an exact DrawingML equivalent, text with explicit
 * anchors, and local images. Everything that would need a rasteriser or a
 * filter pipeline (mask, clipPath, filter, pattern, use, marker, foreignObject)
 * is rejected with a finding instead of silently dropped, so an authored page
 * never diverges from its export.
 */
export declare const SVG_CANVAS_WIDTH = 1280;
export declare const SVG_CANVAS_HEIGHT = 720;
export declare const SVG_MIN_FONT_PX = 12;
export declare const SVG_MAX_ELEMENTS_PER_PAGE = 400;
export declare const SVG_MAX_PAGES = 60;
export interface SvgFinding {
    code: string;
    severity: 'error' | 'warning';
    page?: number;
    element?: string;
    message: string;
}
export interface SvgTextStyle {
    fontFamily: string;
    fontSizePx: number;
    fontWeight: number;
    italic: boolean;
    /** `RRGGBB` */
    color: string;
    letterSpacingPx: number;
    lineHeightPx: number;
    anchor: 'start' | 'middle' | 'end';
}
export interface SvgTextRun {
    text: string;
    fontFamily: string;
    fontSizePx: number;
    fontWeight: number;
    italic: boolean;
    color: string;
}
export interface SvgTextLine {
    /** SVG baseline position, in canvas px. */
    baselineY: number;
    runs: SvgTextRun[];
    /** Measured advance width of the line, in px. */
    width: number;
    /** Measured ascent/descent of the first run's face, in px. */
    ascent: number;
    descent: number;
}
export interface SvgTextElement {
    kind: 'text';
    id: string;
    style: SvgTextStyle;
    /** Box already anchored: `box.x` is the left edge implied by `style.anchor`. */
    box: Box;
    lines: SvgTextLine[];
}
export interface SvgShapeElement {
    kind: 'shape';
    id: string;
    spec: ShapeSpec;
}
export interface SvgImageElement {
    kind: 'image';
    id: string;
    box: Box;
    /** Workspace-relative image path exactly as authored. */
    href: string;
    opacity: number;
}
export type SvgElement = SvgShapeElement | SvgTextElement | SvgImageElement;
export interface SvgPageIR {
    page: number;
    /** `RRGGBB` page background declared with `data-background`. */
    background?: string;
    elements: SvgElement[];
}
export interface SvgDeckIR {
    pages: SvgPageIR[];
    /** Non-blocking findings; blocking problems throw before this is returned. */
    findings: SvgFinding[];
}
export interface SvgDeckOptions {
    metrics: TextMetrics;
    /** Approved font family names; a page may only reference these. */
    fonts: readonly string[];
}
/**
 * Parse and validate one deck. Throws `PptError('SVG_DECK_INVALID')` carrying
 * every blocking finding in `details.issues`; warnings are returned on the IR.
 */
export declare function parseSvgDeck(source: string, options: SvgDeckOptions): Promise<SvgDeckIR>;
/** Measurement helper shared by the parser and its tests. */
export declare function measureTextRun(metrics: TextMetrics, run: Pick<SvgTextRun, 'fontFamily' | 'fontWeight' | 'italic' | 'text'>, sizePx: number): Promise<TextMeasurement>;
