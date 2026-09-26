import { createHash, randomUUID } from "crypto";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "path/posix";
import { readFile, readJSON, realpath, stat } from "fs-extra";
import ts from "typescript";

import { Observable, Scene } from "babylonjs";
import { measurePortableProfiler2D, normalizeTextureImporterSettings } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { analyzeSerializationSource, ISerializationCompileDiagnostic } from "../../tools/serialization-diagnostics";
import { IMCPActionOptions } from "../action";
import { ensureAssetRegistry, IAssetRegistry, IAssetRegistryEntry, readAssetMetadata, refreshAssetRegistryPaths, writeAssetMetadata } from "../assets/registry";

export type ProjectAuditCategory = "serialization" | "obsolete-api" | "particle-texture-readability" | "atlas-waste";
export type ProjectAuditSeverity = "error" | "warning" | "info";
export type ProjectAuditJobStatus = "queued" | "running" | "completed" | "cancelled" | "failed";
export type ProjectAuditJobPhase = "queued" | "discovering" | "serialization" | "obsolete-apis" | "particle-textures" | "atlas-waste" | "complete";

export interface IProjectAuditSettings {
	categories: ProjectAuditCategory[];
	obsoleteTargetVersion: string;
	maximumIssues: number;
	atlasAllocationWasteThresholdPercent: number;
	atlasUnusedRegionThresholdPercent: number;
}

export interface IProjectAuditIssue {
	id: string;
	fingerprint: string;
	category: ProjectAuditCategory;
	severity: ProjectAuditSeverity;
	code: string;
	title: string;
	message: string;
	recommendation: string;
	location: {
		path: string | null;
		line: number | null;
		column: number | null;
		nodeId: string | null;
		nodeName: string | null;
		property: string | null;
	};
	evidence: Record<string, unknown>;
	fixAvailable: boolean;
	resolvedAt: string | null;
}

interface IProjectAuditIssueInternal extends IProjectAuditIssue {
	fix: { kind: "set-texture-readable"; path: string; readable: boolean } | null;
}

interface IProjectAuditJobInternal {
	id: string;
	revision: number;
	status: ProjectAuditJobStatus;
	phase: ProjectAuditJobPhase;
	progress: { completed: number; total: number; message: string };
	settings: IProjectAuditSettings;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	issuesFingerprint: string | null;
	summary: { total: number; errors: number; warnings: number; info: number; byCategory: Record<ProjectAuditCategory, number>; truncated: boolean };
	issues: IProjectAuditIssueInternal[];
	cancelRequested: boolean;
	error: string | null;
}

interface IProjectAuditorStateInternal {
	revision: number;
	activeJobId: string | null;
	jobs: IProjectAuditJobInternal[];
}

interface ISourceSnapshot {
	path: string;
	absolutePath: string;
	content: string;
}

const categories: ProjectAuditCategory[] = ["serialization", "obsolete-api", "particle-texture-readability", "atlas-waste"];
const maximumSourceFiles = 2_000;
const maximumSourceFileBytes = 2 * 1024 * 1024;
const sourceReadConcurrency = 32;
const maximumSourceAggregateBytes = 64 * 1024 * 1024;
const maximumJsonFileBytes = 2 * 1024 * 1024;
const maximumParticleDocuments = 1_024;
const maximumAtlasDocuments = 512;
const maximumAtlasFrames = 65_536;
const maximumRetainedJobs = 20;
const states = new WeakMap<Scene, IProjectAuditorStateInternal>();

export const onProjectAuditorChangedObservable = new Observable<{ scene: Scene; revision: number; jobId: string | null }>();

class ProjectAuditCancelledError extends Error {}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function stateFor(scene: Scene): IProjectAuditorStateInternal {
	let state = states.get(scene);
	if (!state) {
		state = { revision: 1, activeJobId: null, jobs: [] };
		states.set(scene, state);
	}
	return state;
}

function notify(scene: Scene, state: IProjectAuditorStateInternal, jobId: string | null): void {
	state.revision++;
	onProjectAuditorChangedObservable.notifyObservers({ scene, revision: state.revision, jobId });
}

function requireStateRevision(scene: Scene, expectedRevision: unknown): IProjectAuditorStateInternal {
	const state = stateFor(scene);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
		throw new Error(`Project Auditor state changed. Inspect it again and use expectedRevision ${state.revision}.`);
	}
	return state;
}

function publicIssue(issue: IProjectAuditIssueInternal): IProjectAuditIssue {
	const { fix: _fix, ...value } = issue;
	return structuredClone(value);
}

function publicJob(job: IProjectAuditJobInternal): any {
	return {
		id: job.id,
		revision: job.revision,
		status: job.status,
		phase: job.phase,
		progress: structuredClone(job.progress),
		settings: structuredClone(job.settings),
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		issuesFingerprint: job.issuesFingerprint,
		summary: structuredClone(job.summary),
		error: job.error,
	};
}

