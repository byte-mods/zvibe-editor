import { dirname, extname } from "node:path/posix";

import fs from "fs-extra";
import { executeAnimationImporterSource, IAnimationImporterResult, IAnimationImporterSettings } from "babylonjs-editor-tools";

const MAX_ANIMATION_SOURCE_BYTES = 64 * 1024 * 1024;

/** Executes the shared Animation Importer semantics for CLI builds. */
export async function processExportedAnimation(sourcePath: string, outputPath: string, settings: IAnimationImporterSettings): Promise<IAnimationImporterResult> {
	if (![".animation", ".animations", ".anim", ".animator", ".controller"].includes(extname(sourcePath).toLowerCase())) {
		throw new Error("Animation importer supports Babylon .animation/.animations, Unity .anim, and .animator/.controller assets.");
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
		sourceFormat: executed.sourceFormat,
		outputFormat: executed.outputFormat,
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
		controllerBehaviourBindings: executed.controllerBehaviourBindings,
		controllerBehaviourBindingCount: executed.controllerBehaviourBindingCount,
		controllerCompatibility: executed.controllerCompatibility,
		controllerUnsupportedFeatures: executed.controllerUnsupportedFeatures,
		activeStateCurveCount: executed.activeStateCurveCount,
		compressedRotationCurveCount: executed.compressedRotationCurveCount,
		objectReferenceCurves: executed.objectReferenceCurves,
		sourceKeyCount: executed.sourceKeyCount,
		sampledKeyCount: executed.sampledKeyCount,
		outputKeyCount: executed.outputKeyCount,
		reducedKeyCount: Math.max(0, executed.sampledKeyCount - executed.outputKeyCount),
		removedConstantScaleTrackCount: executed.removedConstantScaleTrackCount,
		roundTripSafe: executed.roundTripSafe,
		preservedFeatures: executed.preservedFeatures,
		approximatedFeatures: executed.approximatedFeatures,
		unsupportedFeatures: executed.unsupportedFeatures,
		valid: executed.errors.length === 0,
		errors: [...new Set(executed.errors)],
		warnings: [...new Set(executed.warnings)],
	};
}
