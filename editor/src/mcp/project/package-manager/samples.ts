import { randomUUID } from "crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { normalize as normalizePortablePath } from "path/posix";
import { pathToFileURL } from "url";

import { Scene } from "babylonjs";
import sharp from "sharp";

import { IMCPActionOptions } from "../../action";
import { projectPathContains } from "../project-store";
import { getProjectPackageContext, packageSha256 } from "./context";
import { IProjectPackageContext, ProjectPackageDependencyType } from "./types";

const maximumSamplesPerPackage = 100;
const maximumSampleFiles = 2_000;
const maximumSampleBytes = 128 * 1024 * 1024;
const maximumSampleFileBytes = 32 * 1024 * 1024;
const maximumSampleDepth = 32;
const maximumSampleImages = 8;
const maximumSampleImageBytes = 4 * 1024 * 1024;
const maximumSampleImageDimension = 8192;
const samplePlanLifetimeMs = 15 * 60 * 1_000;
const dependencyTypes: ProjectPackageDependencyType[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

interface IInstalledPackageSampleDeclaration {
	displayName: string;
	description: string | null;
	path: string;
	publishedAt: string | null;
	images: { path: string; caption: string | null; alt: string | null }[];
}

interface IProjectPackageSampleImageInternal {
	path: string;
	caption: string | null;
	alt: string | null;
	absolutePath: string;
	previewUrl: string;
	bytes: number;
	sha256: string;
	format: string;
	width: number;
	height: number;
}

interface ISampleFileEvidence {
	path: string;
	absolutePath: string;
	bytes: number;
	sha256: string;
	mode: number;
}

interface ISampleTreeEvidence {
	files: ISampleFileEvidence[];
	fileCount: number;
	totalBytes: number;
	sha256: string;
}

interface IProjectPackageSampleInternal {
	id: string;
	packageName: string;
	packageVersion: string;
	packageRoot: string;
	displayName: string;
	description: string | null;
	publishedAt: string | null;
	sourcePath: string;
	sourceRoot: string;
	images: IProjectPackageSampleImageInternal[];
	evidence: ISampleTreeEvidence;
}

interface IProjectPackageSamplePlan {
	id: string;
	createdAt: string;
	expiresAt: string;
	packageFingerprint: string;
	sample: IProjectPackageSampleInternal;
	targetPath: string;
	targetRoot: string;
	collision: "fail" | "rename" | "replace";
	targetBeforeSha256: string | null;
}

const samplePlans = new WeakMap<Scene, Map<string, IProjectPackageSamplePlan>>();

function pagination(data: any): { offset: number; limit: number } {
	const offset = data?.offset ?? 0;
	const limit = data?.limit ?? 20;
	if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
		throw new Error("offset must be an integer from 0 through 1000000.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("limit must be an integer from 1 through 100.");
	}
	return { offset, limit };
}

function portableRelativePath(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 1_024 || [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
		throw new Error(`${label} must be a non-empty relative path of at most 1024 characters without control characters.`);
	}
	const normalized = normalizePortablePath(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || isAbsolute(normalized)) {
		throw new Error(`${label} must stay inside its owner directory.`);
	}
	return normalized;
}

function safeSegment(value: string, fallback: string): string {
	const normalized = value
		.normalize("NFKC")
		.replace(/^@/, "")
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+|\.+$/g, "")
		.trim()
		.slice(0, 96);
	return normalized || fallback;
}

