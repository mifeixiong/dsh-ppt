/**
 * SVG geometry for the native slide lane.
 *
 * The lane accepts a deliberately small SVG subset and turns it into DrawingML
 * custom geometry. This module owns the pure math: path-data parsing, absolute
 * normalization (all curves become cubics), affine transforms, bounding boxes
 * and the `<a:pathLst>` serialization. It has no DOM, no I/O and no knowledge
 * of paints, so every rule can be tested with plain numbers.
 */
export interface Point {
    x: number;
    y: number;
}
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
/**
 * A normalized path segment: absolute, curves are cubic, pen state is explicit.
 *
 * Every subpath's `segments` opens with a `move` segment whose `to` equals
 * `start`; a `close` segment is always last and always matches `closed: true`.
 */
export type PathSegment = {
    type: 'move';
    to: Point;
} | {
    type: 'line';
    to: Point;
} | {
    type: 'cubic';
    c1: Point;
    c2: Point;
    to: Point;
} | {
    type: 'close';
};
export interface SubPath {
    start: Point;
    segments: PathSegment[];
    closed: boolean;
}
/** `[a, b, c, d, e, f]` exactly as in SVG's `matrix()`: x' = a·x + c·y + e. */
export type Matrix = readonly [number, number, number, number, number, number];
export declare const IDENTITY_MATRIX: Matrix;
/** 96 CSS px per inch, 914400 EMU per inch. */
export declare const EMU_PER_PX = 9525;
/** DrawingML angles are 60,000ths of a degree. */
export declare const ANGLE_UNIT = 60000;
export declare function pxToEmu(px: number): number;
export declare function multiplyMatrix(left: Matrix, right: Matrix): Matrix;
export declare function applyMatrix(matrix: Matrix, point: Point): Point;
/**
 * Parse one transform value into the local-to-parent matrix.
 *
 * Transforms compose in document order with the leftmost applied last, so the
 * accumulator is multiplied on the right: `translate(10,20) scale(2)` yields
 * `[2,0,0,2,10,20]` and maps (1,1) to (12,22).
 */
export declare function parseTransform(value: string): Matrix;
/** Parse one path `d` value and normalize to absolute move/line/cubic/close. */
export declare function parsePathData(d: string): SubPath[];
/** Parse a `points` value into coordinate pairs. */
export declare function parsePoints(value: string): Point[];
/** Turn a point list into one subpath (polyline open, polygon closed). */
export declare function polylineToSubPaths(points: readonly Point[], closed: boolean): SubPath[];
/** Apply an affine matrix to every coordinate of every subpath. */
export declare function transformSubPaths(subpaths: readonly SubPath[], matrix: Matrix): SubPath[];
/**
 * Control-point bounding box, the same convention the reference converter uses:
 * curve extremes are not solved exactly, so the box can be slightly larger than
 * the painted curve, never smaller. Coordinates are in the caller's space (px).
 */
export declare function pathBounds(subpaths: readonly SubPath[]): Box | undefined;
export interface PathListOptions {
    /** Emit `fill="norm"` (filled shape) or `fill="none"` (stroke-only open path). */
    fill: boolean;
    /** Multiplier applied to box units before the px→EMU conversion; defaults to 1. */
    scale?: number;
}
/**
 * Serialize subpaths as `<a:pathLst>`, with every point translated to the box
 * origin and scaled to EMU. The returned `<a:path w="…" h="…">` covers the box,
 * so the shape's `a:ext` and the path space agree and PowerPoint does not
 * rescale the geometry.
 */
export declare function pathListXml(subpaths: readonly SubPath[], box: Box, options: PathListOptions): string;
export interface DashSpec {
    preset?: 'solid' | 'dot' | 'dash' | 'lgDash' | 'dashDot' | 'lgDashDot' | 'lgDashDotDot' | 'sysDot' | 'sysDash';
    custom?: {
        d: number;
        sp: number;
    };
}
/**
 * Map `stroke-dasharray` to a DrawingML preset when the pattern is one of the
 * named families, otherwise to a single custom dash/gap pair expressed in
 * percent of line width (DrawingML has no multi-length dash pattern).
 */
export declare function dashFromArray(value: string, strokeWidthPx: number): DashSpec | undefined;
