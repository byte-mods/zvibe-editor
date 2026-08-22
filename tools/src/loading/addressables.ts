import { Scene } from "@babylonjs/core/scene";

import { ADDRESSABLES_CATALOG_VERSION, getAddressableCatalogHashPayload, IAddressableCatalog, IAddressableCatalogAsset, IAddressableCatalogGroup } from "./addressables-model";
import { IAddressableTypeTreeSchema, IAddressableTypeTreeRegistry, validateAddressableTypeTreeRegistry } from "./addressable-type-trees";
import { parseAddressablePortableBundle } from "./addressable-portable-bundles";

export * from "./addressables-model";
export * from "./addressable-type-trees";
export * from "./addressable-portable-bundles";

export interface IAddressableQuery {
	groupNames?: string[];
	addresses?: string[];
	labels?: string[];
	match?: "all" | "any";
}

export interface IAddressableRuntimeOptions {
	fetch?: typeof fetch;
	cache?: AddressableMemoryCache;
	verifyHashes?: boolean;
	requestTimeoutMs?: number;
	maxConcurrentRequests?: number;
	cacheMaxBytes?: number;
}

export interface IAddressableCatalogUpdate {
	configured: boolean;
	available: boolean;
	currentBuildId: string;
	remoteBuildId?: string;
	catalogHash?: string;
	catalogUrl?: string;
}

export interface IAddressableDownloadResult {
	assetCount: number;
	downloadedCount: number;
	cachedCount: number;
	downloadedBytes: number;
}

export interface IAddressableCacheStatus {
	entryCount: number;
	sizeBytes: number;
	maxBytes: number;
	hits: number;
	misses: number;
	evictions: number;
}

export interface IAddressableRuntimeStatus {
	buildId: string;
	buildType: "full" | "update";
	profileId: string;
	catalogHash: string;
	groupCount: number;
	assetCount: number;
	typeTreeSchemaCount: number;
	portableBundleCount: number;
	typeTreeSavedBytes: number;
	remoteCatalogConfigured: boolean;
	inFlightRequests: number;
	cache: IAddressableCacheStatus;
	lastCatalogCheckAt?: string;
	lastCatalogUpdateAt?: string;
	lastError?: string;
}

interface IAddressableCatalogPointer {
	version: 1;
	buildId: string;
	catalogHash: string;
	catalogUrl: string;
	hashUrl?: string;
}

interface IAddressableCacheEntry {
	bytes: ArrayBuffer;
	sizeBytes: number;
	lastAccess: number;
}

