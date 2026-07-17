import { dirname, extname } from "node:path/posix";

import fs from "fs-extra";
import { executeAnimationImporterSource, IAnimationImporterResult, IAnimationImporterSettings } from "babylonjs-editor-tools";

const MAX_ANIMATION_SOURCE_BYTES = 64 * 1024 * 1024;

/** Executes the shared Animation Importer semantics for CLI builds. */
export async function processExportedAnimation(sourcePath: string, outputPath: string, settings: IAnimationImporterSettings): Promise<IAnimationImporterResult> {
	if (![".animation", ".animations", ".animator", ".controller"].includes(extname(sourcePath).toLowerCase())) {
		throw new Error("Animation importer supports .animation, .animations, .animator, and .controller assets.");
	}
	const details = await fs.stat(sourcePath);
	if (details.size > MAX_ANIMATION_SOURCE_BYTES) {
		throw new Error(`Animation importer sources are limited to ${MAX_ANIMATION_SOURCE_BYTES} bytes.`);
	}
	const source = await fs.readFile(sourcePath, "utf-8");
	const executed = executeAnimationImporterSource(source, sourcePath, settings);
	await fs.ensureDir(dirname(outputPath));
	await fs.writeJSON(outputPath, executed.document, { spaces: "\t" });
	return {
		sourcePath,
		outputPath,
		sourceKind: executed.sourceKind,
		settings,
		sourceBytes: details.size,
		clips: executed.clips,
		tracks: executed.tracks,
		rootMotion: executed.rootMotion,
		controllerStateCount: executed.controllerStateCount,
		controllerTransitionCount: executed.controllerTransitionCount,
		controllerFormat: executed.controllerFormat,
		controllerLayerCount: executed.controllerLayerCount,
		controllerParameterCount: executed.controllerParameterCount,
		controllerBlendTreeCount: executed.controllerBlendTreeCount,
		controllerMotionBindings: executed.controllerMotionBindings,
		controllerAvatarMaskBindings: executed.controllerAvatarMaskBindings,
		controllerUnsupportedFeatures: executed.controllerUnsupportedFeatures,
		sourceKeyCount: executed.sourceKeyCount,
		sampledKeyCount: executed.sampledKeyCount,
		outputKeyCount: executed.outputKeyCount,
		reducedKeyCount: Math.max(0, executed.sampledKeyCount - executed.outputKeyCount),
		valid: executed.errors.length === 0,
		errors: [...new Set(executed.errors)],
		warnings: [...new Set(executed.warnings)],
	};
}
