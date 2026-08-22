export const ADDRESSABLES_CONFIGURATION_VERSION = 2 as const;
export const ADDRESSABLES_CATALOG_VERSION = 3 as const;

export type AddressableDeliveryMode = "local" | "remote";
export type AddressableUpdateRestriction = "static" | "dynamic";
export type AddressableBundleMode = "pack-together" | "pack-separately";
export type AddressableBuildType = "full" | "update";

export interface IAddressableProfile {
	id: string;
	name: string;
	localBuildPath: string;
	localLoadPath: string;
	remoteBuildPath: string;
	remoteLoadPath: string;
}

export interface IAddressableEntryConfiguration {
	path: string;
	address: string;
	labels: string[];
}

export interface IAddressableGroupConfiguration {
	id: string;
	name: string;
	delivery: AddressableDeliveryMode;
	updateRestriction: AddressableUpdateRestriction;
	bundleMode: AddressableBundleMode;
	buildPath?: string;
	loadPath?: string;
	assets: IAddressableEntryConfiguration[];
}

export interface IAddressableSettings {
	remoteCatalog: boolean;
	remoteCatalogFile: string;
	verifyHashes: boolean;
	extractTypeTrees: boolean;
	requestTimeoutMs: number;
	maxConcurrentRequests: number;
	cacheMaxBytes: number;
}

export interface IAddressableFilesystemDeploymentTarget {
	id: string;
	name: string;
	provider: "filesystem";
	destinationPath: string;
	publicBaseUrl: string;
}

export interface IAddressableHttpDeploymentTarget {
	id: string;
	name: string;
	provider: "http";
	baseUrl: string;
	publicBaseUrl: string;
	authorizationEnvironment?: string;
}

export interface IAddressableS3DeploymentTarget {
	id: string;
	name: string;
	provider: "s3";
	bucket: string;
	region: string;
	endpoint?: string;
	keyPrefix: string;
	publicBaseUrl: string;
	accessKeyIdEnvironment: string;
	secretAccessKeyEnvironment: string;
	sessionTokenEnvironment?: string;
}

export type IAddressableDeploymentTarget = IAddressableFilesystemDeploymentTarget | IAddressableHttpDeploymentTarget | IAddressableS3DeploymentTarget;

export interface IAddressableProjectConfiguration {
	version: typeof ADDRESSABLES_CONFIGURATION_VERSION;
	revision: number;
	activeProfileId: string;
	profiles: IAddressableProfile[];
	groups: IAddressableGroupConfiguration[];
	deploymentTargets: IAddressableDeploymentTarget[];
	activeDeploymentTargetId?: string;
	settings: IAddressableSettings;
}

export interface IAddressableCatalogAsset {
	path: string;
	address: string;
	internalId: string;
	sizeBytes: number;
	hash: string;
	labels: string[];
	sourceGroupId: string;
	portableBundleId?: string;
	typeTreeSchemaId?: string;
}

export interface IAddressableTypeTreeRegistryReference {
	registryId: string;
	internalId: string;
	loadPaths: string[];
	sizeBytes: number;
	hash: string;
	schemaCount: number;
}

export interface IAddressablePortableBundleReference {
	id: string;
	internalId: string;
	sizeBytes: number;
	hash: string;
	addresses: string[];
}

export interface IAddressableTypeTreeBuildSummary {
	enabled: boolean;
	schemaCount: number;
	bundleCount: number;
	structuredAssetCount: number;
	sourceBytes: number;
	bundleBytes: number;
	registryBytes: number;
	savedBytes: number;
}

export interface IAddressableCatalogGroup {
	id: string;
	name: string;
	delivery: AddressableDeliveryMode;
	updateRestriction: AddressableUpdateRestriction;
	loadPath: string;
	assets: IAddressableCatalogAsset[];
}

export interface IAddressableRemoteCatalogReference {
	pointerUrl: string;
}

export interface IAddressableCatalog {
	version: 2 | typeof ADDRESSABLES_CATALOG_VERSION;
	buildId: string;
	buildType: AddressableBuildType;
	baseBuildId?: string;
	profileId: string;
	generatedAt: string;
	catalogHash: string;
	remoteCatalog?: IAddressableRemoteCatalogReference;
	runtime: Pick<IAddressableSettings, "verifyHashes" | "requestTimeoutMs" | "maxConcurrentRequests" | "cacheMaxBytes">;
	groups: IAddressableCatalogGroup[];
	typeTreeRegistry?: IAddressableTypeTreeRegistryReference;
	portableBundles?: IAddressablePortableBundleReference[];
	typeTreeSummary?: IAddressableTypeTreeBuildSummary;
}

