import { createHash } from "crypto";
import { dirname, extname, isAbsolute, join, normalize } from "path/posix";
import { copyFile, ensureDir, pathExists, readFile, readJSON, writeFile, writeJSON } from "fs-extra";

import {
	ADDRESSABLES_CATALOG_VERSION,
	getAddressableCatalogHashPayload,
	getAddressableProfile,
	IAddressableCatalog,
	IAddressableCatalogAsset,
	IAddressableCatalogGroup,
	IAddressableGroupConfiguration,
	IAddressableProjectConfiguration,
	normalizeAddressableConfiguration,
} from "babylonjs-editor-tools";

import { createAddressablePortableBuildPlan, IAddressablePortableBuildArtifact } from "./addressable-type-trees";

export interface IAddressableCatalogSource {
	group: IAddressableGroupConfiguration;
	asset: IAddressableCatalogAsset;
	sourcePath: string;
}

export interface ICreatedAddressableCatalog {
	catalog: IAddressableCatalog;
	sources: IAddressableCatalogSource[];
	portableArtifacts: IAddressablePortableBuildArtifact[];
	portableAddresses: Set<string>;
}

function projectFile(projectDir: string, value: string): string {
	const result = normalize(isAbsolute(value) ? value : join(projectDir, value));
	if (result !== projectDir && !result.startsWith(`${projectDir}/`)) {
		throw new Error(`Addressable asset is outside the project: ${value}`);
	}
	return result;
}

function joinUrl(base: string, value: string): string {
	if (/^https?:\/\//.test(base)) {
		return new URL(value.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`).toString();
	}
	return `${base.replace(/\/$/, "")}/${value.replace(/^\//, "")}`;
}

/** Creates the exact catalog shared by editor builds, generated scenes, and deployed runtime updates. */
export async function createAddressableCatalog(
	projectDir: string,
	configuration: IAddressableProjectConfiguration,
	profileId = configuration.activeProfileId,
	buildType: "full" | "update" = "full",
	baseBuildId?: string
): Promise<ICreatedAddressableCatalog> {
	const profile = getAddressableProfile(configuration, profileId);
	const sources: IAddressableCatalogSource[] = [];
	const groups: IAddressableCatalogGroup[] = await Promise.all(
		configuration.groups.map(async (group): Promise<IAddressableCatalogGroup> => {
			const loadPath = group.loadPath ?? (group.delivery === "remote" ? profile.remoteLoadPath : profile.localLoadPath);
			const assets = await Promise.all(
				group.assets.map(async (entry): Promise<IAddressableCatalogAsset> => {
					const sourcePath = projectFile(projectDir, entry.path);
					if (!(await pathExists(sourcePath))) {
						throw new Error(`Addressable asset no longer exists: ${entry.path}`);
					}
					const bytes = await readFile(sourcePath);
					const hash = createHash("sha256").update(bytes).digest("hex");
					const asset: IAddressableCatalogAsset = {
						path: entry.path,
						address: entry.address,
						internalId: group.delivery === "remote" ? `content/${hash.slice(0, 2)}/${hash}${extname(entry.path).toLowerCase()}` : entry.path,
						sizeBytes: bytes.byteLength,
						hash,
						labels: entry.labels,
						sourceGroupId: group.id,
					};
					sources.push({ group, asset, sourcePath });
					return asset;
				})
			);
			return { id: group.id, name: group.name, delivery: group.delivery, updateRestriction: group.updateRestriction, loadPath, assets };
		})
	);
	const catalog: IAddressableCatalog = {
		version: ADDRESSABLES_CATALOG_VERSION,
		buildId: "pending",
		buildType,
		baseBuildId,
		profileId: profile.id,
		generatedAt: new Date().toISOString(),
		catalogHash: "0".repeat(64),
		remoteCatalog: configuration.settings.remoteCatalog ? { pointerUrl: joinUrl(profile.remoteLoadPath, configuration.settings.remoteCatalogFile) } : undefined,
		runtime: {
			verifyHashes: configuration.settings.verifyHashes,
			requestTimeoutMs: configuration.settings.requestTimeoutMs,
			maxConcurrentRequests: configuration.settings.maxConcurrentRequests,
			cacheMaxBytes: configuration.settings.cacheMaxBytes,
		},
		groups,
	};
	const portablePlan = await createAddressablePortableBuildPlan(
		catalog,
		configuration,
		sources.map((source) => ({ groupId: source.group.id, address: source.asset.address, sourcePath: source.sourcePath }))
	);
	const catalogHash = createHash("sha256").update(getAddressableCatalogHashPayload(catalog)).digest("hex");
	catalog.catalogHash = catalogHash;
	catalog.buildId = `addr-${catalogHash.slice(0, 20)}`;
	sources.sort((left, right) => `${left.group.id}:${left.asset.address}`.localeCompare(`${right.group.id}:${right.asset.address}`));
	return { catalog, sources, portableArtifacts: portablePlan.artifacts, portableAddresses: portablePlan.portableAddresses };
}

/** Builds the embedded initial catalog and copies local Addressables into generated scene output. */
export async function exportAddressables(projectDir: string, scenePath: string): Promise<{ catalog?: IAddressableCatalog; files: string[] }> {
	const configurationPath = join(projectDir, "addressables.json");
	if (!(await pathExists(configurationPath))) {
		return { files: [] };
	}
	const configuration = normalizeAddressableConfiguration(await readJSON(configurationPath));
	const { catalog, sources, portableArtifacts, portableAddresses } = await createAddressableCatalog(projectDir, configuration);
	const files: string[] = [];
	for (const source of sources) {
		if (source.group.delivery !== "local" || portableAddresses.has(source.asset.address)) {
			continue;
		}
		const destination = join(scenePath, source.asset.internalId);
		await ensureDir(dirname(destination));
		await copyFile(source.sourcePath, destination);
		files.push(destination);
	}
	for (const artifact of portableArtifacts.filter((candidate) => candidate.deliveries.includes("local"))) {
		const destination = join(scenePath, artifact.internalId);
		await ensureDir(dirname(destination));
		await writeFile(destination, artifact.bytes);
		files.push(destination);
	}
	const catalogPath = join(scenePath, "addressables.catalog.json");
	await writeJSON(catalogPath, catalog, { spaces: "\t" });
	files.push(catalogPath);
	return { catalog, files };
}