function publishedAt(value: unknown, label: string): string | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${label} must be a valid bounded date string when provided.`);
	}
	return new Date(Date.parse(value)).toISOString();
}

function sampleImages(value: unknown): { path: string; caption: string | null; alt: string | null }[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumSampleImages) {
		throw new Error(`Sample images must be an array of at most ${maximumSampleImages} entries.`);
	}
	return value.map((entry, index) => {
		const object = typeof entry === "string" ? { path: entry } : entry;
		if (!object || typeof object !== "object" || typeof (object as any).path !== "string") {
			throw new Error(`Sample image ${index} must be a path string or an object containing path.`);
		}
		const caption = (object as any).caption;
		const alt = (object as any).alt;
		if ((caption !== undefined && (typeof caption !== "string" || caption.length > 256)) || (alt !== undefined && (typeof alt !== "string" || alt.length > 256))) {
			throw new Error(`Sample image ${index} caption and alt must be strings of at most 256 characters.`);
		}
		return {
			path: portableRelativePath((object as any).path, `Sample image ${index} path`),
			caption: typeof caption === "string" ? caption : null,
			alt: typeof alt === "string" ? alt : null,
		};
	});
}

function sampleDeclarations(manifest: any): IInstalledPackageSampleDeclaration[] {
	const sources = [manifest?.samples, manifest?.babylonEditor?.samples, manifest?.zvibeEditor?.samples];
	const declarations: IInstalledPackageSampleDeclaration[] = [];
	for (const source of sources) {
		if (!Array.isArray(source)) {
			continue;
		}
		for (const value of source.slice(0, maximumSamplesPerPackage)) {
			if (!value || typeof value !== "object" || typeof value.displayName !== "string" || typeof value.path !== "string") {
				continue;
			}
			const displayName = value.displayName.trim().slice(0, 128);
			if (!displayName) {
				continue;
			}
			declarations.push({
				displayName,
				description: typeof value.description === "string" ? value.description.slice(0, 1_024) : null,
				path: portableRelativePath(value.path, "Sample source path"),
				publishedAt: publishedAt(
					value.publishedAt ?? value.publishDate ?? manifest?.publishedAt ?? manifest?.publishDate ?? manifest?.date,
					`Sample "${displayName}" publishedAt`
				),
				images: sampleImages(value.images),
			});
		}
	}
	return declarations.slice(0, maximumSamplesPerPackage);
}

async function sampleImageEvidence(packageRoot: string, image: IInstalledPackageSampleDeclaration["images"][number]): Promise<IProjectPackageSampleImageInternal> {
	const absolutePath = resolve(packageRoot, image.path);
	const declaredStat = await lstat(absolutePath);
	if (declaredStat.isSymbolicLink()) {
		throw new Error(`Sample image "${image.path}" cannot be a symbolic link.`);
	}
	const resolved = await realpath(absolutePath);
	if (!projectPathContains(packageRoot, resolved)) {
		throw new Error(`Sample image "${image.path}" resolves outside its package.`);
	}
	const imageStat = await lstat(resolved);
	if (!imageStat.isFile() || imageStat.size < 1 || imageStat.size > maximumSampleImageBytes) {
		throw new Error(`Sample image "${image.path}" must be a regular 1–${maximumSampleImageBytes}-byte file and cannot be a symbolic link.`);
	}
	const bytes = await readFile(resolved);
	const metadata = await sharp(bytes, { limitInputPixels: maximumSampleImageDimension * maximumSampleImageDimension }).metadata();
	if (!metadata.width || !metadata.height || metadata.width > maximumSampleImageDimension || metadata.height > maximumSampleImageDimension) {
		throw new Error(`Sample image "${image.path}" dimensions must be at most ${maximumSampleImageDimension}×${maximumSampleImageDimension}.`);
	}
	if (!metadata.format || !["png", "jpeg", "webp", "gif"].includes(metadata.format)) {
		throw new Error(`Sample image "${image.path}" must be PNG, JPEG, WebP, or GIF.`);
	}
	return {
		...image,
		absolutePath: resolved,
		previewUrl: pathToFileURL(resolved).toString(),
		bytes: bytes.byteLength,
		sha256: packageSha256(bytes),
		format: metadata.format,
		width: metadata.width,
		height: metadata.height,
	};
}

async function scanSampleTree(root: string): Promise<ISampleTreeEvidence> {
	const rootStat = await lstat(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("Sample source must be a regular directory and cannot be a symbolic link.");
	}
	const realRoot = await realpath(root);
	const queue: { absolute: string; relative: string; depth: number }[] = [{ absolute: root, relative: "", depth: 0 }];
	const files: ISampleFileEvidence[] = [];
	let totalBytes = 0;
	while (queue.length) {
		const current = queue.shift()!;
		if (current.depth > maximumSampleDepth) {
			throw new Error(`Sample source exceeds the ${maximumSampleDepth}-directory depth limit.`);
		}
		const entries = await readdir(current.absolute, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const absolutePath = join(current.absolute, entry.name);
			const entryStat = await lstat(absolutePath);
			if (entryStat.isSymbolicLink()) {
				throw new Error(`Sample source cannot contain symbolic links: ${join(current.relative, entry.name)}`);
			}
			const realEntry = await realpath(absolutePath);
			if (!projectPathContains(realRoot, realEntry)) {
				throw new Error("Sample source entry resolves outside its declared directory.");
			}
			const relativePath = join(current.relative, entry.name).replace(/\\/g, "/");
			if (entryStat.isDirectory()) {
				queue.push({ absolute: absolutePath, relative: relativePath, depth: current.depth + 1 });
				continue;
			}
			if (!entryStat.isFile()) {
				throw new Error(`Sample source supports only regular files and directories: ${relativePath}`);
			}
			if (entryStat.size > maximumSampleFileBytes) {
				throw new Error(`Sample file exceeds the ${maximumSampleFileBytes}-byte limit: ${relativePath}`);
			}
			totalBytes += entryStat.size;
			if (totalBytes > maximumSampleBytes) {
				throw new Error(`Sample source exceeds the ${maximumSampleBytes}-byte total limit.`);
			}
			if (files.length >= maximumSampleFiles) {
				throw new Error(`Sample source exceeds the ${maximumSampleFiles}-file limit.`);
			}
			const bytes = await readFile(absolutePath);
			files.push({ path: relativePath, absolutePath, bytes: bytes.byteLength, sha256: packageSha256(bytes), mode: entryStat.mode & 0o777 });
		}
	}
	const sha256 = packageSha256(JSON.stringify(files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))));
	return { files, fileCount: files.length, totalBytes, sha256 };
}

function directPackageNames(context: IProjectPackageContext): string[] {
	return [
		...new Set(
			dependencyTypes.flatMap((dependencyType) => Object.keys(context.manifest[dependencyType] ?? {})).filter((name) => typeof name === "string" && name.length <= 214)
		),
	].sort();
}

async function installedPackageRoot(context: IProjectPackageContext, packageName: string): Promise<string | null> {
	const allowedRoot = context.workspaceRoot ?? context.projectRoot;
	const candidate = join(allowedRoot, "node_modules", ...packageName.split("/"));
	let resolved: string;
	try {
		resolved = await realpath(candidate);
	} catch {
		return null;
	}
	if (!projectPathContains(allowedRoot, resolved)) {
		throw new Error(`Installed package "${packageName}" resolves outside the project/workspace dependency root.`);
	}
	return resolved;
}

async function discoverSamples(context: IProjectPackageContext): Promise<{ samples: IProjectPackageSampleInternal[]; errors: { packageName: string; error: string }[] }> {
	const samples: IProjectPackageSampleInternal[] = [];
	const errors: { packageName: string; error: string }[] = [];
	for (const packageName of directPackageNames(context)) {
		try {
			const packageRoot = await installedPackageRoot(context, packageName);
			if (!packageRoot) {
				continue;
			}
			const manifestPath = join(packageRoot, "package.json");
			const manifestStat = await lstat(manifestPath);
			if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > 1024 * 1024) {
				throw new Error("Installed package manifest must be a regular file of at most 1 MiB.");
			}
			const manifest = JSON.parse((await readFile(manifestPath)).toString("utf8"));
			const packageVersion = typeof manifest.version === "string" ? manifest.version : "unknown";
			for (const declaration of sampleDeclarations(manifest)) {
				const sourceRoot = resolve(packageRoot, declaration.path);
				const resolvedSource = await realpath(sourceRoot);
				if (!projectPathContains(packageRoot, resolvedSource)) {
					throw new Error(`Sample "${declaration.displayName}" resolves outside package "${packageName}".`);
				}
				const evidence = await scanSampleTree(resolvedSource);
				const images = await Promise.all(declaration.images.map((image) => sampleImageEvidence(packageRoot, image)));
				samples.push({
					id: packageSha256(`${packageName}\n${packageVersion}\n${declaration.path}\n${declaration.displayName}`).slice(0, 32),
					packageName,
					packageVersion,
					packageRoot,
					displayName: declaration.displayName,
					description: declaration.description,
					publishedAt: declaration.publishedAt,
					sourcePath: declaration.path,
					sourceRoot: resolvedSource,
					images,
					evidence,
				});
			}
		} catch (error) {
			errors.push({ packageName, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { samples, errors };
}

function publicSample(sample: IProjectPackageSampleInternal): any {
	return {
		id: sample.id,
		packageName: sample.packageName,
		packageVersion: sample.packageVersion,
		displayName: sample.displayName,
		description: sample.description,
		publishedAt: sample.publishedAt,
		sourcePath: sample.sourcePath,
		imageCount: sample.images.length,
		fileCount: sample.evidence.fileCount,
		totalBytes: sample.evidence.totalBytes,
		sourceSha256: sample.evidence.sha256,
	};
}

function publicImage(image: IProjectPackageSampleImageInternal): any {
	return {
		path: image.path,
		caption: image.caption,
		alt: image.alt,
		previewUrl: image.previewUrl,
		bytes: image.bytes,
		sha256: image.sha256,
		format: image.format,
		width: image.width,
		height: image.height,
	};
}

async function containedDirectoryExists(context: IProjectPackageContext, relativePath: string): Promise<boolean> {
	const absolutePath = resolve(context.projectRoot, relativePath);
	if (!projectPathContains(context.projectRoot, absolutePath)) {
		return false;
	}
	try {
		const value = await lstat(absolutePath);
		return value.isDirectory() && !value.isSymbolicLink();
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

/** Lists bounded installed-package sample manifests with exact source evidence. */
export async function listProjectPackageSamples(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = pagination(data);
	const context = await getProjectPackageContext(options);
	const discovered = await discoverSamples(context);
	const packageName = data?.packageName === undefined ? null : String(data.packageName);
	const query = typeof data?.query === "string" ? data.query.trim().toLowerCase() : "";
	if (packageName && packageName.length > 214) {
		throw new Error("packageName must be at most 214 characters.");
	}
	if (query.length > 200) {
		throw new Error("query must be at most 200 characters.");
	}
	const sortBy = data?.sortBy ?? "display-name";
	const sortDirection = data?.sortDirection ?? (sortBy === "publish-date" ? "desc" : "asc");
	if (!["display-name", "package-name", "publish-date"].includes(sortBy)) {
		throw new Error('sortBy must be "display-name", "package-name", or "publish-date".');
	}
	if (!["asc", "desc"].includes(sortDirection)) {
		throw new Error('sortDirection must be "asc" or "desc".');
	}
	const candidates = discovered.samples.filter(
		(sample) =>
			(!packageName || sample.packageName === packageName) &&
			(!query || `${sample.displayName}\n${sample.description ?? ""}\n${sample.packageName}`.toLowerCase().includes(query))
	);
	candidates.sort((left, right) => {
		let comparison: number;
		if (sortBy === "publish-date") {
			if (left.publishedAt === null || right.publishedAt === null) {
				if (left.publishedAt !== right.publishedAt) {
					return left.publishedAt === null ? 1 : -1;
				}
				comparison = 0;
			} else {
				comparison = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
			}
		} else {
			const leftValue = sortBy === "package-name" ? left.packageName : left.displayName;
			const rightValue = sortBy === "package-name" ? right.packageName : right.displayName;
			comparison = leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
		}
		if (comparison === 0) {
			comparison = left.id.localeCompare(right.id);
		}
		return sortDirection === "desc" ? -comparison : comparison;
	});
	const page = candidates.slice(offset, offset + limit);
	const summaries = await Promise.all(
		page.map(async (sample) => {
			const path = defaultTargetPath(sample);
			return { ...publicSample(sample), defaultTargetPath: path, defaultImportExists: await containedDirectoryExists(context, path) };
		})
	);
	return {
		fingerprint: context.fingerprint,
		samples: summaries,
		errors: discovered.errors,
		sortBy,
		sortDirection,
		offset,
		limit,
		count: page.length,
		total: candidates.length,
		hasMore: offset + page.length < candidates.length,
		nextOffset: offset + page.length < candidates.length ? offset + page.length : null,
	};
}

async function resolveCurrentSample(data: any, options: IMCPActionOptions): Promise<{ context: IProjectPackageContext; sample: IProjectPackageSampleInternal }> {
	if (typeof data?.sampleId !== "string" || !/^[a-f0-9]{32}$/.test(data.sampleId)) {
		throw new Error("sampleId must be a 32-character id returned by list_project_package_samples.");
	}
	if (typeof data?.expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedSourceSha256)) {
		throw new Error("expectedSourceSha256 must be the exact source hash returned by list_project_package_samples.");
	}
	const context = await getProjectPackageContext(options);
	if (data.expectedPackageFingerprint !== undefined && data.expectedPackageFingerprint !== context.fingerprint) {
		throw new Error(`Package state changed since sample inspection; expected ${String(data.expectedPackageFingerprint)} but found ${context.fingerprint}.`);
	}
	const discovered = await discoverSamples(context);
	const sample = discovered.samples.find((candidate) => candidate.id === data.sampleId);
	if (!sample) {
		throw new Error(`Installed package sample "${data.sampleId}" is missing or invalid; list samples again.`);
	}
	if (sample.evidence.sha256 !== data.expectedSourceSha256) {
		throw new Error(`Sample source changed; expected ${data.expectedSourceSha256} but found ${sample.evidence.sha256}.`);
	}
	return { context, sample };
}

function containedTargetPath(context: IProjectPackageContext, sample: IProjectPackageSampleInternal, value: unknown): { path: string; absolutePath: string } {
	const path = targetPath(value, sample);
	const absolutePath = resolve(context.projectRoot, path);
	if (!projectPathContains(context.projectRoot, absolutePath)) {
		throw new Error("Sample target must resolve inside the active project.");
	}
	return { path, absolutePath };
}

/** Reads one exact sample with image metadata and current imported-target evidence. */
export async function getProjectPackageSampleDetails(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { context, sample } = await resolveCurrentSample(data, options);
	const selectedTarget = containedTargetPath(context, sample, data.targetPath);
	const imported = await optionalTreeEvidence(selectedTarget.absolutePath);
	return {
		fingerprint: context.fingerprint,
		sample: publicSample(sample),
		images: sample.images.map(publicImage),
		imported: {
			exists: imported !== null,
			path: selectedTarget.path,
			fileCount: imported?.fileCount ?? 0,
			totalBytes: imported?.totalBytes ?? 0,
			sha256: imported?.sha256 ?? null,
			matchesSource: imported?.sha256 === sample.evidence.sha256,
		},
		cards: [
			{
				id: "overview",
				title: "Overview",
				items: {
					package: `${sample.packageName}@${sample.packageVersion}`,
					publishedAt: sample.publishedAt,
					description: sample.description,
					images: sample.images.length,
				},
			},
			{
				id: "details",
				title: "Details",
				items: {
					sourcePath: sample.sourcePath,
					files: sample.evidence.fileCount,
					bytes: sample.evidence.totalBytes,
					sourceSha256: sample.evidence.sha256,
				},
			},
		],
	};
}

/** Reveals one exact imported sample in the normal Assets Browser without changing project files. */
export async function locateProjectPackageSample(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { context, sample } = await resolveCurrentSample(data, options);
	const selectedTarget = containedTargetPath(context, sample, data.targetPath);
	const imported = await optionalTreeEvidence(selectedTarget.absolutePath);
	if (!imported) {
		throw new Error(`Imported sample target does not exist: ${selectedTarget.path}. Import it first or provide its exact targetPath.`);
	}
	const assets = options.editor.layout?.assets;
	if (!assets || typeof assets.setBrowsePath !== "function") {
		throw new Error("The normal Assets Browser is unavailable; reopen the project editor and retry Locate.");
	}
	await assets.setBrowsePath(selectedTarget.absolutePath);
	const selectedFile = imported.files[0]?.absolutePath ?? null;
	if (selectedFile && typeof assets.setSelectedFile === "function") {
		assets.setSelectedFile(selectedFile);
	}
	options.editor.layout.selectTab?.("assets-browser");
	return {
		located: true,
		sampleId: sample.id,
		targetPath: selectedTarget.path,
		selectedFile: selectedFile ? relative(context.projectRoot, selectedFile).replace(/\\/g, "/") : null,
		fileCount: imported.fileCount,
		totalBytes: imported.totalBytes,
		sha256: imported.sha256,
		matchesSource: imported.sha256 === sample.evidence.sha256,
	};
}

function planMap(scene: Scene): Map<string, IProjectPackageSamplePlan> {
	let plans = samplePlans.get(scene);
	if (!plans) {
		plans = new Map();
		samplePlans.set(scene, plans);
	}
	const now = Date.now();
	for (const [id, plan] of plans) {
		if (Date.parse(plan.expiresAt) <= now) {
			plans.delete(id);
		}
	}
	while (plans.size >= 20) {
		plans.delete(plans.keys().next().value!);
	}
	return plans;
}

function defaultTargetPath(sample: IProjectPackageSampleInternal): string {
	return join("assets", "Samples", safeSegment(sample.packageName, "package"), safeSegment(sample.packageVersion, "unknown"), safeSegment(sample.displayName, "Sample")).replace(
		/\\/g,
		"/"
	);
}

function targetPath(value: unknown, sample: IProjectPackageSampleInternal): string {
	const path = value === undefined || value === null || value === "" ? defaultTargetPath(sample) : portableRelativePath(value, "Sample target path");
	if (path !== "assets" && !path.startsWith("assets/")) {
		throw new Error("Sample target path must stay under the active project's assets directory.");
	}
	if (path === "assets") {
		throw new Error("Sample target path must name a child directory under assets.");
	}
	return path;
}

async function optionalTreeEvidence(path: string): Promise<ISampleTreeEvidence | null> {
	try {
		await lstat(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	return scanSampleTree(path);
}

async function renamedTarget(context: IProjectPackageContext, initialPath: string): Promise<{ path: string; root: string }> {
	const base = initialPath.replace(/\/$/, "");
	for (let suffix = 1; suffix <= 100; suffix++) {
		const path = `${base} (${suffix})`;
		const root = resolve(context.projectRoot, path);
		try {
			await lstat(root);
		} catch (error: any) {
			if (error?.code === "ENOENT") {
				return { path, root };
			}
			throw error;
		}
	}
	throw new Error("Could not find an unused sample target after 100 rename attempts.");
}

function publicPlan(plan: IProjectPackageSamplePlan): any {
	return {
		id: plan.id,
		createdAt: plan.createdAt,
		expiresAt: plan.expiresAt,
		packageFingerprint: plan.packageFingerprint,
		sample: publicSample(plan.sample),
		targetPath: plan.targetPath,
		collision: plan.collision,
		targetBeforeSha256: plan.targetBeforeSha256,
		writes: [plan.targetPath],
	};
}

/** Plans one exact installed-package sample import without changing project files. */
export async function planProjectPackageSampleImport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (typeof data?.sampleId !== "string" || !/^[a-f0-9]{32}$/.test(data.sampleId)) {
		throw new Error("sampleId must be a 32-character id returned by list_project_package_samples.");
	}
	if (typeof data?.expectedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedSourceSha256)) {
		throw new Error("expectedSourceSha256 must be the exact sample source hash returned by list_project_package_samples.");
	}
	const collision = data.collision ?? "fail";
	if (!(["fail", "rename", "replace"] as const).includes(collision)) {
		throw new Error('collision must be "fail", "rename", or "replace".');
	}
	const context = await getProjectPackageContext(options);
	if (data.expectedPackageFingerprint !== undefined && data.expectedPackageFingerprint !== context.fingerprint) {
		throw new Error(`Package state changed since sample inspection; expected ${String(data.expectedPackageFingerprint)} but found ${context.fingerprint}.`);
	}
	const discovered = await discoverSamples(context);
	const sample = discovered.samples.find((candidate) => candidate.id === data.sampleId);
	if (!sample) {
		throw new Error(`Installed package sample "${data.sampleId}" is missing or invalid; list samples again.`);
	}
	if (sample.evidence.sha256 !== data.expectedSourceSha256) {
		throw new Error(`Sample source changed; expected ${data.expectedSourceSha256} but found ${sample.evidence.sha256}.`);
	}
	let selectedPath = targetPath(data.targetPath, sample);
	let selectedRoot = resolve(context.projectRoot, selectedPath);
	if (!projectPathContains(context.projectRoot, selectedRoot)) {
		throw new Error("Sample target must resolve inside the active project.");
	}
	let before = await optionalTreeEvidence(selectedRoot);
	if (before && collision === "fail") {
		throw new Error(`Sample target already exists: ${selectedPath}. Choose rename or replace explicitly.`);
	}
	if (before && collision === "rename") {
		const renamed = await renamedTarget(context, selectedPath);
		selectedPath = renamed.path;
		selectedRoot = renamed.root;
		before = null;
	}
	const now = Date.now();
	const plan: IProjectPackageSamplePlan = {
		id: randomUUID(),
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + samplePlanLifetimeMs).toISOString(),
		packageFingerprint: context.fingerprint,
		sample,
		targetPath: selectedPath,
		targetRoot: selectedRoot,
		collision,
		targetBeforeSha256: before?.sha256 ?? null,
	};
	planMap(scene).set(plan.id, plan);
	return publicPlan(plan);
}

async function ensureContainedParent(context: IProjectPackageContext, targetRoot: string): Promise<void> {
	const parentRelative = relative(context.projectRoot, dirname(targetRoot));
	if (isAbsolute(parentRelative) || parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
		throw new Error("Sample target parent must stay inside the active project.");
	}
	let current = context.projectRoot;
	for (const segment of parentRelative.split(sep).filter(Boolean)) {
		if (segment === "." || segment === "..") {
			throw new Error("Sample target parent contains an unsafe segment.");
		}
		current = join(current, segment);
		try {
			const currentStat = await lstat(current);
			if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
				throw new Error(`Sample target parent must be a regular directory: ${segment}`);
			}
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
			await mkdir(current);
		}
		if (!projectPathContains(context.projectRoot, await realpath(current))) {
			throw new Error("Sample target parent resolves outside the active project.");
		}
	}
}

async function copySampleToStaging(plan: IProjectPackageSamplePlan, staging: string): Promise<void> {
	await mkdir(staging, { mode: 0o700 });
	for (const file of plan.sample.evidence.files) {
		const sourceStat = await lstat(file.absolutePath);
		if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size !== file.bytes || packageSha256(await readFile(file.absolutePath)) !== file.sha256) {
			throw new Error(`Sample source changed during import: ${file.path}`);
		}
		const destination = join(staging, ...file.path.split("/"));
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await copyFile(file.absolutePath, destination);
	}
}

/** Atomically imports one exact sample plan and restores an existing destination on failure. */
export async function applyProjectPackageSampleImport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("confirm must be true to apply a project package sample import.");
	}
	if (typeof data?.planId !== "string" || !/^[a-f0-9-]{36}$/i.test(data.planId)) {
		throw new Error("planId must be a sample import plan UUID returned by plan_project_package_sample_import.");
	}
	const plans = planMap(scene);
	const plan = plans.get(data.planId);
	if (!plan) {
		throw new Error(`Sample import plan "${data.planId}" is missing or expired; create a fresh plan.`);
	}
	if (data.expectedSourceSha256 !== plan.sample.evidence.sha256) {
		throw new Error(`expectedSourceSha256 must exactly match sample plan source hash ${plan.sample.evidence.sha256}.`);
	}
	const context = await getProjectPackageContext(options);
	if (context.fingerprint !== plan.packageFingerprint) {
		throw new Error(`Package state changed after sample planning; expected ${plan.packageFingerprint} but found ${context.fingerprint}.`);
	}
	const sourceNow = await scanSampleTree(plan.sample.sourceRoot);
	if (sourceNow.sha256 !== plan.sample.evidence.sha256) {
		throw new Error(`Sample source changed after planning; expected ${plan.sample.evidence.sha256} but found ${sourceNow.sha256}.`);
	}
	const targetNow = await optionalTreeEvidence(plan.targetRoot);
	if ((targetNow?.sha256 ?? null) !== plan.targetBeforeSha256) {
		throw new Error(`Sample target changed after planning; expected ${plan.targetBeforeSha256 ?? "absence"} but found ${targetNow?.sha256 ?? "absence"}.`);
	}
	await ensureContainedParent(context, plan.targetRoot);
	const staging = join(dirname(plan.targetRoot), `.zvibe-sample-${plan.id}.tmp`);
	const backup = join(dirname(plan.targetRoot), `.zvibe-sample-${plan.id}.bak`);
	let backedUp = false;
	let published = false;
	try {
		await copySampleToStaging(plan, staging);
		const stagedEvidence = await scanSampleTree(staging);
		if (stagedEvidence.sha256 !== plan.sample.evidence.sha256) {
			throw new Error("Staged sample SHA-256 does not match the planned source.");
		}
		if (targetNow) {
			await rename(plan.targetRoot, backup);
			backedUp = true;
		}
		await rename(staging, plan.targetRoot);
		published = true;
		const importedEvidence = await scanSampleTree(plan.targetRoot);
		if (importedEvidence.sha256 !== plan.sample.evidence.sha256) {
			throw new Error("Imported sample SHA-256 does not match the planned source.");
		}
		if (backedUp) {
			await rm(backup, { recursive: true, force: true });
		}
		plans.delete(plan.id);
		options.editor.layout?.inspector?.forceUpdate?.();
		return {
			imported: true,
			plan: publicPlan(plan),
			target: { path: plan.targetPath, fileCount: importedEvidence.fileCount, totalBytes: importedEvidence.totalBytes, sha256: importedEvidence.sha256 },
			rollback: null,
		};
	} catch (error) {
		await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		if (published) {
			await rm(plan.targetRoot, { recursive: true, force: true }).catch(() => undefined);
		}
		if (backedUp) {
			await rename(backup, plan.targetRoot).catch(() => undefined);
		}
		throw error;
	}
}