const defaultProfile: IAddressableProfile = {
	id: "default",
	name: "Default",
	localBuildPath: "AddressableBuilds/{profile}/local",
	localLoadPath: "./",
	remoteBuildPath: "AddressableBuilds/{profile}/remote",
	remoteLoadPath: "http://127.0.0.1:8080/addressables",
};

const defaultSettings: IAddressableSettings = {
	remoteCatalog: false,
	remoteCatalogFile: "addressables.current.json",
	verifyHashes: true,
	extractTypeTrees: false,
	requestTimeoutMs: 30_000,
	maxConcurrentRequests: 8,
	cacheMaxBytes: 256 * 1024 * 1024,
};

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function identifier(value: unknown, fallback: string): string {
	return text(value, fallback).slice(0, 128);
}

function normalizeProjectPath(value: unknown, fallback: string): string {
	const result = text(value, fallback).replaceAll("\\", "/").replace(/^\.\//, "");
	if (result.startsWith("/") || /^[A-Za-z]:\//.test(result) || result.split("/").includes("..")) {
		throw new Error(`Addressables project path must be relative and cannot traverse the project: ${result}`);
	}
	return result;
}

function requireNonEmpty(value: string, description: string): string {
	if (!value.trim()) {
		throw new Error(`${description} must be a non-empty string.`);
	}
	return value;
}

function normalizeLoadPath(value: unknown, fallback: string): string {
	const result = text(value, fallback).replaceAll("\\", "/");
	if (/^https?:\/\//.test(result) || result.startsWith("./") || result.startsWith("../") || result.startsWith("/")) {
		return result.replace(/\/$/, "") || "/";
	}
	return result.replace(/\/$/, "");
}

function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [...new Set(value.filter((label): label is string => typeof label === "string" && Boolean(label.trim())).map((label) => label.trim().slice(0, 128)))].sort();
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const result = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(maximum, Math.max(minimum, Math.round(result)));
}

export function createDefaultAddressableConfiguration(): IAddressableProjectConfiguration {
	return {
		version: ADDRESSABLES_CONFIGURATION_VERSION,
		revision: 0,
		activeProfileId: defaultProfile.id,
		profiles: [structuredClone(defaultProfile)],
		groups: [],
		deploymentTargets: [],
		settings: structuredClone(defaultSettings),
	};
}

function environmentName(value: unknown, fallback: string): string {
	const result = text(value, fallback);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) {
		throw new Error(`Addressables credential environment name is invalid: ${result}`);
	}
	return result;
}

