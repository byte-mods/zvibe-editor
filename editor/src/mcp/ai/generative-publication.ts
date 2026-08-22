import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { realpath } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";

import { copyFile, ensureDir, lstat, move, pathExists, readFile, readJSON, readdir, remove, writeFile } from "fs-extra";
import sharp from "sharp";
import {
	AssetImporterKind,
	GenerativeArtifactRole,
	getDefaultAssetImporterConfiguration,
	IAssetImporterConfiguration,
	IGenerativeAssetProvenance,
	IGenerativeAssetRequest,
	IGenerativeAssetResolvedReference,
	normalizeAssetImporterConfiguration,
	normalizeGenerativeAssetProviderResult,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus } from "../assets/animation-importer";
import { applyAudioImporterArtifact, getAudioImporterArtifactStatus } from "../assets/audio-importer";
import { applyMaterialImporterArtifact, getMaterialImporterArtifactStatus } from "../assets/material-importer";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "../assets/registry";
import { applyTextureImporterArtifact, getTextureImporterArtifactStatus } from "../assets/texture-importer";
import { applyVideoImporterArtifact, getVideoImporterArtifactStatus } from "../assets/video-importer";
import { ensureProjectStoreDirectory, projectPathContains } from "../project/project-store";
import { IValidatedGenerativeArtifact, IValidatedGenerativeCandidate, readGenerativeProviderResultManifest, validateGenerativeProviderOutput } from "./generative-validation";
import { readGenerativeAssetProviderInventory } from "./generative-providers";

const maximumPublicationFiles = 72;
const maximumPublicationRecords = 32;
const maximumMetadataBytes = 1024 * 1024;
const maximumExistingEvidenceBytes = 512 * 1024 * 1024;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const publicationIdPattern = /^generative-publication-[a-f0-9]{24}$/;
const publicationImporterKinds: AssetImporterKind[] = ["texture", "audio", "video", "material", "animation", "custom"];

export type GenerativePublicationRole = GenerativeArtifactRole | "material-packed-orm";

export interface IGenerativeAssetPublicationImporterEvidence {
	kind: AssetImporterKind;
	fingerprint: string | null;
	current: boolean;
	manifestSha256: string | null;
}

export interface IGenerativeAssetPublicationFileRecord {
	path: string;
	guid: string;
	role: GenerativePublicationRole;
	sourceArtifactPath: string | null;
	derived: boolean;
	sha256: string;
	sizeBytes: number;
	metadataSha256: string;
	importer: IGenerativeAssetPublicationImporterEvidence;
}

export interface IGenerativeAssetPublicationRecord {
	id: string;
	revision: number;
	publishedAt: string;
	planFingerprint: string;
	resultFingerprint: string;
	candidateId: string;
	destinationDirectory: string;
	baseName: string;
	overwrite: boolean;
	files: IGenerativeAssetPublicationFileRecord[];
}

export interface IGenerativeAssetPublicationFilePlan {
	path: string;
	guid: string;
	role: GenerativePublicationRole;
	sourceArtifactPath: string | null;
	derived: boolean;
	sha256: string;
	sizeBytes: number;
	metadataSha256: string;
	importerKind: AssetImporterKind;
	action: "create" | "replace";
}

export interface IGenerativeAssetPublicationPlan {
	contract: "zvibe-generative-asset-publication-v1";
	version: 1;
	jobId: string;
	jobRevision: number;
	resultFingerprint: string;
	candidateId: string;
	destinationDirectory: string;
	baseName: string;
	overwrite: boolean;
	planFingerprint: string;
	files: IGenerativeAssetPublicationFilePlan[];
	classification: "generative-ai" | "procedural" | "test-fixture";
	warnings: string[];
}

export interface IGenerativeAssetPublicationJobLease {
	root: string;
	jobDirectory: string;
	outputDirectory: string;
	id: string;
	revision: number;
	status: string;
	provider: {
		id: string;
		name: string;
		vendor: string;
		classification: "generative-ai" | "procedural" | "test-fixture";
		fingerprint: string;
		transport: "executable" | "http";
	};
	request: IGenerativeAssetRequest;
	requestFingerprint: string;
	references: Array<Omit<IGenerativeAssetResolvedReference, "localPath" | "dataBase64">>;
	startedAt: string | null;
	completedAt: string | null;
	resultFingerprint: string | null;
	candidates: IValidatedGenerativeCandidate[];
	execution: {
		durationMilliseconds: number | null;
		exitCode: number | null;
		httpStatus: number | null;
	};
	publicationCount: number;
}

interface IFileEvidence {
	exists: boolean;
	sha256: string | null;
	sizeBytes: number;
}

interface IExistingMetadata {
	guid: string | null;
	labels: string[];
	tags: string[];
	favorite: boolean;
	importer: IAssetImporterConfiguration | null;
}

interface IInternalPublicationFile extends IGenerativeAssetPublicationFilePlan {
	absolutePath: string;
	metadataPath: string;
	metadataBytes: Buffer;
	content: Buffer | null;
	sourceAbsolutePath: string | null;
	existingAsset: IFileEvidence;
	existingMetadata: IFileEvidence;
	importer: IAssetImporterConfiguration;
}

interface IInternalPublicationPlan {
	publicPlan: IGenerativeAssetPublicationPlan;
	files: IInternalPublicationFile[];
}

interface IBackupEntry {
	path: string;
	backupPath: string;
	existed: boolean;
}

const publicationLanes = new Map<string, Promise<void>>();

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)])
		);
	}
	return value;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function contained(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function portable(value: string): string {
	return value.replace(/\\/g, "/");
}

function closedRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const source = value as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	return source;
}

function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
		return false;
	}
	return new Date(value).toISOString() === value;
}

