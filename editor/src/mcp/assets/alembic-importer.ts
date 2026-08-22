import { createHash } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import { convertAlembicFileToCache } from "babylonjs-editor-cli";
import { IAlembicCacheManifest, IAlembicImporterSettings, normalizeAlembicImporterSettings, parseAlembicCache } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { readAssetMetadata } from "./registry";

export interface IAlembicImporterResult {
	sourcePath: string;
	outputPath: string;
	sourceBytes: number;
	outputBytes: number;
	cacheSha256: string;
	executable: string;
	settings: IAlembicImporterSettings;
	manifest: IAlembicCacheManifest;
	stdout: string;
	stderr: string;
}

export interface IAlembicImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IAlembicImporterResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function validateExtension(path: string): void {
	if (extname(path).toLowerCase() !== ".abc") {
		throw new Error("Alembic importer requires a .abc source asset.");
	}
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

async function fingerprint(path: string, settings: IAlembicImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "alembic-import.json") };
}

async function validateCurrentResult(result: IAlembicImporterResult): Promise<boolean> {
	try {
		if (!(await pathExists(result.outputPath))) {
			return false;
		}
		const details = await stat(result.outputPath);
		if (!details.isFile() || details.size !== result.outputBytes || (await contentHash(result.outputPath)) !== result.cacheSha256) {
			return false;
		}
		const document = parseAlembicCache(new Uint8Array(await readFile(result.outputPath)));
		return document.manifest.source.sha256 === result.manifest.source.sha256 && document.manifest.settingsSha256 === result.manifest.settingsSha256;
	} catch {
		return false;
	}
}

/** Inspects the exact source/settings lease and any atomically published portable cache. */
export async function getAlembicImporterArtifactStatus(path: string): Promise<IAlembicImporterArtifactStatus> {
	validateExtension(path);
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "alembic") {
		throw new Error("Alembic importer artifacts are only available for .abc assets.");
	}
	const settings = normalizeAlembicImporterSettings(metadata.importer.settings);
	const currentFingerprint = await fingerprint(path, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(path);
	let result: IAlembicImporterResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.version === 1 && manifest?.fingerprint === currentFingerprint && manifest?.result && (await validateCurrentResult(manifest.result))) {
			result = manifest.result;
		}
	} catch {
		// Missing, malformed, moved, or corrupted artifacts are stale and never reused.
	}
	const exists = result !== null || (await pathExists(artifactDirectory));
	return { path, artifactDirectory, manifestPath, fingerprint: currentFingerprint, current: result !== null, exists, result };
}

/** Applies one exact Alembic conversion lease, optionally through the shared Import Accelerator. */
export async function applyAlembicImporterArtifact(path: string, expectedFingerprint: string): Promise<IAlembicImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "alembic",
		sourcePath: path,
		expectedFingerprint,
		inspect: () => getAlembicImporterArtifactStatus(path),
		applyLocal: () => applyAlembicImporterArtifactLocally(path, expectedFingerprint),
	});
}

async function applyAlembicImporterArtifactLocally(path: string, expectedFingerprint: string): Promise<IAlembicImporterArtifactStatus> {
	const status = await getAlembicImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Alembic importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeAlembicImporterSettings(metadata.importer.settings);
	const sourceDetails = await stat(path);
	const temporaryDirectory = `${status.artifactDirectory}.tmp-${process.pid}-${Date.now()}`;
	await remove(temporaryDirectory);
	try {
		await ensureDir(temporaryDirectory);
		const generated = await convertAlembicFileToCache(path, { settings });
		const generatedDocument = parseAlembicCache(generated.content);
		const sourceSha256 = await contentHash(path);
		if (
			generated.outputBytes !== generated.content.byteLength ||
			generatedDocument.manifest.source.name !== basename(path) ||
			generatedDocument.manifest.source.bytes !== sourceDetails.size ||
			generatedDocument.manifest.source.sha256 !== sourceSha256 ||
			JSON.stringify(generatedDocument.manifest.settings) !== JSON.stringify(settings)
		) {
			throw new Error("Alembic converter output does not match the exact source bytes and normalized importer settings.");
		}
		const temporaryOutputPath = join(temporaryDirectory, basename(path));
		await writeFile(temporaryOutputPath, generated.content);
		const cacheSha256 = createHash("sha256").update(generated.content).digest("hex");
		const result: IAlembicImporterResult = {
			sourcePath: path,
			outputPath: temporaryOutputPath.replace(temporaryDirectory, status.artifactDirectory),
			sourceBytes: sourceDetails.size,
			outputBytes: generated.outputBytes,
			cacheSha256,
			executable: generated.executable,
			settings,
			manifest: generatedDocument.manifest,
			stdout: generated.stdout,
			stderr: generated.stderr,
		};
		await writeJSON(
			join(temporaryDirectory, "alembic-import.json"),
			{ version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result },
			{ spaces: "\t" }
		);
		await remove(status.artifactDirectory);
		await ensureDir(dirname(status.artifactDirectory));
		await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}
