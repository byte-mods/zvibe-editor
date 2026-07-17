import { createHash } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeJSON } from "fs-extra";

import { executeAnimationImporterSource, IAnimationImporterResult, IAnimationImporterSettings, normalizeAnimationImporterSettings } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { readAssetMetadata } from "./registry";

const MAX_ANIMATION_SOURCE_BYTES = 64 * 1024 * 1024;

export interface IAnimationImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IAnimationImporterResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

async function contentHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function animationImporterFingerprint(path: string, settings: IAnimationImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

function validateExtension(path: string): void {
	if (![".animation", ".animations", ".animator", ".controller"].includes(extname(path).toLowerCase())) {
		throw new Error("Animation importer supports .animation, .animations, .animator, and .controller assets.");
	}
}

/** Executes clip resampling, key reduction, looping, root-motion checks, and controller validation into one portable animation artifact. */
export async function processAnimationImporterOutput(sourcePath: string, requestedOutputPath: string, settings: IAnimationImporterSettings): Promise<IAnimationImporterResult> {
	validateExtension(sourcePath);
	const details = await stat(sourcePath);
	if (details.size > MAX_ANIMATION_SOURCE_BYTES) {
		throw new Error(`Animation importer sources are limited to ${MAX_ANIMATION_SOURCE_BYTES} bytes.`);
	}
	const source = await readFile(sourcePath, "utf-8");
	const executed = executeAnimationImporterSource(source, sourcePath, settings);
	await ensureDir(dirname(requestedOutputPath));
	await writeJSON(requestedOutputPath, executed.document, { spaces: "\t" });
	return {
		sourcePath,
		outputPath: requestedOutputPath,
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

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "animation-import.json") };
}

export async function getAnimationImporterArtifactStatus(path: string): Promise<IAnimationImporterArtifactStatus> {
	validateExtension(path);
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "animation") {
		throw new Error("Animation importer artifacts are only available for animation assets.");
	}
	const settings = normalizeAnimationImporterSettings(metadata.importer.settings);
	const fingerprint = await animationImporterFingerprint(path, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(path);
	let result: IAnimationImporterResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result;
		}
	} catch {
		// A missing or malformed lease manifest makes the artifact stale.
	}
	const exists = result ? await pathExists(result.outputPath) : await pathExists(artifactDirectory);
	return { path, artifactDirectory, manifestPath, fingerprint, current: result !== null && exists, exists, result };
}

export async function applyAnimationImporterArtifact(path: string, expectedFingerprint: string): Promise<IAnimationImporterArtifactStatus> {
	const status = await getAnimationImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Animation importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeAnimationImporterSettings(metadata.importer.settings);
	const temporaryDirectory = `${status.artifactDirectory}.tmp-${process.pid}-${Date.now()}`;
	await remove(temporaryDirectory);
	try {
		const generated = await processAnimationImporterOutput(path, join(temporaryDirectory, basename(path)), settings);
		await remove(status.artifactDirectory);
		await ensureDir(dirname(status.artifactDirectory));
		await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
		const result = {
			...generated,
			outputPath: generated.outputPath.replace(temporaryDirectory, status.artifactDirectory),
		};
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}
