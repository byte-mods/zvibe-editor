import { createHash } from "crypto";
import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";
import { copyFile, ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import {
	getAddressableCatalogHashPayload,
	getAddressableProfile,
	IAddressableCatalog,
	IAddressableCatalogGroup,
	IAddressableProjectConfiguration,
	resolveAddressableProfilePath,
} from "babylonjs-editor-tools";

import { createAddressableCatalog, IAddressableCatalogSource } from "../../project/export/addressables";

export interface IAddressableContentStateAsset {
	groupId: string;
	groupName: string;
	delivery: "local" | "remote";
	updateRestriction: "static" | "dynamic";
	path: string;
	address: string;
	internalId: string;
	loadPath: string;
	sizeBytes: number;
	hash: string;
	labels: string[];
	portableBundleId?: string;
	typeTreeSchemaId?: string;
}

export interface IAddressableContentState {
	version: 1;
	buildId: string;
	catalogHash: string;
	profileId: string;
	configurationRevision: number;
	generatedAt: string;
	assets: IAddressableContentStateAsset[];
}

export interface IAddressableBuildArtifact {
	kind: "local-content" | "remote-content" | "type-tree-registry" | "portable-bundle" | "catalog" | "catalog-hash" | "content-state" | "report" | "pointer-preview";
	relativePath: string;
	deployPath?: string;
	sizeBytes: number;
	hash: string;
}

export interface IAddressableBuildReport {
	version: 1;
	buildId: string;
	buildType: "full" | "update";
	baseBuildId?: string;
	profileId: string;
	configurationRevision: number;
	generatedAt: string;
	durationMs: number;
	outputPath: string;
	catalogHash: string;
	groupCount: number;
	assetCount: number;
	localAssetCount: number;
	remoteAssetCount: number;
	addedCount: number;
	changedCount: number;
	removedCount: number;
	unchangedCount: number;
	staticRedirectCount: number;
	emittedContentBytes: number;
	typeTreeSchemaCount: number;
	portableBundleCount: number;
	typeTreeSavedBytes: number;
	artifacts: IAddressableBuildArtifact[];
}

export interface IAddressableContentBuildResult {
	catalog: IAddressableCatalog;
	state: IAddressableContentState;
	report: IAddressableBuildReport;
	reportPath: string;
	statePath: string;
	catalogPath: string;
	hashPath: string;
	pointerPath: string;
}

export interface IAddressableContentBuildOptions {
	buildType: "full" | "update";
	profileId?: string;
	outputPath?: string;
	previousStatePath?: string;
}

interface IAddressableDiff {
	added: IAddressableCatalogSource[];
	changed: IAddressableCatalogSource[];
	removed: IAddressableContentStateAsset[];
	unchanged: IAddressableCatalogSource[];
}

function projectPath(projectDirectory: string, value: string): string {
	const result = normalize(isAbsolute(value) ? value : join(projectDirectory, value));
	if (result !== projectDirectory && !result.startsWith(`${projectDirectory}/`)) {
		throw new Error(`Addressables build paths must stay inside the open project: ${value}`);
	}
	return result;
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function stateAssets(catalog: IAddressableCatalog): IAddressableContentStateAsset[] {
	return catalog.groups
		.flatMap((group) =>
			group.assets.map((asset) => ({
				groupId: group.id,
				groupName: group.name,
				delivery: group.delivery,
				updateRestriction: group.updateRestriction,
				path: asset.path,
				address: asset.address,
				internalId: asset.internalId,
				loadPath: group.loadPath,
				sizeBytes: asset.sizeBytes,
				hash: asset.hash,
				labels: asset.labels,
				portableBundleId: asset.portableBundleId,
				typeTreeSchemaId: asset.typeTreeSchemaId,
			}))
		)
		.sort((left, right) => left.address.localeCompare(right.address));
}

function validateContentState(value: unknown): IAddressableContentState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Addressables content state must be a JSON object.");
	}
	const state = value as IAddressableContentState;
	if (state.version !== 1 || !state.buildId || !state.catalogHash || !state.profileId || !Array.isArray(state.assets) || state.assets.length > 8192) {
		throw new Error("Addressables content state header is invalid.");
	}
	for (const asset of state.assets) {
		if (!asset.address || !asset.path || !asset.groupId || !asset.internalId || !/^[a-f0-9]{64}$/.test(asset.hash)) {
			throw new Error(`Addressables content state asset is invalid: ${asset.address || asset.path}`);
		}
	}
	return state;
}

