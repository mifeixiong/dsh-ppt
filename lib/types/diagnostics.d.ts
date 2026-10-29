import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolSurfaceStatus } from './runtime.ts';
export type DiagnosticStatus = 'ready' | 'degraded' | 'not_available' | 'failed';
export interface DiagnosticCheck {
    id: 'platform' | 'tools' | 'browser' | 'python' | 'fonts' | 'renderer' | 'attachments' | 'vision_model';
    status: DiagnosticStatus;
    message: string;
    details?: Readonly<Record<string, unknown>>;
}
export interface PptDiagnosticReport {
    status: 'ready' | 'degraded' | 'failed';
    checks: DiagnosticCheck[];
}
interface DiagnosticRuntime {
    options: {
        context?: Context;
        pythonExecutable?: string;
        browserExecutable?: string;
        fontDirs?: readonly string[];
    };
    toolSurface?: ToolSurfaceStatus;
}
export declare function diagnosePptRuntime(runtime: DiagnosticRuntime, agent?: Agent): Promise<PptDiagnosticReport>;
export {};
