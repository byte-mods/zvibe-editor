import { createHash, randomUUID } from "crypto";
import { dirname, join, normalize, relative, resolve } from "path/posix";

import { copy, ensureDir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";
import { listAssetImporterDefinitions } from "babylonjs-editor-tools";

import type { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { applyAnimationImporterArtifact, getAnimationImporterArtifactStatus } from "./animation-importer";
import { applyAudioImporterArtifact, getAudioImporterArtifactStatus } from "./audio-importer";
import { applyFontImporterArtifact, getFontImporterArtifactStatus } from "./font-importer";
import { applyMaterialImporterArtifact, getMaterialImporterArtifactStatus } from "./material-importer";
import { applyModelImporterArtifact, getModelImporterArtifactStatus } from "./model-importer";
import { ensureAssetRegistry, IAssetRegistryEntry, inspectAssetImportState, readAssetMetadata, refreshAssetRegistryPaths, writeAssetMetadata } from "./registry";
import { applyTextureImporterArtifact, getTextureImporterArtifactStatus } from "./texture-importer";
import { applyVideoImporterArtifact, getVideoImporterArtifactStatus } from "./video-importer";

export type AutoReimportImporterKind = "texture" | "model" | "audio" | "video" | "font" | "material" | "animation";
export type AutoReimportReason = "source" | "dependency" | "manual";

export interface IAutoReimportSettings {
	version: 1;
	enabled: boolean;
	watchImportedSources: boolean;
	maxBatchSize: number;
	importerKinds: AutoReimportImporterKind[];
}

export interface IAutoReimportCandidate {
	path: string;
	kind: AutoReimportImporterKind;
	triggers: string[];
	reasons: AutoReimportReason[];
	fingerprint: string | null;
	current: boolean | null;
	state: "current" | "stale" | "unsupported" | "error";
	willApply: boolean;
	error: string | null;
}

export interface IAutoReimportPlan {
	settings: IAutoReimportSettings;
	settingsFingerprint: string;
	fingerprint: string;
	paths: string[] | null;
	force: boolean;
	candidates: IAutoReimportCandidate[];
	candidateCount: number;
	applyCount: number;
	blocked: boolean;
	blockers: string[];
}

export interface IAutoReimportResult {
	path: string;
	kind: AutoReimportImporterKind;
	status: "applied" | "current" | "unsupported" | "failed" | "stalePlan";
	fingerprint: string | null;
	triggers: string[];
	reasons: AutoReimportReason[];
	error: string | null;
}

export interface IAutoReimportSourceCopy {
	originPath: string;
	assetPath: string;
	status: "copied" | "failed";
	error: string | null;
}

export interface IAutoReimportJob {
	id: string;
	status: "running" | "completed" | "partial" | "failed";
	createdAt: string;
	finishedAt: string | null;
	planFingerprint: string;
	triggerPaths: string[] | null;
	results: IAutoReimportResult[];
	sourceCopies: IAutoReimportSourceCopy[];
	appliedCount: number;
	currentCount: number;
	failedCount: number;
}

interface IImporterArtifactStatus {
	fingerprint: string;
	current: boolean;
}

interface IImporterHandler {
	getStatus: (path: string) => Promise<IImporterArtifactStatus>;
	apply: (path: string, fingerprint: string, editor?: Editor) => Promise<IImporterArtifactStatus>;
}

const AUTO_REIMPORT_SETTINGS_PATH = ".bjseditor/auto-reimport.json";
const AUTO_REIMPORT_STATUS_PATH = ".bjseditor/auto-reimport-status.json";
const ALL_IMPORTER_KINDS: AutoReimportImporterKind[] = ["texture", "model", "audio", "video", "font", "material", "animation"];
const MAXIMUM_ORIGIN_WATCHES = 512;

const handlers: Record<AutoReimportImporterKind, IImporterHandler> = {
	texture: {
		getStatus: getTextureImporterArtifactStatus,
		apply: applyTextureImporterArtifact,
	},
	model: {
		getStatus: getModelImporterArtifactStatus,
		apply: applyModelImporterArtifact,
	},
	audio: {
		getStatus: getAudioImporterArtifactStatus,
		apply: (path, fingerprint, editor) => applyAudioImporterArtifact(path, fingerprint, editor),
	},
	video: {
		getStatus: getVideoImporterArtifactStatus,
		apply: (path, fingerprint, editor) => applyVideoImporterArtifact(path, fingerprint, editor),
	},
	font: {
		getStatus: getFontImporterArtifactStatus,
		apply: applyFontImporterArtifact,
	},
	material: {
		getStatus: getMaterialImporterArtifactStatus,
		apply: applyMaterialImporterArtifact,
	},
	animation: {
		getStatus: getAnimationImporterArtifactStatus,
		apply: applyAnimationImporterArtifact,
	},
};

const supportedExtensions = new Map<AutoReimportImporterKind, Set<string>>(
	ALL_IMPORTER_KINDS.map((kind) => {
		const extensions = listAssetImporterDefinitions().find((definition) => definition.kind === kind)?.extensions ?? [];
		return [kind, new Set(extensions.map((extension) => `.${extension.toLowerCase().replace(/^\./, "")}`))];
	})
);

let autoReimportOperation: Promise<unknown> = Promise.resolve();
let activeJob: IAutoReimportJob | null = null;
const watcherSuppressions = new Map<string, number>();

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function settingsPath(): string {
	return join(projectDirectory(), AUTO_REIMPORT_SETTINGS_PATH);
}

function statusPath(): string {
	return join(projectDirectory(), AUTO_REIMPORT_STATUS_PATH);
}

function normalizeSettings(value: Partial<IAutoReimportSettings> | null | undefined): IAutoReimportSettings {
	const kinds = Array.isArray(value?.importerKinds)
		? [...new Set(value.importerKinds.filter((kind): kind is AutoReimportImporterKind => ALL_IMPORTER_KINDS.includes(kind as AutoReimportImporterKind)))]
		: ALL_IMPORTER_KINDS;
	return {
		version: 1,
		enabled: value?.enabled !== false,
		watchImportedSources: value?.watchImportedSources === true,
		maxBatchSize: Number.isInteger(value?.maxBatchSize) ? Math.min(256, Math.max(1, value!.maxBatchSize!)) : 64,
		importerKinds: kinds.length ? kinds : ALL_IMPORTER_KINDS,
	};
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await ensureDir(dirname(path));
	await writeJSON(temporary, value, { spaces: "\t" });
	try {
		await move(temporary, path, { overwrite: true });
	} finally {
		await remove(temporary);
	}
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
	const result = autoReimportOperation.then(operation, operation);
	autoReimportOperation = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

function projectPath(path: string): string {
	const root = projectDirectory();
	const absolute = resolve(path.startsWith("/") ? path : join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error(`Auto Reimport paths must stay inside the project: ${path}`);
	}
	return relative(root, absolute).replace(/\\/g, "/");
}

function pathMatches(candidate: string, trigger: string): boolean {
	return candidate === trigger || candidate.startsWith(`${trigger}/`);
}

function isSupportedEntry(entry: IAssetRegistryEntry, settings: IAutoReimportSettings): entry is IAssetRegistryEntry & { importer: { kind: AutoReimportImporterKind } } {
	const kind = entry.importer.kind as AutoReimportImporterKind;
	return settings.importerKinds.includes(kind) && supportedExtensions.get(kind)?.has(entry.extension) === true;
}

function collectCandidates(
	entries: IAssetRegistryEntry[],
	requestedPaths: string[] | null,
	settings: IAutoReimportSettings
): Map<string, { entry: IAssetRegistryEntry; triggers: Set<string>; reasons: Set<AutoReimportReason> }> {
	const result = new Map<string, { entry: IAssetRegistryEntry; triggers: Set<string>; reasons: Set<AutoReimportReason> }>();
	if (requestedPaths === null) {
		for (const entry of entries) {
			if (isSupportedEntry(entry, settings)) {
				result.set(entry.path, { entry, triggers: new Set(), reasons: new Set(["manual"]) });
			}
		}
		return result;
	}

	const affected = new Set(requestedPaths);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of entries) {
			const ownTriggers = requestedPaths.filter((trigger) => pathMatches(entry.path, trigger));
			const dependencyTriggers = [...affected].filter((trigger) => entry.dependencyCandidates.some((dependency) => pathMatches(dependency, trigger)));
			if (!ownTriggers.length && !dependencyTriggers.length) {
				continue;
			}
			if (!affected.has(entry.path)) {
				affected.add(entry.path);
				changed = true;
			}
			if (!isSupportedEntry(entry, settings)) {
				continue;
			}
			const candidate = result.get(entry.path) ?? { entry, triggers: new Set<string>(), reasons: new Set<AutoReimportReason>() };
			ownTriggers.forEach((trigger) => candidate.triggers.add(trigger));
			dependencyTriggers.forEach((trigger) => candidate.triggers.add(trigger));
			if (ownTriggers.length) {
				candidate.reasons.add("source");
			}
			if (dependencyTriggers.length) {
				candidate.reasons.add("dependency");
			}
			result.set(entry.path, candidate);
		}
	}
	return result;
}

/** Reads the project-scoped Auto Reimport configuration and exact mutation lease. */
export async function getAutoReimportSettings(): Promise<{ settings: IAutoReimportSettings; fingerprint: string }> {
	let value: Partial<IAutoReimportSettings> | null = null;
	if (await pathExists(settingsPath())) {
		try {
			value = await readJSON(settingsPath());
		} catch {
			value = null;
		}
	}
	const settings = normalizeSettings(value);
	return { settings, fingerprint: fingerprint(settings) };
}

/** Atomically replaces the complete Auto Reimport configuration under an exact settings lease. */
export async function setAutoReimportSettings(
	expectedFingerprint: string,
	value: Partial<IAutoReimportSettings>
): Promise<{ settings: IAutoReimportSettings; fingerprint: string }> {
	return serialize(async () => {
		const current = await getAutoReimportSettings();
		if (current.fingerprint !== expectedFingerprint) {
			throw new Error(`Auto Reimport settings changed. Inspect again and use current fingerprint ${current.fingerprint}.`);
		}
		const settings = normalizeSettings(value);
		await writeAtomicJson(settingsPath(), settings);
		return { settings, fingerprint: fingerprint(settings) };
	});
}

/** Produces an exact, bounded plan for source and recursively affected dependency importers. */
export async function inspectAutoReimport(options: { paths?: string[]; force?: boolean } = {}): Promise<IAutoReimportPlan> {
	const settingsStatus = await getAutoReimportSettings();
	const requestedPaths = options.paths ? [...new Set(options.paths.map(projectPath))].sort() : null;
	const registry = await ensureAssetRegistry();
	const collected = collectCandidates(registry.entries, requestedPaths, settingsStatus.settings);
	const blockers: string[] = [];
	if (collected.size > settingsStatus.settings.maxBatchSize) {
		blockers.push(`Plan contains ${collected.size} importer assets, exceeding maxBatchSize ${settingsStatus.settings.maxBatchSize}. Narrow paths or increase the setting.`);
	}
	const candidates: IAutoReimportCandidate[] = [];
	for (const { entry, triggers, reasons } of [...collected.values()].sort((a, b) => a.entry.path.localeCompare(b.entry.path))) {
		const kind = entry.importer.kind as AutoReimportImporterKind;
		try {
			const status = await handlers[kind].getStatus(join(projectDirectory(), entry.path));
			const dependencyTriggered = reasons.has("dependency");
			candidates.push({
				path: entry.path,
				kind,
				triggers: [...triggers].sort(),
				reasons: [...reasons].sort(),
				fingerprint: status.fingerprint,
				current: status.current,
				state: status.current ? "current" : "stale",
				willApply: options.force === true || !status.current || dependencyTriggered,
				error: null,
			});
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
			candidates.push({
				path: entry.path,
				kind,
				triggers: [...triggers].sort(),
				reasons: [...reasons].sort(),
				fingerprint: null,
				current: null,
				state: /supports|currently support|remain passthrough/i.test(message) ? "unsupported" : "error",
				willApply: false,
				error: message,
			});
		}
	}
	const planEvidence = {
		settings: settingsStatus.settings,
		paths: requestedPaths,
		force: options.force === true,
		candidates: candidates.map(({ path, kind, triggers, reasons, fingerprint: candidateFingerprint, current, state, willApply, error }) => ({
			path,
			kind,
			triggers,
			reasons,
			fingerprint: candidateFingerprint,
			current,
			state,
			willApply,
			error,
		})),
		blockers,
	};
	return {
		settings: settingsStatus.settings,
		settingsFingerprint: settingsStatus.fingerprint,
		fingerprint: fingerprint(planEvidence),
		paths: requestedPaths,
		force: options.force === true,
		candidates,
		candidateCount: candidates.length,
		applyCount: candidates.filter((candidate) => candidate.willApply).length,
		blocked: blockers.length > 0,
		blockers,
	};
}

async function writeJob(job: IAutoReimportJob): Promise<void> {
	await writeAtomicJson(statusPath(), job);
}

async function executePlan(plan: IAutoReimportPlan, editor?: Editor, sourceCopies: IAutoReimportSourceCopy[] = []): Promise<IAutoReimportJob> {
	if (plan.blocked) {
		throw new Error(plan.blockers.join(" "));
	}
	const job: IAutoReimportJob = {
		id: randomUUID(),
		status: "running",
		createdAt: new Date().toISOString(),
		finishedAt: null,
		planFingerprint: plan.fingerprint,
		triggerPaths: plan.paths,
		results: [],
		sourceCopies,
		appliedCount: 0,
		currentCount: 0,
		failedCount: sourceCopies.filter((copyResult) => copyResult.status === "failed").length,
	};
	activeJob = job;
	await writeJob(job);
	try {
		for (const candidate of plan.candidates) {
			if (!candidate.willApply || !candidate.fingerprint) {
				const status = candidate.state === "unsupported" ? "unsupported" : candidate.state === "error" ? "failed" : "current";
				job.results.push({
					path: candidate.path,
					kind: candidate.kind,
					status,
					fingerprint: candidate.fingerprint,
					triggers: candidate.triggers,
					reasons: candidate.reasons,
					error: candidate.error,
				});
				if (status === "current") {
					job.currentCount++;
				} else if (status === "failed") {
					job.failedCount++;
				}
				continue;
			}
			const absolutePath = join(projectDirectory(), candidate.path);
			try {
				const current = await handlers[candidate.kind].getStatus(absolutePath);
				if (current.fingerprint !== candidate.fingerprint) {
					job.results.push({
						path: candidate.path,
						kind: candidate.kind,
						status: "stalePlan",
						fingerprint: current.fingerprint,
						triggers: candidate.triggers,
						reasons: candidate.reasons,
						error: "Importer source, settings, or dependencies changed after planning.",
					});
					job.failedCount++;
					continue;
				}
				const applied = await handlers[candidate.kind].apply(absolutePath, candidate.fingerprint, editor);
				job.results.push({
					path: candidate.path,
					kind: candidate.kind,
					status: "applied",
					fingerprint: applied.fingerprint,
					triggers: candidate.triggers,
					reasons: candidate.reasons,
					error: null,
				});
				job.appliedCount++;
			} catch (error) {
				job.results.push({
					path: candidate.path,
					kind: candidate.kind,
					status: "failed",
					fingerprint: candidate.fingerprint,
					triggers: candidate.triggers,
					reasons: candidate.reasons,
					error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
				});
				job.failedCount++;
			}
		}
		job.status = job.failedCount === 0 ? "completed" : job.appliedCount || job.currentCount ? "partial" : "failed";
		return job;
	} finally {
		job.finishedAt = new Date().toISOString();
		activeJob = null;
		await writeJob(job);
	}
}

/** Executes one exact plan. Used by manual UI/MCP actions. */
export async function runAutoReimport(expectedFingerprint: string, options: { paths?: string[]; force?: boolean } = {}, editor?: Editor): Promise<IAutoReimportJob> {
	return serialize(async () => {
		const plan = await inspectAutoReimport(options);
		if (plan.fingerprint !== expectedFingerprint) {
			throw new Error(`Auto Reimport plan changed. Inspect again and use current fingerprint ${plan.fingerprint}.`);
		}
		return executePlan(plan, editor);
	});
}

/** Runs enabled Auto Reimport after the editor watcher has refreshed changed registry paths. */
export async function processAutoReimportChanges(paths: string[], editor?: Editor): Promise<IAutoReimportJob | null> {
	return serialize(async () => {
		const settings = await getAutoReimportSettings();
		if (!settings.settings.enabled) {
			return null;
		}
		const now = Date.now();
		const filteredPaths = paths.filter((path) => {
			const normalizedPath = projectPath(path);
			const expiresAt = watcherSuppressions.get(normalizedPath) ?? 0;
			if (expiresAt < now) {
				watcherSuppressions.delete(normalizedPath);
			}
			return expiresAt < now;
		});
		if (!filteredPaths.length) {
			return null;
		}
		const plan = await inspectAutoReimport({ paths: filteredPaths });
		if (plan.applyCount === 0) {
			return null;
		}
		return executePlan(plan, editor);
	});
}

/** Returns bounded external import origins that should be watched when explicitly enabled. */
export async function getAutoReimportOriginPaths(): Promise<string[]> {
	const settings = await getAutoReimportSettings();
	if (!settings.settings.enabled || !settings.settings.watchImportedSources) {
		return [];
	}
	const registry = await ensureAssetRegistry();
	const origins: string[] = [];
	for (const entry of registry.entries) {
		const metadata = await readAssetMetadata(join(projectDirectory(), entry.path));
		if (metadata.originPath) {
			origins.push(normalize(metadata.originPath));
			if (origins.length > MAXIMUM_ORIGIN_WATCHES) {
				throw new Error(`External source watching is limited to ${MAXIMUM_ORIGIN_WATCHES} imported origins.`);
			}
		}
	}
	return [...new Set(origins)].sort();
}

/** Copies explicitly watched external origins atomically, then rebuilds their importer/dependent artifacts through the same controller. */
export async function processAutoReimportOriginChanges(originPaths: string[], editor?: Editor): Promise<IAutoReimportJob | null> {
	return serialize(async () => {
		const settings = await getAutoReimportSettings();
		if (!settings.settings.enabled || !settings.settings.watchImportedSources) {
			return null;
		}
		const requested = new Set(originPaths.map((path) => normalize(resolve(path))));
		const registry = await ensureAssetRegistry();
		const copiedAssets: string[] = [];
		const sourceCopies: IAutoReimportSourceCopy[] = [];
		for (const entry of registry.entries) {
			const absolutePath = join(projectDirectory(), entry.path);
			const metadata = await readAssetMetadata(absolutePath);
			if (!metadata.originPath || !requested.has(normalize(resolve(metadata.originPath)))) {
				continue;
			}
			const originPath = normalize(resolve(metadata.originPath));
			const temporary = `${absolutePath}.${randomUUID()}.auto-reimport.tmp`;
			try {
				if (!(await pathExists(originPath)) || !(await stat(originPath)).isFile()) {
					throw new Error("Recorded import source is unavailable or is not a file.");
				}
				await copy(originPath, temporary, { overwrite: true });
				watcherSuppressions.set(entry.path, Date.now() + 5_000);
				await move(temporary, absolutePath, { overwrite: true });
				metadata.reimportedAt = new Date().toISOString();
				metadata.importState = await inspectAssetImportState({ ...metadata, importState: { status: "unchecked" } });
				await writeAssetMetadata(absolutePath, metadata);
				copiedAssets.push(entry.path);
				sourceCopies.push({ originPath, assetPath: entry.path, status: "copied", error: null });
			} catch (error) {
				sourceCopies.push({
					originPath,
					assetPath: entry.path,
					status: "failed",
					error: (error instanceof Error ? error.message : String(error)).slice(0, 2048),
				});
			} finally {
				await remove(temporary);
			}
		}
		if (!copiedAssets.length) {
			return null;
		}
		await refreshAssetRegistryPaths(copiedAssets);
		const plan = await inspectAutoReimport({ paths: copiedAssets });
		return executePlan(plan, editor, sourceCopies);
	});
}

/** Reports the current/persisted Auto Reimport job without mutating importer artifacts. */
export async function getAutoReimportStatus(): Promise<{
	settings: IAutoReimportSettings;
	settingsFingerprint: string;
	activeJob: IAutoReimportJob | null;
	lastJob: IAutoReimportJob | null;
}> {
	const settings = await getAutoReimportSettings();
	let lastJob: IAutoReimportJob | null = null;
	if (await pathExists(statusPath())) {
		try {
			lastJob = await readJSON(statusPath());
		} catch {
			lastJob = null;
		}
	}
	return { settings: settings.settings, settingsFingerprint: settings.fingerprint, activeJob: activeJob ? structuredClone(activeJob) : null, lastJob };
}
