import { createHash } from "crypto";
import { extname } from "path/posix";
import { readFile } from "fs-extra";

import {
	createAddressablePortableBundle,
	createAddressableTypeTreeRegistry,
	extractAddressableTypeTreeSchema,
	IAddressableCatalog,
	IAddressableCatalogGroup,
	IAddressablePortableBundleReference,
	IAddressableProjectConfiguration,
	IAddressableTypeTreeBuildSummary,
	serializeAddressablePortableBundle,
} from "babylonjs-editor-tools";

interface IPortableSource {
	group: IAddressableCatalogGroup;
	address: string;
	sourcePath: string;
	sourceBytes: number;
	value: unknown;
	schema: Awaited<ReturnType<typeof extractAddressableTypeTreeSchema>>;
}

export interface IAddressablePortableBuildArtifact {
	kind: "type-tree-registry" | "portable-bundle";
	internalId: string;
	bytes: Buffer;
	hash: string;
	deliveries: Array<"local" | "remote">;
	addresses: string[];
}

export interface IAddressablePortableBuildPlan {
	artifacts: IAddressablePortableBuildArtifact[];
	portableAddresses: Set<string>;
	summary: IAddressableTypeTreeBuildSummary;
}

const maximumStructuredAssetBytes = 16 * 1024 * 1024;
const maximumBundleSourceBytes = 32 * 1024 * 1024;
const maximumRegistryBytes = 16 * 1024 * 1024;

