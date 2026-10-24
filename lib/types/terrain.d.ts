/**
 * Deterministic terrain for the contour motif.
 *
 * The motif needs a field that has peaks, saddles and islands — a few sine
 * rings around one centre read as a fingerprint, not a map. This module samples
 * fractal Perlin noise (fixed seed, so the same SVG on every call) and extracts
 * iso-lines with marching squares, then stitches the segments into long
 * polylines and simplifies them. Everything is pure arithmetic: no random
 * state, no canvas, no files, and the result is small enough to ship inside a
 * tool response.
 */
export interface TerrainPoint {
    x: number;
    y: number;
}
export interface TerrainLine {
    /** Zero-based iso level index; the caller decides which levels to accent. */
    level: number;
    points: TerrainPoint[];
    /** Polyline length in canvas px, used to drop specks and to budget the output. */
    length: number;
}
export interface TerrainOptions {
    width: number;
    height: number;
    /** Grid spacing in px; smaller finds finer detail and multiplies the point count. */
    step?: number;
    /** Noise wavelength in px per axis; larger values make broader landforms. */
    scaleX?: number;
    scaleY?: number;
    octaves?: number;
    levels?: number;
    /** Douglas–Peucker tolerance in px. */
    epsilon?: number;
    /** Lines shorter than this (px) are dropped as noise specks. */
    minLength?: number;
    /** Hard cap; beyond this the shortest lines are dropped, deterministically. */
    maxLines?: number;
    seed?: number;
}
/** Fixed seed: the motif contract is "same recipe, same SVG". */
export declare const TERRAIN_SEED = 7368820;
/** Improved Perlin noise, range roughly −1..1. */
export declare function perlin2(table: Uint8Array, x: number, y: number): number;
/** Fractal Brownian motion: three octaves is enough terrain without gridding. */
export declare function fbm(table: Uint8Array, x: number, y: number, octaves: number): number;
interface Segment {
    a: TerrainPoint;
    b: TerrainPoint;
}
/**
 * One iso-level through the sampled grid. Cases 5 and 10 are the ambiguous
 * saddles: the cell average decides which pair of corners is connected, which
 * keeps neighbouring cells consistent instead of leaving crossing segments.
 */
export declare function contourSegments(field: Float32Array, columns: number, rows: number, width: number, height: number, level: number): Segment[];
/**
 * Stitch segments into polylines. Without this every cell edge becomes its own
 * `M…L…` pair and the SVG grows by an order of magnitude; a stitched line also
 * draws as one continuous hairline in PowerPoint.
 */
export declare function chainSegments(segments: readonly Segment[]): Array<{
    points: TerrainPoint[];
    length: number;
}>;
/** Douglas–Peucker; keeps the shape and drops the per-cell staircase points. */
export declare function simplifyPolyline(points: readonly TerrainPoint[], epsilon: number): TerrainPoint[];
/**
 * Sample the field, extract every level, stitch and simplify. Lines are ordered
 * by level so the caller can style index contours; within a level the order is
 * the deterministic scan order.
 */
export declare function terrainLines(options: TerrainOptions): TerrainLine[];
export {};
