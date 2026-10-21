import type { BrowserRuntime } from './browser.ts';
import type { DeckIR } from './ir.ts';
import { type PptOutline } from './outline.ts';
import type { SessionOwner } from './session-resources.ts';
import { type SlideTransitionPlan } from './transitions.ts';
import { type AnimationPlan } from './animation.ts';
export type PptFallbackMode = 'reject' | 'rasterize-element';
export interface RasterizedElementRecord {
    page: number;
    element_id: string;
    reason: string;
    image_path: string;
}
export interface PptCreateResult {
    pptx_path: string;
    page_count: number;
    native_element_count: number;
    rasterized_elements: RasterizedElementRecord[];
    structural_status: 'passed';
}
export interface PptxPackageInspection {
    pageCount: number;
    widthEmu: number;
    heightEmu: number;
    entries: string[];
}
export declare function inspectPptxPackage(data: Uint8Array, expectedPages: number): PptxPackageInspection;
export declare function createPptx(browser: BrowserRuntime, owner: SessionOwner, workspace: string, htmlPathInput: string, outlinePathInput: string, outputPathInput: string, fallbackMode?: PptFallbackMode, signal?: AbortSignal, transitions?: SlideTransitionPlan, animations?: AnimationPlan): Promise<PptCreateResult>;
export interface WriteDeckPptxOptions {
    /** The slide tree to write. Both the HTML lane and the outline lane produce one. */
    ir: DeckIR;
    outline: PptOutline;
    workspace: string;
    artifactRoot: string;
    outputPath: string;
    signal?: AbortSignal;
    transitions?: SlideTransitionPlan;
    animations?: AnimationPlan;
    /** Elements already degraded to images by the caller; the writer only records them. */
    rasterized?: readonly RasterizedElementRecord[];
    subject?: string;
}
/**
 * The single PPTX writer. Both entry points converge here: the HTML lane hands
 * over an IR measured from a rendered page, the outline lane a deterministic IR
 * built from the content model, and everything downstream — native shapes,
 * backgrounds, motion, OOXML validation, atomic commit — is identical. Keeping
 * one writer is what makes the fast lane skip *work*, not *guarantees*.
 */
export declare function writeDeckPptx(options: WriteDeckPptxOptions): Promise<PptCreateResult>;
/**
 * Fast lane: build the PPTX straight from `outline.json` (+ `design-plan.json`)
 * with no HTML authoring, no browser render and no preview pass.
 *
 * It shares every guarantee the HTML lane has after the IR exists — the same
 * writer, the same OOXML validation, the same atomic commit — and it drops the
 * two steps that only exist to feed the design loop: authoring the HTML and
 * measuring it in a browser.
 */
export declare function createPptxFromOutline(workspace: string, outlinePathInput: string, outputPathInput: string, signal?: AbortSignal, transitions?: SlideTransitionPlan, animations?: AnimationPlan): Promise<PptCreateResult>;