function normalizeDestinationDirectory(value: unknown): string {
	if (value !== undefined && typeof value !== "string") {
		throw new Error("Generative publication destinationDirectory must be a string.");
	}
	const result = value === undefined ? "assets/generated" : value.trim();
	if (!result || result.length > 1024 || result.includes("\\") || result.startsWith("/") || result.includes("\0")) {
		throw new Error("Generative publication destinationDirectory must be a project-relative POSIX path under assets/.");
	}
	const segments = result.replace(/^\.\//, "").replace(/\/$/, "").split("/");
	if (segments[0] !== "assets" || segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error("Generative publication destinationDirectory must stay under assets/ without empty, current-directory, or parent-directory segments.");
	}
	return segments.join("/");
}

function slug(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[._-]+|[._-]+$/g, "")
		.slice(0, 96);
}

function normalizeBaseName(value: unknown, request: IGenerativeAssetRequest): string {
	if (value !== undefined && (typeof value !== "string" || value.length > 128 || /[\\/\0\r\n]/.test(value))) {
		throw new Error("Generative publication baseName must be a filename-safe string of at most 128 characters.");
	}
	const result = slug(typeof value === "string" ? value : request.prompt.slice(0, 96));
	if (!result) {
		throw new Error("Generative publication baseName did not contain a portable filename character.");
	}
	return result;
}

function deterministicUuid(seed: string): string {
	const bytes = Buffer.from(sha256(seed).slice(0, 32), "hex");
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizedStrings(value: unknown, maximum: number, length: number): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [
		...new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter((entry) => entry && entry.length <= length)
		),
	]
		.sort()
		.slice(0, maximum);
}

async function fileEvidence(path: string, maximumBytes = maximumExistingEvidenceBytes): Promise<IFileEvidence> {
	if (!(await pathExists(path))) {
		return { exists: false, sha256: null, sizeBytes: 0 };
	}
	const details = await lstat(path);
	if (details.isSymbolicLink() || !details.isFile() || details.size < 0 || details.size > maximumBytes) {
		throw new Error(`Generative publication target must be a bounded regular non-symlink file: ${portable(path)}.`);
	}
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return { exists: true, sha256: hash.digest("hex"), sizeBytes: details.size };
}

async function existingMetadata(assetPath: string): Promise<IExistingMetadata> {
	const sidecar = `${assetPath}${ASSET_META_SUFFIX}`;
	if (!(await pathExists(sidecar))) {
		return { guid: null, labels: [], tags: [], favorite: false, importer: null };
	}
	try {
		const value = await readJSON(sidecar);
		const guid = typeof value.guid === "string" && uuidPattern.test(value.guid) ? value.guid.toLowerCase() : null;
		let importer: IAssetImporterConfiguration | null = null;
		try {
			importer = normalizeAssetImporterConfiguration(assetPath, value.importer);
		} catch {
			importer = null;
		}
		return {
			guid,
			labels: sanitizedStrings(value.labels, 64, 128),
			tags: sanitizedStrings(value.tags, 64, 64),
			favorite: value.favorite === true,
			importer,
		};
	} catch {
		return { guid: null, labels: [], tags: [], favorite: false, importer: null };
	}
}

async function verifyDirectoryChain(root: string, projectPath: string, create: boolean): Promise<string> {
	const rootReal = await realpath(root);
	let current = root;
	for (const segment of projectPath.split("/")) {
		current = join(current, segment);
		if (!(await pathExists(current))) {
			if (!create) {
				continue;
			}
			await ensureDir(current);
		}
		if (await pathExists(current)) {
			const details = await lstat(current);
			const resolved = await realpath(current);
			if (details.isSymbolicLink() || !details.isDirectory() || !contained(rootReal, resolved)) {
				throw new Error(`Generative publication directories must be regular project-contained directories without symlinks: ${projectPath}.`);
			}
		}
	}
	return current;
}

async function directoryNames(path: string): Promise<Set<string>> {
	if (!(await pathExists(path))) {
		return new Set();
	}
	return new Set((await readdir(path)).map((entry) => entry.toLocaleLowerCase("en-US")));
}

function desiredFileName(baseName: string, role: GenerativePublicationRole, artifact: IValidatedGenerativeArtifact | null): string {
	const extension = artifact ? extname(artifact.path).toLowerCase() : role === "material" ? ".material" : role === "material-packed-orm" ? ".png" : "";
	if (["image", "sprite", "spritesheet", "animation", "audio"].includes(role)) {
		return `${baseName}${extension}`;
	}
	if (role === "material") {
		return `${baseName}.material`;
	}
	return `${baseName}-${role}${extension}`;
}

function chooseFileName(desired: string, used: Set<string>, occupied: Set<string>, overwrite: boolean): string {
	const extension = extname(desired);
	const stem = basename(desired, extension);
	for (let suffix = 1; suffix <= 999; suffix++) {
		const candidate = suffix === 1 ? desired : `${stem}-${suffix}${extension}`;
		const key = candidate.toLocaleLowerCase("en-US");
		if (!used.has(key) && (overwrite || (!occupied.has(key) && !occupied.has(`${key}${ASSET_META_SUFFIX}`)))) {
			used.add(key);
			return candidate;
		}
	}
	throw new Error(`Generative publication could not find a collision-safe name for ${desired}.`);
}

function importerFor(path: string, role: GenerativePublicationRole, request: IGenerativeAssetRequest, previous: IAssetImporterConfiguration | null): IAssetImporterConfiguration {
	const defaults = getDefaultAssetImporterConfiguration(path);
	const importer = previous?.kind === defaults.kind ? structuredClone(previous) : defaults;
	if (importer.kind === "texture") {
		if (role === "sprite" || role === "spritesheet") {
			importer.settings.textureType = "sprite";
			if (request.options.modality === "sprite") {
				importer.settings.spritePixelsPerUnit = request.options.value.pixelsPerUnit;
			}
		} else if (role === "normal") {
			importer.settings.textureType = "normalMap";
		}
		if (["normal", "metallic", "roughness", "ambient-occlusion", "height", "opacity", "material-packed-orm"].includes(role)) {
			importer.settings.colorSpace = "linear";
		}
	}
	if (importer.kind === "animation" && request.options.modality === "animation") {
		importer.settings.resampleRate = request.options.value.framesPerSecond;
		importer.settings.loopByDefault = request.options.value.loop;
	}
	return normalizeAssetImporterConfiguration(path, importer, true);
}

