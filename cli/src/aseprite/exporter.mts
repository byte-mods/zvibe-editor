import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path/posix";

import fs from "fs-extra";
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

const maximumAsepriteGraphFiles = 64;
const asepriteGuidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const artifactLocks = new Map<string, Promise<void>>();

interface IAsepritePublishEntry {
	target: string;
	staged: string;
	backup: string;
	backedUp: boolean;
	published: boolean;
}

interface ILoadedAsepriteDocument {
	path: string;
	bytes: Uint8Array;
	sha256: string;
	document: IAsepriteDocument;
}

export interface IAsepriteBuildSource extends ILoadedAsepriteDocument {
	projectRoot: string;
	projectRelativePath: string;
	settings: IAsepriteImporterSettings;
	settingsSha256: string;
	dependencies: IAsepriteAtlasDependencyEvidence[];
	fingerprint: string;
}

export interface IAsepriteBuildOutputPaths {
	source: string;
	runtimeManifest: string;
	artifactDirectory: string;
	atlasImage: string;
	atlasJson: string;
	importManifest: string;
	sourceRelativePath: string;
	artifactRelativeDirectory: string;
	atlasImageRelativePath: string;
	atlasJsonRelativePath: string;
	importManifestRelativePath: string;
}

export interface IAsepriteBuildOutputManifest {
	version: 1;
	model: typeof ASEPRITE_IMPORTER_MODEL;
	fingerprint: string;
	source: { path: string; name: string; bytes: number; sha256: string };
	settings: IAsepriteImporterSettings;
	settingsSha256: string;
	dependencies: IAsepriteAtlasDependencyEvidence[];
	artifactDirectory: string;
	atlasImage: { path: string; bytes: number; sha256: string };
	atlasJson: { path: string; bytes: number; sha256: string };
	importManifestPath: string;
	document: IAsepriteDocumentSummary;
	atlas: Omit<IAsepriteAtlas, "pixels">;
}

export interface IAsepriteBuildOutput {
	reused: boolean;
	manifest: IAsepriteBuildOutputManifest;
	paths: IAsepriteBuildOutputPaths;
	exportedPaths: string[];
}

export interface IAsepriteBuildOutputOptions {
	projectRoot: string;
	outputRoot: string;
	destination: string;
	guid: string;
	expectedFingerprint?: string;
}

