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
export interface MotifPalette {
    /** Main line/dot colour; the theme's text colour for that tonal group. */
    ink: string;
    /** Accent used sparingly, never as the dominant colour. */
    accent: string;
}
export interface MotifDefinition {
    id: string;
    /** Bilingual name for the catalogue. */
    name: string;
    /** One line saying where this device belongs on a page. */
    placement: string;
    description: string;
    width: number;
    height: number;
    build: (palette: MotifPalette) => string;
}
/** Decorative payload; Code 39 is uppercase, digits, space and `- . $ / + %`. */
export declare const BARCODE_PAYLOAD = "DSH 2026";
export interface BarcodeBar {
    x: number;
    width: number;
}
/**
 * Encode a payload into bar rectangles on an integer module grid. Bars only:
 * the spaces between them are the gaps, so the geometry can be rasterised or
 * drawn as SVG without changing the pattern.
 */
export declare function code39Bars(payload: string, options: {
    module: number;
    quietModules?: number;
}): {
    bars: BarcodeBar[];
    width: number;
};
export declare const MOTIFS: readonly MotifDefinition[];
export declare const MOTIF_IDS: readonly string[];
export declare function findMotif(id: string): MotifDefinition | undefined;
/** Render one motif for a tonal group; the SVG is self-contained and whitelist-safe. */
export declare function renderMotif(id: string, palette: MotifPalette): string;
/** Guard rail for tests and the catalogue: no blocked SVG feature, bounded size. */
export declare function motifSvgFinding(svg: string): string | undefined;