function diffSources(sources: IAddressableCatalogSource[], previous?: IAddressableContentState): IAddressableDiff {
	const before = new Map((previous?.assets ?? []).map((asset) => [asset.address, asset]));
	const after = new Map(sources.map((source) => [source.asset.address, source]));
	const added: IAddressableCatalogSource[] = [];
	const changed: IAddressableCatalogSource[] = [];
	const unchanged: IAddressableCatalogSource[] = [];
	for (const source of sources) {
		const old = before.get(source.asset.address);
		if (!old) {
			added.push(source);
		} else if (
			old.hash !== source.asset.hash ||
			old.internalId !== source.asset.internalId ||
			old.groupId !== source.group.id ||
			JSON.stringify(old.labels) !== JSON.stringify(source.asset.labels)
		) {
			changed.push(source);
		} else {
			unchanged.push(source);
		}
	}
	const removed = [...before.entries()].filter(([address]) => !after.has(address)).map(([, asset]) => asset);
	return { added, changed, removed, unchanged };
}

function finalizeCatalog(catalog: IAddressableCatalog): void {
	const catalogHash = sha256(getAddressableCatalogHashPayload(catalog));
	catalog.catalogHash = catalogHash;
	catalog.buildId = `addr-${catalogHash.slice(0, 20)}`;
}

function redirectStaticUpdates(catalog: IAddressableCatalog, sources: IAddressableCatalogSource[], diff: IAddressableDiff, remoteLoadPath: string): number {
	const changedAddresses = new Set([...diff.added, ...diff.changed].map((source) => source.asset.address));
	const candidates = sources.filter((source) => changedAddresses.has(source.asset.address) && (source.group.delivery === "local" || source.group.updateRestriction === "static"));
	if (!candidates.length) {
		return 0;
	}
	const suffix = sha256(
		candidates
			.map((source) => source.asset.address)
			.sort()
			.join("\n")
	).slice(0, 10);
	const bySourceGroup = new Map<string, IAddressableCatalogGroup>();
	for (const source of candidates) {
		const authoredGroup = catalog.groups.find((group) => group.id === source.group.id);
		if (!authoredGroup) {
			throw new Error(`Addressable source group disappeared during update planning: ${source.group.id}`);
		}
		const assetIndex = authoredGroup.assets.findIndex((asset) => asset.address === source.asset.address);
		if (assetIndex === -1) {
			throw new Error(`Addressable source asset disappeared during update planning: ${source.asset.address}`);
		}
		const [asset] = authoredGroup.assets.splice(assetIndex, 1);
		asset.internalId = `content/${asset.hash.slice(0, 2)}/${asset.hash}${extname(asset.path).toLowerCase()}`;
		let updateGroup = bySourceGroup.get(source.group.id);
		if (!updateGroup) {
			updateGroup = {
				id: `${source.group.id}-update-${suffix}`,
				name: `${source.group.name} Update ${suffix}`,
				delivery: "remote",
				updateRestriction: "dynamic",
				loadPath: remoteLoadPath,
				assets: [],
			};
			bySourceGroup.set(source.group.id, updateGroup);
			catalog.groups.push(updateGroup);
		}
		updateGroup.assets.push(asset);
	}
	catalog.groups = catalog.groups.filter((group) => group.assets.length || !group.id.includes("-update-"));
	if (catalog.typeTreeRegistry && candidates.some((source) => source.asset.portableBundleId) && !catalog.typeTreeRegistry.loadPaths.includes(remoteLoadPath)) {
		catalog.typeTreeRegistry.loadPaths.push(remoteLoadPath);
		catalog.typeTreeRegistry.loadPaths.sort();
	}
	return candidates.length;
}

async function addArtifact(
	artifacts: IAddressableBuildArtifact[],
	root: string,
	kind: IAddressableBuildArtifact["kind"],
	relativePath: string,
	deployPath?: string
): Promise<void> {
	const bytes = await readFile(join(root, relativePath));
	artifacts.push({ kind, relativePath, deployPath, sizeBytes: bytes.byteLength, hash: sha256(bytes) });
}