function resolveUrl(base: string, path: string): string {
	if (/^https?:\/\//.test(path)) {
		return path;
	}
	if (/^https?:\/\//.test(base)) {
		return new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`).toString();
	}
	return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function resolveDocumentUrl(documentUrl: string, path: string): string {
	if (/^https?:\/\//.test(path)) {
		return path;
	}
	if (/^https?:\/\//.test(documentUrl)) {
		return new URL(path, documentUrl).toString();
	}
	return resolveUrl(documentUrl.replace(/\/[^/]*$/, ""), path);
}

async function sha256(bytes: BufferSource): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("SHA-256 verification is unavailable in this runtime.");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeCatalog(value: unknown, rootUrl: string): IAddressableCatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Addressable catalog must be a JSON object.");
	}
	const source = value as Record<string, unknown>;
	if (source.version === ADDRESSABLES_CATALOG_VERSION) {
		const catalog = structuredClone(value) as IAddressableCatalog;
		validateCatalog(catalog);
		return catalog;
	}
	if (source.version === 2 && Array.isArray(source.groups)) {
		const catalog = structuredClone(value) as IAddressableCatalog;
		catalog.version = ADDRESSABLES_CATALOG_VERSION;
		catalog.portableBundles = [];
		catalog.typeTreeSummary = {
			enabled: false,
			schemaCount: 0,
			bundleCount: 0,
			structuredAssetCount: 0,
			sourceBytes: 0,
			bundleBytes: 0,
			registryBytes: 0,
			savedBytes: 0,
		};
		validateCatalog(catalog);
		return catalog;
	}
	const legacyGroups = Array.isArray(source.groups) ? source.groups : [];
	const groups: IAddressableCatalogGroup[] = legacyGroups.map((candidate, groupIndex) => {
		const group = candidate as Record<string, unknown>;
		const id = typeof group.id === "string" ? group.id : `group-${groupIndex + 1}`;
		const assets = Array.isArray(group.assets) ? group.assets : [];
		return {
			id,
			name: typeof group.name === "string" ? group.name : id,
			delivery: typeof group.remoteUrl === "string" ? "remote" : "local",
			updateRestriction: "static",
			loadPath: typeof group.remoteUrl === "string" ? group.remoteUrl : rootUrl,
			assets: assets.map((candidateAsset): IAddressableCatalogAsset => {
				const asset = candidateAsset as Record<string, unknown>;
				const path = String(asset.path ?? "");
				return {
					path,
					address: path,
					internalId: path,
					sizeBytes: Number(asset.sizeBytes ?? 0),
					hash: String(asset.hash ?? ""),
					labels: Array.isArray(asset.labels) ? asset.labels.filter((label): label is string => typeof label === "string") : [],
					sourceGroupId: id,
				};
			}),
		};
	});
	return {
		version: ADDRESSABLES_CATALOG_VERSION,
		buildId: "legacy-v1",
		buildType: "full",
		profileId: "legacy",
		generatedAt: typeof source.generatedAt === "string" ? source.generatedAt : new Date(0).toISOString(),
		catalogHash: "",
		runtime: {
			verifyHashes: true,
			requestTimeoutMs: 30_000,
			maxConcurrentRequests: 8,
			cacheMaxBytes: 256 * 1024 * 1024,
		},
		groups,
		portableBundles: [],
		typeTreeSummary: {
			enabled: false,
			schemaCount: 0,
			bundleCount: 0,
			structuredAssetCount: 0,
			sourceBytes: 0,
			bundleBytes: 0,
			registryBytes: 0,
			savedBytes: 0,
		},
	};
}

function validateCatalog(catalog: IAddressableCatalog): void {
	if (catalog.version !== ADDRESSABLES_CATALOG_VERSION || !catalog.buildId || !catalog.profileId || !Array.isArray(catalog.groups)) {
		throw new Error("Addressable catalog header is invalid.");
	}
	if (catalog.groups.length > 256) {
		throw new Error("Addressable catalog exceeds 256 groups.");
	}
	const addresses = new Set<string>();
	const assetsByAddress = new Map<string, IAddressableCatalogAsset>();
	const bundles = new Map((catalog.portableBundles ?? []).map((bundle) => [bundle.id, bundle]));
	if ((catalog.portableBundles?.length ?? 0) > 8_192 || bundles.size !== (catalog.portableBundles?.length ?? 0)) {
		throw new Error("Addressable catalog portable bundle references are invalid or duplicated.");
	}
	if (
		catalog.typeTreeRegistry &&
		(!/^zvttr-[a-f0-9]{64}$/.test(catalog.typeTreeRegistry.registryId) ||
			!catalog.typeTreeRegistry.internalId ||
			!Array.isArray(catalog.typeTreeRegistry.loadPaths) ||
			!catalog.typeTreeRegistry.loadPaths.length ||
			catalog.typeTreeRegistry.loadPaths.length > 256 ||
			catalog.typeTreeRegistry.loadPaths.some((loadPath) => typeof loadPath !== "string" || !loadPath.length || loadPath.length > 2_048) ||
			!Number.isSafeInteger(catalog.typeTreeRegistry.sizeBytes) ||
			catalog.typeTreeRegistry.sizeBytes <= 0 ||
			catalog.typeTreeRegistry.sizeBytes > 16 * 1024 * 1024 ||
			!/^[a-f0-9]{64}$/.test(catalog.typeTreeRegistry.hash) ||
			!Number.isSafeInteger(catalog.typeTreeRegistry.schemaCount) ||
			catalog.typeTreeRegistry.schemaCount < 1)
	) {
		throw new Error("Addressable catalog TypeTree registry reference is invalid.");
	}
	for (const bundle of bundles.values()) {
		if (
			!/^zvpb-[a-f0-9]{64}$/.test(bundle.id) ||
			!bundle.internalId ||
			!Number.isSafeInteger(bundle.sizeBytes) ||
			bundle.sizeBytes <= 0 ||
			bundle.sizeBytes > 64 * 1024 * 1024 ||
			!/^[a-f0-9]{64}$/.test(bundle.hash) ||
			!Array.isArray(bundle.addresses) ||
			!bundle.addresses.length ||
			bundle.addresses.length > 4_096
		) {
			throw new Error(`Addressable catalog portable bundle reference is invalid: ${bundle.id}`);
		}
	}
	if (catalog.typeTreeSummary) {
		const values = [
			catalog.typeTreeSummary.schemaCount,
			catalog.typeTreeSummary.bundleCount,
			catalog.typeTreeSummary.structuredAssetCount,
			catalog.typeTreeSummary.sourceBytes,
			catalog.typeTreeSummary.bundleBytes,
			catalog.typeTreeSummary.registryBytes,
			catalog.typeTreeSummary.savedBytes,
		];
		if (typeof catalog.typeTreeSummary.enabled !== "boolean" || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
			throw new Error("Addressable catalog TypeTree summary is invalid.");
		}
	}
	let count = 0;
	for (const group of catalog.groups) {
		if (!group.id || !group.name || !Array.isArray(group.assets) || group.assets.length > 4096) {
			throw new Error(`Addressable catalog group is invalid: ${group.name || group.id}`);
		}
		for (const asset of group.assets) {
			count++;
			if (
				count > 8192 ||
				!asset.path ||
				!asset.address ||
				!asset.internalId ||
				!/^[a-f0-9]{64}$/.test(asset.hash) ||
				!Number.isSafeInteger(asset.sizeBytes) ||
				asset.sizeBytes < 0
			) {
				throw new Error(`Addressable catalog asset is invalid: ${asset.address || asset.path}`);
			}
			if (addresses.has(asset.address)) {
				throw new Error(`Addressable catalog address is duplicated: ${asset.address}`);
			}
			addresses.add(asset.address);
			assetsByAddress.set(asset.address, asset);
			if ((asset.portableBundleId || asset.typeTreeSchemaId) && (!asset.portableBundleId || !asset.typeTreeSchemaId || !bundles.has(asset.portableBundleId))) {
				throw new Error(`Addressable portable asset reference is incomplete: ${asset.address}`);
			}
			if (asset.typeTreeSchemaId && !/^zvtts-[a-f0-9]{64}$/.test(asset.typeTreeSchemaId)) {
				throw new Error(`Addressable TypeTree schema id is invalid: ${asset.address}`);
			}
		}
	}
	const referencedPortableAddresses = new Set<string>();
	for (const bundle of bundles.values()) {
		let previous = "";
		for (const address of bundle.addresses) {
			if (typeof address !== "string" || address <= previous || !addresses.has(address) || referencedPortableAddresses.has(address)) {
				throw new Error(`Addressable portable bundle addresses are not uniquely sorted or addressable: ${bundle.id}`);
			}
			referencedPortableAddresses.add(address);
			previous = address;
			const asset = assetsByAddress.get(address);
			if (asset?.portableBundleId !== bundle.id) {
				throw new Error(`Addressable portable bundle membership does not match asset ${address}.`);
			}
		}
	}
	for (const [address, asset] of assetsByAddress) {
		if (asset.portableBundleId && !referencedPortableAddresses.has(address)) {
			throw new Error(`Addressable portable asset is missing from bundle ${asset.portableBundleId}: ${address}`);
		}
	}
	if (bundles.size && !catalog.typeTreeRegistry) {
		throw new Error("Addressable portable bundles require a shared TypeTree registry.");
	}
}

/** In-memory bounded LRU cache shared by all catalog downloads in one runtime. */
export class AddressableMemoryCache {
	private _entries = new Map<string, IAddressableCacheEntry>();
	private _sizeBytes = 0;
	private _clock = 0;
	private _hits = 0;
	private _misses = 0;
	private _evictions = 0;

	public constructor(public readonly maxBytes = 256 * 1024 * 1024) {}

	public has(hash: string): boolean {
		return this._entries.has(hash);
	}

	public get(hash: string): ArrayBuffer | undefined {
		const result = this._entries.get(hash);
		if (!result) {
			this._misses++;
			return undefined;
		}
		this._hits++;
		result.lastAccess = ++this._clock;
		return result.bytes.slice(0);
	}

	public set(hash: string, bytes: ArrayBuffer): void {
		if (!this.maxBytes || bytes.byteLength > this.maxBytes) {
			return;
		}
		this.delete(hash);
		this._entries.set(hash, { bytes: bytes.slice(0), sizeBytes: bytes.byteLength, lastAccess: ++this._clock });
		this._sizeBytes += bytes.byteLength;
		while (this._sizeBytes > this.maxBytes && this._entries.size) {
			const oldest = [...this._entries.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess)[0];
			this.delete(oldest[0]);
			this._evictions++;
		}
	}

	public delete(hash: string): boolean {
		const result = this._entries.get(hash);
		if (!result) {
			return false;
		}
		this._sizeBytes -= result.sizeBytes;
		return this._entries.delete(hash);
	}

	public clear(hashes?: string[]): number {
		if (!hashes) {
			const count = this._entries.size;
			this._entries.clear();
			this._sizeBytes = 0;
			return count;
		}
		return [...new Set(hashes)].reduce((count, hash) => count + Number(this.delete(hash)), 0);
	}

	public getStatus(): IAddressableCacheStatus {
		return { entryCount: this._entries.size, sizeBytes: this._sizeBytes, maxBytes: this.maxBytes, hits: this._hits, misses: this._misses, evictions: this._evictions };
	}
}

/** Resolves, updates, caches, and hash-verifies files assigned to editor Addressable groups. */
export class AddressableCatalog {
	private _catalog: IAddressableCatalog;
	private _fetch: typeof fetch;
	private _cache: AddressableMemoryCache;
	private _verifyHashes: boolean;
	private _requestTimeoutMs: number;
	private _maxConcurrentRequests: number;
	private _inFlight = new Map<string, Promise<ArrayBuffer>>();
	private _portableBundleInFlight = new Map<string, Promise<Map<string, ArrayBuffer>>>();
	private _typeTreeSchemasPromise?: Promise<Map<string, IAddressableTypeTreeSchema>>;
	private _catalogGeneration = 0;
	private _lastCatalogCheckAt?: string;
	private _lastCatalogUpdateAt?: string;
	private _lastError?: string;

	public constructor(
		private _rootUrl: string,
		catalog: IAddressableCatalog,
		options: IAddressableRuntimeOptions = {}
	) {
		this._catalog = normalizeCatalog(catalog, _rootUrl);
		this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this._cache = options.cache ?? new AddressableMemoryCache(options.cacheMaxBytes ?? this._catalog.runtime.cacheMaxBytes);
		this._verifyHashes = options.verifyHashes ?? this._catalog.runtime.verifyHashes;
		this._requestTimeoutMs = Math.min(120_000, Math.max(1_000, Math.round(options.requestTimeoutMs ?? this._catalog.runtime.requestTimeoutMs)));
		this._maxConcurrentRequests = Math.min(32, Math.max(1, Math.round(options.maxConcurrentRequests ?? this._catalog.runtime.maxConcurrentRequests)));
	}

	public getGroups(): IAddressableCatalogGroup[] {
		return structuredClone(this._catalog.groups);
	}

	public getAsset(groupName: string, assetPathOrAddress: string): IAddressableCatalogAsset | undefined {
		return this._catalog.groups
			.find((group) => group.name === groupName || group.id === groupName)
			?.assets.find((asset) => asset.path === assetPathOrAddress || asset.address === assetPathOrAddress);
	}

	public getAssetByAddress(address: string): { group: IAddressableCatalogGroup; asset: IAddressableCatalogAsset } | undefined {
		for (const group of this._catalog.groups) {
			const asset = group.assets.find((candidate) => candidate.address === address);
			if (asset) {
				return { group, asset };
			}
		}
		return undefined;
	}

	public getAssetUrl(groupName: string, assetPathOrAddress: string): string | undefined {
		const group = this._catalog.groups.find((candidate) => candidate.name === groupName || candidate.id === groupName);
		const asset = group?.assets.find((candidate) => candidate.path === assetPathOrAddress || candidate.address === assetPathOrAddress);
		return group && asset ? resolveUrl(resolveUrl(this._rootUrl, group.loadPath || "./"), asset.internalId) : undefined;
	}

	public getAssetsByLabels(labels: string[], match: "all" | "any" = "all"): { group: IAddressableCatalogGroup; asset: IAddressableCatalogAsset }[] {
		return this._select({ labels, match });
	}

	public getDownloadSize(query: IAddressableQuery = {}): number {
		const selected = this._select(query).filter(({ asset }) => !this._cache.has(asset.hash));
		const bundleIds = new Set(selected.flatMap(({ asset }) => (asset.portableBundleId ? [asset.portableBundleId] : [])));
		const bundleBytes = [...bundleIds].reduce((total, id) => total + (this._catalog.portableBundles?.find((bundle) => bundle.id === id)?.sizeBytes ?? 0), 0);
		const rawBytes = selected.reduce((total, { asset }) => total + (asset.portableBundleId ? 0 : asset.sizeBytes), 0);
		const registryBytes = bundleIds.size && !this._typeTreeSchemasPromise ? (this._catalog.typeTreeRegistry?.sizeBytes ?? 0) : 0;
		return rawBytes + bundleBytes + registryBytes;
	}

	public async downloadDependencies(query: IAddressableQuery = {}): Promise<IAddressableDownloadResult> {
		const selected = this._select(query);
		const expectedDownloadBytes = this.getDownloadSize(query);
		let cursor = 0;
		let downloadedCount = 0;
		let cachedCount = 0;
		let downloadedBytes = 0;
		const workers = Array.from({ length: Math.min(this._maxConcurrentRequests, Math.max(1, selected.length)) }, async (): Promise<void> => {
			while (cursor < selected.length) {
				const index = cursor++;
				const { group, asset } = selected[index];
				if (this._cache.has(asset.hash)) {
					cachedCount++;
					continue;
				}
				await this._load(group, asset, this._verifyHashes);
				downloadedCount++;
				downloadedBytes += asset.sizeBytes;
			}
		});
		await Promise.all(workers);
		return { assetCount: selected.length, downloadedCount, cachedCount, downloadedBytes: downloadedCount ? expectedDownloadBytes : downloadedBytes };
	}

	public clearDependencyCache(query?: IAddressableQuery): number {
		if (!query) {
			this._catalogGeneration++;
			this._portableBundleInFlight.clear();
			this._typeTreeSchemasPromise = undefined;
			return this._cache.clear();
		}
		return this._cache.clear(this._select(query).map(({ asset }) => asset.hash));
	}

	public async checkForCatalogUpdates(): Promise<IAddressableCatalogUpdate> {
		this._lastCatalogCheckAt = new Date().toISOString();
		const pointerUrl = this._catalog.remoteCatalog?.pointerUrl;
		if (!pointerUrl) {
			return { configured: false, available: false, currentBuildId: this._catalog.buildId };
		}
		try {
			const pointer = await this._readPointer(resolveUrl(this._rootUrl, pointerUrl));
			this._lastError = undefined;
			return {
				configured: true,
				available: pointer.buildId !== this._catalog.buildId || pointer.catalogHash !== this._catalog.catalogHash,
				currentBuildId: this._catalog.buildId,
				remoteBuildId: pointer.buildId,
				catalogHash: pointer.catalogHash,
				catalogUrl: pointer.catalogUrl,
			};
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	public async updateCatalog(): Promise<IAddressableCatalogUpdate> {
		const pointerUrl = this._catalog.remoteCatalog?.pointerUrl;
		if (!pointerUrl) {
			throw new Error("Remote Addressable catalog is not configured.");
		}
		try {
			const pointer = await this._readPointer(resolveUrl(this._rootUrl, pointerUrl));
			const resolvedPointerUrl = resolveUrl(this._rootUrl, pointerUrl);
			const catalogBytes = await this._requestArrayBuffer(resolveDocumentUrl(resolvedPointerUrl, pointer.catalogUrl));
			const catalogValue = JSON.parse(new TextDecoder().decode(catalogBytes)) as IAddressableCatalog;
			const semanticHash = await sha256(new TextEncoder().encode(getAddressableCatalogHashPayload(catalogValue)));
			const catalog = normalizeCatalog(catalogValue, this._rootUrl);
			if (semanticHash !== pointer.catalogHash || catalog.catalogHash !== pointer.catalogHash || catalog.buildId !== pointer.buildId) {
				throw new Error("Remote Addressable catalog hash or build identity does not match its publication pointer.");
			}
			if (pointer.hashUrl) {
				const hashText = new TextDecoder().decode(await this._requestArrayBuffer(resolveDocumentUrl(resolvedPointerUrl, pointer.hashUrl))).trim();
				if (hashText !== pointer.catalogHash) {
					throw new Error("Remote Addressable catalog hash file does not match its publication pointer.");
				}
			}
			this._catalog = catalog;
			this._catalogGeneration++;
			this._portableBundleInFlight.clear();
			this._typeTreeSchemasPromise = undefined;
			this._lastCatalogUpdateAt = new Date().toISOString();
			this._lastError = undefined;
			return {
				configured: true,
				available: false,
				currentBuildId: catalog.buildId,
				remoteBuildId: catalog.buildId,
				catalogHash: catalog.catalogHash,
				catalogUrl: pointer.catalogUrl,
			};
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	public async loadArrayBuffer(groupName: string, assetPathOrAddress: string, verifyHash = this._verifyHashes): Promise<ArrayBuffer> {
		const group = this._catalog.groups.find((candidate) => candidate.name === groupName || candidate.id === groupName);
		const asset = group?.assets.find((candidate) => candidate.path === assetPathOrAddress || candidate.address === assetPathOrAddress);
		if (!group || !asset) {
			throw new Error(`Addressable asset "${assetPathOrAddress}" was not found in group "${groupName}".`);
		}
		return this._load(group, asset, verifyHash);
	}

	public async loadAddress(address: string, verifyHash = this._verifyHashes): Promise<ArrayBuffer> {
		const result = this.getAssetByAddress(address);
		if (!result) {
			throw new Error(`Addressable asset was not found: ${address}`);
		}
		return this._load(result.group, result.asset, verifyHash);
	}

	public async loadText(groupName: string, assetPathOrAddress: string, verifyHash = this._verifyHashes): Promise<string> {
		return new TextDecoder().decode(await this.loadArrayBuffer(groupName, assetPathOrAddress, verifyHash));
	}

	public getRuntimeStatus(): IAddressableRuntimeStatus {
		return {
			buildId: this._catalog.buildId,
			buildType: this._catalog.buildType,
			profileId: this._catalog.profileId,
			catalogHash: this._catalog.catalogHash,
			groupCount: this._catalog.groups.length,
			assetCount: this._catalog.groups.reduce((total, group) => total + group.assets.length, 0),
			typeTreeSchemaCount: this._catalog.typeTreeSummary?.schemaCount ?? 0,
			portableBundleCount: this._catalog.typeTreeSummary?.bundleCount ?? 0,
			typeTreeSavedBytes: this._catalog.typeTreeSummary?.savedBytes ?? 0,
			remoteCatalogConfigured: Boolean(this._catalog.remoteCatalog?.pointerUrl),
			inFlightRequests: this._inFlight.size,
			cache: this._cache.getStatus(),
			lastCatalogCheckAt: this._lastCatalogCheckAt,
			lastCatalogUpdateAt: this._lastCatalogUpdateAt,
			lastError: this._lastError,
		};
	}

	private _select(query: IAddressableQuery): { group: IAddressableCatalogGroup; asset: IAddressableCatalogAsset }[] {
		const groupNames = new Set(query.groupNames ?? []);
		const addresses = new Set(query.addresses ?? []);
		const labels = [...new Set((query.labels ?? []).filter((label) => label.trim()))];
		const match = query.match ?? "all";
		return this._catalog.groups.flatMap((group) => {
			if (groupNames.size && !groupNames.has(group.id) && !groupNames.has(group.name)) {
				return [];
			}
			return group.assets
				.filter((asset) => !addresses.size || addresses.has(asset.address))
				.filter(
					(asset) => !labels.length || (match === "all" ? labels.every((label) => asset.labels.includes(label)) : labels.some((label) => asset.labels.includes(label)))
				)
				.map((asset) => ({ group, asset }));
		});
	}

	private async _load(group: IAddressableCatalogGroup, asset: IAddressableCatalogAsset, verifyHash: boolean): Promise<ArrayBuffer> {
		const cached = this._cache.get(asset.hash);
		if (cached) {
			return cached;
		}
		const existing = this._inFlight.get(asset.hash);
		if (existing) {
			return (await existing).slice(0);
		}
		const request = (async (): Promise<ArrayBuffer> => {
			const bytes = asset.portableBundleId
				? await this._loadPortableBundleEntry(group, asset)
				: await this._requestArrayBuffer(resolveUrl(resolveUrl(this._rootUrl, group.loadPath || "./"), asset.internalId));
			if (bytes.byteLength !== asset.sizeBytes) {
				throw new Error(`Addressable asset "${asset.address}" size does not match its catalog.`);
			}
			if (verifyHash && (await sha256(bytes)) !== asset.hash) {
				throw new Error(`Addressable asset "${asset.address}" failed SHA-256 verification.`);
			}
			this._cache.set(asset.hash, bytes);
			return bytes;
		})();
		this._inFlight.set(asset.hash, request);
		try {
			return (await request).slice(0);
		} finally {
			this._inFlight.delete(asset.hash);
		}
	}

	/** Loads and verifies one shared registry, trying its bounded local/remote locations in order. */
	private async _loadTypeTreeSchemas(): Promise<Map<string, IAddressableTypeTreeSchema>> {
		if (this._typeTreeSchemasPromise) {
			return this._typeTreeSchemasPromise;
		}
		const reference = this._catalog.typeTreeRegistry;
		if (!reference) {
			throw new Error("Addressable portable bundle requires a TypeTree registry, but the catalog has none.");
		}
		const request = (async (): Promise<Map<string, IAddressableTypeTreeSchema>> => {
			let lastError: unknown;
			for (const loadPath of reference.loadPaths) {
				try {
					const bytes = await this._requestArrayBuffer(resolveUrl(resolveUrl(this._rootUrl, loadPath), reference.internalId));
					if (bytes.byteLength !== reference.sizeBytes || (this._verifyHashes && (await sha256(bytes)) !== reference.hash)) {
						throw new Error("TypeTree registry size or SHA-256 does not match its catalog reference.");
					}
					const registry = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as IAddressableTypeTreeRegistry;
					const schemas = await validateAddressableTypeTreeRegistry(registry);
					if (registry.id !== reference.registryId || schemas.size !== reference.schemaCount) {
						throw new Error("TypeTree registry identity or schema count does not match its catalog reference.");
					}
					return schemas;
				} catch (error) {
					lastError = error;
				}
			}
			throw new Error(`Addressable TypeTree registry could not be loaded from any catalog location: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
		})();
		this._typeTreeSchemasPromise = request;
		try {
			return await request;
		} catch (error) {
			this._typeTreeSchemasPromise = undefined;
			throw error;
		}
	}

	/** Decodes a bundle once per concurrent request wave and seeds all verified entries into the bounded LRU. */
	private async _loadPortableBundleEntry(group: IAddressableCatalogGroup, asset: IAddressableCatalogAsset): Promise<ArrayBuffer> {
		const bundleId = asset.portableBundleId;
		const reference = this._catalog.portableBundles?.find((bundle) => bundle.id === bundleId);
		if (!bundleId || !reference) {
			throw new Error(`Addressable portable bundle reference was not found for ${asset.address}.`);
		}
		let request = this._portableBundleInFlight.get(bundleId);
		if (!request) {
			const generation = this._catalogGeneration;
			request = (async (): Promise<Map<string, ArrayBuffer>> => {
				const [schemas, bytes] = await Promise.all([
					this._loadTypeTreeSchemas(),
					this._requestArrayBuffer(resolveUrl(resolveUrl(this._rootUrl, group.loadPath || "./"), reference.internalId)),
				]);
				if (bytes.byteLength !== reference.sizeBytes || (this._verifyHashes && (await sha256(bytes)) !== reference.hash)) {
					throw new Error(`Addressable portable bundle ${bundleId} failed size or SHA-256 verification.`);
				}
				const parsed = await parseAddressablePortableBundle(bytes, schemas);
				if (parsed.bundle.id !== bundleId || parsed.entries.size !== reference.addresses.length) {
					throw new Error(`Addressable portable bundle ${bundleId} does not match its catalog reference.`);
				}
				if (generation !== this._catalogGeneration) {
					throw new Error(`Addressable catalog changed while portable bundle ${bundleId} was loading; retry the asset request.`);
				}
				const decodedBytes = new Map<string, ArrayBuffer>();
				for (const [address, decoded] of parsed.entries) {
					const catalogAsset = this.getAssetByAddress(address)?.asset;
					if (
						!catalogAsset ||
						catalogAsset.portableBundleId !== bundleId ||
						catalogAsset.typeTreeSchemaId !== decoded.entry.schemaId ||
						catalogAsset.hash !== decoded.entry.hash ||
						catalogAsset.sizeBytes !== decoded.entry.sizeBytes
					) {
						throw new Error(`Addressable portable bundle entry does not match the catalog: ${address}`);
					}
					decodedBytes.set(address, decoded.bytes);
					this._cache.set(catalogAsset.hash, decoded.bytes);
				}
				return decodedBytes;
			})();
			this._portableBundleInFlight.set(bundleId, request);
		}
		try {
			const decodedBytes = await request;
			const result = this._cache.get(asset.hash) ?? decodedBytes.get(asset.address);
			if (!result) {
				throw new Error(`Addressable portable bundle did not produce entry ${asset.address}.`);
			}
			return result;
		} finally {
			this._portableBundleInFlight.delete(bundleId);
		}
	}

	private async _requestArrayBuffer(url: string): Promise<ArrayBuffer> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this._requestTimeoutMs);
		try {
			const response = await this._fetch(url, { signal: controller.signal });
			if (!response.ok) {
				throw new Error(`Addressable request failed for ${url}: ${response.status} ${response.statusText}`);
			}
			return response.arrayBuffer();
		} finally {
			clearTimeout(timeout);
		}
	}

	private async _readPointer(url: string): Promise<IAddressableCatalogPointer> {
		const value = JSON.parse(new TextDecoder().decode(await this._requestArrayBuffer(url))) as Partial<IAddressableCatalogPointer>;
		if (value.version !== 1 || !value.buildId || !value.catalogHash || !value.catalogUrl || !/^[a-f0-9]{64}$/.test(value.catalogHash)) {
			throw new Error("Remote Addressable publication pointer is invalid.");
		}
		return value as IAddressableCatalogPointer;
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		addressables?: AddressableCatalog;
	}
}

export function configureAddressables(scene: Scene, rootUrl: string): void {
	const catalog = scene.metadata?.babylonEditorAddressables as IAddressableCatalog | undefined;
	if (catalog?.groups) {
		scene.addressables = new AddressableCatalog(rootUrl, catalog);
	}
}
