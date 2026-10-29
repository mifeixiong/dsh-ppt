export interface PptxPageDigest {
    page: number;
    before: string;
    after: string;
}
export interface PptxPatchReport {
    updated_pages: number[];
    unchanged_pages: number[];
    media: {
        added: string[];
        reused: number;
        pruned: string[];
    };
    notes_replaced: number[];
    /** SHA-256 of each patched slide part before and after the splice. */
    slide_digests: PptxPageDigest[];
}
export interface SpliceResult {
    bytes: Uint8Array;
    report: PptxPatchReport;
}
/**
 * Replace the named pages of `target` with the same pages from `reference`.
 * Both packages must already be valid decks with the same slide count.
 *
 * Throws `PPT_UPDATE_PATCH_UNAVAILABLE` when the packages are not comparable
 * part-for-part; the caller is expected to fall back to a full rebuild rather
 * than guess.
 */
export declare function splicePptxPages(target: Uint8Array, reference: Uint8Array, pages: readonly number[]): SpliceResult;
/** Slide numbers present in a deck package; used to sanity-check the outline. */
export declare function deckPageCount(bytes: Uint8Array): number;
