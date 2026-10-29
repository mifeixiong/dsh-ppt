/*!
 * DSH PPT — host-plane entry for the PPT design plugin.
 *
 * Maintained fork / default install source : https://github.com/mifeixiong/dsh-ppt
 * Source fork (upstream, sync-only)        : https://github.com/yejiming/dsh-ppt
 *
 * Policy: changes land on this fork's main branch and are published from there;
 * no pull requests are sent upstream. Keep this header in step with
 * package.json (repository / homepage / bugs / upstream / dsh.install)
 * and dsh-plugin.json (source.repository).
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
import { PptError, PPT_ERROR_CODES, type PptErrorCode } from './errors.ts';
import { createPptRuntime, type PptRuntime, type PptRuntimeOptions } from './runtime.ts';
import { PPT_CORE_TOOL_NAMES, PPT_MODE_TOOL_NAMES, PPT_OFFICE_TOOL_NAMES, PPT_TOOL_NAMES, type PptToolName } from './schemas.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        pptRuntime: PptRuntime;
    }
}
export { createPptRuntime, PptError, PPT_ERROR_CODES, PPT_CORE_TOOL_NAMES, PPT_MODE_TOOL_NAMES, PPT_OFFICE_TOOL_NAMES, PPT_TOOL_NAMES, };
export type { PptErrorCode, PptRuntime, PptRuntimeOptions, PptToolName };
export declare const name = "dsh-ppt";
export declare const inject: string[];
export interface Config {
    presetId: string;
    pythonExecutable: string;
    browserExecutable: string;
    fontDirs: string[];
    outputRoot: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    presetId: z<string, string>;
    pythonExecutable: z<string, string>;
    browserExecutable: z<string, string>;
    fontDirs: z<string[], string[]>;
    outputRoot: z<string, string>;
}>, Schemastery.ObjectT<{
    presetId: z<string, string>;
    pythonExecutable: z<string, string>;
    browserExecutable: z<string, string>;
    fontDirs: z<string[], string[]>;
    outputRoot: z<string, string>;
}>>;
export declare function assertSupportedPlatform(platform?: NodeJS.Platform): void;
/**
 * Provide the host-plane PPT runtime. The model-facing PPT preset is declared by
 * this package's `cordis.patch.yml`, because the DSH agent-preset registry
 * composes presets from ordinary plugin rows and no longer scans
 * `<dshHome>/.agent-presets`.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