function emptySummary(): IProjectAuditJobInternal["summary"] {
	return {
		total: 0,
		errors: 0,
		warnings: 0,
		info: 0,
		byCategory: { serialization: 0, "obsolete-api": 0, "particle-texture-readability": 0, "atlas-waste": 0 },
		truncated: false,
	};
}

function normalizeSettings(value: unknown): IProjectAuditSettings {
	const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<IProjectAuditSettings>) : {};
	const selected = input.categories ?? categories;
	if (!Array.isArray(selected) || !selected.length || selected.length > categories.length || selected.some((category) => !categories.includes(category))) {
		throw new Error(`Project Auditor categories must contain one or more of: ${categories.join(", ")}.`);
	}
	if (new Set(selected).size !== selected.length) {
		throw new Error("Project Auditor categories must be unique.");
	}
	const obsoleteTargetVersion = input.obsoleteTargetVersion ?? "2.0.0";
	if (!/^\d+\.\d+\.\d+$/.test(obsoleteTargetVersion)) {
		throw new Error("obsoleteTargetVersion must use major.minor.patch syntax.");
	}
	const maximumIssues = input.maximumIssues ?? 5_000;
	if (!Number.isSafeInteger(maximumIssues) || maximumIssues < 1 || maximumIssues > 10_000) {
		throw new Error("maximumIssues must be an integer from 1 to 10,000.");
	}
	const atlasAllocationWasteThresholdPercent = input.atlasAllocationWasteThresholdPercent ?? 35;
	const atlasUnusedRegionThresholdPercent = input.atlasUnusedRegionThresholdPercent ?? 50;
	for (const [name, threshold] of [
		["atlasAllocationWasteThresholdPercent", atlasAllocationWasteThresholdPercent],
		["atlasUnusedRegionThresholdPercent", atlasUnusedRegionThresholdPercent],
	] as const) {
		if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
			throw new Error(`${name} must be a finite percentage from 1 to 100.`);
		}
	}
	return {
		categories: [...selected],
		obsoleteTargetVersion,
		maximumIssues,
		atlasAllocationWasteThresholdPercent,
		atlasUnusedRegionThresholdPercent,
	};
}

function issueFingerprint(value: Omit<IProjectAuditIssueInternal, "id" | "fingerprint" | "fixAvailable" | "resolvedAt">): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeIssue(value: Omit<IProjectAuditIssueInternal, "id" | "fingerprint" | "fixAvailable" | "resolvedAt">): IProjectAuditIssueInternal {
	const fingerprint = issueFingerprint(value);
	return { ...value, id: fingerprint.slice(0, 24), fingerprint, fixAvailable: value.fix !== null, resolvedAt: null };
}

function addIssue(job: IProjectAuditJobInternal, issue: IProjectAuditIssueInternal): void {
	if (job.issues.length >= job.settings.maximumIssues) {
		job.summary.truncated = true;
		return;
	}
	if (job.issues.some((candidate) => candidate.fingerprint === issue.fingerprint)) {
		return;
	}
	job.issues.push(issue);
}

function updateSummary(job: IProjectAuditJobInternal): void {
	const unresolved = job.issues.filter((issue) => issue.resolvedAt === null);
	job.summary = {
		total: unresolved.length,
		errors: unresolved.filter((issue) => issue.severity === "error").length,
		warnings: unresolved.filter((issue) => issue.severity === "warning").length,
		info: unresolved.filter((issue) => issue.severity === "info").length,
		byCategory: Object.fromEntries(categories.map((category) => [category, unresolved.filter((issue) => issue.category === category).length])) as Record<
			ProjectAuditCategory,
			number
		>,
		truncated: job.summary.truncated,
	};
}

function touchJob(scene: Scene, state: IProjectAuditorStateInternal, job: IProjectAuditJobInternal): void {
	job.revision++;
	updateSummary(job);
	notify(scene, state, job.id);
}

function setPhase(scene: Scene, state: IProjectAuditorStateInternal, job: IProjectAuditJobInternal, phase: ProjectAuditJobPhase, message: string, total = 0): void {
	job.phase = phase;
	job.progress = { completed: 0, total, message };
	touchJob(scene, state, job);
}

function checkCancelled(job: IProjectAuditJobInternal): void {
	if (job.cancelRequested) {
		throw new ProjectAuditCancelledError("Project audit cancelled before result publication.");
	}
}

async function yieldToEditor(job: IProjectAuditJobInternal): Promise<void> {
	checkCancelled(job);
	await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
	checkCancelled(job);
}

async function assertContainedRegularFile(path: string): Promise<void> {
	const root = await realpath(projectDirectory());
	const canonical = await realpath(path);
	if (canonical !== root && !canonical.startsWith(`${root}/`)) {
		throw new Error(`Project Auditor refused a symlink that resolves outside the project: ${relative(projectDirectory(), path)}.`);
	}
	const details = await stat(canonical);
	if (!details.isFile()) {
		throw new Error(`Project Auditor expected a regular file: ${relative(projectDirectory(), path)}.`);
	}
}