/** Produces one rollback-safe full or incremental Addressables content build. */
export async function buildAddressableContent(
	projectDirectory: string,
	configuration: IAddressableProjectConfiguration,
	options: IAddressableContentBuildOptions
): Promise<IAddressableContentBuildResult> {
	const startedAt = Date.now();
	const profile = getAddressableProfile(configuration, options.profileId);
	let previous: IAddressableContentState | undefined;
	if (options.buildType === "update") {
		if (!configuration.settings.remoteCatalog) {
			throw new Error("Addressables update builds require Remote Catalog to be enabled.");
		}
		if (!options.previousStatePath) {
			throw new Error("Addressables update builds require previousStatePath.");
		}
		const previousPath = projectPath(projectDirectory, options.previousStatePath);
		if (!(await pathExists(previousPath))) {
			throw new Error(`Previous Addressables content state was not found: ${options.previousStatePath}`);
		}
		previous = validateContentState(await readJSON(previousPath));
		if (previous.profileId !== profile.id) {
			throw new Error(`Previous content state uses profile "${previous.profileId}" instead of "${profile.id}".`);
		}
	}
	const created = await createAddressableCatalog(projectDirectory, configuration, profile.id, options.buildType, previous?.buildId);
	const diff = diffSources(created.sources, previous);
	const staticRedirectCount = options.buildType === "update" ? redirectStaticUpdates(created.catalog, created.sources, diff, profile.remoteLoadPath) : 0;
	finalizeCatalog(created.catalog);
	const outputValue = options.outputPath ?? `AddressableBuilds/${profile.name.replace(/[^A-Za-z0-9._-]+/g, "-")}/${created.catalog.buildId}`;
	const outputPath = projectPath(projectDirectory, resolveAddressableProfilePath(outputValue, profile));
	const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
	const backupPath = `${outputPath}.backup-${process.pid}-${Date.now()}`;
	await remove(temporaryPath);
	await ensureDir(temporaryPath);
	const emitted = new Set(
		options.buildType === "full" ? created.sources.map((source) => source.asset.address) : [...diff.added, ...diff.changed].map((source) => source.asset.address)
	);
	const finalAssets = new Map(created.catalog.groups.flatMap((group) => group.assets.map((asset) => [asset.address, { group, asset }] as const)));
	const artifacts: IAddressableBuildArtifact[] = [];
	let emittedContentBytes = 0;
	try {
		for (const source of created.sources) {
			if (!emitted.has(source.asset.address)) {
				continue;
			}
			if (created.portableAddresses.has(source.asset.address)) {
				continue;
			}
			const final = finalAssets.get(source.asset.address);
			if (!final) {
				continue;
			}
			const local = options.buildType === "full" && final.group.delivery === "local";
			const relativePath = local ? `local/${final.asset.internalId}` : `remote/${final.asset.internalId}`;
			const destination = join(temporaryPath, relativePath);
			await ensureDir(dirname(destination));
			await copyFile(source.sourcePath, destination);
			emittedContentBytes += final.asset.sizeBytes;
			await addArtifact(artifacts, temporaryPath, local ? "local-content" : "remote-content", relativePath, local ? undefined : final.asset.internalId);
		}
		for (const artifact of created.portableArtifacts) {
			const artifactAddresses = artifact.addresses.length ? artifact.addresses : [...created.portableAddresses];
			if (options.buildType === "update" && !artifactAddresses.some((address) => emitted.has(address))) {
				continue;
			}
			const deliveries = new Set(
				artifactAddresses.flatMap((address) => {
					const final = finalAssets.get(address);
					return final ? [final.group.delivery] : [];
				})
			);
			for (const delivery of deliveries) {
				const relativePath = `${delivery}/${artifact.internalId}`;
				const destination = join(temporaryPath, relativePath);
				await ensureDir(dirname(destination));
				await writeFile(destination, artifact.bytes);
				emittedContentBytes += artifact.bytes.byteLength;
				await addArtifact(artifacts, temporaryPath, artifact.kind, relativePath, delivery === "remote" ? artifact.internalId : undefined);
			}
		}
		const catalogRelativePath = `catalogs/${created.catalog.buildId}.catalog.json`;
		const hashRelativePath = `catalogs/${created.catalog.buildId}.hash`;
		const stateRelativePath = `states/${created.catalog.buildId}.state.json`;
		const reportRelativePath = `reports/${created.catalog.buildId}.report.json`;
		const pointerRelativePath = configuration.settings.remoteCatalogFile;
		const state: IAddressableContentState = {
			version: 1,
			buildId: created.catalog.buildId,
			catalogHash: created.catalog.catalogHash,
			profileId: profile.id,
			configurationRevision: configuration.revision,
			generatedAt: created.catalog.generatedAt,
			assets: stateAssets(created.catalog),
		};
		const pointer = {
			version: 1,
			buildId: created.catalog.buildId,
			catalogHash: created.catalog.catalogHash,
			catalogUrl: catalogRelativePath,
			hashUrl: hashRelativePath,
		};
		await ensureDir(join(temporaryPath, "catalogs"));
		await ensureDir(join(temporaryPath, "states"));
		await ensureDir(join(temporaryPath, "reports"));
		await ensureDir(dirname(join(temporaryPath, pointerRelativePath)));
		await writeJSON(join(temporaryPath, catalogRelativePath), created.catalog, { spaces: "\t" });
		await writeFile(join(temporaryPath, hashRelativePath), `${created.catalog.catalogHash}\n`, "utf8");
		await writeJSON(join(temporaryPath, stateRelativePath), state, { spaces: "\t" });
		await writeJSON(join(temporaryPath, pointerRelativePath), pointer, { spaces: "\t" });
		await addArtifact(artifacts, temporaryPath, "catalog", catalogRelativePath, catalogRelativePath);
		await addArtifact(artifacts, temporaryPath, "catalog-hash", hashRelativePath, hashRelativePath);
		await addArtifact(artifacts, temporaryPath, "content-state", stateRelativePath);
		await addArtifact(artifacts, temporaryPath, "pointer-preview", pointerRelativePath, pointerRelativePath);
		const report: IAddressableBuildReport = {
			version: 1,
			buildId: created.catalog.buildId,
			buildType: options.buildType,
			baseBuildId: previous?.buildId,
			profileId: profile.id,
			configurationRevision: configuration.revision,
			generatedAt: created.catalog.generatedAt,
			durationMs: Date.now() - startedAt,
			outputPath: relative(projectDirectory, outputPath),
			catalogHash: created.catalog.catalogHash,
			groupCount: created.catalog.groups.length,
			assetCount: state.assets.length,
			localAssetCount: state.assets.filter((asset) => asset.delivery === "local").length,
			remoteAssetCount: state.assets.filter((asset) => asset.delivery === "remote").length,
			addedCount: diff.added.length,
			changedCount: diff.changed.length,
			removedCount: diff.removed.length,
			unchangedCount: diff.unchanged.length,
			staticRedirectCount,
			emittedContentBytes,
			typeTreeSchemaCount: created.catalog.typeTreeSummary?.schemaCount ?? 0,
			portableBundleCount: created.catalog.typeTreeSummary?.bundleCount ?? 0,
			typeTreeSavedBytes: created.catalog.typeTreeSummary?.savedBytes ?? 0,
			artifacts,
		};
		await writeJSON(join(temporaryPath, reportRelativePath), report, { spaces: "\t" });
		let backedUp = false;
		if (await pathExists(outputPath)) {
			await remove(backupPath);
			await move(outputPath, backupPath);
			backedUp = true;
		}
		try {
			await move(temporaryPath, outputPath);
			if (backedUp) {
				await remove(backupPath);
			}
		} catch (error) {
			if (backedUp && !(await pathExists(outputPath))) {
				await move(backupPath, outputPath);
			}
			throw error;
		}
		return {
			catalog: created.catalog,
			state,
			report,
			reportPath: join(outputPath, reportRelativePath),
			statePath: join(outputPath, stateRelativePath),
			catalogPath: join(outputPath, catalogRelativePath),
			hashPath: join(outputPath, hashRelativePath),
			pointerPath: join(outputPath, pointerRelativePath),
		};
	} catch (error) {
		await remove(temporaryPath);
		throw error;
	}
}

export async function readAddressableBuildReport(projectDirectory: string, reportPath: string): Promise<IAddressableBuildReport> {
	const absolutePath = projectPath(projectDirectory, reportPath);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Addressables build report was not found: ${reportPath}`);
	}
	const report = (await readJSON(absolutePath)) as IAddressableBuildReport;
	if (report.version !== 1 || !report.buildId || !report.catalogHash || !Array.isArray(report.artifacts) || report.artifacts.length > 8192) {
		throw new Error("Addressables build report is invalid.");
	}
	for (const artifact of report.artifacts) {
		const artifactPath = projectPath(projectDirectory, join(dirname(absolutePath), "..", artifact.relativePath));
		if (!(await pathExists(artifactPath)) || (await stat(artifactPath)).isDirectory()) {
			throw new Error(`Addressables build artifact is missing: ${artifact.relativePath}`);
		}
	}
	return report;
}
