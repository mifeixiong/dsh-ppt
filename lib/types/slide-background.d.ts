import type { SlideBackgroundIR } from './ir.ts';
/**
 * A CSS slide background has to become a native PresentationML background:
 * pptxgenjs can fill a whole slide with a solid color, but it has no API for a
 * per-slide gradient. The finished package is therefore rewritten so only
 * `ppt/slides/slideN.xml` changes, mirroring the transition and animation
 * rewrites. Everything here is pure and DOM-free so the parser can be tested
 * without a browser.
 */
export interface ParsedGradientStop {
    color: string;
    position: number;
}
export interface ParsedLinearGradient {
    angleDeg: number;
    stops: ParsedGradientStop[];
}
export interface SlideBackgroundPlan {
    solid: string;
    gradient?: ParsedLinearGradient;
}
export declare function cssColorToHex(value: string): string | undefined;
export declare function parseLinearGradient(image: string): ParsedLinearGradient | undefined;
export declare function planSlideBackground(background: SlideBackgroundIR | undefined): SlideBackgroundPlan | undefined;
export declare function slideBackgroundXml(plan: SlideBackgroundPlan): string;
export declare function injectSlideBackground(xml: string, plan: SlideBackgroundPlan): string;
export declare function rewritePptxSlideBackgrounds(data: Uint8Array, plans: ReadonlyMap<number, SlideBackgroundPlan>): Uint8Array;
