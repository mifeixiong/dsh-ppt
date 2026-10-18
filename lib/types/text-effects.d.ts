/**
 * Low-opacity ghost text is a poster device: a large bilingual watermark sits
 * behind the headline, the way a print layout repeats a word in a lighter ink.
 * The browser carries it as a text leaf with `opacity`, but pptxgenjs has no
 * text-alpha option, so the finished package is rewritten to put an alpha value
 * on every run colour inside that named text shape. The text stays editable.
 */
export interface TextOpacityEntry {
    /** `data-ppt-id`, which is also the PPTX shape name. */
    id: string;
    opacity: number;
}
export type TextOpacityPlan = ReadonlyMap<number, readonly TextOpacityEntry[]>;
export declare function injectTextOpacity(xml: string, entries: readonly TextOpacityEntry[]): string;
export declare function rewritePptxTextOpacity(data: Uint8Array, plan: TextOpacityPlan): Uint8Array;
