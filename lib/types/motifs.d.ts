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
export declare const MOTIFS: readonly MotifDefinition[];
export declare const MOTIF_IDS: readonly string[];
export declare function findMotif(id: string): MotifDefinition | undefined;
/** Render one motif for a tonal group; the SVG is self-contained and whitelist-safe. */
export declare function renderMotif(id: string, palette: MotifPalette): string;
/** Guard rail for tests and the catalogue: no blocked SVG feature, bounded size. */
export declare function motifSvgFinding(svg: string): string | undefined;
