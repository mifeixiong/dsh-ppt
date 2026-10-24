import type { Box, DashSpec, SubPath } from './svg-geometry.ts';
/**
 * DrawingML for the SVG lane.
 *
 * The HTML lane expresses its leaves through pptxgenjs, which covers rectangles,
 * text, pictures and tables — but not custom geometry, gradients inside a shape,
 * dash patterns or arrowheads. This module serializes one `<p:sp>` per SVG leaf
 * so the finished package can carry real freeform geometry, and it rewrites the
 * slide parts of an already-written package, mirroring the transition,
 * background and animation rewrites.
 *
 * Three schema facts drive the shape of this code:
 *
 * - `<a:ln>` is a sequence, not a bag of attributes: fill, `prstDash`, join,
 *   `headEnd`, `tailEnd`. PowerPoint rejects (or silently drops) children that
 *   arrive in another order, so every child here is emitted positionally.
 * - PowerPoint ignores `headEnd`/`tailEnd` on custom geometry. A line that has
 *   arrows therefore has to be a preset `prst="line"` shape whose endpoints are
 *   restored with `flipH`/`flipV`, not a `custGeom`.
 * - `a:ext` must be at least 1 EMU on both axes: a horizontal or vertical line
 *   is one EMU thick, not zero.
 */
export type ArrowEnd = 'none' | 'triangle' | 'stealth' | 'diamond' | 'oval' | 'arrow';
export interface GradientStop {
    /** 0..1 */
    offset: number;
    /** `RRGGBB` */
    color: string;
}
export interface SolidPaint {
    type: 'solid';
    /** `RRGGBB` */
    color: string;
}
export interface LinearGradientPaint {
    type: 'linear';
    /** SVG-style angle in degrees: 0 = to the right, 90 = down. */
    angleDeg: number;
    stops: readonly GradientStop[];
}
export interface RadialGradientPaint {
    type: 'radial';
    stops: readonly GradientStop[];
    /** Focus point in object-bounding-box units, 0..1. */
    focusX: number;
    focusY: number;
}
export interface NoPaint {
    type: 'none';
}
export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint | NoPaint;
export interface StrokeSpec {
    paint: Paint;
    widthPx: number;
    dash?: DashSpec;
    cap?: 'butt' | 'round' | 'square';
    join?: 'miter' | 'round' | 'bevel';
    headEnd?: ArrowEnd;
    tailEnd?: ArrowEnd;
}
export type ShapeGeometry = {
    kind: 'preset';
    preset: 'rect' | 'roundRect' | 'ellipse' | 'line';
    box: Box;
    radiusPx?: number;
    flipH?: boolean;
    flipV?: boolean;
} | {
    kind: 'path';
    subpaths: readonly SubPath[];
    box: Box;
    fillable: boolean;
};
export interface ShapeSpec {
    /** Matches the placeholder shape's `objectName`, which becomes `p:cNvPr/@name`. */
    id: string;
    /** Human-readable name shown in PowerPoint's selection pane. */
    name: string;
    geometry: ShapeGeometry;
    fill: Paint;
    /** Element opacity 0..1; multiplied into every paint alpha of this shape. */
    opacity?: number;
    stroke?: StrokeSpec;
}
/** `<a:solidFill>` / `<a:gradFill>` / `<a:noFill>` for a paint. */
export declare function paintXml(paint: Paint, opacity?: number): string;
/** `<a:ln>` for a stroke, including dash, cap, join and line ends. */
export declare function strokeXml(stroke: StrokeSpec, opacity?: number): string;
/** A complete `<p:sp>` for one SVG leaf. */
export declare function shapeXml(spec: ShapeSpec, shapeId: number): string;
/** Replace the `<p:sp>` named `shapeName` in one slide part; throws when absent. */
export declare function replaceSlideShape(slideXml: string, shapeName: string, replacementXml: string): string;
/** Rewrite every slide part named in `plans`; pages without plans stay untouched. */
export declare function rewritePptxSlideShapes(data: Uint8Array, plans: ReadonlyMap<number, readonly ShapeSpec[]>): Uint8Array;
