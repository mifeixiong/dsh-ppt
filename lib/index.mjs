import { n as PptError, t as PPT_ERROR_CODES } from "./errors-Dl_S9HpG.mjs";
import { rt as isSupportedPlatform } from "./quality-Dz3KlrTp.mjs";
import { t as createPptRuntime } from "./runtime-CVFkby4y.mjs";
import { PPT_MODE_TOOL_NAMES, PPT_TOOL_NAMES } from "./schemas.mjs";
import z from "schemastery";
//#region src/index.ts
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
const name = "dsh-ppt";
const inject = ["sandbox", "subprocess"];
const Config = z.object({
	presetId: z.string().pattern(/^[a-z0-9][a-z0-9-]*$/).default("ppt"),
	pythonExecutable: z.string().default(process.platform === "win32" ? "python" : "python3"),
	browserExecutable: z.string().default(""),
	fontDirs: z.array(z.string()).default([]),
	outputRoot: z.string().default("ppt-output")
});
function assertSupportedPlatform(platform = process.platform) {
	if (!isSupportedPlatform(platform)) throw new PptError("PPT_PLATFORM_UNSUPPORTED", `PPT mode supports macOS, Linux, and Windows; unsupported platform: ${platform}`);
}
/**
* Provide the host-plane PPT runtime. The model-facing PPT preset is declared by
* this package's `cordis.patch.yml`, because the DSH agent-preset registry
* composes presets from ordinary plugin rows and no longer scans
* `<dshHome>/.agent-presets`.
*/
async function apply(ctx, config) {
	assertSupportedPlatform();
	const runtime = createPptRuntime({
		context: ctx,
		pythonExecutable: config.pythonExecutable,
		browserExecutable: config.browserExecutable || void 0,
		fontDirs: config.fontDirs,
		outputRoot: config.outputRoot
	});
	ctx.provide("pptRuntime", runtime);
	ctx.effect(() => () => runtime.dispose(), "dsh-ppt: dispose runtime resources");
}
//#endregion
export { Config, PPT_ERROR_CODES, PPT_MODE_TOOL_NAMES, PPT_TOOL_NAMES, PptError, apply, assertSupportedPlatform, createPptRuntime, inject, name };

//# sourceMappingURL=index.mjs.map