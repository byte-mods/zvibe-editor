import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, relative, resolve } from "node:path/posix";

import fs from "fs-extra";

import {
	getScriptableAudioDependencyPaths,
	IScriptableAudioGeneratorGraph,
	normalizeAssetImporterConfiguration,
	normalizeScriptableAudioGeneratorGraph,
	serializeScriptableAudioRuntimeFingerprintInput,
} from "babylonjs-editor-tools";

const maximumGraphBytes = 8 * 1024 * 1024;
const maximumDependencyBytes = 64 * 1024 * 1024;

export interface IScriptableAudioBuildDependency {
	path: string;
	absolutePath: string;
	sizeBytes: number;
	contentHash: string;
}

export interface IScriptableAudioBuildAsset {
	graph: IScriptableAudioGeneratorGraph;
	contentHash: string;
	runtimeFingerprint: string;
	dependencies: IScriptableAudioBuildDependency[];
}

function contains(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}/`);
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function dependencyIncludedInBuild(path: string): Promise<boolean> {
	let importer = normalizeAssetImporterConfiguration(path, {});
	const sidecar = `${path}.bjsmeta.json`;
	if (await fs.pathExists(sidecar)) {
		try {
			importer = normalizeAssetImporterConfiguration(path, (await fs.readJSON(sidecar)).importer);
		} catch (error) {
			throw new Error(`Audio Generator dependency metadata is invalid for "${path}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return importer.settings.includeInBuild !== false;
}

/** Reads an exact, build-safe graph snapshot and rejects dependencies that cannot ship with it. */
export async function inspectScriptableAudioBuildAsset(file: string, projectDir: string, baseAssetsDir: string): Promise<IScriptableAudioBuildAsset> {
	const projectRoot = resolve(projectDir);
	const assetsRoot = resolve(baseAssetsDir);
	const [projectRealPath, assetsRealPath, sourceRealPath] = await Promise.all([fs.realpath(projectRoot), fs.realpath(assetsRoot), fs.realpath(file)]);
	if (
		!contains(projectRoot, normalize(file)) ||
		!contains(assetsRoot, normalize(file)) ||
		!contains(projectRealPath, sourceRealPath) ||
		!contains(assetsRealPath, sourceRealPath)
	) {
		throw new Error("Audio Generator assets must be contained regular files under the project assets directory.");
	}
	const sourceStat = await fs.stat(file);
	if (!sourceStat.isFile() || sourceStat.size > maximumGraphBytes) {
		throw new Error(`Audio Generator assets must be regular files no larger than ${maximumGraphBytes} bytes.`);
	}
	const bytes = await fs.readFile(file);
	let source: unknown;
	try {
		source = JSON.parse(bytes.toString("utf-8"));
	} catch (error) {
		throw new Error(`Audio Generator asset contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const graph = normalizeScriptableAudioGeneratorGraph(source);
	const dependencies: IScriptableAudioBuildDependency[] = [];
	for (const dependencyPath of getScriptableAudioDependencyPaths(graph)) {
		if (isAbsolute(dependencyPath)) {
			throw new Error(`Audio Generator dependency must be project-relative: ${dependencyPath}.`);
		}
		const absolutePath = normalize(join(projectRoot, dependencyPath));
		if (!contains(projectRoot, absolutePath) || !contains(assetsRoot, absolutePath) || !(await fs.pathExists(absolutePath))) {
			throw new Error(`Audio Generator dependency is missing from the build asset scope: ${dependencyPath}.`);
		}
		const dependencyRealPath = await fs.realpath(absolutePath);
		const details = await fs.stat(absolutePath);
		if (!contains(projectRealPath, dependencyRealPath) || !contains(assetsRealPath, dependencyRealPath) || !details.isFile()) {
			throw new Error(`Audio Generator dependency must be a contained regular asset file: ${dependencyPath}.`);
		}
		if (details.size > maximumDependencyBytes) {
			throw new Error(`Audio Generator dependency exceeds the ${maximumDependencyBytes}-byte exact build limit: ${dependencyPath}.`);
		}
		if (!(await dependencyIncludedInBuild(absolutePath))) {
			throw new Error(`Audio Generator dependency is excluded from the build: ${dependencyPath}.`);
		}
		const dependencyBytes = await fs.readFile(absolutePath);
		dependencies.push({ path: dependencyPath, absolutePath, sizeBytes: details.size, contentHash: hash(dependencyBytes) });
	}
	dependencies.sort((left, right) => left.path.localeCompare(right.path));
	const contentHash = hash(bytes);
	const runtimeFingerprint = createHash("sha256").update(serializeScriptableAudioRuntimeFingerprintInput(contentHash, dependencies)).digest("hex");
	return { graph, contentHash, runtimeFingerprint, dependencies };
}

/** Portable path used only in diagnostics and tests. */
export function scriptableAudioBuildPath(file: string, projectDir: string): string {
	return relative(resolve(projectDir), resolve(file)).replace(/\\/g, "/");
}