/** Deterministically migrates legacy version-1 groups and returns canonical version-2 authoring data. */
export function normalizeAddressableConfiguration(value: unknown): IAddressableProjectConfiguration {
	const source = asRecord(value);
	const sourceProfiles = Array.isArray(source.profiles) ? source.profiles : [];
	const profiles = sourceProfiles.length
		? sourceProfiles.slice(0, 32).map((candidate, index): IAddressableProfile => {
				const profile = asRecord(candidate);
				return {
					id: identifier(profile.id, `profile-${index + 1}`),
					name: text(profile.name, `Profile ${index + 1}`).slice(0, 128),
					localBuildPath: normalizeProjectPath(profile.localBuildPath, defaultProfile.localBuildPath),
					localLoadPath: normalizeLoadPath(profile.localLoadPath, defaultProfile.localLoadPath),
					remoteBuildPath: normalizeProjectPath(profile.remoteBuildPath, defaultProfile.remoteBuildPath),
					remoteLoadPath: normalizeLoadPath(profile.remoteLoadPath, defaultProfile.remoteLoadPath),
				};
			})
		: [structuredClone(defaultProfile)];
	const sourceGroups = Array.isArray(source.groups) ? source.groups : [];
	const groups = sourceGroups.slice(0, 128).map((candidate, groupIndex): IAddressableGroupConfiguration => {
		const group = asRecord(candidate);
		const legacyLabels = asRecord(group.assetLabels);
		const sourceAssets = Array.isArray(group.assets) ? group.assets : [];
		const assets = sourceAssets.slice(0, 2048).map((asset, assetIndex): IAddressableEntryConfiguration => {
			const entry = typeof asset === "string" ? { path: asset } : asRecord(asset);
			const path = normalizeProjectPath(entry.path, `asset-${assetIndex + 1}`);
			return {
				path,
				address: text(entry.address, path).slice(0, 512),
				labels: normalizeLabels(entry.labels ?? legacyLabels[path]),
			};
		});
		const legacyRemoteUrl = typeof group.remoteUrl === "string" && group.remoteUrl.trim() ? group.remoteUrl.trim() : undefined;
		return {
			id: identifier(group.id, `group-${groupIndex + 1}`),
			name: text(group.name, `Group ${groupIndex + 1}`).slice(0, 128),
			delivery: group.delivery === "remote" || legacyRemoteUrl ? "remote" : "local",
			updateRestriction: group.updateRestriction === "dynamic" ? "dynamic" : "static",
			bundleMode: group.bundleMode === "pack-together" ? "pack-together" : "pack-separately",
			buildPath: typeof group.buildPath === "string" && group.buildPath.trim() ? normalizeProjectPath(group.buildPath, "") : undefined,
			loadPath: legacyRemoteUrl
				? normalizeLoadPath(legacyRemoteUrl, "")
				: typeof group.loadPath === "string" && group.loadPath.trim()
					? normalizeLoadPath(group.loadPath, "")
					: undefined,
			assets,
		};
	});
	const settingsSource = asRecord(source.settings);
	const sourceTargets = Array.isArray(source.deploymentTargets) ? source.deploymentTargets : [];
	const deploymentTargets = sourceTargets.slice(0, 32).map((candidate, index): IAddressableDeploymentTarget => {
		const target = asRecord(candidate);
		const common = { id: identifier(target.id, `deployment-${index + 1}`), name: text(target.name, `Deployment ${index + 1}`).slice(0, 128) };
		if (target.provider === "filesystem") {
			return {
				...common,
				provider: "filesystem",
				destinationPath: text(target.destinationPath, "AddressableDeployments/local"),
				publicBaseUrl: normalizeLoadPath(target.publicBaseUrl, defaultProfile.remoteLoadPath),
			};
		}
		if (target.provider === "http") {
			return {
				...common,
				provider: "http",
				baseUrl: normalizeLoadPath(target.baseUrl, defaultProfile.remoteLoadPath),
				publicBaseUrl: normalizeLoadPath(target.publicBaseUrl, String(target.baseUrl ?? defaultProfile.remoteLoadPath)),
				authorizationEnvironment: target.authorizationEnvironment ? environmentName(target.authorizationEnvironment, "") : undefined,
			};
		}
		return {
			...common,
			provider: "s3",
			bucket: text(target.bucket, "babylonjs-editor"),
			region: text(target.region, "us-east-1"),
			endpoint: typeof target.endpoint === "string" && target.endpoint.trim() ? normalizeLoadPath(target.endpoint, "") : undefined,
			keyPrefix: normalizeProjectPath(target.keyPrefix, "addressables"),
			publicBaseUrl: normalizeLoadPath(target.publicBaseUrl, defaultProfile.remoteLoadPath),
			accessKeyIdEnvironment: environmentName(target.accessKeyIdEnvironment, "AWS_ACCESS_KEY_ID"),
			secretAccessKeyEnvironment: environmentName(target.secretAccessKeyEnvironment, "AWS_SECRET_ACCESS_KEY"),
			sessionTokenEnvironment: target.sessionTokenEnvironment ? environmentName(target.sessionTokenEnvironment, "") : undefined,
		};
	});
	const configuration: IAddressableProjectConfiguration = {
		version: ADDRESSABLES_CONFIGURATION_VERSION,
		revision: numberInRange(source.revision, 0, 0, Number.MAX_SAFE_INTEGER),
		activeProfileId: identifier(source.activeProfileId, profiles[0].id),
		profiles,
		groups,
		deploymentTargets,
		activeDeploymentTargetId: typeof source.activeDeploymentTargetId === "string" ? source.activeDeploymentTargetId : undefined,
		settings: {
			remoteCatalog: settingsSource.remoteCatalog === true,
			remoteCatalogFile: normalizeProjectPath(settingsSource.remoteCatalogFile, defaultSettings.remoteCatalogFile),
			verifyHashes: settingsSource.verifyHashes !== false,
			extractTypeTrees: settingsSource.extractTypeTrees === true,
			requestTimeoutMs: numberInRange(settingsSource.requestTimeoutMs, defaultSettings.requestTimeoutMs, 1_000, 120_000),
			maxConcurrentRequests: numberInRange(settingsSource.maxConcurrentRequests, defaultSettings.maxConcurrentRequests, 1, 32),
			cacheMaxBytes: numberInRange(settingsSource.cacheMaxBytes, defaultSettings.cacheMaxBytes, 0, 2 * 1024 * 1024 * 1024),
		},
	};
	validateAddressableConfiguration(configuration);
	return configuration;
}

