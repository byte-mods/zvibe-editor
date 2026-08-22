import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";

import { ensureDir, lstat, move, pathExists, readFile, readJSON, realpath, remove, stat, writeFile } from "fs-extra";
import sharp from "sharp";

import {
	ASEPRITE_ATLAS_MODEL,
	ASEPRITE_IMPORTER_MODEL,
	ASEPRITE_MAX_SOURCE_BYTES,
	bindAsepriteExternalTilesets,
	buildAsepriteAtlas,
	createAsepriteAtlasJson,
	IAsepriteAtlas,
	IAsepriteAtlasDependencyEvidence,
	IAsepriteDocument,
	IAsepriteDocumentSummary,
	IAsepriteImporterSettings,
	normalizeAsepriteImporterSettings,
	parseAseprite,
	summarizeAsepriteDocument,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";

import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { readAssetMetadata } from "./registry";

export type IAsepriteDependencyEvidence = IAsepriteAtlasDependencyEvidence;
export type { IAsepriteDocumentSummary };

export interface IAsepriteImporterResult {
	model: typeof ASEPRITE_IMPORTER_MODEL;
	sourcePath: string;
	sourceBytes: number;
	sourceSha256: string;
	settings: IAsepriteImporterSettings;
	settingsSha256: string;
	dependencies: IAsepriteDependencyEvidence[];
	atlasImagePath: string;
	atlasImageBytes: number;
	atlasImageSha256: string;
	atlasJsonPath: string;
	atlasJsonBytes: number;
	atlasJsonSha256: string;
	document: IAsepriteDocumentSummary;
	atlas: Omit<IAsepriteAtlas, "pixels">;
}

export interface IAsepriteImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	sourceSha256: string;
	dependencies: IAsepriteDependencyEvidence[];
	current: boolean;
	exists: boolean;
	result: IAsepriteImporterResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function validateExtension(path: string): void {
	if (![".ase", ".aseprite"].includes(extname(path).toLowerCase())) {
		throw new Error("Aseprite importer requires a .ase or .aseprite source asset.");
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

function settingsHash(settings: IAsepriteImporterSettings): string {
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

function portablePath(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function isOutside(root: string, path: string): boolean {
	const containment = relative(root, path);
	return containment.split(/[\\/]/)[0] === ".." || isAbsolute(containment);
}

async function canonicalProjectFile(path: string, label: string): Promise<string> {
	const root = await realpath(projectDirectory());
	const requested = resolve(path);
	const [canonical, details] = await Promise.all([realpath(requested), lstat(requested)]).catch(() => {
		throw new Error(`${label} does not resolve to an existing project file: ${path}.`);
	});
	if (isOutside(root, canonical) || !details.isFile()) {
		throw new Error(`${label} must be a regular file inside the open project: ${path}.`);
	}
	return canonical;
}

interface ILoadedAsepriteDocument {
	path: string;
	bytes: Uint8Array;
	sha256: string;
	document: IAsepriteDocument;
}

interface IPreparedAsepriteSource extends ILoadedAsepriteDocument {
	fingerprint: string;
	dependencies: IAsepriteDependencyEvidence[];
}

/** Reads, recursively binds, and fingerprints one project-contained Aseprite dependency graph before any artifact mutation. */
async function prepareAsepriteSource(path: string, settings: IAsepriteImporterSettings): Promise<IPreparedAsepriteSource> {
	const root = await realpath(projectDirectory());
	const cache = new Map<string, ILoadedAsepriteDocument>();
	const dependencies: IAsepriteDependencyEvidence[] = [];
	let aggregateBytes = 0;
	const load = async (requestedPath: string, ancestors: string[]): Promise<ILoadedAsepriteDocument> => {
		const canonical = await canonicalProjectFile(requestedPath, ancestors.length ? "Aseprite external dependency" : "Aseprite source");
		validateExtension(canonical);
		if (ancestors.includes(canonical)) {
			throw new Error(`Aseprite external dependency cycle detected at ${portablePath(root, canonical)}.`);
		}
		const cached = cache.get(canonical);
		if (cached) {
			return cached;
		}
		if (ancestors.length >= 64 || cache.size >= 64) {
			throw new Error("Aseprite import supports at most 64 unique source/dependency files.");
		}
		const details = await stat(canonical);
		if (details.size < 128 || details.size > ASEPRITE_MAX_SOURCE_BYTES) {
			throw new Error(`Aseprite source ${portablePath(root, canonical)} must contain 128 through ${ASEPRITE_MAX_SOURCE_BYTES} bytes.`);
		}
		aggregateBytes += details.size;
		if (aggregateBytes > ASEPRITE_MAX_SOURCE_BYTES * 2) {
			throw new Error(`Aseprite source and dependency bytes exceed the bounded ${ASEPRITE_MAX_SOURCE_BYTES * 2}-byte aggregate limit.`);
		}
		const buffer = await readFile(canonical);
		const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const loaded: ILoadedAsepriteDocument = {
			path: canonical,
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			document: parseAseprite(bytes),
		};
		const bindings: Array<{ externalFileId: number; document: IAsepriteDocument }> = [];
		const externalIds = [...new Set(loaded.document.tilesets.flatMap((tileset) => (tileset.pixels || tileset.externalFileId === null ? [] : [tileset.externalFileId])))].sort(
			(a, b) => a - b
		);
		for (const externalFileId of externalIds) {
			const declaration = loaded.document.externalFiles.find((entry) => entry.id === externalFileId && entry.type === "tileset");
			if (!declaration) {
				throw new Error(`Aseprite source ${portablePath(root, canonical)} is missing external tileset declaration ${externalFileId}.`);
			}
			if (!declaration.name || declaration.name.includes("\0")) {
				throw new Error(`Aseprite external tileset declaration ${externalFileId} has an invalid path.`);
			}
			const dependency = await load(resolve(dirname(canonical), declaration.name.replaceAll("\\", "/")), [...ancestors, canonical]);
			const tilesetIds = [
				...new Set(
					loaded.document.tilesets
						.filter((tileset) => !tileset.pixels && tileset.externalFileId === externalFileId && tileset.externalTilesetId !== null)
						.map((tileset) => tileset.externalTilesetId!)
				),
			].sort((a, b) => a - b);
			dependencies.push({
				ownerPath: portablePath(root, canonical),
				externalFileId,
				declaredName: declaration.name,
				path: portablePath(root, dependency.path),
				sourceBytes: dependency.bytes.byteLength,
				sourceSha256: dependency.sha256,
				tilesetIds,
			});
			bindings.push({ externalFileId, document: dependency.document });
		}
		if (bindings.length) {
			bindAsepriteExternalTilesets(loaded.document, bindings);
		}
		cache.set(canonical, loaded);
		return loaded;
	};
	const loaded = await load(path, []);
	dependencies.sort((a, b) => a.ownerPath.localeCompare(b.ownerPath) || a.externalFileId - b.externalFileId || a.path.localeCompare(b.path));
	const fingerprint = createHash("sha256")
		.update(ASEPRITE_IMPORTER_MODEL)
		.update("\0")
		.update(portablePath(root, loaded.path))
		.update("\0")
		.update(loaded.sha256)
		.update("\0")
		.update(JSON.stringify(settings))
		.update("\0")
		.update(JSON.stringify(dependencies))
		.digest("hex");
	return { ...loaded, fingerprint, dependencies };
}

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "aseprite-import.json") };
}

async function validateCurrentResult(
	result: IAsepriteImporterResult,
	expected: { artifactDirectory: string; sourcePath: string; sourceBytes: number; sourceSha256: string; settingsSha256: string; dependencies: IAsepriteDependencyEvidence[] }
): Promise<boolean> {
	try {
		if (
			result.model !== ASEPRITE_IMPORTER_MODEL ||
			result.sourcePath !== expected.sourcePath ||
			result.sourceBytes !== expected.sourceBytes ||
			result.sourceSha256 !== expected.sourceSha256 ||
			result.settingsSha256 !== expected.settingsSha256 ||
			settingsHash(result.settings) !== expected.settingsSha256 ||
			JSON.stringify(result.dependencies) !== JSON.stringify(expected.dependencies) ||
			result.atlasImagePath !== join(expected.artifactDirectory, "atlas.png") ||
			result.atlasJsonPath !== join(expected.artifactDirectory, "atlas.json") ||
			!Number.isSafeInteger(result.atlasImageBytes) ||
			result.atlasImageBytes <= 0 ||
			result.atlasImageBytes > 512 * 1024 * 1024 ||
			!Number.isSafeInteger(result.atlasJsonBytes) ||
			result.atlasJsonBytes <= 0 ||
			result.atlasJsonBytes > 128 * 1024 * 1024
		) {
			return false;
		}
		const [imageDetails, jsonDetails] = await Promise.all([lstat(result.atlasImagePath), lstat(result.atlasJsonPath)]);
		if (
			!imageDetails.isFile() ||
			!jsonDetails.isFile() ||
			imageDetails.size !== result.atlasImageBytes ||
			jsonDetails.size !== result.atlasJsonBytes ||
			(await contentHash(result.atlasImagePath)) !== result.atlasImageSha256 ||
			(await contentHash(result.atlasJsonPath)) !== result.atlasJsonSha256
		) {
			return false;
		}
		const json = await readJSON(result.atlasJsonPath);
		const metadata = await sharp(result.atlasImagePath).metadata();
		return (
			json?.meta?.zvibe?.model === ASEPRITE_ATLAS_MODEL &&
			json?.meta?.zvibe?.source?.bytes === result.sourceBytes &&
			json?.meta?.zvibe?.source?.sha256 === result.sourceSha256 &&
			json?.meta?.zvibe?.settingsSha256 === result.settingsSha256 &&
			JSON.stringify(json?.meta?.zvibe?.dependencies) === JSON.stringify(result.dependencies) &&
			Object.keys(json?.frames ?? {}).length === result.atlas.frames.length &&
			json?.meta?.size?.w === result.atlas.width &&
			json?.meta?.size?.h === result.atlas.height &&
			metadata.width === result.atlas.width &&
			metadata.height === result.atlas.height &&
			metadata.channels === 4
		);
	} catch {
		return false;
	}
}

/** Inspects the exact source/settings lease and any atomically published native Aseprite atlas. */
export async function getAsepriteImporterArtifactStatus(path: string): Promise<IAsepriteImporterArtifactStatus> {
	validateExtension(path);
	const canonicalPath = await canonicalProjectFile(path, "Aseprite source");
	const metadata = await readAssetMetadata(canonicalPath);
	if (metadata.importer.kind !== "aseprite") {
		throw new Error("Aseprite artifacts are only available for .ase/.aseprite assets.");
	}
	const settings = normalizeAsepriteImporterSettings(metadata.importer.settings);
	const prepared = await prepareAsepriteSource(canonicalPath, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(canonicalPath);
	const expected = {
		artifactDirectory,
		sourcePath: prepared.path,
		sourceBytes: prepared.bytes.byteLength,
		sourceSha256: prepared.sha256,
		settingsSha256: settingsHash(settings),
		dependencies: prepared.dependencies,
	};
	let result: IAsepriteImporterResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.version === 1 && manifest?.fingerprint === prepared.fingerprint && manifest?.result && (await validateCurrentResult(manifest.result, expected))) {
			result = manifest.result;
		}
	} catch {
		// Missing, malformed, moved, or tampered artifacts are stale and never reused.
	}
	return {
		path: prepared.path,
		artifactDirectory,
		manifestPath,
		fingerprint: prepared.fingerprint,
		sourceSha256: prepared.sha256,
		dependencies: prepared.dependencies,
		current: result !== null,
		exists: result !== null || (await pathExists(artifactDirectory)),
		result,
	};
}

/** Applies one exact native Aseprite conversion lease, optionally through the shared Import Accelerator. */
export async function applyAsepriteImporterArtifact(path: string, expectedFingerprint: string): Promise<IAsepriteImporterArtifactStatus> {
	const canonicalPath = await canonicalProjectFile(path, "Aseprite source");
	return applyImporterArtifactWithAccelerator({
		kind: "aseprite",
		sourcePath: canonicalPath,
		expectedFingerprint,
		inspect: () => getAsepriteImporterArtifactStatus(canonicalPath),
		applyLocal: () => applyAsepriteImporterArtifactLocally(canonicalPath, expectedFingerprint),
	});
}

async function applyAsepriteImporterArtifactLocally(path: string, expectedFingerprint: string): Promise<IAsepriteImporterArtifactStatus> {
	const status = await getAsepriteImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Aseprite importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(status.path);
	const settings = normalizeAsepriteImporterSettings(metadata.importer.settings);
	const settingsSha256 = settingsHash(settings);
	const prepared = await prepareAsepriteSource(status.path, settings);
	if (prepared.fingerprint !== expectedFingerprint) {
		throw new Error(`Aseprite importer plan changed during preparation. Inspect again and use current fingerprint ${prepared.fingerprint}.`);
	}
	const atlas = buildAsepriteAtlas(prepared.document, settings);
	const temporaryDirectory = `${status.artifactDirectory}.${randomUUID()}.tmp`;
	const backupDirectory = `${status.artifactDirectory}.${randomUUID()}.backup`;
	await remove(temporaryDirectory);
	try {
		await ensureDir(temporaryDirectory);
		const imageBytes = await sharp(Buffer.from(atlas.pixels), { raw: { width: atlas.width, height: atlas.height, channels: 4 } })
			.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
			.toBuffer();
		const imagePath = join(temporaryDirectory, "atlas.png");
		const jsonPath = join(temporaryDirectory, "atlas.json");
		await writeFile(imagePath, imageBytes);
		const jsonBytes = Buffer.from(
			`${JSON.stringify(
				createAsepriteAtlasJson(
					prepared.document,
					atlas,
					{ name: basename(prepared.path), bytes: prepared.bytes.byteLength, sha256: prepared.sha256 },
					settingsSha256,
					prepared.dependencies
				),
				null,
				"\t"
			)}\n`
		);
		await writeFile(jsonPath, jsonBytes);
		const { pixels: _pixels, ...atlasSummary } = atlas;
		const result: IAsepriteImporterResult = {
			model: ASEPRITE_IMPORTER_MODEL,
			sourcePath: prepared.path,
			sourceBytes: prepared.bytes.byteLength,
			sourceSha256: prepared.sha256,
			settings,
			settingsSha256,
			dependencies: prepared.dependencies,
			atlasImagePath: join(status.artifactDirectory, "atlas.png"),
			atlasImageBytes: imageBytes.byteLength,
			atlasImageSha256: createHash("sha256").update(imageBytes).digest("hex"),
			atlasJsonPath: join(status.artifactDirectory, "atlas.json"),
			atlasJsonBytes: jsonBytes.byteLength,
			atlasJsonSha256: createHash("sha256").update(jsonBytes).digest("hex"),
			document: summarizeAsepriteDocument(prepared.document),
			atlas: atlasSummary,
		};
		await writeFile(
			join(temporaryDirectory, "aseprite-import.json"),
			`${JSON.stringify({ version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, null, "\t")}\n`
		);
		await ensureDir(dirname(status.artifactDirectory));
		if (await pathExists(status.artifactDirectory)) {
			await move(status.artifactDirectory, backupDirectory, { overwrite: true });
		}
		try {
			await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
			const published = await getAsepriteImporterArtifactStatus(prepared.path);
			if (!published.current || published.fingerprint !== prepared.fingerprint || !published.result) {
				throw new Error("Published Aseprite artifacts failed their exact source/settings/dependency integrity validation.");
			}
			await remove(backupDirectory);
			return published;
		} catch (error) {
			await remove(status.artifactDirectory);
			if (await pathExists(backupDirectory)) {
				await move(backupDirectory, status.artifactDirectory, { overwrite: true });
			}
			throw error;
		}
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}
