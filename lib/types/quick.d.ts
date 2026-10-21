import type { ArtDirection } from './art-direction.ts';
import type { PptOutline } from './outline.ts';
import { type DeckIR } from './ir.ts';
/** Canvas geometry, documented once here because every page family uses it. */
export declare const MARGIN_X = 72;
export declare const MARGIN_Y = 64;
export declare const CONTENT_W: number;
export declare const CONTENT_H: number;
export declare const BOTTOM: number;
/** The documented type scale. Each entry is px on the 1280x720 canvas. */
export declare const TYPE_SCALE: {
    readonly poster: 72;
    readonly section: 56;
    readonly title: 44;
    readonly lead: 26;
    readonly body: 24;
    readonly bodySmall: 21;
    readonly small: 16;
    readonly metric: 88;
};
export interface Rgb {
    r: number;
    g: number;
    b: number;
}
export declare function parseHex(value: string): Rgb;
/** Parse either `#RRGGBB` or the `rgb(r, g, b)` form the IR carries. */
export declare function parseColor(value: string): Rgb;
export declare function toCssColor(color: Rgb): string;
export declare function relativeLuminance(color: Rgb): number;
export declare function contrastRatio(a: Rgb, b: Rgb): number;
/** Linear blend: `ratio` 0 -> `from`, 1 -> `to`. */
export declare function mix(from: Rgb, to: Rgb, ratio: number): Rgb;
/** Push `color` toward white or black until it clears `target` contrast on `field`. */
export declare function ensureContrast(color: Rgb, field: Rgb, target: number): Rgb;
export interface PagePalette {
    background: string;
    ink: string;
    muted: string;
    rule: string;
    accent: string;
    surface: string;
    isDark: boolean;
}
export declare function paletteFor(backgroundRole: 'light' | 'dark' | 'accent' | 'image', accentValue: string, plan: ArtDirection | undefined): PagePalette;
/**
 * Greedy wrap used only to *size* a text box: PowerPoint re-wraps on its own,
 * so the estimate errs wide (7%) to guarantee the box is tall enough.
 */
export declare function wrapText(text: string, fontPx: number, widthPx: number): string[];
export declare function measureText(text: string, fontPx: number, widthPx: number, lineHeight: number): number;
/** Step a display size down when the longest unbreakable run would not fit. */
export declare function fitDisplay(text: string, base: number, widthPx: number, min: number): number;
type Slide = PptOutline[number];
export interface QuickLayoutOptions {
    /** Workspace root; asset paths in the outline are workspace-relative. */
    workspace: string;
    /** The artifact directory that owns this deck, i.e. `dirname(outline.json)`. */
    artifactRoot: string;
    /** The Art Direction plan written next to the outline, when the deck has one. */
    designPlan?: ArtDirection;
}
export declare function familyFor(slide: Slide): 'poster' | 'statement' | 'columns' | 'sequenced' | 'metrics' | 'media';
/**
 * Build the slide tree for an entire deck. The only asynchronous part is
 * resolving frozen image assets; every page is laid out by pure arithmetic, so
 * the same outline always produces the same PPTX.
 */
export declare function buildOutlineDeckIr(outline: PptOutline, options: QuickLayoutOptions): Promise<DeckIR>;
export {};