function textureDescriptor(path: string, tileable: boolean): Record<string, unknown> {
	return {
		name: path,
		url: path,
		noMipmap: false,
		invertY: true,
		samplingMode: 3,
		coordinatesIndex: 0,
		coordinatesMode: 0,
		wrapU: tileable ? 1 : 0,
		wrapV: tileable ? 1 : 0,
		wrapR: tileable ? 1 : 0,
		anisotropicFilteringLevel: 4,
	};
}

function rewriteMaterialStrings(value: unknown, aliases: Map<string, string>): unknown {
	if (typeof value === "string") {
		return aliases.get(value) ?? aliases.get(value.replace(/^\.\//, "")) ?? value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => rewriteMaterialStrings(entry, aliases));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewriteMaterialStrings(entry, aliases)]));
	}
	return value;
}

function materialBytes(
	source: Buffer | null,
	baseName: string,
	request: IGenerativeAssetRequest,
	artifactPaths: Map<GenerativeArtifactRole, string>,
	aliases: Map<string, string>,
	ormPath: string | null
): Buffer {
	let data: Record<string, unknown> = {};
	if (source) {
		const parsed = JSON.parse(source.toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).customType !== "BABYLON.PBRMaterial") {
			throw new Error("Generated material publication requires a serialized Babylon PBRMaterial.");
		}
		data = rewriteMaterialStrings(parsed, aliases) as Record<string, unknown>;
	}
	const tileable = request.options.modality === "material" ? request.options.value.tileable : true;
	data.customType = "BABYLON.PBRMaterial";
	data.id = typeof data.id === "string" && data.id ? data.id : `generated-${baseName}`;
	data.name = baseName;
	data.albedo ??= [1, 1, 1];
	data.metallic ??= 1;
	data.roughness ??= 1;
	data.emissive ??= [0, 0, 0];
	const bind = (role: GenerativeArtifactRole, field: string): void => {
		const path = artifactPaths.get(role);
		if (path) {
			data[field] = textureDescriptor(path, tileable);
		}
	};
	bind("base-color", "albedoTexture");
	bind("normal", "bumpTexture");
	bind("emissive", "emissiveTexture");
	bind("opacity", "opacityTexture");
	if (!artifactPaths.has("normal") && artifactPaths.has("height")) {
		bind("height", "bumpTexture");
		data.useParallax = true;
		data.parallaxScaleBias = 0.05;
	}
	if (ormPath) {
		data.metallicTexture = textureDescriptor(ormPath, tileable);
		data.useRoughnessFromMetallicTextureGreen = true;
		data.useMetallnessFromMetallicTextureBlue = true;
		data.useAmbientOcclusionFromMetallicTextureRed = artifactPaths.has("ambient-occlusion");
	}
	return Buffer.from(`${JSON.stringify(data, null, "\t")}\n`, "utf8");
}

async function grayscaleChannel(path: string, width: number, height: number, fallback: number): Promise<Buffer> {
	if (!path) {
		return Buffer.alloc(width * height, fallback);
	}
	const result = await sharp(path, { animated: false, limitInputPixels: 67_108_864 }).rotate().greyscale().raw().toBuffer({ resolveWithObject: true });
	if (result.info.width !== width || result.info.height !== height || result.info.channels !== 1) {
		throw new Error("Generated material maps changed dimensions while the packed ORM derivative was being prepared.");
	}
	return result.data;
}

async function packedOrmBytes(paths: Map<GenerativeArtifactRole, string>, request: IGenerativeAssetRequest): Promise<Buffer> {
	if (request.options.modality !== "material") {
		throw new Error("Packed ORM derivatives are valid only for material jobs.");
	}
	const size = request.options.value.resolution;
	const [occlusion, roughness, metallic] = await Promise.all([
		grayscaleChannel(paths.get("ambient-occlusion") ?? "", size, size, 255),
		grayscaleChannel(paths.get("roughness") ?? "", size, size, 255),
		grayscaleChannel(paths.get("metallic") ?? "", size, size, 0),
	]);
	const rgba = Buffer.allocUnsafe(size * size * 4);
	for (let index = 0; index < size * size; index++) {
		rgba[index * 4] = occlusion[index];
		rgba[index * 4 + 1] = roughness[index];
		rgba[index * 4 + 2] = metallic[index];
		rgba[index * 4 + 3] = 255;
	}
	return sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
		.png({ compressionLevel: 9, adaptiveFiltering: false })
		.toBuffer();
}

function sameCandidates(left: IValidatedGenerativeCandidate[], right: IValidatedGenerativeCandidate[]): boolean {
	const projection = (candidates: IValidatedGenerativeCandidate[]): unknown =>
		candidates.map((candidate) => ({
			id: candidate.id,
			reportedModel: candidate.reportedModel,
			reportedSeed: candidate.reportedSeed,
			providerRequestId: candidate.providerRequestId,
			warnings: candidate.warnings,
			artifacts: candidate.artifacts,
		}));
	return JSON.stringify(projection(left)) === JSON.stringify(projection(right));
}

async function revalidateJob(lease: IGenerativeAssetPublicationJobLease, editor: Editor): Promise<IValidatedGenerativeCandidate[]> {
	if (lease.status !== "succeeded" || !lease.resultFingerprint || !lease.startedAt || !lease.completedAt || lease.execution.durationMilliseconds === null) {
		throw new Error("Only a complete succeeded generative job can be published.");
	}
	if (projectDirectory() !== lease.root) {
		throw new Error("The open project changed; inspect generative publication again in the current project.");
	}
	const inventory = await readGenerativeAssetProviderInventory();
	const provider = inventory.providers.find((entry) => entry.id === lease.provider.id);
	if (!provider || provider.fingerprint !== lease.provider.fingerprint) {
		throw new Error("The generative provider manifest changed after generation; retry the job before publication.");
	}
	let referenceBytes = 0;
	for (const reference of lease.references) {
		const path = join(lease.root, reference.path);
		const details = await lstat(path);
		const resolved = await realpath(path);
		const rootReal = await realpath(lease.root);
		if (details.isSymbolicLink() || !details.isFile() || !projectPathContains(rootReal, resolved) || details.size !== reference.sizeBytes) {
			throw new Error(`Generative reference changed before publication: ${reference.path}.`);
		}
		const bytes = await readFile(resolved);
		referenceBytes += bytes.byteLength;
		if (referenceBytes > 64 * 1024 * 1024 || sha256(bytes) !== reference.sha256) {
			throw new Error(`Generative reference SHA-256 changed before publication: ${reference.path}.`);
		}
	}
	const raw = await readGenerativeProviderResultManifest(join(lease.outputDirectory, "result.json"));
	const result = normalizeGenerativeAssetProviderResult(raw, lease.request);
	const validated = await validateGenerativeProviderOutput(lease.jobDirectory, lease.outputDirectory, result, lease.request, provider.maximumOutputBytes, {
		editor,
		createPreviews: false,
	});
	if (validated.resultFingerprint !== lease.resultFingerprint || !sameCandidates(validated.candidates, lease.candidates)) {
		throw new Error("Generative staged output changed after validation; retry the job before publication.");
	}
	return validated.candidates;
}

function provenance(lease: IGenerativeAssetPublicationJobLease, candidate: IValidatedGenerativeCandidate): IGenerativeAssetProvenance {
	return {
		contract: "zvibe-generative-assets-v1",
		version: 1,
		generatedAt: lease.completedAt!,
		jobId: lease.id,
		provider: {
			id: lease.provider.id,
			name: lease.provider.name,
			vendor: lease.provider.vendor,
			classification: lease.provider.classification,
			manifestFingerprint: lease.provider.fingerprint,
			transport: lease.provider.transport,
		},
		request: structuredClone(lease.request),
		requestFingerprint: lease.requestFingerprint,
		resultFingerprint: lease.resultFingerprint!,
		candidateId: candidate.id,
		reportedModel: candidate.reportedModel,
		reportedSeed: candidate.reportedSeed,
		providerRequestId: candidate.providerRequestId,
		references: structuredClone(lease.references),
		artifacts: candidate.artifacts.map((artifact) => ({
			path: artifact.path,
			role: artifact.role,
			mediaType: artifact.mediaType,
			sha256: artifact.sha256,
			sizeBytes: artifact.sizeBytes,
		})),
		execution: {
			startedAt: lease.startedAt!,
			completedAt: lease.completedAt!,
			durationMilliseconds: lease.execution.durationMilliseconds!,
			exitCode: lease.execution.exitCode,
			httpStatus: lease.execution.httpStatus,
		},
	};
}

function metadataBytes(
	guid: string,
	existing: IExistingMetadata,
	importer: IAssetImporterConfiguration,
	provenanceValue: IGenerativeAssetProvenance,
	file: { path: string; role: GenerativePublicationRole; sourceArtifactPath: string | null; derived: boolean }
): Buffer {
	const classificationTag =
		provenanceValue.provider.classification === "generative-ai"
			? "generated-ai"
			: provenanceValue.provider.classification === "procedural"
				? "generated-procedural"
				: "generated-test-fixture";
	const value = {
		guid,
		labels: existing.labels,
		tags: [...new Set([...existing.tags, "generated", classificationTag])].sort(),
		favorite: existing.favorite,
		importer: {
			...importer,
			extra: {
				...(importer.extra ?? {}),
				generativeProvenance: provenanceValue,
				generativePublication: {
					contract: "zvibe-generative-asset-publication-v1",
					version: 1,
					path: file.path,
					role: file.role,
					sourceArtifactPath: file.sourceArtifactPath,
					derived: file.derived,
				},
			},
		},
		importedAt: provenanceValue.generatedAt,
		importState: { status: "native" },
	};
	const bytes = Buffer.from(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
	if (bytes.byteLength > maximumMetadataBytes) {
		throw new Error("Generative provenance metadata exceeds the 1 MiB per-asset bound.");
	}
	return bytes;
}

async function inspectInternal(lease: IGenerativeAssetPublicationJobLease, data: Record<string, unknown>, editor: Editor): Promise<IInternalPublicationPlan> {
	if (lease.publicationCount >= maximumPublicationRecords) {
		throw new Error(`Generative job already contains ${maximumPublicationRecords} publication records; start a fresh job before publishing again.`);
	}
	const destinationDirectory = normalizeDestinationDirectory(data.destinationDirectory);
	const baseName = normalizeBaseName(data.baseName, lease.request);
	const overwrite = data.overwrite === true;
	if (data.overwrite !== undefined && typeof data.overwrite !== "boolean") {
		throw new Error("Generative publication overwrite must be a Boolean.");
	}
	await verifyDirectoryChain(lease.root, destinationDirectory, false);
	const candidates = await revalidateJob(lease, editor);
	const currentCandidate = candidates.find((entry) => entry.id === data.candidateId);
	if (!currentCandidate) {
		throw new Error(`Generative candidate "${String(data.candidateId)}" was not found in job ${lease.id}.`);
	}
	const destinationAbsolute = join(lease.root, destinationDirectory);
	const occupied = await directoryNames(destinationAbsolute);
	const used = new Set<string>();
	const publishable = currentCandidate.artifacts.filter((artifact) => !["preview-image", "preview-audio", "preview-video"].includes(artifact.role));
	if (publishable.length > maximumPublicationFiles) {
		throw new Error(`Generative publication exceeds the ${maximumPublicationFiles}-file bound.`);
	}
	const definitions: Array<{ role: GenerativePublicationRole; artifact: IValidatedGenerativeArtifact | null; derived: boolean }> = publishable.map((artifact) => ({
		role: artifact.role,
		artifact,
		derived: artifact.role === "material",
	}));
	if (lease.request.modality === "material" && !definitions.some((entry) => entry.role === "material")) {
		definitions.push({ role: "material", artifact: null, derived: true });
	}
	if (lease.request.modality === "material" && definitions.some((entry) => ["metallic", "roughness", "ambient-occlusion"].includes(entry.role))) {
		definitions.push({ role: "material-packed-orm", artifact: null, derived: true });
	}
	if (definitions.length > maximumPublicationFiles) {
		throw new Error(`Generative publication exceeds the ${maximumPublicationFiles}-file bound after required material derivatives.`);
	}
	const mapped = definitions.map((definition) => {
		const name = chooseFileName(desiredFileName(baseName, definition.role, definition.artifact), used, occupied, overwrite);
		return { ...definition, path: `${destinationDirectory}/${name}`, absolutePath: join(destinationAbsolute, name) };
	});
	if (overwrite) {
		for (const entry of mapped) {
			const name = basename(entry.path);
			if (occupied.has(name.toLocaleLowerCase("en-US")) && !(await pathExists(entry.absolutePath))) {
				throw new Error(`Generative publication refuses a case-only overwrite collision for ${entry.path}. Rename the existing asset first.`);
			}
		}
	}
	const artifactPathMap = new Map<GenerativeArtifactRole, string>();
	const absoluteArtifactPaths = new Map<GenerativeArtifactRole, string>();
	const aliases = new Map<string, string>();
	const baseNameCounts = new Map<string, number>();
	for (const entry of mapped) {
		if (!entry.artifact) {
			continue;
		}
		artifactPathMap.set(entry.artifact.role, entry.path);
		absoluteArtifactPaths.set(entry.artifact.role, join(lease.outputDirectory, entry.artifact.path));
		aliases.set(entry.artifact.path, entry.path);
		const sourceName = basename(entry.artifact.path);
		baseNameCounts.set(sourceName, (baseNameCounts.get(sourceName) ?? 0) + 1);
	}
	for (const entry of mapped) {
		if (entry.artifact && baseNameCounts.get(basename(entry.artifact.path)) === 1) {
			aliases.set(basename(entry.artifact.path), entry.path);
		}
	}
	const ormPath = mapped.find((entry) => entry.role === "material-packed-orm")?.path ?? null;
	const ormContent = ormPath ? await packedOrmBytes(absoluteArtifactPaths, lease.request) : null;
	const provenanceValue = provenance(lease, currentCandidate);
	const guidSet = new Set<string>();
	const files: IInternalPublicationFile[] = [];
	for (const entry of mapped) {
		const existingAsset = await fileEvidence(entry.absolutePath);
		const metadataPath = `${entry.absolutePath}${ASSET_META_SUFFIX}`;
		const existingMetadataEvidence = await fileEvidence(metadataPath, maximumMetadataBytes);
		const previous = await existingMetadata(entry.absolutePath);
		let guid = previous.guid ?? deterministicUuid(`${lease.id}\0${currentCandidate.id}\0${entry.path}`);
		if (guidSet.has(guid)) {
			throw new Error(`Generative publication target metadata reuses GUID ${guid}; repair the existing asset metadata before publication.`);
		}
		guidSet.add(guid);
		let content: Buffer | null = null;
		let sourceAbsolutePath: string | null = entry.artifact ? join(lease.outputDirectory, entry.artifact.path) : null;
		if (entry.role === "material") {
			const source = sourceAbsolutePath ? await readFile(sourceAbsolutePath) : null;
			content = materialBytes(source, baseName, lease.request, artifactPathMap, aliases, ormPath);
			sourceAbsolutePath = null;
		} else if (entry.role === "material-packed-orm") {
			content = ormContent!;
			sourceAbsolutePath = null;
		}
		const outputSha = content ? sha256(content) : entry.artifact!.sha256;
		const outputSize = content ? content.byteLength : entry.artifact!.sizeBytes;
		const importer = importerFor(entry.path, entry.role, lease.request, previous.importer);
		const metadata = metadataBytes(guid, previous, importer, provenanceValue, {
			path: entry.path,
			role: entry.role,
			sourceArtifactPath: entry.artifact?.path ?? null,
			derived: entry.derived,
		});
		files.push({
			path: entry.path,
			absolutePath: entry.absolutePath,
			metadataPath,
			guid,
			role: entry.role,
			sourceArtifactPath: entry.artifact?.path ?? null,
			derived: entry.derived,
			sha256: outputSha,
			sizeBytes: outputSize,
			metadataSha256: sha256(metadata),
			metadataBytes: metadata,
			content,
			sourceAbsolutePath,
			existingAsset,
			existingMetadata: existingMetadataEvidence,
			importer,
			importerKind: importer.kind,
			action: existingAsset.exists || existingMetadataEvidence.exists ? "replace" : "create",
		});
	}
	const planInput = {
		contract: "zvibe-generative-asset-publication-v1",
		version: 1,
		jobId: lease.id,
		jobRevision: lease.revision,
		providerFingerprint: lease.provider.fingerprint,
		requestFingerprint: lease.requestFingerprint,
		resultFingerprint: lease.resultFingerprint,
		candidateId: currentCandidate.id,
		destinationDirectory,
		baseName,
		overwrite,
		files: files.map((file) => ({
			path: file.path,
			guid: file.guid,
			role: file.role,
			sourceArtifactPath: file.sourceArtifactPath,
			derived: file.derived,
			sha256: file.sha256,
			sizeBytes: file.sizeBytes,
			metadataSha256: file.metadataSha256,
			importer: file.importer,
			existingAsset: file.existingAsset,
			existingMetadata: file.existingMetadata,
		})),
	};
	const planFingerprint = sha256(JSON.stringify(canonical(planInput)));
	const warnings = currentCandidate.warnings.slice(0, 32);
	if (lease.provider.classification !== "generative-ai") {
		warnings.push(
			lease.provider.classification === "procedural"
				? "This publication was produced by a procedural provider and is not labeled as AI-generated."
				: "This publication was produced by a test fixture and is not evidence of AI generation."
		);
	}
	return {
		publicPlan: {
			contract: "zvibe-generative-asset-publication-v1",
			version: 1,
			jobId: lease.id,
			jobRevision: lease.revision,
			resultFingerprint: lease.resultFingerprint!,
			candidateId: currentCandidate.id,
			destinationDirectory,
			baseName,
			overwrite,
			planFingerprint,
			files: files.map(
				({
					absolutePath: _absolutePath,
					metadataPath: _metadataPath,
					metadataBytes: _metadataBytes,
					content: _content,
					sourceAbsolutePath: _sourceAbsolutePath,
					existingAsset: _existingAsset,
					existingMetadata: _existingMetadata,
					importer: _importer,
					...file
				}) => file
			),
			classification: lease.provider.classification,
			warnings: [...new Set(warnings)],
		},
		files,
	};
}

async function withPublicationLane<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = publicationLanes.get(path) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const queued = previous.catch(() => undefined).then(() => gate);
	publicationLanes.set(path, queued);
	await previous.catch(() => undefined);
	try {
		return await operation();
	} finally {
		release();
		if (publicationLanes.get(path) === queued) {
			publicationLanes.delete(path);
		}
	}
}

async function stageFile(file: IInternalPublicationFile, path: string): Promise<void> {
	await ensureDir(dirname(path));
	if (file.content) {
		await writeFile(path, file.content, { mode: 0o600, flag: "wx" });
	} else {
		await copyFile(file.sourceAbsolutePath!, path, 1);
	}
	const evidence = await fileEvidence(path);
	if (evidence.sha256 !== file.sha256 || evidence.sizeBytes !== file.sizeBytes) {
		throw new Error(`Generative publication staging did not reproduce ${file.path}.`);
	}
	await writeFile(`${path}${ASSET_META_SUFFIX}`, file.metadataBytes, { mode: 0o600, flag: "wx" });
}

async function moveToBackup(path: string, backupPath: string): Promise<IBackupEntry> {
	const existed = await pathExists(path);
	if (existed) {
		await ensureDir(dirname(backupPath));
		await move(path, backupPath, { overwrite: false });
	}
	return { path, backupPath, existed };
}

/** Moves only the exact asset or sidecar state leased by inspection, then verifies the backup before replacement. */
async function backupLeasedFile(path: string, backupPath: string, expected: IFileEvidence, maximumBytes = maximumExistingEvidenceBytes): Promise<IBackupEntry> {
	const current = await fileEvidence(path, maximumBytes);
	if (JSON.stringify(current) !== JSON.stringify(expected)) {
		throw new Error(`Generative publication destination changed after inspection: ${portable(path)}.`);
	}
	const backup = await moveToBackup(path, backupPath);
	if (backup.existed) {
		const moved = await fileEvidence(backupPath, maximumBytes);
		if (JSON.stringify(moved) !== JSON.stringify(expected)) {
			await move(backupPath, path, { overwrite: false }).catch(() => undefined);
			throw new Error(`Generative publication could not preserve the exact previous destination bytes: ${portable(path)}.`);
		}
	}
	return backup;
}

async function restoreBackups(entries: IBackupEntry[]): Promise<void> {
	for (const entry of [...entries].reverse()) {
		await remove(entry.path).catch(() => undefined);
		if (entry.existed && (await pathExists(entry.backupPath))) {
			await ensureDir(dirname(entry.path));
			await move(entry.backupPath, entry.path, { overwrite: false }).catch(() => undefined);
		}
	}
}

async function importerEvidence(file: IInternalPublicationFile, editor: Editor): Promise<IGenerativeAssetPublicationImporterEvidence> {
	let fingerprint: string | null = null;
	let current = true;
	let manifestPath: string | null = null;
	if (file.importer.kind === "texture") {
		let status = await getTextureImporterArtifactStatus(file.absolutePath);
		status = status.current ? status : await applyTextureImporterArtifact(file.absolutePath, status.fingerprint);
		fingerprint = status.fingerprint;
		current = status.current;
		manifestPath = status.manifestPath;
	} else if (file.importer.kind === "material") {
		let status = await getMaterialImporterArtifactStatus(file.absolutePath);
		status = status.current ? status : await applyMaterialImporterArtifact(file.absolutePath, status.fingerprint);
		fingerprint = status.fingerprint;
		current = status.current && status.result?.valid === true;
		manifestPath = status.manifestPath;
	} else if (file.importer.kind === "animation") {
		let status = await getAnimationImporterArtifactStatus(file.absolutePath);
		status = status.current ? status : await applyAnimationImporterArtifact(file.absolutePath, status.fingerprint);
		fingerprint = status.fingerprint;
		current = status.current && status.result?.valid === true;
		manifestPath = status.manifestPath;
	} else if (file.importer.kind === "audio") {
		let status = await getAudioImporterArtifactStatus(file.absolutePath);
		status = status.current ? status : await applyAudioImporterArtifact(file.absolutePath, status.fingerprint, editor);
		fingerprint = status.fingerprint;
		current = status.current;
		manifestPath = status.manifestPath;
	} else if (file.importer.kind === "video") {
		let status = await getVideoImporterArtifactStatus(file.absolutePath);
		status = status.current ? status : await applyVideoImporterArtifact(file.absolutePath, status.fingerprint, editor, "default");
		fingerprint = status.fingerprint;
		current = status.current;
		manifestPath = status.manifestPath;
	}
	if (!current) {
		throw new Error(`The normal ${file.importer.kind} importer did not produce a current valid artifact for ${file.path}.`);
	}
	const manifestSha256 = manifestPath && (await pathExists(manifestPath)) ? sha256(await readFile(manifestPath)) : null;
	return { kind: file.importer.kind, fingerprint, current, manifestSha256 };
}

/** Revalidates a complete succeeded job and returns a collision-safe immutable publication plan without changing project assets. */
export async function inspectGenerativeAssetPublication(
	lease: IGenerativeAssetPublicationJobLease,
	data: Record<string, unknown>,
	editor: Editor
): Promise<IGenerativeAssetPublicationPlan> {
	return (await inspectInternal(lease, data, editor)).publicPlan;
}

/** Publishes one exact plan and rolls project assets, metadata, and importer caches back together on any failure. */
export async function publishGenerativeAssetCandidate(
	lease: IGenerativeAssetPublicationJobLease,
	data: Record<string, unknown>,
	editor: Editor,
	commit: (record: IGenerativeAssetPublicationRecord) => Promise<void>
): Promise<IGenerativeAssetPublicationRecord> {
	if (data.confirm !== true) {
		throw new Error("Publishing generated files requires confirm=true because project assets may be created or replaced.");
	}
	if (typeof data.expectedPlanFingerprint !== "string" || !fingerprintPattern.test(data.expectedPlanFingerprint)) {
		throw new Error("Generative expectedPlanFingerprint must be the exact SHA-256 returned by inspect_generative_asset_publication.");
	}
	const destinationDirectory = normalizeDestinationDirectory(data.destinationDirectory);
	const lane = join(lease.root, destinationDirectory);
	return withPublicationLane(lane, async () => {
		const plan = await inspectInternal(lease, data, editor);
		if (plan.publicPlan.planFingerprint !== data.expectedPlanFingerprint) {
			throw new Error(`Generative publication plan changed; inspect again and use expectedPlanFingerprint ${plan.publicPlan.planFingerprint}.`);
		}
		const publicationRoot = await ensureProjectStoreDirectory(lease.root, ".bjseditor", "generative-assets", "publications");
		const transactionRoot = join(publicationRoot, `transaction-${randomUUID()}`);
		const stagingRoot = join(transactionRoot, "staging");
		const backupRoot = join(transactionRoot, "backups");
		const importerBackupRoot = join(transactionRoot, "importers");
		const backups: IBackupEntry[] = [];
		const importerBackups: IBackupEntry[] = [];
		try {
			await ensureDir(stagingRoot);
			for (let index = 0; index < plan.files.length; index++) {
				await stageFile(plan.files[index], join(stagingRoot, `${String(index).padStart(3, "0")}-${basename(plan.files[index].path)}`));
			}
			const revalidated = await inspectInternal(lease, data, editor);
			if (revalidated.publicPlan.planFingerprint !== plan.publicPlan.planFingerprint) {
				throw new Error(`Generative publication inputs changed while staging; inspect again and use current fingerprint ${revalidated.publicPlan.planFingerprint}.`);
			}
			await verifyDirectoryChain(lease.root, destinationDirectory, true);
			for (let index = 0; index < plan.files.length; index++) {
				const file = plan.files[index];
				backups.push(await backupLeasedFile(file.absolutePath, join(backupRoot, `${index}-asset`), file.existingAsset));
				backups.push(await backupLeasedFile(file.metadataPath, join(backupRoot, `${index}-metadata`), file.existingMetadata, maximumMetadataBytes));
				const staged = join(stagingRoot, `${String(index).padStart(3, "0")}-${basename(file.path)}`);
				await move(staged, file.absolutePath, { overwrite: false });
				await move(`${staged}${ASSET_META_SUFFIX}`, file.metadataPath, { overwrite: false });
			}
			const registry = await refreshAssetRegistryPaths(plan.files.map((file) => file.absolutePath));
			const plannedGuids = new Set(plan.files.map((file) => file.guid));
			const duplicate = registry.duplicateGuids.find((entry) => plannedGuids.has(entry.guid));
			if (duplicate) {
				throw new Error(
					`Generative publication would reuse asset GUID ${duplicate.guid} across ${duplicate.paths.join(", ")}; repair duplicate metadata before publishing.`
				);
			}
			for (let index = 0; index < plan.files.length; index++) {
				const directory = join(lease.root, ".bjseditor", "imported-assets", plan.files[index].guid);
				importerBackups.push(await moveToBackup(directory, join(importerBackupRoot, `${index}-${plan.files[index].guid}`)));
			}
			const importerResults = new Map<string, IGenerativeAssetPublicationImporterEvidence>();
			for (const file of [...plan.files].sort((left, right) => Number(left.importer.kind === "material") - Number(right.importer.kind === "material"))) {
				importerResults.set(file.path, await importerEvidence(file, editor));
			}
			for (const file of plan.files) {
				const [asset, metadata] = await Promise.all([fileEvidence(file.absolutePath), fileEvidence(file.metadataPath, maximumMetadataBytes)]);
				if (asset.sha256 !== file.sha256 || asset.sizeBytes !== file.sizeBytes || metadata.sha256 !== file.metadataSha256) {
					throw new Error(`Generative publication verification failed for ${file.path}.`);
				}
			}
			await revalidateJob(lease, editor);
			if (projectDirectory() !== lease.root) {
				throw new Error("The open project changed before generative publication could commit.");
			}
			const publishedAt = new Date().toISOString();
			const record: IGenerativeAssetPublicationRecord = {
				id: `generative-publication-${createHash("sha256").update(`${lease.id}\0${plan.publicPlan.planFingerprint}\0${publishedAt}`).digest("hex").slice(0, 24)}`,
				revision: lease.publicationCount + 1,
				publishedAt,
				planFingerprint: plan.publicPlan.planFingerprint,
				resultFingerprint: plan.publicPlan.resultFingerprint,
				candidateId: plan.publicPlan.candidateId,
				destinationDirectory: plan.publicPlan.destinationDirectory,
				baseName: plan.publicPlan.baseName,
				overwrite: plan.publicPlan.overwrite,
				files: plan.files.map((file) => ({
					path: file.path,
					guid: file.guid,
					role: file.role,
					sourceArtifactPath: file.sourceArtifactPath,
					derived: file.derived,
					sha256: file.sha256,
					sizeBytes: file.sizeBytes,
					metadataSha256: file.metadataSha256,
					importer: importerResults.get(file.path)!,
				})),
			};
			await commit(record);
			await remove(transactionRoot).catch(() => undefined);
			return record;
		} catch (error) {
			if (backups.length || importerBackups.length) {
				await restoreBackups(importerBackups);
				await restoreBackups(backups);
				await refreshAssetRegistryPaths(plan.files.map((file) => file.absolutePath)).catch(() => undefined);
			}
			await remove(transactionRoot).catch(() => undefined);
			throw error;
		}
	});
}

/** Strictly validates retained publication evidence before it is trusted after an Editor restart. */
export function normalizeGenerativeAssetPublicationRecord(value: unknown): IGenerativeAssetPublicationRecord {
	const source = closedRecord(
		value,
		["id", "revision", "publishedAt", "planFingerprint", "resultFingerprint", "candidateId", "destinationDirectory", "baseName", "overwrite", "files"],
		"Persisted generative publication"
	);
	if (
		typeof source.id !== "string" ||
		!publicationIdPattern.test(source.id) ||
		!Number.isSafeInteger(source.revision) ||
		(source.revision as number) < 1 ||
		!isoTimestamp(source.publishedAt) ||
		typeof source.planFingerprint !== "string" ||
		!fingerprintPattern.test(source.planFingerprint) ||
		typeof source.resultFingerprint !== "string" ||
		!fingerprintPattern.test(source.resultFingerprint) ||
		typeof source.candidateId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(source.candidateId) ||
		typeof source.baseName !== "string" ||
		source.baseName !== slug(source.baseName) ||
		typeof source.overwrite !== "boolean" ||
		!Array.isArray(source.files) ||
		!source.files.length ||
		source.files.length > maximumPublicationFiles
	) {
		throw new Error("Persisted generative publication identity, fingerprint, timestamp, or file count is invalid.");
	}
	const destinationDirectory = normalizeDestinationDirectory(source.destinationDirectory);
	const paths = new Set<string>();
	const guids = new Set<string>();
	const files = source.files.map((entry, index) => {
		const file = closedRecord(
			entry,
			["path", "guid", "role", "sourceArtifactPath", "derived", "sha256", "sizeBytes", "metadataSha256", "importer"],
			`Persisted generative publication file ${index + 1}`
		);
		const importer = closedRecord(file.importer, ["kind", "fingerprint", "current", "manifestSha256"], `Persisted generative publication importer ${index + 1}`);
		if (
			typeof file.path !== "string" ||
			!file.path.startsWith(`${destinationDirectory}/`) ||
			file.path.includes("\\") ||
			file.path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
			paths.has(file.path.toLocaleLowerCase("en-US")) ||
			typeof file.guid !== "string" ||
			!uuidPattern.test(file.guid) ||
			guids.has(file.guid) ||
			typeof file.role !== "string" ||
			![
				"image",
				"sprite",
				"spritesheet",
				"material",
				"base-color",
				"normal",
				"metallic",
				"roughness",
				"ambient-occlusion",
				"height",
				"emissive",
				"opacity",
				"animation",
				"audio",
				"source-video",
				"metadata",
				"material-packed-orm",
			].includes(file.role) ||
			(file.sourceArtifactPath !== null &&
				(typeof file.sourceArtifactPath !== "string" ||
					file.sourceArtifactPath.length > 1024 ||
					file.sourceArtifactPath.includes("\\") ||
					file.sourceArtifactPath.split("/").some((segment) => !segment || segment === "." || segment === ".."))) ||
			typeof file.derived !== "boolean" ||
			typeof file.sha256 !== "string" ||
			!fingerprintPattern.test(file.sha256) ||
			!Number.isSafeInteger(file.sizeBytes) ||
			(file.sizeBytes as number) < 1 ||
			(file.sizeBytes as number) > maximumExistingEvidenceBytes ||
			typeof file.metadataSha256 !== "string" ||
			!fingerprintPattern.test(file.metadataSha256) ||
			typeof importer.kind !== "string" ||
			!publicationImporterKinds.includes(importer.kind as AssetImporterKind) ||
			(importer.fingerprint !== null && (typeof importer.fingerprint !== "string" || !fingerprintPattern.test(importer.fingerprint))) ||
			importer.current !== true ||
			(importer.kind === "custom"
				? importer.fingerprint !== null || importer.manifestSha256 !== null
				: typeof importer.fingerprint !== "string" ||
					!fingerprintPattern.test(importer.fingerprint) ||
					typeof importer.manifestSha256 !== "string" ||
					!fingerprintPattern.test(importer.manifestSha256))
		) {
			throw new Error(`Persisted generative publication file ${index + 1} evidence is invalid.`);
		}
		paths.add(file.path.toLocaleLowerCase("en-US"));
		guids.add(file.guid);
		return file as unknown as IGenerativeAssetPublicationFileRecord;
	});
	return {
		id: source.id,
		revision: source.revision,
		publishedAt: source.publishedAt,
		planFingerprint: source.planFingerprint,
		resultFingerprint: source.resultFingerprint,
		candidateId: source.candidateId,
		destinationDirectory,
		baseName: source.baseName,
		overwrite: source.overwrite,
		files,
	} as IGenerativeAssetPublicationRecord;
}

export const maximumGenerativeAssetPublicationRecords = maximumPublicationRecords;
