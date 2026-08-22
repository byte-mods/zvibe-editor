import { createHash } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";
import { Scene, Tools } from "babylonjs";

import {
	AddressableCatalog,
	IAddressableCatalog,
	IAddressableDeploymentTarget,
	IAddressableEntryConfiguration,
	IAddressableGroupConfiguration,
	IAddressableProfile,
	IAddressableProjectConfiguration,
	IAddressableQuery,
	IAddressableTypeTreeRegistry,
	normalizeAddressableConfiguration,
	parseAddressablePortableBundle,
	validateAddressableTypeTreeRegistry,
	validateAddressableConfiguration,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { createAddressableCatalog } from "../../project/export/addressables";
import { IMCPActionOptions } from "../action";
import { buildAddressableContent, IAddressableBuildArtifact, IAddressableBuildReport, readAddressableBuildReport } from "./content";
import { deployAddressableBuild, listAddressableDeploymentReceipts, verifyAddressableDeployment } from "./deployment";

interface IRevisionData {
	expectedRevision: number;
}

function directory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function projectPath(value: string): string {
	const root = directory();
	const resolved = normalize(isAbsolute(value) ? value : join(root, value));
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		throw new Error("Addressable project paths must stay inside the open project.");
	}
	return resolved;
}

function configurationPath(): string {
	return join(directory(), "addressables.json");
}

async function configuration(): Promise<IAddressableProjectConfiguration> {
	return normalizeAddressableConfiguration((await pathExists(configurationPath())) ? await readJSON(configurationPath()) : undefined);
}

function assertRevision(value: IAddressableProjectConfiguration, data: IRevisionData): void {
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== value.revision) {
		throw new Error(`Stale Addressables revision ${data.expectedRevision}; current revision is ${value.revision}.`);
	}
}

async function saveConfiguration(value: IAddressableProjectConfiguration, expectedRevision: number): Promise<IAddressableProjectConfiguration> {
	assertRevision(value, { expectedRevision });
	const next = structuredClone(value);
	next.revision++;
	validateAddressableConfiguration(next);
	const outputPath = configurationPath();
	const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporaryPath, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	await move(temporaryPath, outputPath, { overwrite: true });
	return next;
}

function refreshAssets(options: IMCPActionOptions): void {
	options.editor.layout.assets.refresh();
}

function group(value: IAddressableProjectConfiguration, data: { id?: string; name?: string }): IAddressableGroupConfiguration {
	const found = value.groups.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!found) {
		throw new Error("Addressable group not found.");
	}
	return found;
}

function profile(value: IAddressableProjectConfiguration, id: string): IAddressableProfile {
	const found = value.profiles.find((candidate) => candidate.id === id);
	if (!found) {
		throw new Error(`Addressables profile was not found: ${id}`);
	}
	return found;
}

function deploymentTarget(value: IAddressableProjectConfiguration, id?: string): IAddressableDeploymentTarget {
	const targetId = id ?? value.activeDeploymentTargetId;
	const found = value.deploymentTargets.find((candidate) => candidate.id === targetId);
	if (!found) {
		throw new Error(`Addressables deployment target was not found: ${targetId ?? "none selected"}`);
	}
	return found;
}

function labels(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((label) => typeof label !== "string" || !label.trim())) {
		throw new Error("labels must be an array of non-empty strings.");
	}
	return [...new Set(value.map((label) => String(label).trim()))].sort();
}

function assetEntry(target: IAddressableGroupConfiguration, assetPathOrAddress: string): IAddressableEntryConfiguration {
	const found = target.assets.find((asset) => asset.path === assetPathOrAddress || asset.address === assetPathOrAddress);
	if (!found) {
		throw new Error(`Addressable asset was not found in group "${target.name}": ${assetPathOrAddress}`);
	}
	return found;
}

export async function listAddressableGroups(): Promise<IAddressableProjectConfiguration> {
	return configuration();
}