async function collectSources(): Promise<ISourceSnapshot[]> {
	const root = projectDirectory();
	const files = ((await normalizedGlob(join(root, "src/**/*.{ts,tsx}"), { nodir: true, ignore: ["**/*.d.ts", "**/node_modules/**"] })) as string[]).sort();
	if (files.length > maximumSourceFiles) {
		throw new Error(`Project Auditor supports at most ${maximumSourceFiles.toLocaleString()} TypeScript source files.`);
	}
	const result: ISourceSnapshot[] = [];
	let aggregateBytes = 0;
	// Check and read sources in bounded batches: one file at a time costs several event-loop turns per file, which makes
	// discovery take minutes for projects with hundreds of scripts while the renderer is busy drawing the preview.
	for (let index = 0; index < files.length; index += sourceReadConcurrency) {
		const batch = files.slice(index, index + sourceReadConcurrency);
		const sizes = await Promise.all(
			batch.map(async (absolutePath) => {
				await assertContainedRegularFile(absolutePath);
				return (await stat(absolutePath)).size;
			})
		);
		sizes.forEach((size, batchIndex) => {
			if (size > maximumSourceFileBytes) {
				throw new Error(`Project source ${relative(root, batch[batchIndex])} exceeds the 2 MiB analysis limit.`);
			}
			aggregateBytes += size;
			if (aggregateBytes > maximumSourceAggregateBytes) {
				throw new Error("Project TypeScript exceeds the 64 MiB aggregate analysis limit.");
			}
		});
		const contents = await Promise.all(batch.map((absolutePath) => readFile(absolutePath, "utf-8")));
		batch.forEach((absolutePath, batchIndex) => result.push({ path: relative(root, absolutePath).replace(/\\/g, "/"), absolutePath, content: contents[batchIndex] }));
	}
	return result;
}

function serializationIssue(value: ISerializationCompileDiagnostic): IProjectAuditIssueInternal {
	return makeIssue({
		category: "serialization",
		severity: value.category,
		code: value.code,
		title: "Serialized Inspector field is not compile-safe",
		message: value.message,
		recommendation: "Use one visibleAs* decorator and a concrete compatible TypeScript field type; rerun script diagnostics before Play or export.",
		location: { path: value.path, line: value.line, column: value.column, nodeId: null, nodeName: null, property: value.field },
		evidence: { analyzer: "zvibe-typescript-serialization-analyzer-v1", decorator: value.decorator, compileBlocking: value.category === "error" },
		fix: null,
	});
}

function textForJsDocTag(tag: ts.JSDocTagInfo): string {
	return (tag.text ?? [])
		.map((part) => part.text)
		.join("")
		.slice(0, 1_024);
}

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) {
			return a[index] - b[index];
		}
	}
	return 0;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
	const parent = node.parent;
	return (
		(ts.isImportSpecifier(parent) ||
			ts.isImportClause(parent) ||
			ts.isNamespaceImport(parent) ||
			ts.isBindingElement(parent) ||
			ts.isVariableDeclaration(parent) ||
			ts.isParameter(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isFunctionDeclaration(parent) ||
			ts.isClassDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent) ||
			ts.isTypeAliasDeclaration(parent) ||
			ts.isEnumDeclaration(parent)) &&
		parent.name === node
	);
}

function locationForNode(sourceFile: ts.SourceFile, node: ts.Node): IProjectAuditIssue["location"] {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return {
		path: relative(projectDirectory(), sourceFile.fileName).replace(/\\/g, "/"),
		line: position.line + 1,
		column: position.character + 1,
		nodeId: null,
		nodeName: null,
		property: null,
	};
}

const futureObsoleteCatalog: Record<string, { obsoleteIn: string; replacement: string; message: string }> = {
	guiFromAsset: {
		obsoleteIn: "2.0.0",
		replacement: "visibleAsAsset",
		message: "The asynchronous guiFromAsset decorator is replaced by the serializable visibleAsAsset GUI binding.",
	},
};

function collectFutureCatalogImports(sourceFile: ts.SourceFile): Map<string, string> {
	const result = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "babylonjs-editor-tools") {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) {
			continue;
		}
		for (const element of bindings.elements) {
			const importedName = (element.propertyName ?? element.name).text;
			if (futureObsoleteCatalog[importedName]) {
				result.set(element.name.text, importedName);
			}
		}
	}
	return result;
}