function hash(bytes: Buffer | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function chunks(sources: IPortableSource[], mode: "pack-together" | "pack-separately"): IPortableSource[][] {
	if (mode === "pack-separately") {
		return sources.map((source) => [source]);
	}
	const result: IPortableSource[][] = [];
	let current: IPortableSource[] = [];
	let currentBytes = 0;
	for (const source of sources) {
		if (current.length && (currentBytes + source.sourceBytes > maximumBundleSourceBytes || current.length >= 2_048)) {
			result.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(source);
		currentBytes += source.sourceBytes;
	}
	if (current.length) {
		result.push(current);
	}
	return result;
}

async function inspectSource(group: IAddressableCatalogGroup, address: string, sourcePath: string): Promise<IPortableSource | null> {
	if (extname(sourcePath).toLowerCase() !== ".json") {
		return null;
	}
	const bytes = await readFile(sourcePath);
	if (!bytes.byteLength || bytes.byteLength > maximumStructuredAssetBytes) {
		return null;
	}
	try {
		const value = JSON.parse(bytes.toString("utf8")) as unknown;
		if (!value || typeof value !== "object") {
			return null;
		}
		return { group, address, sourcePath, sourceBytes: bytes.byteLength, value, schema: await extractAddressableTypeTreeSchema(value) };
	} catch {
		return null;
	}
}

/** Builds an all-or-nothing extraction plan so enabling the feature can never increase emitted content size. */
export async function createAddressablePortableBuildPlan(
	catalog: IAddressableCatalog,
	configuration: IAddressableProjectConfiguration,
	sources: Array<{ groupId: string; address: string; sourcePath: string }>
): Promise<IAddressablePortableBuildPlan> {
	const disabled: IAddressableTypeTreeBuildSummary = {
		enabled: false,
		schemaCount: 0,
		bundleCount: 0,
		structuredAssetCount: 0,
		sourceBytes: 0,
		bundleBytes: 0,
		registryBytes: 0,
		savedBytes: 0,
	};
	if (!configuration.settings.extractTypeTrees) {
		catalog.portableBundles = [];
		catalog.typeTreeSummary = disabled;
		return { artifacts: [], portableAddresses: new Set(), summary: disabled };
	}
	const groups = new Map(catalog.groups.map((group) => [group.id, group]));
	const inspected = (
		await Promise.all(
			sources.map((source) => {
				const group = groups.get(source.groupId);
				return group ? inspectSource(group, source.address, source.sourcePath) : Promise.resolve(null);
			})
		)
	).filter((source): source is IPortableSource => source !== null);
	if (!inspected.length) {
		catalog.portableBundles = [];
		catalog.typeTreeSummary = disabled;
		return { artifacts: [], portableAddresses: new Set(), summary: disabled };
	}
	const registry = await createAddressableTypeTreeRegistry(inspected.map((source) => source.schema));
	const registryBytes = Buffer.from(`${JSON.stringify(registry)}\n`);
	if (registryBytes.byteLength > maximumRegistryBytes) {
		catalog.portableBundles = [];
		catalog.typeTreeSummary = disabled;
		return { artifacts: [], portableAddresses: new Set(), summary: disabled };
	}
	const artifacts: IAddressablePortableBuildArtifact[] = [];
	const references: IAddressablePortableBundleReference[] = [];
	const portableEntries = new Map<string, { internalId: string; bundleId: string; schemaId: string; sizeBytes: number; hash: string }>();
	for (const group of catalog.groups) {
		const authored = configuration.groups.find((candidate) => candidate.id === group.id);
		const groupSources = inspected.filter((source) => source.group.id === group.id).sort((left, right) => left.address.localeCompare(right.address));
		for (const chunk of chunks(groupSources, authored?.bundleMode ?? "pack-separately")) {
			const bundle = await createAddressablePortableBundle(chunk.map((source) => ({ address: source.address, value: source.value, schema: source.schema })));
			const bytes = Buffer.from(serializeAddressablePortableBundle(bundle));
			const internalId = `bundles/${bundle.id}.bundle.json`;
			const reference = { id: bundle.id, internalId, sizeBytes: bytes.byteLength, hash: hash(bytes), addresses: chunk.map((source) => source.address) };
			references.push(reference);
			artifacts.push({ kind: "portable-bundle", internalId, bytes, hash: reference.hash, deliveries: [group.delivery], addresses: reference.addresses });
			for (const source of chunk) {
				const entry = bundle.entries.find((candidate) => candidate.address === source.address);
				if (entry) {
					portableEntries.set(source.address, { internalId, bundleId: bundle.id, schemaId: entry.schemaId, sizeBytes: entry.sizeBytes, hash: entry.hash });
				}
			}
		}
	}
	const bundleBytes = artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
	const sourceBytes = inspected.reduce((total, source) => total + source.sourceBytes, 0);
	const emittedBytes = registryBytes.byteLength + bundleBytes;
	if (emittedBytes >= sourceBytes) {
		catalog.portableBundles = [];
		catalog.typeTreeSummary = disabled;
		return { artifacts: [], portableAddresses: new Set(), summary: disabled };
	}
	const registryInternalId = `type-trees/${registry.id}.registry.json`;
	const deliveries = [...new Set(inspected.map((source) => source.group.delivery))];
	artifacts.unshift({ kind: "type-tree-registry", internalId: registryInternalId, bytes: registryBytes, hash: hash(registryBytes), deliveries, addresses: [] });
	for (const group of catalog.groups) {
		for (const asset of group.assets) {
			const portable = portableEntries.get(asset.address);
			if (portable) {
				asset.internalId = portable.internalId;
				asset.sizeBytes = portable.sizeBytes;
				asset.hash = portable.hash;
				asset.portableBundleId = portable.bundleId;
				asset.typeTreeSchemaId = portable.schemaId;
			}
		}
	}
	catalog.typeTreeRegistry = {
		registryId: registry.id,
		internalId: registryInternalId,
		loadPaths: [...new Set(inspected.map((source) => source.group.loadPath))].sort(),
		sizeBytes: registryBytes.byteLength,
		hash: hash(registryBytes),
		schemaCount: registry.schemas.length,
	};
	catalog.portableBundles = references.sort((left, right) => left.id.localeCompare(right.id));
	const summary: IAddressableTypeTreeBuildSummary = {
		enabled: true,
		schemaCount: registry.schemas.length,
		bundleCount: references.length,
		structuredAssetCount: inspected.length,
		sourceBytes,
		bundleBytes,
		registryBytes: registryBytes.byteLength,
		savedBytes: sourceBytes - emittedBytes,
	};
	catalog.typeTreeSummary = summary;
	return { artifacts, portableAddresses: new Set(inspected.map((source) => source.address)), summary };
}