export function validateAddressableConfiguration(configuration: IAddressableProjectConfiguration): void {
	if (configuration.version !== ADDRESSABLES_CONFIGURATION_VERSION) {
		throw new Error(`Addressables configuration version must be ${ADDRESSABLES_CONFIGURATION_VERSION}.`);
	}
	if (!Number.isSafeInteger(configuration.revision) || configuration.revision < 0) {
		throw new Error("Addressables revision must be a non-negative safe integer.");
	}
	if (!configuration.profiles.length || configuration.profiles.length > 32) {
		throw new Error("Addressables requires 1–32 profiles.");
	}
	const profileIds = new Set<string>();
	const profileNames = new Set<string>();
	for (const profile of configuration.profiles) {
		requireNonEmpty(profile.id, "Addressables profile id");
		requireNonEmpty(profile.name, "Addressables profile name");
		if (profileIds.has(profile.id) || profileNames.has(profile.name)) {
			throw new Error(`Addressables profile ids and names must be unique: ${profile.name}`);
		}
		profileIds.add(profile.id);
		profileNames.add(profile.name);
		normalizeProjectPath(requireNonEmpty(profile.localBuildPath, "Local build path"), "");
		normalizeProjectPath(requireNonEmpty(profile.remoteBuildPath, "Remote build path"), "");
		normalizeLoadPath(requireNonEmpty(profile.localLoadPath, "Local load path"), "");
		const remoteLoadPath = normalizeLoadPath(profile.remoteLoadPath, "");
		if (!/^https?:\/\//.test(remoteLoadPath)) {
			throw new Error(`Remote load path must use HTTP or HTTPS: ${profile.remoteLoadPath}`);
		}
	}
	if (!profileIds.has(configuration.activeProfileId)) {
		throw new Error(`Active Addressables profile was not found: ${configuration.activeProfileId}`);
	}
	if (configuration.groups.length > 128) {
		throw new Error("Addressables supports at most 128 groups.");
	}
	if (configuration.deploymentTargets.length > 32) {
		throw new Error("Addressables supports at most 32 deployment targets.");
	}
	const deploymentIds = new Set<string>();
	const deploymentNames = new Set<string>();
	for (const target of configuration.deploymentTargets) {
		requireNonEmpty(target.id, "Addressables deployment target id");
		requireNonEmpty(target.name, "Addressables deployment target name");
		if (deploymentIds.has(target.id) || deploymentNames.has(target.name)) {
			throw new Error(`Addressables deployment target ids and names must be unique: ${target.name}`);
		}
		deploymentIds.add(target.id);
		deploymentNames.add(target.name);
		if (!/^https?:\/\//.test(target.publicBaseUrl)) {
			throw new Error(`Addressables deployment publicBaseUrl must use HTTP or HTTPS: ${target.publicBaseUrl}`);
		}
		if (target.provider === "http" && !/^https?:\/\//.test(target.baseUrl)) {
			throw new Error(`Addressables HTTP deployment baseUrl must use HTTP or HTTPS: ${target.baseUrl}`);
		}
		if (target.provider === "http" && target.authorizationEnvironment) {
			environmentName(target.authorizationEnvironment, "");
		}
		if (target.provider === "filesystem") {
			requireNonEmpty(target.destinationPath, "Addressables filesystem destination path");
		}
		if (target.provider === "s3") {
			requireNonEmpty(target.bucket, "Addressables S3 bucket");
			requireNonEmpty(target.region, "Addressables S3 region");
			normalizeProjectPath(requireNonEmpty(target.keyPrefix, "Addressables S3 key prefix"), "");
			environmentName(target.accessKeyIdEnvironment, "");
			environmentName(target.secretAccessKeyEnvironment, "");
			if (target.sessionTokenEnvironment) {
				environmentName(target.sessionTokenEnvironment, "");
			}
		}
		if (target.provider === "s3" && target.endpoint && !/^https?:\/\//.test(target.endpoint)) {
			throw new Error(`Addressables S3 endpoint must use HTTP or HTTPS: ${target.endpoint}`);
		}
	}
	if (configuration.activeDeploymentTargetId && !deploymentIds.has(configuration.activeDeploymentTargetId)) {
		throw new Error(`Active Addressables deployment target was not found: ${configuration.activeDeploymentTargetId}`);
	}
	const groupIds = new Set<string>();
	const groupNames = new Set<string>();
	const addresses = new Set<string>();
	const sourcePaths = new Set<string>();
	let assetCount = 0;
	for (const group of configuration.groups) {
		requireNonEmpty(group.id, "Addressables group id");
		requireNonEmpty(group.name, "Addressables group name");
		if (groupIds.has(group.id) || groupNames.has(group.name)) {
			throw new Error(`Addressable group ids and names must be unique: ${group.name}`);
		}
		groupIds.add(group.id);
		groupNames.add(group.name);
		if (group.delivery === "local" && group.updateRestriction !== "static") {
			throw new Error(`Local Addressable group "${group.name}" must prevent updates.`);
		}
		if (group.buildPath) {
			normalizeProjectPath(group.buildPath, "");
		}
		if (group.loadPath) {
			const loadPath = normalizeLoadPath(group.loadPath, "");
			if (group.delivery === "remote" && !/^https?:\/\//.test(loadPath)) {
				throw new Error(`Remote group load path must use HTTP or HTTPS: ${group.loadPath}`);
			}
		}
		if (group.assets.length > 2048) {
			throw new Error(`Addressable group "${group.name}" exceeds 2,048 assets.`);
		}
		for (const asset of group.assets) {
			assetCount++;
			if (assetCount > 8192) {
				throw new Error("Addressables supports at most 8,192 assets.");
			}
			normalizeProjectPath(requireNonEmpty(asset.path, "Addressable asset path"), "");
			if (!asset.address.trim() || asset.address.length > 512 || addresses.has(asset.address)) {
				throw new Error(`Addressable addresses must be unique non-empty strings: ${asset.address}`);
			}
			if (sourcePaths.has(asset.path)) {
				throw new Error(`A project asset can belong to only one Addressable group: ${asset.path}`);
			}
			addresses.add(asset.address);
			sourcePaths.add(asset.path);
			if (asset.labels.length > 64 || asset.labels.some((label) => !label.trim() || label.length > 128)) {
				throw new Error(`Addressable asset "${asset.path}" has invalid labels.`);
			}
		}
	}
	if (configuration.settings.remoteCatalog && !configuration.groups.some((group) => group.delivery === "remote")) {
		throw new Error("Remote catalog requires at least one remote Addressable group.");
	}
	normalizeProjectPath(requireNonEmpty(configuration.settings.remoteCatalogFile, "Remote catalog file"), "");
	if (
		typeof configuration.settings.extractTypeTrees !== "boolean" ||
		!Number.isSafeInteger(configuration.settings.requestTimeoutMs) ||
		configuration.settings.requestTimeoutMs < 1_000 ||
		configuration.settings.requestTimeoutMs > 120_000 ||
		!Number.isSafeInteger(configuration.settings.maxConcurrentRequests) ||
		configuration.settings.maxConcurrentRequests < 1 ||
		configuration.settings.maxConcurrentRequests > 32 ||
		!Number.isSafeInteger(configuration.settings.cacheMaxBytes) ||
		configuration.settings.cacheMaxBytes < 0 ||
		configuration.settings.cacheMaxBytes > 2 * 1024 * 1024 * 1024
	) {
		throw new Error("Addressables runtime timeout, concurrency, or cache settings are outside their supported bounds.");
	}
}