function portablePath(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function isOutside(root: string, path: string): boolean {
	const containment = relative(root, path);
	return containment === ".." || containment.startsWith("../") || isAbsolute(containment);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, "\t")}\n`);
}

function validateAsepriteExtension(path: string): void {
	if (![".ase", ".aseprite"].includes(extname(path).toLowerCase())) {
		throw new Error("Aseprite build source must use the .ase or .aseprite extension.");
	}
}

/** Restricts artifact ownership to one non-traversing registry identity. */
export function normalizeAsepriteBuildGuid(value: unknown, sourceRelativePath: string): string {
	if (typeof value === "string" && asepriteGuidPattern.test(value) && value !== "." && value !== "..") {
		return value;
	}
	return `aseprite-${createHash("sha256").update(sourceRelativePath).digest("hex").slice(0, 32)}`;
}

async function canonicalProjectFile(projectRoot: string, path: string, label: string): Promise<string> {
	const requested = resolve(path);
	const details = await fs.lstat(requested).catch(() => null);
	if (!details?.isFile() || details.isSymbolicLink()) {
		throw new Error(`${label} must be an existing regular, non-symbolic project file: ${path}.`);
	}
	const canonical = await fs.realpath(requested);
	if (isOutside(projectRoot, canonical)) {
		throw new Error(`${label} resolves outside the project: ${path}.`);
	}
	return canonical;
}

/** Resolves, parses, binds, and fingerprints the complete project-contained Aseprite tileset graph before output mutation. */
export async function inspectAsepriteBuildSource(sourcePath: string, projectRootPath: string, settingsValue?: unknown): Promise<IAsepriteBuildSource> {
	const projectRoot = await fs.realpath(projectRootPath);
	const settings = normalizeAsepriteImporterSettings(settingsValue);
	// Resolve the shared byte ceiling only when Aseprite work runs so importing the CLI barrel remains safe for partial Tools mocks.
	const maximumAsepriteGraphBytes = ASEPRITE_MAX_SOURCE_BYTES * 2;
	const cache = new Map<string, ILoadedAsepriteDocument>();
	const dependencies: IAsepriteAtlasDependencyEvidence[] = [];
	let aggregateBytes = 0;
	const load = async (requestedPath: string, ancestors: string[]): Promise<ILoadedAsepriteDocument> => {
		const canonical = await canonicalProjectFile(projectRoot, requestedPath, ancestors.length ? "Aseprite external dependency" : "Aseprite source");
		validateAsepriteExtension(canonical);
		if (ancestors.includes(canonical)) {
			throw new Error(`Aseprite external dependency cycle detected at ${portablePath(projectRoot, canonical)}.`);
		}
		const cached = cache.get(canonical);
		if (cached) {
			return cached;
		}
		if (ancestors.length >= maximumAsepriteGraphFiles || cache.size >= maximumAsepriteGraphFiles) {
			throw new Error(`Aseprite build supports at most ${maximumAsepriteGraphFiles} unique source/dependency files.`);
		}
		const details = await fs.stat(canonical);
		if (details.size < 128 || details.size > ASEPRITE_MAX_SOURCE_BYTES) {
			throw new Error(`Aseprite source ${portablePath(projectRoot, canonical)} must contain 128 through ${ASEPRITE_MAX_SOURCE_BYTES} bytes.`);
		}
		aggregateBytes += details.size;
		if (aggregateBytes > maximumAsepriteGraphBytes) {
			throw new Error(`Aseprite source and dependency bytes exceed the bounded ${maximumAsepriteGraphBytes}-byte aggregate limit.`);
		}
		const buffer = await fs.readFile(canonical);
		if (buffer.byteLength !== details.size) {
			throw new Error(`Aseprite source ${portablePath(projectRoot, canonical)} changed while it was being inspected.`);
		}
		const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const loaded: ILoadedAsepriteDocument = { path: canonical, bytes, sha256: sha256(bytes), document: parseAseprite(bytes) };
		const bindings: Array<{ externalFileId: number; document: IAsepriteDocument }> = [];
		const externalIds = [...new Set(loaded.document.tilesets.flatMap((tileset) => (tileset.pixels || tileset.externalFileId === null ? [] : [tileset.externalFileId])))].sort(
			(left, right) => left - right
		);
		for (const externalFileId of externalIds) {
			const declaration = loaded.document.externalFiles.find((entry) => entry.id === externalFileId && entry.type === "tileset");
			if (!declaration) {
				throw new Error(`Aseprite source ${portablePath(projectRoot, canonical)} is missing external tileset declaration ${externalFileId}.`);
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
			].sort((left, right) => left - right);
			dependencies.push({
				ownerPath: portablePath(projectRoot, canonical),
				externalFileId,
				declaredName: declaration.name,
				path: portablePath(projectRoot, dependency.path),
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
	const loaded = await load(sourcePath, []);
	dependencies.sort((left, right) => left.ownerPath.localeCompare(right.ownerPath) || left.externalFileId - right.externalFileId || left.path.localeCompare(right.path));
	const projectRelativePath = portablePath(projectRoot, loaded.path);
	const settingsSha256 = sha256(Buffer.from(JSON.stringify(settings)));
	const fingerprint = createHash("sha256")
		.update(ASEPRITE_IMPORTER_MODEL)
		.update("\0")
		.update(projectRelativePath)
		.update("\0")
		.update(loaded.sha256)
		.update("\0")
		.update(JSON.stringify(settings))
		.update("\0")
		.update(JSON.stringify(dependencies))
		.digest("hex");
	return { ...loaded, projectRoot, projectRelativePath, settings, settingsSha256, dependencies, fingerprint };
}

/** Derives every owned output without accepting caller-controlled relative artifact paths. */
export function getAsepriteBuildOutputPaths(outputRoot: string, destination: string, guidValue: string): IAsepriteBuildOutputPaths {
	const normalizedRoot = resolve(outputRoot);
	const normalizedDestination = resolve(destination);
	const sourceRelativePath = portablePath(normalizedRoot, normalizedDestination);
	if (!sourceRelativePath || isOutside(normalizedRoot, normalizedDestination)) {
		throw new Error("Aseprite build destination must be inside the output root.");
	}
	const guid = normalizeAsepriteBuildGuid(guidValue, normalize(sourceRelativePath));
	const artifactRelativeDirectory = `.bjseditor/imported-assets/${guid}`;
	const artifactDirectory = join(normalizedRoot, artifactRelativeDirectory);
	return {
		source: normalizedDestination,
		runtimeManifest: `${normalizedDestination}.bjsaseprite.json`,
		artifactDirectory,
		atlasImage: join(artifactDirectory, "atlas.png"),
		atlasJson: join(artifactDirectory, "atlas.json"),
		importManifest: join(artifactDirectory, "aseprite-import.json"),
		sourceRelativePath,
		artifactRelativeDirectory,
		atlasImageRelativePath: `${artifactRelativeDirectory}/atlas.png`,
		atlasJsonRelativePath: `${artifactRelativeDirectory}/atlas.json`,
		importManifestRelativePath: `${artifactRelativeDirectory}/aseprite-import.json`,
	};
}

function outputManifestMatchesSource(manifest: Partial<IAsepriteBuildOutputManifest>, source: IAsepriteBuildSource, paths: IAsepriteBuildOutputPaths): boolean {
	return (
		manifest.version === 1 &&
		manifest.model === ASEPRITE_IMPORTER_MODEL &&
		manifest.fingerprint === source.fingerprint &&
		manifest.source?.path === source.projectRelativePath &&
		manifest.source?.name === basename(source.path) &&
		manifest.source?.bytes === source.bytes.byteLength &&
		manifest.source?.sha256 === source.sha256 &&
		manifest.settingsSha256 === source.settingsSha256 &&
		JSON.stringify(manifest.settings) === JSON.stringify(source.settings) &&
		JSON.stringify(manifest.dependencies) === JSON.stringify(source.dependencies) &&
		manifest.artifactDirectory === paths.artifactRelativeDirectory &&
		manifest.atlasImage?.path === paths.atlasImageRelativePath &&
		manifest.atlasJson?.path === paths.atlasJsonRelativePath &&
		manifest.importManifestPath === paths.importManifestRelativePath &&
		manifest.atlas?.model === ASEPRITE_ATLAS_MODEL
	);
}

async function regularContainedFile(root: string, path: string): Promise<boolean> {
	const details = await fs.lstat(path).catch(() => null);
	if (!details?.isFile() || details.isSymbolicLink()) {
		return false;
	}
	const [canonicalRoot, canonical] = await Promise.all([fs.realpath(root), fs.realpath(path)]);
	return !isOutside(canonicalRoot, canonical);
}

async function containedFileSize(root: string, path: string, minimum: number, maximum: number): Promise<number | null> {
	if (!(await regularContainedFile(root, path))) {
		return null;
	}
	const size = (await fs.stat(path)).size;
	return Number.isSafeInteger(size) && size >= minimum && size <= maximum ? size : null;
}

async function ensureContainedOutputParent(rootPath: string, path: string): Promise<void> {
	await fs.ensureDir(rootPath);
	await fs.ensureDir(dirname(path));
	const [root, parent] = await Promise.all([fs.realpath(rootPath), fs.realpath(dirname(path))]);
	if (isOutside(root, parent)) {
		throw new Error(`Aseprite build output parent resolves outside the output root: ${dirname(path)}.`);
	}
}

/** Validates source bytes, both manifests, atlas bytes, PNG metadata, and semantic atlas fields before cache reuse. */
export async function asepriteBuildOutputIsCurrent(source: IAsepriteBuildSource, options: IAsepriteBuildOutputOptions): Promise<boolean> {
	try {
		const paths = getAsepriteBuildOutputPaths(options.outputRoot, options.destination, options.guid);
		if (paths.sourceRelativePath !== source.projectRelativePath) {
			return false;
		}
		const required = [paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest] as const;
		const sizes = await Promise.all([
			containedFileSize(options.outputRoot, paths.source, 128, ASEPRITE_MAX_SOURCE_BYTES),
			containedFileSize(options.outputRoot, paths.runtimeManifest, 2, 128 * 1024 * 1024),
			containedFileSize(options.outputRoot, paths.atlasImage, 1, 512 * 1024 * 1024),
			containedFileSize(options.outputRoot, paths.atlasJson, 2, 128 * 1024 * 1024),
			containedFileSize(options.outputRoot, paths.importManifest, 2, 128 * 1024 * 1024),
		]);
		if (sizes.some((size) => size === null) || sizes[0] !== source.bytes.byteLength) {
			return false;
		}
		const [sourceBytes, runtimeBytes, imageBytes, atlasJsonBytes, importBytes] = await Promise.all(required.map((path) => fs.readFile(path)));
		if (!runtimeBytes.equals(importBytes) || sourceBytes.byteLength !== source.bytes.byteLength || sha256(sourceBytes) !== source.sha256) {
			return false;
		}
		const manifest = JSON.parse(runtimeBytes.toString("utf-8")) as Partial<IAsepriteBuildOutputManifest>;
		if (!outputManifestMatchesSource(manifest, source, paths)) {
			return false;
		}
		if (
			!Number.isSafeInteger(manifest.atlasImage?.bytes) ||
			(manifest.atlasImage?.bytes ?? 0) < 1 ||
			(manifest.atlasImage?.bytes ?? 0) > 512 * 1024 * 1024 ||
			!sha256Pattern.test(manifest.atlasImage?.sha256 ?? "") ||
			imageBytes.byteLength !== manifest.atlasImage?.bytes ||
			sha256(imageBytes) !== manifest.atlasImage?.sha256 ||
			!Number.isSafeInteger(manifest.atlasJson?.bytes) ||
			(manifest.atlasJson?.bytes ?? 0) < 1 ||
			(manifest.atlasJson?.bytes ?? 0) > 128 * 1024 * 1024 ||
			!sha256Pattern.test(manifest.atlasJson?.sha256 ?? "") ||
			atlasJsonBytes.byteLength !== manifest.atlasJson?.bytes ||
			sha256(atlasJsonBytes) !== manifest.atlasJson?.sha256
		) {
			return false;
		}
		const atlasJson = JSON.parse(atlasJsonBytes.toString("utf-8"));
		const metadata = await sharp(imageBytes).metadata();
		return (
			metadata.width === manifest.atlas?.width &&
			metadata.height === manifest.atlas?.height &&
			metadata.channels === 4 &&
			atlasJson?.meta?.image === "atlas.png" &&
			atlasJson?.meta?.zvibe?.model === ASEPRITE_ATLAS_MODEL &&
			atlasJson?.meta?.zvibe?.importer === ASEPRITE_IMPORTER_MODEL &&
			atlasJson?.meta?.zvibe?.source?.bytes === source.bytes.byteLength &&
			atlasJson?.meta?.zvibe?.source?.sha256 === source.sha256 &&
			atlasJson?.meta?.zvibe?.settingsSha256 === source.settingsSha256 &&
			JSON.stringify(atlasJson?.meta?.zvibe?.dependencies) === JSON.stringify(source.dependencies) &&
			atlasJson?.meta?.size?.w === manifest.atlas?.width &&
			atlasJson?.meta?.size?.h === manifest.atlas?.height &&
			Object.keys(atlasJson?.frames ?? {}).length === manifest.atlas?.frames?.length
		);
	} catch {
		return false;
	}
}

function exportedPaths(paths: IAsepriteBuildOutputPaths): string[] {
	return [paths.source, paths.runtimeManifest, paths.atlasImage, paths.atlasJson, paths.importManifest];
}

async function currentOutput(paths: IAsepriteBuildOutputPaths): Promise<IAsepriteBuildOutputManifest | null> {
	try {
		const details = await fs.lstat(paths.runtimeManifest);
		if (!details.isFile() || details.isSymbolicLink() || details.size < 2 || details.size > 128 * 1024 * 1024) {
			return null;
		}
		return (await fs.readJSON(paths.runtimeManifest)) as IAsepriteBuildOutputManifest;
	} catch {
		return null;
	}
}

async function withArtifactLock<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = artifactLocks.get(key) ?? Promise.resolve();
	const operation = previous.catch(() => undefined).then(action);
	const tail = operation.then(
		() => undefined,
		() => undefined
	);
	artifactLocks.set(key, tail);
	try {
		return await operation;
	} finally {
		if (artifactLocks.get(key) === tail) {
			artifactLocks.delete(key);
		}
	}
}

async function rollbackPublish(entries: IAsepritePublishEntry[]): Promise<void> {
	for (const entry of [...entries].reverse()) {
		if (entry.published) {
			await fs.remove(entry.target).catch(() => undefined);
		}
		if (entry.backedUp && (await fs.pathExists(entry.backup))) {
			await fs.move(entry.backup, entry.target, { overwrite: true }).catch(() => undefined);
		}
		await fs.remove(entry.staged).catch(() => undefined);
	}
}

/** Publishes a fully staged source, sidecar, and atlas directory while restoring every previous output on any failure. */
async function publishAsepriteBuild(entries: IAsepritePublishEntry[]): Promise<void> {
	for (const entry of entries) {
		if (await fs.pathExists(entry.target)) {
			await fs.move(entry.target, entry.backup, { overwrite: true });
			entry.backedUp = true;
		}
	}
	for (const entry of entries) {
		await fs.move(entry.staged, entry.target, { overwrite: true });
		entry.published = true;
	}
}

function safeOwnedArtifactDirectory(outputRoot: string, value: unknown): string | null {
	if (
		typeof value !== "string" ||
		!value.startsWith(".bjseditor/imported-assets/") ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	) {
		return null;
	}
	const root = resolve(outputRoot);
	const path = join(root, normalize(value));
	return isOutside(root, path) ? null : path;
}

async function removeContainedOutput(rootPath: string, path: string): Promise<void> {
	if (!(await fs.pathExists(rootPath)) || !(await fs.pathExists(dirname(path)))) {
		return;
	}
	const [root, parent] = await Promise.all([fs.realpath(rootPath), fs.realpath(dirname(path))]);
	if (isOutside(root, parent)) {
		throw new Error(`Refusing to remove Aseprite output through a parent outside the output root: ${dirname(path)}.`);
	}
	await fs.remove(path);
}

/** Builds exact PNG/JSON evidence in memory, then publishes it under the source GUID after revalidating the input lease. */
export async function exportAsepriteBuildAsset(sourceValue: IAsepriteBuildSource, options: IAsepriteBuildOutputOptions): Promise<IAsepriteBuildOutput> {
	const paths = getAsepriteBuildOutputPaths(options.outputRoot, options.destination, options.guid);
	if (paths.sourceRelativePath !== sourceValue.projectRelativePath) {
		throw new Error(`Aseprite build destination must preserve project path ${sourceValue.projectRelativePath}.`);
	}
	if (options.expectedFingerprint && options.expectedFingerprint !== sourceValue.fingerprint) {
		throw new Error(`Aseprite build plan changed. Inspect again and use current fingerprint ${sourceValue.fingerprint}.`);
	}
	return withArtifactLock(paths.artifactDirectory, async () => {
		const source = await inspectAsepriteBuildSource(sourceValue.path, options.projectRoot, sourceValue.settings);
		if (source.fingerprint !== sourceValue.fingerprint) {
			throw new Error(`Aseprite source or dependency changed during build. Inspect again and use current fingerprint ${source.fingerprint}.`);
		}
		if (await asepriteBuildOutputIsCurrent(source, options)) {
			const manifest = await currentOutput(paths);
			if (!manifest) {
				throw new Error("Current Aseprite build output lost its runtime manifest during validation.");
			}
			return { reused: true, manifest, paths, exportedPaths: exportedPaths(paths) };
		}
		const prior = await currentOutput(paths);
		const existingArtifactDetails = await fs.lstat(paths.importManifest).catch(() => null);
		const existingArtifactManifest =
			existingArtifactDetails?.isFile() && !existingArtifactDetails.isSymbolicLink() ? await fs.readJSON(paths.importManifest).catch(() => null) : null;
		if (existingArtifactManifest?.source?.path && existingArtifactManifest.source.path !== source.projectRelativePath) {
			throw new Error(`Aseprite asset GUID collision: ${paths.artifactRelativeDirectory} is already owned by ${existingArtifactManifest.source.path}.`);
		}
		const atlas = buildAsepriteAtlas(source.document, source.settings);
		const imageBytes = await sharp(Buffer.from(atlas.pixels), { raw: { width: atlas.width, height: atlas.height, channels: 4 } })
			.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
			.toBuffer();
		const atlasJsonBytes = jsonBytes(
			createAsepriteAtlasJson(
				source.document,
				atlas,
				{ name: basename(source.path), bytes: source.bytes.byteLength, sha256: source.sha256 },
				source.settingsSha256,
				source.dependencies
			)
		);
		const { pixels: _pixels, ...atlasSummary } = atlas;
		const manifest: IAsepriteBuildOutputManifest = {
			version: 1,
			model: ASEPRITE_IMPORTER_MODEL,
			fingerprint: source.fingerprint,
			source: { path: source.projectRelativePath, name: basename(source.path), bytes: source.bytes.byteLength, sha256: source.sha256 },
			settings: source.settings,
			settingsSha256: source.settingsSha256,
			dependencies: source.dependencies,
			artifactDirectory: paths.artifactRelativeDirectory,
			atlasImage: { path: paths.atlasImageRelativePath, bytes: imageBytes.byteLength, sha256: sha256(imageBytes) },
			atlasJson: { path: paths.atlasJsonRelativePath, bytes: atlasJsonBytes.byteLength, sha256: sha256(atlasJsonBytes) },
			importManifestPath: paths.importManifestRelativePath,
			document: summarizeAsepriteDocument(source.document),
			atlas: atlasSummary,
		};
		const manifestBytes = jsonBytes(manifest);
		const transactionId = randomUUID();
		const stagedSource = `${paths.source}.${transactionId}.tmp`;
		const stagedRuntime = `${paths.runtimeManifest}.${transactionId}.tmp`;
		const stagedArtifact = `${paths.artifactDirectory}.${transactionId}.tmp`;
		const entries: IAsepritePublishEntry[] = [
			{ target: paths.source, staged: stagedSource, backup: `${paths.source}.${transactionId}.backup`, backedUp: false, published: false },
			{ target: paths.runtimeManifest, staged: stagedRuntime, backup: `${paths.runtimeManifest}.${transactionId}.backup`, backedUp: false, published: false },
			{ target: paths.artifactDirectory, staged: stagedArtifact, backup: `${paths.artifactDirectory}.${transactionId}.backup`, backedUp: false, published: false },
		];
		try {
			await Promise.all([
				ensureContainedOutputParent(options.outputRoot, stagedSource),
				ensureContainedOutputParent(options.outputRoot, stagedRuntime),
				ensureContainedOutputParent(options.outputRoot, stagedArtifact),
			]);
			await fs.writeFile(stagedSource, source.bytes);
			await fs.writeFile(stagedRuntime, manifestBytes);
			await fs.ensureDir(stagedArtifact);
			await Promise.all([
				fs.writeFile(join(stagedArtifact, "atlas.png"), imageBytes),
				fs.writeFile(join(stagedArtifact, "atlas.json"), atlasJsonBytes),
				fs.writeFile(join(stagedArtifact, "aseprite-import.json"), manifestBytes),
			]);
			await publishAsepriteBuild(entries);
			if (!(await asepriteBuildOutputIsCurrent(source, options))) {
				throw new Error("Published Aseprite build artifacts failed exact integrity validation.");
			}
			await Promise.all(entries.map((entry) => fs.remove(entry.backup).catch(() => undefined)));
			const priorArtifact = safeOwnedArtifactDirectory(options.outputRoot, prior?.artifactDirectory);
			if (priorArtifact && priorArtifact !== paths.artifactDirectory) {
				await fs.remove(priorArtifact).catch(() => undefined);
			}
			return { reused: false, manifest, paths, exportedPaths: exportedPaths(paths) };
		} catch (error) {
			await rollbackPublish(entries);
			throw error;
		}
	});
}

/** Removes only the source, sidecar, and GUID-owned hidden artifact directory recorded by this build output. */
export async function removeAsepriteBuildOutput(destination: string, outputRoot: string, guid?: string): Promise<void> {
	const paths = getAsepriteBuildOutputPaths(outputRoot, destination, guid ?? "");
	const runtimeManifest = paths.runtimeManifest;
	const manifest = await currentOutput(paths);
	const owned = safeOwnedArtifactDirectory(outputRoot, manifest?.artifactDirectory);
	const expected = guid ? paths.artifactDirectory : null;
	const candidates = [paths.source, runtimeManifest, ...(owned ? [owned] : []), ...(expected && expected !== owned ? [expected] : [])];
	for (const candidate of candidates) {
		await removeContainedOutput(outputRoot, candidate);
	}
}