function analyzeObsoleteApis(sources: ISourceSnapshot[], targetVersion: string): IProjectAuditIssueInternal[] {
	if (!sources.length) {
		return [];
	}
	const compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		experimentalDecorators: true,
		noEmit: true,
		skipLibCheck: true,
	};
	const program = ts.createProgram(
		sources.map((source) => source.absolutePath),
		compilerOptions
	);
	const checker = program.getTypeChecker();
	const result: IProjectAuditIssueInternal[] = [];
	for (const source of sources) {
		const sourceFile = program.getSourceFile(source.absolutePath);
		if (!sourceFile) {
			continue;
		}
		const futureCatalogImports = collectFutureCatalogImports(sourceFile);
		const visit = (node: ts.Node): void => {
			if (ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
				let symbol = checker.getSymbolAtLocation(node);
				if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
					try {
						symbol = checker.getAliasedSymbol(symbol);
					} catch {
						// An unresolved alias has no authoritative deprecation declaration to audit.
					}
				}
				const tags = symbol?.getJsDocTags(checker) ?? [];
				const deprecated = tags.find((tag) => tag.name === "deprecated");
				const obsoleteTag = tags.find((tag) => tag.name.toLowerCase() === "obsoletein");
				const catalogKey = futureCatalogImports.get(node.text);
				const catalog = catalogKey ? futureObsoleteCatalog[catalogKey] : undefined;
				const obsoleteIn = (obsoleteTag ? textForJsDocTag(obsoleteTag) : (catalog?.obsoleteIn ?? "")).trim().split(/\s+/)[0];
				const future = Boolean(obsoleteIn && /^\d+\.\d+\.\d+$/.test(obsoleteIn) && compareVersions(targetVersion, obsoleteIn) >= 0);
				if (deprecated || future) {
					const details = catalog?.message ?? textForJsDocTag(deprecated ?? obsoleteTag!);
					const replacement = catalog?.replacement ?? details.match(/(?:use|replace(?:d)? by)\s+[`@]?([A-Za-z_$][\w$]*)/i)?.[1] ?? null;
					result.push(
						makeIssue({
							category: "obsolete-api",
							severity: future ? "error" : "warning",
							code: future ? "PA2002" : "PA2001",
							title: future ? `API becomes obsolete in ${obsoleteIn}` : "Deprecated API usage",
							message: `${node.text}: ${details || "The resolved TypeScript declaration is marked deprecated."}`,
							recommendation: replacement
								? `Replace ${node.text} with ${replacement} before upgrading.`
								: "Inspect the declaration's deprecation guidance and migrate before upgrading.",
							location: locationForNode(sourceFile, node),
							evidence: {
								analyzer: "zvibe-typescript-obsolete-api-analyzer-v1",
								symbol: node.text,
								deprecatedNow: Boolean(deprecated),
								obsoleteIn: obsoleteIn || null,
								targetVersion,
								replacement,
							},
							fix: null,
						})
					);
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return result;
}

function normalizedAssetCandidate(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim() || value.startsWith("data:")) {
		return null;
	}
	let candidate = value
		.trim()
		.replace(/\\/g, "/")
		.replace(/[?#].*$/, "");
	if (candidate.startsWith("file://")) {
		candidate = candidate.slice("file://".length);
	}
	const root = projectDirectory().replace(/\\/g, "/");
	if (candidate.startsWith(`${root}/`)) {
		candidate = candidate.slice(root.length + 1);
	}
	const assetsIndex = candidate.toLowerCase().lastIndexOf("/assets/");
	if (assetsIndex !== -1) {
		candidate = candidate.slice(assetsIndex + 1);
	}
	return normalize(candidate).replace(/^\.\//, "").replace(/^\/+/, "");
}

function resolveTextureEntry(value: unknown, textureEntries: IAssetRegistryEntry[]): IAssetRegistryEntry | null {
	const candidate = normalizedAssetCandidate(value);
	if (!candidate) {
		return null;
	}
	const direct = textureEntries.find((entry) => entry.path === candidate || entry.path.endsWith(`/${candidate}`));
	if (direct) {
		return direct;
	}
	const basename = candidate.slice(candidate.lastIndexOf("/") + 1);
	const matches = textureEntries.filter((entry) => entry.name === basename);
	return matches.length === 1 ? matches[0] : null;
}

function particleTextureIssue(entry: IAssetRegistryEntry, usage: { source: string; nodeId: string | null; nodeName: string | null; property: string }): IProjectAuditIssueInternal {
	return makeIssue({
		category: "particle-texture-readability",
		severity: "warning",
		code: "PA3001",
		title: "Particle texture has unnecessary CPU Read/Write enabled",
		message: `${entry.path} is sampled by ${usage.property} on ${usage.nodeName ?? usage.source}, but this Babylon particle path is GPU-only and does not read pixels on the CPU.`,
		recommendation: "Disable CPU Readable on the texture importer to avoid publishing an unnecessary RGBA sidecar and retained CPU memory.",
		location: { path: entry.path, line: null, column: null, nodeId: usage.nodeId, nodeName: usage.nodeName, property: usage.property },
		evidence: { analyzer: "zvibe-particle-texture-readability-v1", source: usage.source, importerReadable: true, requiredReadable: false, importerKind: entry.importer.kind },
		fix: { kind: "set-texture-readable", path: entry.path, readable: false },
	});
}

function textureReferenceFromValue(value: unknown): string | null {
	if (typeof value === "string") {
		return value;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const object = value as Record<string, unknown>;
	for (const key of ["url", "name", "textureName", "_url"]) {
		if (typeof object[key] === "string") {
			return object[key] as string;
		}
	}
	return null;
}

function collectParticleDocumentReferences(value: unknown): Array<{ reference: string; property: string }> {
	const references: Array<{ reference: string; property: string }> = [];
	let visits = 0;
	const visit = (current: unknown, depth: number): void => {
		if (++visits > 100_000 || depth > 64 || !current || typeof current !== "object") {
			return;
		}
		if (Array.isArray(current)) {
			current.forEach((entry) => visit(entry, depth + 1));
			return;
		}
		for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
			if (["particleTexture", "noiseTexture", "textureName"].includes(key)) {
				const reference = textureReferenceFromValue(child);
				if (reference) {
					references.push({ reference, property: key });
				}
			}
			visit(child, depth + 1);
		}
	};
	visit(value, 0);
	return references.slice(0, 4_096);
}

async function analyzeParticleTextures(scene: Scene, registry: IAssetRegistry, job: IProjectAuditJobInternal): Promise<IProjectAuditIssueInternal[]> {
	const textureEntries = registry.entries.filter((entry) => entry.type === "texture" || entry.type === "cube-texture");
	const usages: Array<{ entry: IAssetRegistryEntry; source: string; nodeId: string | null; nodeName: string | null; property: string }> = [];
	for (const system of scene.particleSystems as any[]) {
		for (const property of ["particleTexture", "noiseTexture"] as const) {
			const texture = system[property];
			const entry = resolveTextureEntry(texture?.url ?? texture?.name ?? texture?._url, textureEntries);
			if (entry) {
				usages.push({ entry, source: "active-scene", nodeId: system.id ?? null, nodeName: system.name ?? null, property });
			}
		}
	}
	const documents = registry.entries
		.filter((entry) => entry.sizeBytes <= maximumJsonFileBytes && (entry.type === "particle" || entry.path.includes("particleSystems/") || entry.path.endsWith(".scene")))
		.slice(0, maximumParticleDocuments);
	for (let index = 0; index < documents.length; index++) {
		checkCancelled(job);
		const document = documents[index];
		try {
			const absolutePath = join(projectDirectory(), document.path);
			await assertContainedRegularFile(absolutePath);
			const value = await readJSON(absolutePath);
			for (const reference of collectParticleDocumentReferences(value)) {
				const entry = resolveTextureEntry(reference.reference, textureEntries);
				if (entry) {
					usages.push({ entry, source: document.path, nodeId: null, nodeName: null, property: reference.property });
				}
			}
		} catch {
			// Malformed project JSON is owned by the asset importer/dependency diagnostics, not this focused analyzer.
		}
		if (index % 32 === 31) {
			await yieldToEditor(job);
		}
	}
	return usages
		.filter((usage) => usage.entry.importer.kind === "texture" && normalizeTextureImporterSettings(usage.entry.importer.settings).readable)
		.map((usage) => particleTextureIssue(usage.entry, usage));
}

function atlasRectanglePixels(value: unknown): number {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return 0;
	}
	const record = value as Record<string, unknown>;
	const frame = record.frame && typeof record.frame === "object" && !Array.isArray(record.frame) ? (record.frame as Record<string, unknown>) : record;
	const width = Number(frame.w ?? frame.width);
	const height = Number(frame.h ?? frame.height);
	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(width) * Math.round(height)) : 0;
}

async function analyzeAtlasWaste(scene: Scene, registry: IAssetRegistry, job: IProjectAuditJobInternal): Promise<IProjectAuditIssueInternal[]> {
	const result: IProjectAuditIssueInternal[] = [];
	let retainedFrames = 0;
	const documents = registry.entries.filter((entry) => entry.extension === ".json" && entry.sizeBytes <= maximumJsonFileBytes).slice(0, maximumAtlasDocuments);
	for (let index = 0; index < documents.length; index++) {
		checkCancelled(job);
		const document = documents[index];
		try {
			const absolutePath = join(projectDirectory(), document.path);
			await assertContainedRegularFile(absolutePath);
			const value = (await readJSON(absolutePath)) as any;
			if (!value?.frames || typeof value.frames !== "object" || Array.isArray(value.frames)) {
				continue;
			}
			const width = Number(value.meta?.size?.w ?? value.meta?.size?.width);
			const height = Number(value.meta?.size?.h ?? value.meta?.size?.height);
			if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
				continue;
			}
			const frames = (Object.values(value.frames) as unknown[]).slice(0, Math.max(0, maximumAtlasFrames - retainedFrames));
			retainedFrames += frames.length;
			const totalPixels = Math.round(width) * Math.round(height);
			const definedPixels = Math.min(
				totalPixels,
				frames.reduce<number>((sum, frame) => Math.min(Number.MAX_SAFE_INTEGER, sum + atlasRectanglePixels(frame)), 0)
			);
			const wastePercent = totalPixels ? ((totalPixels - definedPixels) / totalPixels) * 100 : 0;
			if (wastePercent >= job.settings.atlasAllocationWasteThresholdPercent) {
				result.push(
					makeIssue({
						category: "atlas-waste",
						severity: "warning",
						code: "PA4001",
						title: "Sprite atlas leaves substantial texture area unallocated",
						message: `${document.path} leaves ${wastePercent.toFixed(1)}% of its ${Math.round(width)}×${Math.round(height)} texture outside declared sprite rectangles.`,
						recommendation: "Repack the atlas with tighter dimensions/padding or split sources by runtime use, then verify the 2D Profiler snapshot.",
						location: { path: document.path, line: null, column: null, nodeId: null, nodeName: null, property: "frames" },
						evidence: {
							analyzer: "zvibe-project-atlas-allocation-v1",
							width: Math.round(width),
							height: Math.round(height),
							frameCount: frames.length,
							definedPixels,
							totalPixels,
							wastePercent,
							thresholdPercent: job.settings.atlasAllocationWasteThresholdPercent,
						},
						fix: null,
					})
				);
			}
		} catch {
			// Non-atlas or malformed JSON remains owned by its importer diagnostics.
		}
		if (retainedFrames >= maximumAtlasFrames) {
			break;
		}
		if (index % 32 === 31) {
			await yieldToEditor(job);
		}
	}
	const snapshot = measurePortableProfiler2D(scene as any);
	for (const atlas of snapshot.atlases) {
		const unusedPercent = atlas.definedRegionPixels ? ((atlas.definedRegionPixels - atlas.usedRegionPixels) / atlas.definedRegionPixels) * 100 : 0;
		if (unusedPercent < job.settings.atlasUnusedRegionThresholdPercent || !atlas.regionCount) {
			continue;
		}
		result.push(
			makeIssue({
				category: "atlas-waste",
				severity: "warning",
				code: "PA4002",
				title: "Live sprite atlas retains mostly unused regions",
				message: `${atlas.name} uses ${atlas.usedRegionCount}/${atlas.regionCount} declared regions in the active scene (${unusedPercent.toFixed(1)}% unused region pixels).`,
				recommendation: "Build a scene-specific atlas or remove unused regions, then profile representative gameplay before changing the source atlas.",
				location: {
					path: atlas.textureName ? normalizedAssetCandidate(atlas.textureName) : null,
					line: null,
					column: null,
					nodeId: atlas.id,
					nodeName: atlas.name,
					property: "atlas",
				},
				evidence: {
					analyzer: "zvibe-live-atlas-usage-v1",
					ownerKind: atlas.kind,
					regionCount: atlas.regionCount,
					usedRegionCount: atlas.usedRegionCount,
					definedRegionPixels: atlas.definedRegionPixels,
					usedRegionPixels: atlas.usedRegionPixels,
					unusedPercent,
					thresholdPercent: job.settings.atlasUnusedRegionThresholdPercent,
					snapshotTruncated: snapshot.truncated,
				},
				fix: null,
			})
		);
	}
	return result;
}

async function runProjectAudit(scene: Scene, state: IProjectAuditorStateInternal, job: IProjectAuditJobInternal): Promise<void> {
	job.status = "running";
	job.startedAt = new Date().toISOString();
	touchJob(scene, state, job);
	try {
		setPhase(scene, state, job, "discovering", "Collecting bounded project sources and indexed assets.");
		const [sources, registry] = await Promise.all([collectSources(), ensureAssetRegistry()]);
		job.progress = { completed: sources.length + registry.entries.length, total: sources.length + registry.entries.length, message: "Project discovery complete." };
		touchJob(scene, state, job);
		await yieldToEditor(job);

		if (job.settings.categories.includes("serialization")) {
			setPhase(scene, state, job, "serialization", "Checking serializable Inspector fields before script emission.", sources.length);
			for (let index = 0; index < sources.length; index++) {
				analyzeSerializationSource(sources[index].content, sources[index].path).forEach((diagnostic) => addIssue(job, serializationIssue(diagnostic)));
				job.progress.completed = index + 1;
				if (index % 32 === 31) {
					await yieldToEditor(job);
				}
			}
			touchJob(scene, state, job);
		}

		if (job.settings.categories.includes("obsolete-api")) {
			setPhase(scene, state, job, "obsolete-apis", `Resolving deprecated and future-obsolete APIs for target ${job.settings.obsoleteTargetVersion}.`, sources.length);
			analyzeObsoleteApis(sources, job.settings.obsoleteTargetVersion).forEach((issue) => addIssue(job, issue));
			job.progress.completed = sources.length;
			touchJob(scene, state, job);
			await yieldToEditor(job);
		}

		if (job.settings.categories.includes("particle-texture-readability")) {
			setPhase(scene, state, job, "particle-textures", "Comparing particle texture use with CPU Readable importer settings.", registry.entries.length);
			(await analyzeParticleTextures(scene, registry, job)).forEach((issue) => addIssue(job, issue));
			job.progress.completed = registry.entries.length;
			touchJob(scene, state, job);
			await yieldToEditor(job);
		}

		if (job.settings.categories.includes("atlas-waste")) {
			setPhase(scene, state, job, "atlas-waste", "Measuring project atlas allocation and live region usage.", registry.entries.length);
			(await analyzeAtlasWaste(scene, registry, job)).forEach((issue) => addIssue(job, issue));
			job.progress.completed = registry.entries.length;
			touchJob(scene, state, job);
		}

		checkCancelled(job);
		job.issues.sort(
			(left, right) =>
				left.category.localeCompare(right.category) ||
				left.severity.localeCompare(right.severity) ||
				(left.location.path ?? "").localeCompare(right.location.path ?? "") ||
				left.id.localeCompare(right.id)
		);
		job.issuesFingerprint = createHash("sha256")
			.update(JSON.stringify(job.issues.map((issue) => issue.fingerprint)))
			.digest("hex");
		job.status = "completed";
		job.phase = "complete";
		job.progress = { completed: job.progress.total, total: job.progress.total, message: "Project audit completed." };
	} catch (error) {
		if (error instanceof ProjectAuditCancelledError || job.cancelRequested) {
			job.status = "cancelled";
			job.error = "Cancelled cooperatively; no project files were changed.";
		} else {
			job.status = "failed";
			job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
		}
	} finally {
		job.finishedAt = new Date().toISOString();
		if (state.activeJobId === job.id) {
			state.activeJobId = null;
		}
		touchJob(scene, state, job);
	}
}

/** Returns the bounded analyzer/fix contract shared by the Project Auditor workspace and MCP. */
export function getProjectAuditorCapabilities(): any {
	return {
		model: "zvibe-project-auditor-v1",
		asynchronous: true,
		categories,
		serialization: { compileBlockingSeverity: "error", diagnostics: ["SER1001-SER1011"], compiler: "TypeScript/esbuild" },
		obsoleteApis: { sources: ["resolved TypeScript @deprecated/@obsoleteIn JSDoc", "bounded editor future-obsolete catalog"], defaultTargetVersion: "2.0.0" },
		particleTextures: { importerSetting: "readable", gpuOnlyProperties: ["particleTexture", "noiseTexture"], fixable: true },
		atlasWaste: { projectAllocation: true, liveUsage: true, profilerModel: "portable-2d-profiler-v1", automaticRepack: false },
		limits: {
			maximumSourceFiles,
			maximumSourceFileBytes,
			maximumSourceAggregateBytes,
			maximumJsonFileBytes,
			maximumParticleDocuments,
			maximumAtlasDocuments,
			maximumAtlasFrames,
			maximumIssues: 10_000,
		},
		limitations: [
			"This is a portable Babylon/TypeScript auditor, not Unity Project Auditor, C# Roslyn, or Unity obsolete-database identity.",
			"Live atlas usage covers the active edit scene; project atlas allocation covers bounded indexed JSON atlases.",
			"Particle texture fixes only disable CPU Readable where the audited Babylon property is GPU-only.",
		],
	};
}

/** Reads current asynchronous job state without starting analysis. */
export function getProjectAuditorState(scene: Scene): any {
	const state = stateFor(scene);
	return {
		revision: state.revision,
		activeJobId: state.activeJobId,
		active: state.activeJobId ? publicJob(state.jobs.find((job) => job.id === state.activeJobId)!) : null,
		recentJobs: state.jobs.map(publicJob),
	};
}

/** Starts one cooperative background analysis under an exact auditor-state lease. */
export function startProjectAudit(scene: Scene, data: any, _options: IMCPActionOptions): any {
	const state = requireStateRevision(scene, data.expectedRevision);
	if (state.activeJobId) {
		const active = state.jobs.find((job) => job.id === state.activeJobId);
		throw new Error(`Project audit ${state.activeJobId} is already ${active?.status ?? "active"}; wait for it or cancel it first.`);
	}
	const job: IProjectAuditJobInternal = {
		id: randomUUID(),
		revision: 1,
		status: "queued",
		phase: "queued",
		progress: { completed: 0, total: 0, message: "Queued for asynchronous analysis." },
		settings: normalizeSettings(data.settings),
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		issuesFingerprint: null,
		summary: emptySummary(),
		issues: [],
		cancelRequested: false,
		error: null,
	};
	state.jobs.unshift(job);
	state.jobs.splice(maximumRetainedJobs);
	state.activeJobId = job.id;
	notify(scene, state, job.id);
	void runProjectAudit(scene, state, job);
	return { revision: state.revision, job: publicJob(job) };
}

/** Reads one retained audit job and its exact immutable/completing revision. */
export function getProjectAudit(scene: Scene, data: any): any {
	const state = stateFor(scene);
	const job = state.jobs.find((candidate) => candidate.id === data.id);
	if (!job) {
		throw new Error(`Project audit job not found: ${data.id}.`);
	}
	return { auditorRevision: state.revision, job: publicJob(job) };
}

/** Lists a stable filtered page of issues under the exact job revision returned by get_project_audit. */
export function listProjectAuditIssues(scene: Scene, data: any): any {
	const job = stateFor(scene).jobs.find((candidate) => candidate.id === data.id);
	if (!job) {
		throw new Error(`Project audit job not found: ${data.id}.`);
	}
	if (!Number.isSafeInteger(data.expectedJobRevision) || data.expectedJobRevision !== job.revision) {
		throw new Error(`Project audit job changed. Inspect it again and use expectedJobRevision ${job.revision}.`);
	}
	let issues = job.issues.filter(
		(issue) =>
			(data.includeResolved === true || issue.resolvedAt === null) &&
			(!data.category || issue.category === data.category) &&
			(!data.severity || issue.severity === data.severity)
	);
	const search = typeof data.search === "string" && data.search.trim() ? data.search.trim().toLowerCase() : null;
	if (search) {
		issues = issues.filter((issue) =>
			`${issue.code} ${issue.title} ${issue.message} ${issue.location.path ?? ""} ${issue.location.nodeName ?? ""}`.toLowerCase().includes(search)
		);
	}
	const offset = Number.isSafeInteger(data.offset) ? Math.max(0, data.offset) : 0;
	const limit = Number.isSafeInteger(data.limit) ? Math.min(100, Math.max(1, data.limit)) : 50;
	return {
		id: job.id,
		revision: job.revision,
		issuesFingerprint: job.issuesFingerprint,
		totalCount: issues.length,
		offset,
		limit,
		hasMore: offset + limit < issues.length,
		nextOffset: offset + limit < issues.length ? offset + limit : null,
		issues: issues.slice(offset, offset + limit).map(publicIssue),
	};
}

/** Requests cooperative cancellation under the exact global state revision. */
export function cancelProjectAudit(scene: Scene, data: any, _options: IMCPActionOptions): any {
	const state = requireStateRevision(scene, data.expectedRevision);
	const job = state.jobs.find((candidate) => candidate.id === data.id);
	if (!job) {
		throw new Error(`Project audit job not found: ${data.id}.`);
	}
	if (!["queued", "running"].includes(job.status)) {
		throw new Error(`Project audit ${job.id} is already ${job.status} and cannot be cancelled.`);
	}
	job.cancelRequested = true;
	touchJob(scene, state, job);
	return { revision: state.revision, job: publicJob(job) };
}

/** Applies one supported issue fix under exact global/job/issue leases. */
export async function applyProjectAuditorFix(scene: Scene, data: any, _options: IMCPActionOptions): Promise<any> {
	const state = requireStateRevision(scene, data.expectedRevision);
	const job = state.jobs.find((candidate) => candidate.id === data.id);
	if (!job) {
		throw new Error(`Project audit job not found: ${data.id}.`);
	}
	if (job.revision !== data.expectedJobRevision) {
		throw new Error(`Project audit job changed. Inspect it again and use expectedJobRevision ${job.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Applying a Project Auditor fix requires confirm=true.");
	}
	const issue = job.issues.find((candidate) => candidate.id === data.issueId);
	if (!issue || issue.fingerprint !== data.expectedIssueFingerprint) {
		throw new Error("Project Auditor issue was not found or changed; list issues again and use its exact fingerprint.");
	}
	if (issue.resolvedAt) {
		throw new Error(`Project Auditor issue ${issue.id} was already resolved at ${issue.resolvedAt}.`);
	}
	if (!issue.fix) {
		throw new Error(`Project Auditor issue ${issue.id} has no automatic fix; follow its recommendation manually.`);
	}
	if (issue.fix.kind === "set-texture-readable") {
		const absolutePath = normalize(isAbsolute(issue.fix.path) ? issue.fix.path : join(projectDirectory(), issue.fix.path));
		if (absolutePath !== projectDirectory() && !absolutePath.startsWith(`${projectDirectory()}/`)) {
			throw new Error("Project Auditor fix path escaped the open project.");
		}
		await assertContainedRegularFile(absolutePath);
		const metadata = await readAssetMetadata(absolutePath);
		if (metadata.importer.kind !== "texture") {
			throw new Error(`Project Auditor fix target is no longer a texture importer: ${issue.fix.path}.`);
		}
		const settings = normalizeTextureImporterSettings(metadata.importer.settings);
		if (settings.readable !== issue.fix.readable) {
			metadata.importer = { ...metadata.importer, settings: { ...metadata.importer.settings, readable: issue.fix.readable } };
			await writeAssetMetadata(absolutePath, metadata);
			await refreshAssetRegistryPaths([absolutePath]);
		}
	}
	issue.resolvedAt = new Date().toISOString();
	job.issuesFingerprint = createHash("sha256")
		.update(JSON.stringify(job.issues.map((candidate) => ({ fingerprint: candidate.fingerprint, resolvedAt: candidate.resolvedAt }))))
		.digest("hex");
	touchJob(scene, state, job);
	return { revision: state.revision, jobRevision: job.revision, issue: publicIssue(issue) };
}

/** Cancels in-flight work and releases transient state for a disposed scene. */
export function shutdownProjectAuditor(scene: Scene): void {
	const state = states.get(scene);
	if (!state) {
		return;
	}
	for (const job of state.jobs) {
		if (job.status === "queued" || job.status === "running") {
			job.cancelRequested = true;
		}
	}
	states.delete(scene);
}
