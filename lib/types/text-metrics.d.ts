import { type DiscoveredFont } from './fonts.ts';
/**
 * Text measurement without a browser.
 *
 * Both authoring lanes need to know how wide a string is before the slide
 * exists: the SVG lane positions `<text>` by its anchor and has to turn a
 * baseline + anchor into a left/top box. The HTML lane measures the live DOM
 * instead; this module is the lane that has no DOM.
 *
 * Widths come from the font's own advance tables through fontkit. Text is split
 * into maximal runs so kerning inside a run survives, and a character the Latin
 * face cannot cover (CJK in a Latin face, for instance) is measured with a face
 * that actually has the glyph. When no face is available the module falls back
 * to a conservative estimate, so a missing system font degrades into a slightly
 * wide box rather than a crash — and the caller can see `measured: false`.
 */
export interface TextMeasureRequest {
    family: string;
    /** Numeric CSS weight; the closest installed subfamily is used. */
    weight: number;
    italic: boolean;
    sizePx: number;
    text: string;
}
export interface TextMeasurement {
    /** Advance width in px. */
    width: number;
    /** Distance from the text baseline up to the top of the em box, in px. */
    ascent: number;
    /** Distance from the baseline down to the bottom of the em box, in px (positive). */
    descent: number;
    /** True when a real font face measured the string. */
    measured: boolean;
}
export interface TextMetrics {
    measure(request: TextMeasureRequest): Promise<TextMeasurement>;
    /** True when at least one real face is available for this family. */
    hasFamily(family: string): boolean;
    /** Open every face of these families now; `measure` does it lazily otherwise. */
    preload(families: readonly string[]): Promise<void>;
}
/**
 * Deterministic fallback: Latin at 0.52 em, CJK at 1 em, spaces at 0.26 em.
 * Deliberately slightly wide, so an estimated box never claims a fit the real
 * font would not have.
 */
export declare function estimateTextWidth(text: string, sizePx: number): number;
export declare function estimateMeasurement(text: string, sizePx: number): TextMeasurement;
/** Builds a provider over the faces discovery already found. */
export declare function createTextMetrics(fonts: readonly DiscoveredFont[]): TextMetrics;
/** Discovery is process-wide and lazy: one font-directory scan per session. */
export declare function loadSystemTextMetrics(): Promise<TextMetrics>;
