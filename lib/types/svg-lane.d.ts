import { type PptCreateResult } from './pptx.ts';
import type { SlideTransitionPlan } from './transitions.ts';
import type { AnimationPlan } from './animation.ts';
export interface SvgLaneSummary {
    pages: number;
    shape_count: number;
    text_count: number;
    image_count: number;
    warnings: string[];
}
export interface SvgCreateResult extends PptCreateResult {
    svg: SvgLaneSummary;
}
export interface SvgLaneInput {
    workspace: string;
    svg_path: string;
    outline_path: string;
    output_path: string;
    signal?: AbortSignal;
    transitions?: SlideTransitionPlan;
    animations?: AnimationPlan;
}
export declare function createPptxFromSvg(input: SvgLaneInput): Promise<SvgCreateResult>;