export async function setAddressableSettings(
	_scene: Scene,
	data: IRevisionData & Partial<IAddressableProjectConfiguration["settings"]> & { activeProfileId?: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	if (data.activeProfileId !== undefined) {
		profile(value, data.activeProfileId);
		value.activeProfileId = data.activeProfileId;
	}
	for (const key of ["remoteCatalog", "remoteCatalogFile", "verifyHashes", "extractTypeTrees", "requestTimeoutMs", "maxConcurrentRequests", "cacheMaxBytes"] as const) {
		if (data[key] !== undefined) {
			(value.settings as unknown as Record<string, unknown>)[key] = data[key];
		}
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function createAddressableProfile(
	_scene: Scene,
	data: IRevisionData & Omit<IAddressableProfile, "id"> & { id?: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	value.profiles.push({
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		localBuildPath: data.localBuildPath,
		localLoadPath: data.localLoadPath,
		remoteBuildPath: data.remoteBuildPath,
		remoteLoadPath: data.remoteLoadPath,
	});
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function setAddressableProfile(
	_scene: Scene,
	data: IRevisionData & Partial<Omit<IAddressableProfile, "id">> & { id: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const target = profile(value, data.id);
	for (const key of ["name", "localBuildPath", "localLoadPath", "remoteBuildPath", "remoteLoadPath"] as const) {
		if (data[key] !== undefined) {
			target[key] = data[key]!;
		}
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function deleteAddressableProfile(_scene: Scene, data: IRevisionData & { id: string }, options: IMCPActionOptions): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	if (value.profiles.length === 1) {
		throw new Error("The final Addressables profile cannot be deleted.");
	}
	const index = value.profiles.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Addressables profile was not found: ${data.id}`);
	}
	value.profiles.splice(index, 1);
	if (value.activeProfileId === data.id) {
		value.activeProfileId = value.profiles[0].id;
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function createAddressableGroup(
	_scene: Scene,
	data: IRevisionData & Partial<Omit<IAddressableGroupConfiguration, "id" | "assets">> & { id?: string; name: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	value.groups.push({
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		delivery: data.delivery ?? "local",
		updateRestriction: data.delivery === "remote" ? (data.updateRestriction ?? "dynamic") : "static",
		bundleMode: data.bundleMode ?? "pack-separately",
		buildPath: data.buildPath,
		loadPath: data.loadPath,
		assets: [],
	});
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function setAddressableGroup(
	_scene: Scene,
	data: IRevisionData & Partial<Omit<IAddressableGroupConfiguration, "id" | "assets">> & { id: string; clearBuildPath?: boolean; clearLoadPath?: boolean },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const target = group(value, data);
	for (const key of ["name", "delivery", "updateRestriction", "bundleMode", "buildPath", "loadPath"] as const) {
		if (data[key] !== undefined) {
			(target as unknown as Record<string, unknown>)[key] = data[key];
		}
	}
	if (data.clearBuildPath) {
		delete target.buildPath;
	}
	if (data.clearLoadPath) {
		delete target.loadPath;
	}
	if (target.delivery === "local") {
		target.updateRestriction = "static";
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function deleteAddressableGroup(_scene: Scene, data: IRevisionData & { id: string }, options: IMCPActionOptions): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const index = value.groups.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Addressable group was not found: ${data.id}`);
	}
	value.groups.splice(index, 1);
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function assignAddressableAsset(
	_scene: Scene,
	data: IRevisionData & { id?: string; name?: string; assetPath: string; address?: string; labels?: string[] },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const target = group(value, data);
	const asset = projectPath(data.assetPath);
	if (!(await pathExists(asset)) || (await stat(asset)).isDirectory()) {
		throw new Error("Addressable asset must be an existing project file.");
	}
	const assetPath = relative(directory(), asset);
	let existing: IAddressableEntryConfiguration | undefined;
	for (const candidate of value.groups) {
		const index = candidate.assets.findIndex((entry) => entry.path === assetPath);
		if (index !== -1) {
			[existing] = candidate.assets.splice(index, 1);
		}
	}
	target.assets.push({ path: assetPath, address: data.address ?? existing?.address ?? assetPath, labels: data.labels ? labels(data.labels) : (existing?.labels ?? []) });
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function setAddressableAsset(
	_scene: Scene,
	data: IRevisionData & { id?: string; name?: string; assetPathOrAddress: string; address?: string; labels?: string[] },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const target = group(value, data);
	const entry = assetEntry(target, data.assetPathOrAddress);
	if (data.address !== undefined) {
		entry.address = data.address;
	}
	if (data.labels !== undefined) {
		entry.labels = labels(data.labels);
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function removeAddressableAsset(
	_scene: Scene,
	data: IRevisionData & { id?: string; name?: string; assetPath?: string; assetPathOrAddress?: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const target = group(value, data);
	const key = data.assetPathOrAddress ?? data.assetPath;
	if (!key) {
		throw new Error("assetPathOrAddress is required.");
	}
	const index = target.assets.findIndex((entry) => entry.path === key || entry.address === key || entry.path === relative(directory(), projectPath(key)));
	if (index === -1) {
		throw new Error(`Asset "${key}" is not in this group.`);
	}
	target.assets.splice(index, 1);
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function setAddressableAssetLabels(
	scene: Scene,
	data: IRevisionData & { id?: string; name?: string; assetPath?: string; assetPathOrAddress?: string; labels: string[] },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	return setAddressableAsset(scene, { ...data, assetPathOrAddress: data.assetPathOrAddress ?? data.assetPath ?? "" }, options);
}

export async function findAddressableAssetsByLabels(_scene: Scene, data: { labels: string[]; match?: "all" | "any" }): Promise<{ assets: object[] }> {
	const value = await configuration();
	const requested = labels(data.labels);
	if (!requested.length) {
		throw new Error("labels must contain at least one value.");
	}
	const match = data.match ?? "all";
	return {
		assets: value.groups.flatMap((candidate) =>
			candidate.assets
				.filter((entry) => (match === "all" ? requested.every((label) => entry.labels.includes(label)) : requested.some((label) => entry.labels.includes(label))))
				.map((entry) => ({ groupId: candidate.id, groupName: candidate.name, ...entry }))
		),
	};
}

export async function diffAddressableCatalogs(_scene: Scene, data: { previousCatalogPath: string; nextCatalogPath: string }): Promise<object> {
	const oldPath = projectPath(data.previousCatalogPath);
	const nextPath = projectPath(data.nextCatalogPath);
	if (!(await pathExists(oldPath)) || !(await pathExists(nextPath))) {
		throw new Error("Both previousCatalogPath and nextCatalogPath must reference existing catalog files.");
	}
	const [previous, next] = (await Promise.all([readJSON(oldPath), readJSON(nextPath)])) as Array<{
		groups?: Array<{ id: string; name: string; assets?: Array<Record<string, unknown>> }>;
	}>;
	const flatten = (catalog: { groups?: Array<{ id: string; name: string; assets?: Array<Record<string, unknown>> }> }): Map<string, Record<string, unknown>> =>
		new Map(
			(catalog.groups ?? []).flatMap((candidate) =>
				(candidate.assets ?? []).map((asset) => [String(asset.address ?? asset.path), { groupId: candidate.id, groupName: candidate.name, ...asset }])
			)
		);
	const before = flatten(previous);
	const after = flatten(next);
	const added: object[] = [];
	const changed: object[] = [];
	const removed: object[] = [];
	const unchanged: object[] = [];
	for (const [key, asset] of after) {
		const old = before.get(key);
		if (!old) {
			added.push(asset);
		} else if (old.hash !== asset.hash || old.groupId !== asset.groupId || JSON.stringify(old.labels ?? []) !== JSON.stringify(asset.labels ?? [])) {
			changed.push({ previous: old, next: asset });
		} else {
			unchanged.push(asset);
		}
	}
	for (const [key, asset] of before) {
		if (!after.has(key)) {
			removed.push(asset);
		}
	}
	return {
		previousCatalogPath: relative(directory(), oldPath),
		nextCatalogPath: relative(directory(), nextPath),
		added,
		changed,
		removed,
		unchanged,
		summary: { added: added.length, changed: changed.length, removed: removed.length, unchanged: unchanged.length },
	};
}

export async function buildAddressableCatalog(_scene: Scene, data: IRevisionData & { outputPath?: string; profileId?: string }, options: IMCPActionOptions): Promise<object> {
	const value = await configuration();
	assertRevision(value, data);
	const output = projectPath(data.outputPath ?? "assets/addressables.catalog.json");
	const { catalog } = await createAddressableCatalog(directory(), value, data.profileId);
	await ensureDir(dirname(output));
	await writeJSON(output, catalog, { spaces: "\t" });
	refreshAssets(options);
	return {
		built: true,
		outputPath: relative(directory(), output),
		buildId: catalog.buildId,
		catalogHash: catalog.catalogHash,
		groupCount: catalog.groups.length,
		assetCount: catalog.groups.reduce((total, candidate) => total + candidate.assets.length, 0),
	};
}

export async function setAddressableDeploymentTarget(
	_scene: Scene,
	data: IRevisionData & { target: IAddressableDeploymentTarget; makeActive?: boolean },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const index = value.deploymentTargets.findIndex((candidate) => candidate.id === data.target.id);
	if (index === -1) {
		value.deploymentTargets.push(data.target);
	} else {
		value.deploymentTargets[index] = data.target;
	}
	if (data.makeActive || !value.activeDeploymentTargetId) {
		value.activeDeploymentTargetId = data.target.id;
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function deleteAddressableDeploymentTarget(
	_scene: Scene,
	data: IRevisionData & { id: string },
	options: IMCPActionOptions
): Promise<IAddressableProjectConfiguration> {
	const value = await configuration();
	assertRevision(value, data);
	const index = value.deploymentTargets.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Addressables deployment target was not found: ${data.id}`);
	}
	value.deploymentTargets.splice(index, 1);
	if (value.activeDeploymentTargetId === data.id) {
		value.activeDeploymentTargetId = value.deploymentTargets[0]?.id;
	}
	const result = await saveConfiguration(value, data.expectedRevision);
	refreshAssets(options);
	return result;
}

export async function buildAddressableContentAction(
	_scene: Scene,
	data: IRevisionData & { buildType: "full" | "update"; profileId?: string; outputPath?: string; previousStatePath?: string },
	options: IMCPActionOptions
): Promise<object> {
	const value = await configuration();
	assertRevision(value, data);
	const result = await buildAddressableContent(directory(), value, data);
	const current = await configuration();
	if (current.revision !== data.expectedRevision) {
		await remove(projectPath(result.report.outputPath));
		throw new Error(`Addressables configuration changed during the build; discarded output for revision ${data.expectedRevision}.`);
	}
	const indexPath = join(directory(), ".bjseditor/addressables/build-reports.json");
	const existing = (await pathExists(indexPath)) ? ((await readJSON(indexPath)) as string[]) : [];
	const reportPath = relative(directory(), result.reportPath);
	await ensureDir(dirname(indexPath));
	await writeJSON(indexPath, [reportPath, ...existing.filter((path) => path !== reportPath)].slice(0, 256), { spaces: "\t" });
	refreshAssets(options);
	return {
		...result.report,
		reportPath,
		statePath: relative(directory(), result.statePath),
		catalogPath: relative(directory(), result.catalogPath),
		hashPath: relative(directory(), result.hashPath),
		pointerPath: relative(directory(), result.pointerPath),
	};
}

export async function listAddressableBuildReports(): Promise<{ reports: Array<IAddressableBuildReport & { reportPath: string }> }> {
	const indexPath = join(directory(), ".bjseditor/addressables/build-reports.json");
	if (!(await pathExists(indexPath))) {
		return { reports: [] };
	}
	const paths = ((await readJSON(indexPath)) as unknown[]).filter((path): path is string => typeof path === "string").slice(0, 256);
	const reports: Array<IAddressableBuildReport & { reportPath: string }> = [];
	for (const reportPath of paths) {
		try {
			reports.push({ ...(await readAddressableBuildReport(directory(), reportPath)), reportPath });
		} catch {
			// Missing or invalid historical reports are omitted without mutating the index.
		}
	}
	return { reports };
}

export async function getAddressableBuildReport(_scene: Scene, data: { reportPath: string }): Promise<IAddressableBuildReport> {
	return readAddressableBuildReport(directory(), data.reportPath);
}

interface IAddressableTypeTreeBuildEvidence {
	report: IAddressableBuildReport;
	buildRoot: string;
	catalog: IAddressableCatalog;
}

async function readVerifiedArtifact(buildRoot: string, artifact: IAddressableBuildArtifact): Promise<Buffer> {
	const absolutePath = normalize(join(buildRoot, artifact.relativePath));
	if (absolutePath !== buildRoot && !absolutePath.startsWith(`${buildRoot}/`)) {
		throw new Error(`Addressable build artifact escaped its build root: ${artifact.relativePath}`);
	}
	const bytes = await readFile(absolutePath);
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (bytes.byteLength !== artifact.sizeBytes || hash !== artifact.hash) {
		throw new Error(`Addressable build artifact no longer matches its report: ${artifact.relativePath}`);
	}
	return bytes;
}

async function typeTreeBuildEvidence(reportPath: string): Promise<IAddressableTypeTreeBuildEvidence> {
	const absoluteReportPath = projectPath(reportPath);
	const report = await readAddressableBuildReport(directory(), reportPath);
	const buildRoot = normalize(join(dirname(absoluteReportPath), ".."));
	const projectRoot = directory();
	if (buildRoot !== projectRoot && !buildRoot.startsWith(`${projectRoot}/`)) {
		throw new Error("Addressable build report must resolve to a build root inside the open project.");
	}
	const catalogArtifact = report.artifacts.find((artifact) => artifact.kind === "catalog");
	if (!catalogArtifact) {
		throw new Error("Addressable build report does not contain a catalog artifact.");
	}
	const catalog = JSON.parse((await readVerifiedArtifact(buildRoot, catalogArtifact)).toString("utf8")) as IAddressableCatalog;
	return { report, buildRoot, catalog };
}

async function loadTypeTreeRegistry(
	evidence: IAddressableTypeTreeBuildEvidence
): Promise<{ registry: IAddressableTypeTreeRegistry; schemas: Awaited<ReturnType<typeof validateAddressableTypeTreeRegistry>> }> {
	const reference = evidence.catalog.typeTreeRegistry;
	if (!reference) {
		throw new Error("Addressable build does not contain an extracted TypeTree registry. Enable extraction and create a net-smaller content build first.");
	}
	const artifact = evidence.report.artifacts.find(
		(candidate) => candidate.kind === "type-tree-registry" && (candidate.relativePath === reference.internalId || candidate.relativePath.endsWith(`/${reference.internalId}`))
	);
	if (!artifact) {
		throw new Error(`Addressable build report does not contain TypeTree registry ${reference.registryId}.`);
	}
	const bytes = await readVerifiedArtifact(evidence.buildRoot, artifact);
	if (bytes.byteLength !== reference.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== reference.hash) {
		throw new Error("Addressable TypeTree registry does not match its catalog reference.");
	}
	const registry = JSON.parse(bytes.toString("utf8")) as IAddressableTypeTreeRegistry;
	const schemas = await validateAddressableTypeTreeRegistry(registry);
	if (registry.id !== reference.registryId || schemas.size !== reference.schemaCount) {
		throw new Error("Addressable TypeTree registry identity does not match its catalog reference.");
	}
	return { registry, schemas };
}

export async function analyzeAddressableTypeTrees(_scene: Scene, data: { profileId?: string; offset?: number; limit?: number }): Promise<object> {
	const value = await configuration();
	const analysisConfiguration = structuredClone(value);
	analysisConfiguration.settings.extractTypeTrees = true;
	const { catalog } = await createAddressableCatalog(directory(), analysisConfiguration, data.profileId);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	const bundles = catalog.portableBundles ?? [];
	const items = bundles.slice(offset, offset + limit);
	return {
		revision: value.revision,
		extractionEnabled: value.settings.extractTypeTrees,
		analysisMode: value.settings.extractTypeTrees ? "authored-settings" : "what-if-enabled",
		buildId: catalog.buildId,
		catalogHash: catalog.catalogHash,
		summary: catalog.typeTreeSummary,
		registry: catalog.typeTreeRegistry,
		total: bundles.length,
		count: items.length,
		offset,
		hasMore: offset + items.length < bundles.length,
		nextOffset: offset + items.length < bundles.length ? offset + items.length : undefined,
		bundles: items,
	};
}

export async function getAddressableTypeTreeBuild(_scene: Scene, data: { reportPath: string; offset?: number; limit?: number }): Promise<object> {
	const evidence = await typeTreeBuildEvidence(data.reportPath);
	const bundles = evidence.catalog.portableBundles ?? [];
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	const items = bundles.slice(offset, offset + limit);
	return {
		buildId: evidence.report.buildId,
		catalogHash: evidence.report.catalogHash,
		summary: evidence.catalog.typeTreeSummary,
		registry: evidence.catalog.typeTreeRegistry,
		total: bundles.length,
		count: items.length,
		offset,
		hasMore: offset + items.length < bundles.length,
		nextOffset: offset + items.length < bundles.length ? offset + items.length : undefined,
		bundles: items,
	};
}

export async function getAddressableTypeTreeSchema(_scene: Scene, data: { reportPath: string; schemaId: string; offset?: number; limit?: number }): Promise<object> {
	const evidence = await typeTreeBuildEvidence(data.reportPath);
	const { schemas } = await loadTypeTreeRegistry(evidence);
	const schema = schemas.get(data.schemaId);
	if (!schema) {
		throw new Error(`Addressable TypeTree schema was not found in build ${evidence.report.buildId}: ${data.schemaId}`);
	}
	const nodes: Array<{ path: string; kind: string }> = [];
	const stack: Array<{ path: string; node: typeof schema.root }> = [{ path: "$", node: schema.root }];
	while (stack.length) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		nodes.push({ path: current.path, kind: current.node.kind });
		if (current.node.kind === "object") {
			for (let index = current.node.fields.length - 1; index >= 0; index--) {
				const field = current.node.fields[index];
				stack.push({ path: `${current.path}.${field.name}`, node: field.node });
			}
		} else if (current.node.kind === "array") {
			for (let index = current.node.variants.length - 1; index >= 0; index--) {
				stack.push({ path: `${current.path}[]#${index}`, node: current.node.variants[index] });
			}
		}
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	const items = nodes.slice(offset, offset + limit);
	return {
		buildId: evidence.report.buildId,
		schema: { id: schema.id, version: schema.version, nodeCount: schema.nodeCount, maxDepth: schema.maxDepth },
		total: nodes.length,
		count: items.length,
		offset,
		hasMore: offset + items.length < nodes.length,
		nextOffset: offset + items.length < nodes.length ? offset + items.length : undefined,
		nodes: items,
	};
}

export async function validateAddressablePortableBundleAction(_scene: Scene, data: { reportPath: string; bundleId: string; offset?: number; limit?: number }): Promise<object> {
	const evidence = await typeTreeBuildEvidence(data.reportPath);
	const reference = evidence.catalog.portableBundles?.find((bundle) => bundle.id === data.bundleId);
	if (!reference) {
		throw new Error(`Addressable portable bundle was not found in build ${evidence.report.buildId}: ${data.bundleId}`);
	}
	const { schemas } = await loadTypeTreeRegistry(evidence);
	const artifact = evidence.report.artifacts.find(
		(candidate) => candidate.kind === "portable-bundle" && (candidate.relativePath === reference.internalId || candidate.relativePath.endsWith(`/${reference.internalId}`))
	);
	if (!artifact) {
		throw new Error(`Addressable build report does not contain portable bundle ${data.bundleId}.`);
	}
	const bytes = await readVerifiedArtifact(evidence.buildRoot, artifact);
	if (bytes.byteLength !== reference.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== reference.hash) {
		throw new Error(`Addressable portable bundle ${data.bundleId} does not match its catalog reference.`);
	}
	const parsed = await parseAddressablePortableBundle(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, schemas);
	const entries = [...parsed.entries.values()].map(({ entry }) => ({ address: entry.address, schemaId: entry.schemaId, sizeBytes: entry.sizeBytes, hash: entry.hash }));
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	const items = entries.slice(offset, offset + limit);
	return {
		valid: true,
		buildId: evidence.report.buildId,
		bundle: reference,
		total: entries.length,
		count: items.length,
		offset,
		hasMore: offset + items.length < entries.length,
		nextOffset: offset + items.length < entries.length ? offset + items.length : undefined,
		entries: items,
	};
}

export async function deployAddressableContentAction(
	_scene: Scene,
	data: { reportPath: string; targetId?: string; expectedCatalogHash: string; confirmPublish: boolean }
): Promise<object> {
	const value = await configuration();
	return deployAddressableBuild(directory(), data.reportPath, deploymentTarget(value, data.targetId), data.expectedCatalogHash, data.confirmPublish);
}

export async function verifyAddressableDeploymentAction(
	_scene: Scene,
	data: { targetId?: string; pointerPath?: string; expectedBuildId: string; expectedCatalogHash: string }
): Promise<object> {
	const value = await configuration();
	return verifyAddressableDeployment(
		directory(),
		deploymentTarget(value, data.targetId),
		data.pointerPath ?? value.settings.remoteCatalogFile,
		data.expectedBuildId,
		data.expectedCatalogHash
	);
}

export async function listAddressableDeploymentReceiptsAction(): Promise<object> {
	return { receipts: await listAddressableDeploymentReceipts(directory()) };
}

export async function reloadAddressableRuntime(scene: Scene, data: { expectedRevision: number; profileId?: string }): Promise<object> {
	const value = await configuration();
	assertRevision(value, data);
	const { catalog, portableArtifacts } = await createAddressableCatalog(directory(), value, data.profileId);
	const rootUrl = `file://${directory().replace(/\/$/, "")}/`;
	const virtualPortableArtifacts = new Map(portableArtifacts.map((artifact) => [artifact.internalId.replace(/^\//, ""), artifact.bytes]));
	const fileFetch: typeof fetch = async (input, init): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const pathname = decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
		const portableArtifact = [...virtualPortableArtifacts].find(([internalId]) => pathname === internalId || pathname.endsWith(`/${internalId}`))?.[1];
		if (portableArtifact) {
			return new Response(portableArtifact.buffer.slice(portableArtifact.byteOffset, portableArtifact.byteOffset + portableArtifact.byteLength) as ArrayBuffer, {
				status: 200,
			});
		}
		if (!url.startsWith("file://")) {
			return fetch(input, init);
		}
		const bytes = await readFile(decodeURIComponent(new URL(url).pathname));
		return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 });
	};
	const addressableScene = scene as Scene & { addressables?: AddressableCatalog };
	addressableScene.addressables = new AddressableCatalog(rootUrl, catalog, { fetch: fileFetch });
	return addressableScene.addressables.getRuntimeStatus();
}

function runtime(scene: Scene): AddressableCatalog {
	const result = (scene as Scene & { addressables?: AddressableCatalog }).addressables;
	if (!result) {
		throw new Error("Addressables runtime is not configured; call reload_addressable_runtime first.");
	}
	return result;
}

export function getAddressableRuntimeStatus(scene: Scene): object {
	return runtime(scene).getRuntimeStatus();
}

export async function checkAddressableCatalogUpdates(scene: Scene): Promise<object> {
	return runtime(scene).checkForCatalogUpdates();
}

export async function updateAddressableCatalog(scene: Scene): Promise<object> {
	return runtime(scene).updateCatalog();
}

export function getAddressableDownloadSize(scene: Scene, data: IAddressableQuery): object {
	return { sizeBytes: runtime(scene).getDownloadSize(data), query: data };
}

export async function downloadAddressableDependencies(scene: Scene, data: IAddressableQuery): Promise<object> {
	return runtime(scene).downloadDependencies(data);
}

export function clearAddressableCache(scene: Scene, data: IAddressableQuery): object {
	return { clearedEntries: runtime(scene).clearDependencyCache(Object.keys(data).length ? data : undefined), status: runtime(scene).getRuntimeStatus() };
}

export async function validateAddressableContent(_scene: Scene, data: { profileId?: string }): Promise<object> {
	const value = await configuration();
	const { catalog, sources } = await createAddressableCatalog(directory(), value, data.profileId);
	const totalBytes = sources.reduce((total, source) => total + source.asset.sizeBytes, 0);
	return {
		valid: true,
		revision: value.revision,
		profileId: catalog.profileId,
		groupCount: catalog.groups.length,
		assetCount: sources.length,
		totalBytes,
		catalogHash: catalog.catalogHash,
		configurationHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
	};
}