export function getAddressableProfile(configuration: IAddressableProjectConfiguration, profileId?: string): IAddressableProfile {
	const result = configuration.profiles.find((profile) => profile.id === (profileId ?? configuration.activeProfileId));
	if (!result) {
		throw new Error(`Addressables profile was not found: ${profileId ?? configuration.activeProfileId}`);
	}
	return result;
}

export function resolveAddressableProfilePath(value: string, profile: IAddressableProfile): string {
	return value.replaceAll("{profile}", profile.name.replace(/[^A-Za-z0-9._-]+/g, "-")).replaceAll("{profileId}", profile.id);
}

export function visitAddressableAssets(
	configuration: IAddressableProjectConfiguration,
	callback: (group: IAddressableGroupConfiguration, asset: IAddressableEntryConfiguration) => void
): void {
	for (const group of configuration.groups) {
		for (const asset of group.assets) {
			callback(group, asset);
		}
	}
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortJson(child)])
		);
	}
	return value;
}

export function stableAddressableStringify(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

/** Returns the stable semantic payload hashed by content builds and remote runtime verification. */
export function getAddressableCatalogHashPayload(catalog: IAddressableCatalog): string {
	return stableAddressableStringify({
		...catalog,
		buildId: "",
		generatedAt: "",
		catalogHash: "",
	});
}
