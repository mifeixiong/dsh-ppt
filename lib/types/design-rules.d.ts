import type { DesignFinding } from './art-direction.ts';
/**
 * Refactoring UI laws, checked against rendered slides.
 *
 * The theme recipes and the Art Direction schema decide what a deck *looks*
 * like; this module decides what the rendered result must *obey*. It encodes
 * the machine-checkable half of the rulebook the plugin's design guidance is
 * drawn from — the hierarchy, colour, measure and spacing invariants — so a
 * violation comes back as a named finding instead of a matter of taste.
 *
 * The browser pass in `browser.ts` measures every text leaf (computed type,
 * colour and the solid field behind it) and hands the numbers over as
 * `DesignPageSample`s. This module is pure: no DOM, no clock, no I/O. That is
 * what makes the thresholds auditable and testable without launching Chromium.
 *
 * What is deliberately *not* machine-checked here — the ranking of emphasis,
 * whether space around a group exceeds space inside it, colour-only signalling —
 * needs a rendered judgement and lives in the model visual-review checklist.
 */
/** A rendered colour channel triple, 0..255 per channel. */
export interface RgbColor {
    r: number;
    g: number;
    b: number;
}
/** One text leaf as measured on a rendered slide. */
export interface DesignTextSample {
    /** `data-ppt-id` of the leaf, so a finding names the element to fix. */
    id: string;
    /** `data-art-role`, when the deck declares one. */
    role?: string;
    /** Trimmed text content, capped by the collector. */
    text: string;
    /** Primary font family as computed, e.g. `DengXian`. */
    fontFamily: string;
    /** Computed font size in px. */
    fontSize: number;
    /** Computed font weight, 100..900. */
    fontWeight: number;
    /** Effective foreground colour, already composited over its field when known. */
    color: RgbColor;
    /** Computed element opacity, 0..1. */
    opacity: number;
    /** Computed line-height in px; omitted when the browser reports `normal`. */
    lineHeightPx?: number;
    /** Computed letter-spacing in px (negative tightens). */
    letterSpacingPx: number;
    /** Computed `text-transform`. */
    textTransform: string;
    /** Number of line boxes the text occupies. */
    lines: number;
    /** True when the leaf carries a pure rotate transform. */
    rotated: boolean;
    /** Solid field behind the text; omitted when a gradient, image or unknown layer sits behind it. */
    background?: RgbColor;
}
/** Everything one slide contributed to the audit. */
export interface DesignPageSample {
    page: number;
    texts: DesignTextSample[];
}
/** One documented, machine-checked design law. */
export interface DesignRule {
    id: string;
    /** Reference section in the rulebook the law comes from, e.g. `§2.2.a`. */
    law: string;
    title: string;
    /** The invariant in one line, for docs and review checklists. */
    invariant: string;
}
/**
 * The rule catalogue. `docs/design-rules.md` and the README quote these IDs, so
 * adding a rule means adding it here first, then it appears wherever the
 * findings are surfaced.
 */
export declare const DESIGN_RULES: readonly DesignRule[];
/** Model-review items for the laws no measurement can settle. */
export declare const DESIGN_REVIEW_PROBES: readonly string[];
/** WCAG 2.1 relative luminance of a composited colour. */
export declare function relativeLuminanceRgb(color: RgbColor): number;
/** WCAG 2.1 contrast ratio between two composited colours, from 1 to 21. */
export declare function contrastRatioRgb(a: RgbColor, b: RgbColor): number;
/** HSL of a colour, with saturation and lightness in 0..1. */
export declare function rgbToHsl(color: RgbColor): {
    h: number;
    s: number;
    l: number;
};
export declare function designRuleFindings(pages: readonly DesignPageSample[]): DesignFinding[];
