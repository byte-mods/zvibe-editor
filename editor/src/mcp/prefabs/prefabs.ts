import { createHash } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { ensureDir, pathExists, readJSON, writeJSON } from "fs-extra";

import { AbstractMesh, Mesh, Scene, SceneLoader, SceneSerializer, Tools } from "babylonjs";

import { projectConfiguration } from "../../project/configuration";
import { isMesh } from "../../tools/guards/nodes";
import { UniqueNumber } from "../../tools/tools";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return dirname(projectConfiguration.path);
}

function resolvePrefabPath(path: string): string {
	const directory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) {
		throw new Error("Prefab paths must stay inside the open project directory.");
	}
	if (!absolutePath.endsWith(".prefab")) {
		throw new Error("Prefab paths must end in .prefab.");
	}

	return absolutePath;
}

const prefabPropertyNames = ["name", "position", "rotation", "scaling", "visibility", "isVisible"] as const;
const maximumVariantDepth = 16;
const maximumPropertyOverrideBytes = 64 * 1024;
const maximumSerializedMeshBytes = 2 * 1024 * 1024;
const forbiddenPropertySegments = new Set(["__proto__", "prototype", "constructor"]);
const reservedPropertyRoots = new Set(["id", "uniqueId", "parentId", ...prefabPropertyNames]);

interface IPrefabPropertyOverride {
	nodeName: string;
	path: string;
	value: any;
}

interface IPrefabStructuralAddition {
	nodeName: string;
	displayName: string;
	parentNodeName: string | null;
	kind: "transform" | "cloneMesh" | "nestedPrefab" | "mesh";
	cloneSourceNodeName?: string;
	prefabPath?: string;
	serializedMesh?: any;
	properties: any;
}

interface IPrefabStructuralOverrides {
	removals: string[];
	additions: IPrefabStructuralAddition[];
	reparents: { nodeName: string; parentNodeName: string | null }[];
}

interface IPrefabComponentOverrides {
	additions: { nodeName: string; componentKey: string; value: any }[];
	removals: { nodeName: string; componentKey: string }[];
}

interface IPrefabLink {
	path: string;
	sourceNodeName: string;
	boundarySourceNodeName?: string;
}

interface IPrefabVariantResolution {
	document: any;
	path: string;
	variant: boolean;
	basePath: string | null;
	baseRevision: string | null;
	storedBaseRevision: string | null;
	stale: boolean;
	conflicts: {
		code:
			| "missingNode"
			| "ambiguousNode"
			| "missingProperty"
			| "structuralMissingNode"
			| "structuralAmbiguousNode"
			| "structuralMissingParent"
			| "structuralCycle"
			| "nestedPrefabConflict"
			| "componentMissingNode"
			| "componentAmbiguousNode"
			| "componentAlreadyExists"
			| "componentMissing";
		nodeName: string;
		path?: string;
		message: string;
	}[];
	chain: string[];
}

function prefabRevision(document: any): string {
	return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function validatePrefabProperties(value: unknown, field = "properties"): any {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must be an object containing supported prefab properties.`);
	}
	const source = value as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		if (!(prefabPropertyNames as readonly string[]).includes(key)) {
			throw new Error(`${field}.${key} is not supported. Use name, position, rotation, scaling, visibility, or isVisible.`);
		}
	}
	for (const key of ["position", "rotation", "scaling"] as const) {
		const vector = source[key];
		if (vector !== undefined && (!Array.isArray(vector) || vector.length !== 3 || vector.some((component) => typeof component !== "number" || !Number.isFinite(component)))) {
			throw new Error(`${field}.${key} must contain exactly three finite numbers.`);
		}
	}
	if (source.name !== undefined && (typeof source.name !== "string" || !source.name.trim() || source.name.length > 256 || /[\r\n\0]/.test(source.name))) {
		throw new Error(`${field}.name must be 1–256 characters without control line breaks.`);
	}
	if (source.visibility !== undefined && (typeof source.visibility !== "number" || !Number.isFinite(source.visibility) || source.visibility < 0 || source.visibility > 1)) {
		throw new Error(`${field}.visibility must be a finite number from 0 through 1.`);
	}
	if (source.isVisible !== undefined && typeof source.isVisible !== "boolean") {
		throw new Error(`${field}.isVisible must be a boolean.`);
	}
	return Object.fromEntries(prefabPropertyNames.filter((key) => source[key] !== undefined).map((key) => [key, structuredClone(source[key])]));
}

function serializedPrefabNodes(document: any): any[] {
	return [...(Array.isArray(document?.meshes) ? document.meshes : []), ...(Array.isArray(document?.transformNodes) ? document.transformNodes : [])];
}

function markPrefabSourceIdentities(document: any): void {
	for (const node of serializedPrefabNodes(document)) {
		node.metadata ??= {};
		node.metadata.babylonEditorPrefabSourceNodeName ??= node.name;
	}
}

function findSerializedPrefabNodes(document: any, sourceNodeName: string): any[] {
	return serializedPrefabNodes(document).filter(
		(node) => node.metadata?.babylonEditorPrefabSourceNodeName === sourceNodeName || (!node.metadata?.babylonEditorPrefabSourceNodeName && node.name === sourceNodeName)
	);
}

function validateVariantNodeOverrides(value: unknown): { nodeName: string; properties: any }[] {
	if (!Array.isArray(value) || value.length > 512) {
		throw new Error("nodeOverrides must contain at most 512 source-node overrides.");
	}
	const overrides = value.map((override: any, index: number) => {
		if (!override || typeof override.nodeName !== "string" || !override.nodeName || override.nodeName.length > 256 || /[\r\n\0]/.test(override.nodeName)) {
			throw new Error(`nodeOverrides[${index}].nodeName must be a non-empty source node name of at most 256 characters.`);
		}
		return { nodeName: override.nodeName, properties: validatePrefabProperties(override.properties ?? {}, `nodeOverrides[${index}].properties`) };
	});
	if (new Set(overrides.map((override) => override.nodeName)).size !== overrides.length) {
		throw new Error("nodeOverrides must not contain duplicate source node names.");
	}
	return overrides;
}

function parsePropertyPointer(value: unknown, field = "path"): string[] {
	if (typeof value !== "string" || !value.startsWith("/") || value.length > 512) {
		throw new Error(`${field} must be a JSON Pointer of 1–512 characters beginning with /.`);
	}
	const encoded = value.slice(1).split("/");
	if (!encoded.length || encoded.length > 32) {
		throw new Error(`${field} must contain between 1 and 32 path segments.`);
	}
	const segments = encoded.map((segment) => {
		if (/~(?![01])/u.test(segment)) {
			throw new Error(`${field} contains an invalid JSON Pointer escape.`);
		}
		return segment.replace(/~1/g, "/").replace(/~0/g, "~");
	});
	if (segments.some((segment) => !segment || forbiddenPropertySegments.has(segment))) {
		throw new Error(`${field} contains an empty or unsafe property segment.`);
	}
	if (reservedPropertyRoots.has(segments[0])) {
		throw new Error(`${field} targets a reserved identity, structure, or standard prefab property.`);
	}
	if (segments[0] === "metadata" && (segments.length === 1 || segments[1] === "babylonEditorPrefabSourceNodeName")) {
		throw new Error(`${field} cannot change stable prefab source identity metadata.`);
	}
	return segments;
}

function validatePropertyValue(value: unknown, field = "value"): any {
	const inspect = (entry: any): void => {
		if (typeof entry === "number" && !Number.isFinite(entry)) {
			throw new Error(`${field} must not contain non-finite numbers.`);
		}
		if (entry && typeof entry === "object") {
			for (const [key, child] of Object.entries(entry)) {
				if (forbiddenPropertySegments.has(key)) {
					throw new Error(`${field} contains an unsafe object key.`);
				}
				inspect(child);
			}
		}
	};
	inspect(value);
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error(`${field} must be JSON-serializable.`);
	}
	if (serialized === undefined || serialized.length > maximumPropertyOverrideBytes) {
		throw new Error(`${field} must be JSON-serializable and no larger than ${maximumPropertyOverrideBytes} bytes.`);
	}
	const clone = JSON.parse(serialized);
	return clone;
}

function validatePropertyOverrides(value: unknown): IPrefabPropertyOverride[] {
	if (!Array.isArray(value) || value.length > 512) {
		throw new Error("propertyOverrides must contain at most 512 serialized property overrides.");
	}
	const overrides = value.map((override: any, index: number) => {
		if (!override || typeof override.nodeName !== "string" || !override.nodeName || override.nodeName.length > 256 || /[\r\n\0]/.test(override.nodeName)) {
			throw new Error(`propertyOverrides[${index}].nodeName must be a non-empty source node name of at most 256 characters.`);
		}
		parsePropertyPointer(override.path, `propertyOverrides[${index}].path`);
		return { nodeName: override.nodeName, path: override.path, value: validatePropertyValue(override.value, `propertyOverrides[${index}].value`) };
	});
	if (new Set(overrides.map((override) => `${override.nodeName}\0${override.path}`)).size !== overrides.length) {
		throw new Error("propertyOverrides must not contain duplicate source-node and path pairs.");
	}
	return overrides;
}

function getPropertyAtPointer(target: any, path: string): { parent: any; key: string; value: any } {
	const segments = parsePropertyPointer(path);
	let parent = target;
	for (const segment of segments.slice(0, -1)) {
		if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, segment)) {
			throw new Error(`Serialized property path "${path}" does not exist.`);
		}
		parent = parent[segment];
	}
	const key = segments[segments.length - 1];
	if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) {
		throw new Error(`Serialized property path "${path}" does not exist.`);
	}
	return { parent, key, value: parent[key] };
}

function applyPropertyOverride(target: any, override: IPrefabPropertyOverride): void {
	const property = getPropertyAtPointer(target, override.path);
	property.parent[property.key] = structuredClone(override.value);
}

function validateSourceNodeName(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 256 || /[\r\n\0]/.test(value)) {
		throw new Error("sourceNodeName must be a non-empty stable prefab source name of at most 256 characters.");
	}
	return value;
}

function validateStructuralOverrides(value: unknown): IPrefabStructuralOverrides {
	if (value === undefined || value === null) {
		return { removals: [], additions: [], reparents: [] };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("structuralOverrides must be an object containing removals, additions, and reparents.");
	}
	const source = value as any;
	if (!Array.isArray(source.removals ?? []) || source.removals?.length > 512) {
		throw new Error("structuralOverrides.removals must contain at most 512 stable source node names.");
	}
	const removals = (source.removals ?? []).map((nodeName: unknown) => validateSourceNodeName(nodeName));
	if (new Set(removals).size !== removals.length) {
		throw new Error("structuralOverrides.removals must not contain duplicate source node names.");
	}
	if (!Array.isArray(source.additions ?? []) || source.additions?.length > 256) {
		throw new Error("structuralOverrides.additions must contain at most 256 added nodes.");
	}
	const additions = (source.additions ?? []).map((addition: any, index: number): IPrefabStructuralAddition => {
		const nodeName = validateSourceNodeName(addition?.nodeName);
		if (typeof addition?.displayName !== "string" || !addition.displayName.trim() || addition.displayName.length > 256 || /[\r\n\0]/.test(addition.displayName)) {
			throw new Error(`structuralOverrides.additions[${index}].displayName must be 1–256 characters without control line breaks.`);
		}
		const parentNodeName = addition.parentNodeName === null ? null : validateSourceNodeName(addition.parentNodeName);
		if (addition.kind !== "transform" && addition.kind !== "cloneMesh" && addition.kind !== "nestedPrefab" && addition.kind !== "mesh") {
			throw new Error(`structuralOverrides.additions[${index}].kind must be transform, cloneMesh, nestedPrefab, or mesh.`);
		}
		const cloneSourceNodeName = addition.kind === "cloneMesh" ? validateSourceNodeName(addition.cloneSourceNodeName) : undefined;
		const prefabPath = addition.kind === "nestedPrefab" ? addition.prefabPath : undefined;
		if (addition.kind === "nestedPrefab" && (typeof prefabPath !== "string" || !prefabPath.endsWith(".prefab") || prefabPath.length > 512 || /[\r\n\0]/.test(prefabPath))) {
			throw new Error(`structuralOverrides.additions[${index}].prefabPath must be a contained .prefab path of at most 512 characters.`);
		}
		let serializedMesh: any;
		if (addition.kind === "mesh") {
			if (!addition.serializedMesh || typeof addition.serializedMesh !== "object" || Array.isArray(addition.serializedMesh)) {
				throw new Error(`structuralOverrides.additions[${index}].serializedMesh must contain one bounded serialized Babylon mesh.`);
			}
			const encoded = JSON.stringify(addition.serializedMesh);
			if (encoded.length > maximumSerializedMeshBytes) {
				throw new Error(`structuralOverrides.additions[${index}].serializedMesh must not exceed ${maximumSerializedMeshBytes} bytes.`);
			}
			if (!Array.isArray(addition.serializedMesh.meshes) || addition.serializedMesh.meshes.length !== 1) {
				throw new Error(`structuralOverrides.additions[${index}].serializedMesh must contain exactly one mesh.`);
			}
			if ((addition.serializedMesh.transformNodes?.length ?? 0) > 0) {
				throw new Error(`structuralOverrides.additions[${index}].serializedMesh cannot contain child transform nodes.`);
			}
			const geometryCount = (Object.values(addition.serializedMesh.geometries ?? {}) as unknown[]).reduce<number>(
				(count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
				0
			);
			if (
				(addition.serializedMesh.materials?.length ?? 0) > 32 ||
				(addition.serializedMesh.multiMaterials?.length ?? 0) > 16 ||
				(addition.serializedMesh.skeletons?.length ?? 0) > 8 ||
				(addition.serializedMesh.textures?.length ?? 0) > 128 ||
				geometryCount > 64
			) {
				throw new Error(`structuralOverrides.additions[${index}].serializedMesh exceeds bounded resource counts.`);
			}
			serializedMesh = structuredClone(addition.serializedMesh);
			const mesh = serializedMesh.meshes[0];
			delete mesh.parentId;
			delete mesh.uniqueId;
			mesh.instances = [];
			mesh.metadata = Object.fromEntries(
				Object.entries(mesh.metadata ?? {}).filter(
					([key]) =>
						![
							"prefab",
							"babylonEditorPrefabSourceNodeName",
							"babylonEditorPrefabAddedNode",
							"babylonEditorPrefabAddedKind",
							"babylonEditorNestedPrefabPath",
							"babylonEditorNestedPrefabLinks",
						].includes(key)
				)
			);
		}
		const properties = validatePrefabProperties(addition.properties ?? {}, `structuralOverrides.additions[${index}].properties`);
		if (properties.name !== undefined) {
			throw new Error(`structuralOverrides.additions[${index}].properties.name is not supported; use displayName.`);
		}
		return { nodeName, displayName: addition.displayName, parentNodeName, kind: addition.kind, cloneSourceNodeName, prefabPath, serializedMesh, properties };
	});
	if (new Set(additions.map((addition) => addition.nodeName)).size !== additions.length) {
		throw new Error("structuralOverrides.additions must not contain duplicate stable source node names.");
	}
	if (!Array.isArray(source.reparents ?? []) || source.reparents?.length > 512) {
		throw new Error("structuralOverrides.reparents must contain at most 512 reparent operations.");
	}
	const reparents = (source.reparents ?? []).map((entry: any) => ({
		nodeName: validateSourceNodeName(entry?.nodeName),
		parentNodeName: entry?.parentNodeName === null ? null : validateSourceNodeName(entry?.parentNodeName),
	}));
	if (new Set(reparents.map((entry) => entry.nodeName)).size !== reparents.length) {
		throw new Error("structuralOverrides.reparents must not contain duplicate source node names.");
	}
	const addedNames = new Set(additions.map((addition) => addition.nodeName));
	if (removals.some((nodeName) => addedNames.has(nodeName)) || reparents.some((entry) => addedNames.has(entry.nodeName))) {
		throw new Error("An added node cannot also be removed or reparented in the same structural override set; edit its addition instead.");
	}
	return { removals, additions, reparents };
}

function validateComponentKey(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) {
		throw new Error(`${field} must be a 1–128 character metadata component key beginning with a letter.`);
	}
	if (
		forbiddenPropertySegments.has(value) ||
		[
			"babylonEditorPrefabSourceNodeName",
			"babylonEditorPrefabAddedNode",
			"babylonEditorPrefabAddedKind",
			"babylonEditorNestedPrefabPath",
			"babylonEditorNestedPrefabLinks",
			"prefab",
		].includes(value)
	) {
		throw new Error(`${field} targets protected prefab identity/runtime metadata.`);
	}
	return value;
}

function validateKnownComponent(componentKey: string, value: any, field: string): void {
	if (componentKey === "scripts") {
		if (!Array.isArray(value) || value.length > 64) {
			throw new Error(`${field} scripts component must contain at most 64 script attachments.`);
		}
		for (const [index, script] of value.entries()) {
			if (!script || typeof script.key !== "string" || !/^scripts\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx)$/.test(script.key) || script.key.includes("..")) {
				throw new Error(`${field}[${index}].key must be a safe scripts/ TypeScript or JavaScript path.`);
			}
			if (script.enabled !== undefined && typeof script.enabled !== "boolean") {
				throw new Error(`${field}[${index}].enabled must be a boolean.`);
			}
			if (script.executionOrder !== undefined && (!Number.isInteger(script.executionOrder) || Math.abs(script.executionOrder) > 1_000_000)) {
				throw new Error(`${field}[${index}].executionOrder must be an integer from -1000000 through 1000000.`);
			}
		}
	}
	if (componentKey === "physicsAggregate") {
		const finite = (entry: any): boolean => typeof entry === "number" && Number.isFinite(entry);
		if (
			!value ||
			!Number.isInteger(value.shape?.type) ||
			!finite(value.shape?.density) ||
			value.shape.density < 0 ||
			!Number.isInteger(value.body?.motionType) ||
			!finite(value.massProperties?.mass) ||
			value.massProperties.mass < 0 ||
			!["friction", "restitution", "staticFriction"].every((key) => finite(value.material?.[key]))
		) {
			throw new Error(`${field} physicsAggregate component must contain finite shape, body, massProperties, and material values.`);
		}
	}
}

function validateComponentOverrides(value: unknown): IPrefabComponentOverrides {
	if (value === undefined || value === null) {
		return { additions: [], removals: [] };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("componentOverrides must be an object containing additions and removals.");
	}
	const source = value as any;
	if (!Array.isArray(source.additions ?? []) || source.additions?.length > 512 || !Array.isArray(source.removals ?? []) || source.removals?.length > 512) {
		throw new Error("componentOverrides additions and removals must each contain at most 512 entries.");
	}
	const additions = (source.additions ?? []).map((entry: any, index: number) => {
		const componentKey = validateComponentKey(entry?.componentKey, `componentOverrides.additions[${index}].componentKey`);
		const value = validatePropertyValue(entry?.value, `componentOverrides.additions[${index}].value`);
		validateKnownComponent(componentKey, value, `componentOverrides.additions[${index}].value`);
		return { nodeName: validateSourceNodeName(entry?.nodeName), componentKey, value };
	});
	const removals = (source.removals ?? []).map((entry: any, index: number) => ({
		nodeName: validateSourceNodeName(entry?.nodeName),
		componentKey: validateComponentKey(entry?.componentKey, `componentOverrides.removals[${index}].componentKey`),
	}));
	const keys = (entries: { nodeName: string; componentKey: string }[]): string[] => entries.map((entry) => `${entry.nodeName}\0${entry.componentKey}`);
	if (new Set(keys(additions)).size !== additions.length || new Set(keys(removals)).size !== removals.length) {
		throw new Error("componentOverrides must not contain duplicate source-node and component-key pairs.");
	}
	const removed = new Set(keys(removals));
	if (keys(additions).some((key) => removed.has(key))) {
		throw new Error("A component cannot be both added and removed in the same override set.");
	}
	return { additions, removals };
}

function sourceNodeName(node: any): string {
	return node.metadata?.babylonEditorPrefabSourceNodeName ?? node.name;
}

function removeSerializedNodeSubtree(document: any, root: any): void {
	const removedIds = new Set<string>([root.id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of serializedPrefabNodes(document)) {
			if (typeof node.parentId === "string" && removedIds.has(node.parentId) && !removedIds.has(node.id)) {
				removedIds.add(node.id);
				changed = true;
			}
		}
	}
	document.meshes = (document.meshes ?? []).filter((node: any) => !removedIds.has(node.id));
	document.transformNodes = (document.transformNodes ?? []).filter((node: any) => !removedIds.has(node.id));
}

function remappedNestedId(prefix: string, kind: string, value: unknown): string {
	return `prefab-nested-${createHash("sha256")
		.update(`${prefix}\0${kind}\0${String(value)}`)
		.digest("hex")
		.slice(0, 24)}`;
}

async function addNestedPrefab(
	document: any,
	addition: IPrefabStructuralAddition,
	parent: any,
	conflicts: IPrefabVariantResolution["conflicts"],
	ancestors: string[]
): Promise<boolean> {
	try {
		const nestedPath = resolvePrefabPath(addition.prefabPath!);
		const nested = await resolvePrefabDocument(nestedPath, ancestors);
		if (nested.conflicts.length) {
			throw new Error(`nested asset has ${nested.conflicts.length} unresolved conflict(s)`);
		}
		const source = structuredClone(nested.document);
		const sourceNodes = serializedPrefabNodes(source);
		const sourceRoot = source.meshes[0];
		const sourceRootId = sourceRoot.id;
		const nodeIds = new Map(sourceNodes.map((node) => [node.id, remappedNestedId(addition.nodeName, "node", node.id)]));
		const materialIds = new Map<string, string>();
		for (const material of [...(source.materials ?? []), ...(source.multiMaterials ?? [])]) {
			if (material.id !== undefined) {
				materialIds.set(String(material.id), remappedNestedId(addition.nodeName, "material", material.id));
			}
		}
		const geometryIds = new Map<string, string>();
		for (const values of Object.values(source.geometries ?? {}) as any[][]) {
			for (const geometry of values ?? []) {
				if (geometry.id !== undefined) {
					geometryIds.set(String(geometry.id), remappedNestedId(addition.nodeName, "geometry", geometry.id));
				}
			}
		}
		const skeletonIds = new Map<string, string>(
			(source.skeletons ?? []).map((skeleton: any) => [String(skeleton.id), remappedNestedId(addition.nodeName, "skeleton", skeleton.id)])
		);
		for (const node of sourceNodes) {
			const originalId = node.id;
			const originalSourceName = sourceNodeName(node);
			const inheritedLinks = Array.isArray(node.metadata?.babylonEditorNestedPrefabLinks) ? structuredClone(node.metadata.babylonEditorNestedPrefabLinks) : [];
			const nestedSourceName = node === sourceRoot ? addition.nodeName : `${addition.nodeName}/${originalSourceName}`;
			if (nestedSourceName.length > 256 || findSerializedPrefabNodes(document, nestedSourceName).length) {
				throw new Error(`nested stable source identity "${nestedSourceName}" is too long or already exists`);
			}
			node.id = nodeIds.get(originalId);
			node.parentId = node === sourceRoot ? parent.id : (nodeIds.get(node.parentId) ?? nodeIds.get(sourceRootId));
			node.geometryId = geometryIds.get(String(node.geometryId)) ?? node.geometryId;
			node.materialId = materialIds.get(String(node.materialId)) ?? node.materialId;
			node.skeletonId = skeletonIds.get(String(node.skeletonId)) ?? node.skeletonId;
			delete node.uniqueId;
			node.metadata = {
				...(node.metadata ?? {}),
				babylonEditorPrefabSourceNodeName: nestedSourceName,
				babylonEditorPrefabAddedNode: true,
				babylonEditorPrefabAddedKind: "nestedPrefab",
				babylonEditorNestedPrefabPath: relative(getProjectDirectory(), nestedPath),
				babylonEditorNestedPrefabLinks: [
					{ path: relative(getProjectDirectory(), nestedPath), sourceNodeName: originalSourceName, boundarySourceNodeName: addition.nodeName },
					...inheritedLinks,
				],
			};
			for (const instance of node.instances ?? []) {
				instance.id = remappedNestedId(addition.nodeName, "instance", instance.id ?? instance.name);
				instance.parentId = nodeIds.get(instance.parentId) ?? instance.parentId;
				instance.metadata = { ...(instance.metadata ?? {}), babylonEditorNestedPrefabPath: relative(getProjectDirectory(), nestedPath) };
			}
		}
		sourceRoot.name = addition.displayName;
		applyPrefabProperties(sourceRoot, addition.properties);
		for (const material of [...(source.materials ?? []), ...(source.multiMaterials ?? [])]) {
			if (material.id !== undefined) {
				material.id = materialIds.get(String(material.id));
			}
			delete material.uniqueId;
			if (Array.isArray(material.materials)) {
				material.materials = material.materials.map((id: unknown) => materialIds.get(String(id)) ?? id);
			}
		}
		for (const values of Object.values(source.geometries ?? {}) as any[][]) {
			for (const geometry of values ?? []) {
				if (geometry.id !== undefined) {
					geometry.id = geometryIds.get(String(geometry.id));
				}
				delete geometry.uniqueId;
			}
		}
		for (const skeleton of source.skeletons ?? []) {
			skeleton.id = skeletonIds.get(String(skeleton.id));
			delete skeleton.uniqueId;
		}
		document.meshes.push(...(source.meshes ?? []));
		document.transformNodes ??= [];
		document.transformNodes.push(...(source.transformNodes ?? []));
		document.materials ??= [];
		document.materials.push(...(source.materials ?? []));
		document.multiMaterials ??= [];
		document.multiMaterials.push(...(source.multiMaterials ?? []));
		document.skeletons ??= [];
		document.skeletons.push(...(source.skeletons ?? []));
		document.geometries ??= {};
		for (const [kind, values] of Object.entries(source.geometries ?? {}) as [string, any[]][]) {
			document.geometries[kind] ??= [];
			document.geometries[kind].push(...values);
		}
		for (const texture of source.textures ?? []) {
			document.textures ??= [];
			document.textures.push(texture);
		}
		return true;
	} catch (error: any) {
		conflicts.push({ code: "nestedPrefabConflict", nodeName: addition.nodeName, message: `Nested prefab "${addition.prefabPath}" could not be composed: ${error.message}` });
		return false;
	}
}

function addSerializedMesh(document: any, addition: IPrefabStructuralAddition, parent: any): any {
	const source = structuredClone(addition.serializedMesh);
	const node = source.meshes[0];
	const materialIds = new Map<string, string>();
	for (const material of [...(source.materials ?? []), ...(source.multiMaterials ?? [])]) {
		if (material.id !== undefined) {
			materialIds.set(String(material.id), remappedNestedId(addition.nodeName, "material", material.id));
		}
	}
	const geometryIds = new Map<string, string>();
	for (const values of Object.values(source.geometries ?? {}) as any[][]) {
		for (const geometry of values ?? []) {
			if (geometry.id !== undefined) {
				geometryIds.set(String(geometry.id), remappedNestedId(addition.nodeName, "geometry", geometry.id));
			}
		}
	}
	const skeletonIds = new Map<string, string>(
		(source.skeletons ?? []).map((skeleton: any) => [String(skeleton.id), remappedNestedId(addition.nodeName, "skeleton", skeleton.id)])
	);
	node.id = `prefab-added-${createHash("sha256").update(addition.nodeName).digest("hex").slice(0, 24)}`;
	delete node.uniqueId;
	node.instances = [];
	node.name = addition.displayName;
	node.parentId = parent.id;
	node.geometryId = geometryIds.get(String(node.geometryId)) ?? node.geometryId;
	delete node.geometryUniqueId;
	if (node.materialId !== undefined && materialIds.has(String(node.materialId))) {
		node.materialId = materialIds.get(String(node.materialId));
	} else {
		delete node.materialId;
	}
	delete node.materialUniqueId;
	node.skeletonId = skeletonIds.get(String(node.skeletonId)) ?? node.skeletonId;
	delete node.skeletonUniqueId;
	node.metadata = {
		...(node.metadata ?? {}),
		babylonEditorPrefabSourceNodeName: addition.nodeName,
		babylonEditorPrefabAddedNode: true,
		babylonEditorPrefabAddedKind: "mesh",
	};
	applyPrefabProperties(node, addition.properties);
	for (const material of [...(source.materials ?? []), ...(source.multiMaterials ?? [])]) {
		if (material.id !== undefined) {
			material.id = materialIds.get(String(material.id));
		}
		delete material.uniqueId;
		if (Array.isArray(material.materials)) {
			material.materials = material.materials.map((id: unknown) => materialIds.get(String(id)) ?? id);
		}
	}
	for (const values of Object.values(source.geometries ?? {}) as any[][]) {
		for (const geometry of values ?? []) {
			if (geometry.id !== undefined) {
				geometry.id = geometryIds.get(String(geometry.id));
			}
			delete geometry.uniqueId;
		}
	}
	for (const skeleton of source.skeletons ?? []) {
		skeleton.id = skeletonIds.get(String(skeleton.id));
		delete skeleton.uniqueId;
	}
	document.meshes.push(node);
	document.materials ??= [];
	document.materials.push(...(source.materials ?? []));
	document.multiMaterials ??= [];
	document.multiMaterials.push(...(source.multiMaterials ?? []));
	document.skeletons ??= [];
	document.skeletons.push(...(source.skeletons ?? []));
	document.geometries ??= {};
	for (const [kind, values] of Object.entries(source.geometries ?? {}) as [string, any[]][]) {
		document.geometries[kind] ??= [];
		document.geometries[kind].push(...values);
	}
	document.textures ??= [];
	for (const texture of source.textures ?? []) {
		const signature = JSON.stringify(texture);
		if (!document.textures.some((existing: any) => JSON.stringify(existing) === signature)) {
			document.textures.push(texture);
		}
	}
	return node;
}

async function applyStructuralOverrides(
	document: any,
	overrides: IPrefabStructuralOverrides,
	conflicts: IPrefabVariantResolution["conflicts"],
	ancestors: string[]
): Promise<void> {
	const root = document.meshes[0];
	const pending = [...overrides.additions];
	for (let pass = 0; pending.length && pass <= overrides.additions.length; pass++) {
		let progressed = false;
		for (let index = pending.length - 1; index >= 0; index--) {
			const addition = pending[index];
			if (findSerializedPrefabNodes(document, addition.nodeName).length) {
				conflicts.push({
					code: "structuralAmbiguousNode",
					nodeName: addition.nodeName,
					message: `Added stable source node "${addition.nodeName}" already exists in the current base.`,
				});
				pending.splice(index, 1);
				continue;
			}
			const parentMatches = addition.parentNodeName === null ? [root] : findSerializedPrefabNodes(document, addition.parentNodeName);
			if (parentMatches.length !== 1) {
				continue;
			}
			if (addition.kind === "nestedPrefab") {
				await addNestedPrefab(document, addition, parentMatches[0], conflicts, ancestors);
				pending.splice(index, 1);
				progressed = true;
				continue;
			}
			if (addition.kind === "mesh") {
				const id = `prefab-added-${createHash("sha256").update(addition.nodeName).digest("hex").slice(0, 24)}`;
				if (serializedPrefabNodes(document).some((entry) => entry.id === id)) {
					conflicts.push({
						code: "structuralAmbiguousNode",
						nodeName: addition.nodeName,
						message: `Deterministic serialized id collision for added mesh "${addition.nodeName}".`,
					});
				} else {
					addSerializedMesh(document, addition, parentMatches[0]);
				}
				pending.splice(index, 1);
				progressed = true;
				continue;
			}
			let node: any;
			if (addition.kind === "cloneMesh") {
				const sourceMatches = findSerializedPrefabNodes(document, addition.cloneSourceNodeName!);
				const meshSource = sourceMatches.length === 1 && (document.meshes ?? []).includes(sourceMatches[0]) ? sourceMatches[0] : null;
				if (!meshSource) {
					conflicts.push({
						code: sourceMatches.length > 1 ? "structuralAmbiguousNode" : "structuralMissingNode",
						nodeName: addition.nodeName,
						message: `Clone source "${addition.cloneSourceNodeName}" is missing, ambiguous, or not a mesh.`,
					});
					pending.splice(index, 1);
					continue;
				}
				node = structuredClone(meshSource);
				delete node.uniqueId;
				node.instances = [];
				node.animations = [];
			} else {
				node = { type: "Mesh", position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1], instances: [], animations: [] };
			}
			node.id = `prefab-added-${createHash("sha256").update(addition.nodeName).digest("hex").slice(0, 24)}`;
			if (serializedPrefabNodes(document).some((entry) => entry.id === node.id)) {
				conflicts.push({
					code: "structuralAmbiguousNode",
					nodeName: addition.nodeName,
					message: `Deterministic serialized id collision for added node "${addition.nodeName}".`,
				});
				pending.splice(index, 1);
				continue;
			}
			node.name = addition.displayName;
			node.parentId = parentMatches[0].id;
			node.metadata = {
				...(node.metadata ?? {}),
				babylonEditorPrefabSourceNodeName: addition.nodeName,
				babylonEditorPrefabAddedNode: true,
				babylonEditorPrefabAddedKind: addition.kind,
			};
			applyPrefabProperties(node, addition.properties);
			document.meshes.push(node);
			pending.splice(index, 1);
			progressed = true;
		}
		if (!progressed) {
			break;
		}
	}
	for (const addition of pending) {
		conflicts.push({
			code: "structuralMissingParent",
			nodeName: addition.nodeName,
			message: `Parent "${addition.parentNodeName}" for added node "${addition.nodeName}" is missing, ambiguous, or cyclic.`,
		});
	}
	for (const nodeName of overrides.removals) {
		const matches = findSerializedPrefabNodes(document, nodeName);
		if (matches.length !== 1 || matches[0] === root) {
			conflicts.push({
				code: matches.length > 1 ? "structuralAmbiguousNode" : "structuralMissingNode",
				nodeName,
				message:
					matches[0] === root
						? "A prefab structural override cannot remove the prefab root."
						: `Structural removal target "${nodeName}" is ${matches.length ? "ambiguous" : "missing"}.`,
			});
			continue;
		}
		removeSerializedNodeSubtree(document, matches[0]);
	}
	for (const entry of overrides.reparents) {
		const matches = findSerializedPrefabNodes(document, entry.nodeName);
		const parentMatches = entry.parentNodeName === null ? [root] : findSerializedPrefabNodes(document, entry.parentNodeName);
		if (matches.length !== 1 || matches[0] === root) {
			conflicts.push({
				code: matches.length > 1 ? "structuralAmbiguousNode" : "structuralMissingNode",
				nodeName: entry.nodeName,
				message: `Structural reparent target "${entry.nodeName}" is missing, ambiguous, or is the prefab root.`,
			});
			continue;
		}
		if (parentMatches.length !== 1) {
			conflicts.push({ code: "structuralMissingParent", nodeName: entry.nodeName, message: `Reparent destination "${entry.parentNodeName}" is missing or ambiguous.` });
			continue;
		}
		const target = matches[0];
		const parent = parentMatches[0];
		let ancestor = parent;
		let cyclic = parent === target;
		while (ancestor && !cyclic) {
			cyclic = ancestor.parentId === target.id;
			ancestor = serializedPrefabNodes(document).find((node) => node.id === ancestor.parentId);
		}
		if (cyclic) {
			conflicts.push({
				code: "structuralCycle",
				nodeName: entry.nodeName,
				message: `Reparenting "${entry.nodeName}" below "${entry.parentNodeName}" would create a hierarchy cycle.`,
			});
			continue;
		}
		target.parentId = parent.id;
	}
}

function applyComponentOverrides(document: any, overrides: IPrefabComponentOverrides, conflicts: IPrefabVariantResolution["conflicts"]): void {
	for (const entry of overrides.removals) {
		const matches = findSerializedPrefabNodes(document, entry.nodeName);
		if (matches.length !== 1) {
			conflicts.push({
				code: matches.length > 1 ? "componentAmbiguousNode" : "componentMissingNode",
				nodeName: entry.nodeName,
				path: `/metadata/${entry.componentKey}`,
				message: `Component removal target "${entry.nodeName}" is ${matches.length ? "ambiguous" : "missing"}.`,
			});
			continue;
		}
		if (!matches[0].metadata || !Object.prototype.hasOwnProperty.call(matches[0].metadata, entry.componentKey)) {
			conflicts.push({
				code: "componentMissing",
				nodeName: entry.nodeName,
				path: `/metadata/${entry.componentKey}`,
				message: `Component "${entry.componentKey}" no longer exists on "${entry.nodeName}".`,
			});
			continue;
		}
		delete matches[0].metadata[entry.componentKey];
	}
	for (const entry of overrides.additions) {
		const matches = findSerializedPrefabNodes(document, entry.nodeName);
		if (matches.length !== 1) {
			conflicts.push({
				code: matches.length > 1 ? "componentAmbiguousNode" : "componentMissingNode",
				nodeName: entry.nodeName,
				path: `/metadata/${entry.componentKey}`,
				message: `Component addition target "${entry.nodeName}" is ${matches.length ? "ambiguous" : "missing"}.`,
			});
			continue;
		}
		matches[0].metadata ??= {};
		if (Object.prototype.hasOwnProperty.call(matches[0].metadata, entry.componentKey)) {
			conflicts.push({
				code: "componentAlreadyExists",
				nodeName: entry.nodeName,
				path: `/metadata/${entry.componentKey}`,
				message: `Component "${entry.componentKey}" already exists on "${entry.nodeName}".`,
			});
			continue;
		}
		matches[0].metadata[entry.componentKey] = structuredClone(entry.value);
	}
}

function applyPrefabProperties(target: any, properties: any): void {
	for (const key of prefabPropertyNames) {
		if (properties?.[key] !== undefined) {
			target[key] = structuredClone(properties[key]);
		}
	}
}

async function readRawPrefab(path: string): Promise<any> {
	if (!(await pathExists(path))) {
		throw new Error(`Prefab asset not found: ${relative(getProjectDirectory(), path)}`);
	}
	const value = await readJSON(path, { encoding: "utf-8" });
	if (!value || typeof value !== "object" || !Array.isArray(value.meshes) || !value.meshes.length) {
		throw new Error(`Prefab asset is malformed or contains no mesh root: ${relative(getProjectDirectory(), path)}`);
	}
	return value;
}

async function resolvePrefabDocument(path: string, ancestors: string[] = []): Promise<IPrefabVariantResolution> {
	if (ancestors.includes(path)) {
		throw new Error(`Prefab variant inheritance cycle detected: ${[...ancestors, path].map((entry) => relative(getProjectDirectory(), entry)).join(" -> ")}`);
	}
	if (ancestors.length >= maximumVariantDepth) {
		throw new Error(`Prefab variant inheritance exceeds the maximum depth of ${maximumVariantDepth}.`);
	}
	const raw = await readRawPrefab(path);
	const variant = raw.metadata?.babylonEditorPrefabVariant;
	if (!variant) {
		const document = structuredClone(raw);
		markPrefabSourceIdentities(document);
		return {
			document,
			path: relative(getProjectDirectory(), path),
			variant: false,
			basePath: null,
			baseRevision: null,
			storedBaseRevision: null,
			stale: false,
			conflicts: [],
			chain: [relative(getProjectDirectory(), path)],
		};
	}
	if (typeof variant.basePath !== "string" || !variant.basePath) {
		throw new Error(`Prefab variant has no valid basePath: ${relative(getProjectDirectory(), path)}`);
	}
	const basePath = resolvePrefabPath(variant.basePath);
	const base = await resolvePrefabDocument(basePath, [...ancestors, path]);
	const document = structuredClone(base.document);
	markPrefabSourceIdentities(document);
	const conflicts = [...base.conflicts];
	const structuralOverrides = validateStructuralOverrides(variant.structuralOverrides);
	await applyStructuralOverrides(document, structuralOverrides, conflicts, [...ancestors, path]);
	const componentOverrides = validateComponentOverrides(variant.componentOverrides);
	applyComponentOverrides(document, componentOverrides, conflicts);
	applyPrefabProperties(document.meshes[0], validatePrefabProperties(variant.rootOverrides ?? {}, "rootOverrides"));
	const nodeOverrides = validateVariantNodeOverrides(variant.nodeOverrides ?? []);
	for (const override of nodeOverrides) {
		const matches = findSerializedPrefabNodes(document, override.nodeName);
		if (matches.length === 0) {
			conflicts.push({ code: "missingNode", nodeName: override.nodeName, message: `Base prefab no longer contains source node "${override.nodeName}".` });
			continue;
		}
		if (matches.length > 1) {
			conflicts.push({ code: "ambiguousNode", nodeName: override.nodeName, message: `Base prefab contains multiple source nodes named "${override.nodeName}".` });
			continue;
		}
		applyPrefabProperties(matches[0], override.properties);
	}
	const propertyOverrides = validatePropertyOverrides(variant.propertyOverrides ?? []);
	for (const override of propertyOverrides) {
		const matches = findSerializedPrefabNodes(document, override.nodeName);
		if (matches.length === 0) {
			conflicts.push({
				code: "missingNode",
				nodeName: override.nodeName,
				path: override.path,
				message: `Base prefab no longer contains source node "${override.nodeName}".`,
			});
			continue;
		}
		if (matches.length > 1) {
			conflicts.push({
				code: "ambiguousNode",
				nodeName: override.nodeName,
				path: override.path,
				message: `Base prefab contains multiple source nodes named "${override.nodeName}".`,
			});
			continue;
		}
		try {
			applyPropertyOverride(matches[0], override);
		} catch {
			conflicts.push({
				code: "missingProperty",
				nodeName: override.nodeName,
				path: override.path,
				message: `Base source node "${override.nodeName}" no longer contains property "${override.path}".`,
			});
		}
	}
	const baseRevision = prefabRevision(base.document);
	const storedBaseRevision = typeof variant.baseRevision === "string" && /^[a-f0-9]{64}$/.test(variant.baseRevision) ? variant.baseRevision : null;
	document.metadata ??= {};
	document.metadata.babylonEditorPrefabVariant = {
		version: 2,
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision,
		rootOverrides: structuredClone(variant.rootOverrides ?? {}),
		nodeOverrides,
		propertyOverrides,
		structuralOverrides,
		componentOverrides,
	};
	document.metadata.babylonEditorPrefab = {
		...(document.metadata.babylonEditorPrefab ?? {}),
		version: 1,
		rootName: document.meshes[0].name,
		rootClassName: document.meshes[0].type ?? "Mesh",
	};
	return {
		document,
		path: relative(getProjectDirectory(), path),
		variant: true,
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision,
		storedBaseRevision,
		stale: storedBaseRevision !== baseRevision,
		conflicts,
		chain: [...base.chain, relative(getProjectDirectory(), path)],
	};
}

export async function listPrefabs(): Promise<any> {
	const { normalizedGlob } = await import("../../tools/fs");
	const directory = getProjectDirectory();
	const paths = await normalizedGlob(join(directory, "/**/*.prefab"), { nodir: true, ignore: ["**/node_modules/**"] });
	return { prefabs: paths.map((path) => ({ path: relative(directory, path.toString()) })) };
}

export async function getPrefab(_scene: Scene, data: any): Promise<any> {
	const path = resolvePrefabPath(data.path);
	return (await resolvePrefabDocument(path)).document;
}

export async function createPrefab(scene: Scene, data: any): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error("Prefab creation currently requires a Mesh root. Parent mesh children are included in the prefab asset.");
	}

	const path = resolvePrefabPath(data.path);
	if ((await pathExists(path)) && data.overwrite !== true) {
		throw new Error(`A prefab already exists at ${data.path}. Set overwrite: true to replace it.`);
	}

	const root = node as Mesh;
	const serialized = await SceneSerializer.SerializeMesh(root, false, true);
	serialized.version = 5;
	serialized.producer = {
		name: "Babylon.js Editor Prefab",
		version: "1",
	};
	serialized.metadata = {
		...(serialized.metadata ?? {}),
		babylonEditorPrefab: {
			version: 1,
			rootName: root.name,
			rootClassName: root.getClassName(),
		},
	};

	await ensureDir(dirname(path));
	markPrefabSourceIdentities(serialized);
	await writeJSON(path, serialized, { encoding: "utf-8", spaces: "\t" });

	return { created: true, path: relative(getProjectDirectory(), path), root: toNodeSummary(root) };
}

/** Creates a derived prefab asset with serialized root/node overrides over a base prefab. */
export async function createPrefabVariant(_scene: Scene, data: any): Promise<any> {
	const basePath = resolvePrefabPath(data.basePath);
	if (!(await pathExists(basePath))) {
		throw new Error(`Base prefab asset not found: ${data.basePath}`);
	}
	const path = resolvePrefabPath(data.path);
	if ((await pathExists(path)) && data.overwrite !== true) {
		throw new Error(`A prefab already exists at ${data.path}. Set overwrite: true to replace it.`);
	}
	if (basePath === path) {
		throw new Error("A prefab variant cannot use itself as its base asset.");
	}
	const baseResolution = await resolvePrefabDocument(basePath);
	if (baseResolution.conflicts.length) {
		throw new Error("The base prefab variant has unresolved rebase conflicts. Inspect and repair its variant chain first.");
	}
	const base = baseResolution.document;
	const variant = structuredClone(base);
	const root = variant.meshes?.[0];
	if (!root) {
		throw new Error("Base prefab contains no serializable mesh root.");
	}
	const rootOverrides = validatePrefabProperties(data.rootOverrides ?? {}, "rootOverrides");
	const nodeOverrides = validateVariantNodeOverrides(data.nodeOverrides ?? []);
	const propertyOverrides = validatePropertyOverrides(data.propertyOverrides ?? []);
	const structuralOverrides = validateStructuralOverrides(data.structuralOverrides);
	const structuralConflicts: IPrefabVariantResolution["conflicts"] = [];
	await applyStructuralOverrides(variant, structuralOverrides, structuralConflicts, [path, basePath]);
	const componentOverrides = validateComponentOverrides(data.componentOverrides);
	applyComponentOverrides(variant, componentOverrides, structuralConflicts);
	if (structuralConflicts.length) {
		throw new Error(`Prefab structural overrides are invalid: ${structuralConflicts.map((conflict) => conflict.message).join(" ")}`);
	}
	applyPrefabProperties(root, rootOverrides);
	for (const override of nodeOverrides) {
		const matches = findSerializedPrefabNodes(variant, override.nodeName);
		if (matches.length !== 1) {
			throw new Error(
				matches.length ? `Prefab source node "${override.nodeName}" is ambiguous in the base asset.` : `Prefab node "${override.nodeName}" was not found in the base asset.`
			);
		}
		applyPrefabProperties(matches[0], override.properties);
	}
	for (const override of propertyOverrides) {
		const matches = findSerializedPrefabNodes(variant, override.nodeName);
		if (matches.length !== 1) {
			throw new Error(
				matches.length ? `Prefab source node "${override.nodeName}" is ambiguous in the base asset.` : `Prefab node "${override.nodeName}" was not found in the base asset.`
			);
		}
		applyPropertyOverride(matches[0], override);
	}
	variant.metadata ??= {};
	variant.metadata.babylonEditorPrefab = { ...(variant.metadata.babylonEditorPrefab ?? {}), version: 1, rootName: root.name, rootClassName: root.type ?? "Mesh" };
	variant.metadata.babylonEditorPrefabVariant = {
		version: 2,
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision: prefabRevision(base),
		rootOverrides,
		nodeOverrides,
		propertyOverrides,
		structuralOverrides,
		componentOverrides,
	};
	await ensureDir(dirname(path));
	await writeJSON(path, variant, { encoding: "utf-8", spaces: "\t" });
	return {
		created: true,
		path: relative(getProjectDirectory(), path),
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision: prefabRevision(base),
		rootOverrides,
		nodeOverrides,
		propertyOverrides,
		structuralOverrides,
		componentOverrides,
	};
}

/** Inspects whether a variant is dynamically current with its recursively resolved base chain. */
export async function inspectPrefabVariantRebase(_scene: Scene, data: any): Promise<any> {
	const resolution = await resolvePrefabDocument(resolvePrefabPath(data.path));
	return {
		path: resolution.path,
		variant: resolution.variant,
		basePath: resolution.basePath,
		baseRevision: resolution.baseRevision,
		storedBaseRevision: resolution.storedBaseRevision,
		stale: resolution.stale,
		conflicts: resolution.conflicts,
		chain: resolution.chain,
		resolvedRevision: prefabRevision(resolution.document),
		nodeCount: serializedPrefabNodes(resolution.document).length,
		rootOverrides: structuredClone(resolution.document.metadata?.babylonEditorPrefabVariant?.rootOverrides ?? {}),
		nodeOverrides: structuredClone(resolution.document.metadata?.babylonEditorPrefabVariant?.nodeOverrides ?? []),
		propertyOverrides: structuredClone(resolution.document.metadata?.babylonEditorPrefabVariant?.propertyOverrides ?? []),
		structuralOverrides: structuredClone(resolution.document.metadata?.babylonEditorPrefabVariant?.structuralOverrides ?? { removals: [], additions: [], reparents: [] }),
		componentOverrides: structuredClone(resolution.document.metadata?.babylonEditorPrefabVariant?.componentOverrides ?? { additions: [], removals: [] }),
	};
}

/** Returns the resolved stable-source hierarchy and the current variant's structural override set. */
export async function inspectPrefabVariantStructure(_scene: Scene, data: any): Promise<any> {
	const resolution = await resolvePrefabDocument(resolvePrefabPath(data.path));
	const structuralOverrides = validateStructuralOverrides(resolution.document.metadata?.babylonEditorPrefabVariant?.structuralOverrides);
	const addedHere = new Set(structuralOverrides.additions.map((addition) => addition.nodeName));
	const nodes = serializedPrefabNodes(resolution.document);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	return {
		path: resolution.path,
		variant: resolution.variant,
		revision: prefabRevision(resolution.document),
		stale: resolution.stale,
		conflicts: resolution.conflicts,
		chain: resolution.chain,
		structuralOverrides,
		nodes: nodes.map((node) => ({
			nodeName: sourceNodeName(node),
			displayName: node.name,
			parentNodeName: node.parentId && byId.has(node.parentId) ? sourceNodeName(byId.get(node.parentId)) : null,
			kind: node.metadata?.babylonEditorPrefabAddedKind ?? ((resolution.document.meshes ?? []).includes(node) ? "mesh" : "transform"),
			addedHere: addedHere.has(sourceNodeName(node)),
		})),
	};
}

/** Replaces one variant's complete add/remove/reparent set under an exact resolved-revision lease. */
export async function setPrefabVariantStructure(scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to replace prefab variant structure.");
	}
	const path = resolvePrefabPath(data.path);
	const current = await resolvePrefabDocument(path);
	if (!current.variant) {
		throw new Error("Structural overrides require a prefab variant.");
	}
	const metadata = current.document.metadata.babylonEditorPrefabVariant;
	const structuralOverrides = validateStructuralOverrides(data.structuralOverrides);
	const result = await setPrefabVariantOverrides(scene, {
		path,
		expectedRevision: data.expectedRevision,
		rootOverrides: metadata.rootOverrides ?? {},
		nodeOverrides: metadata.nodeOverrides ?? [],
		propertyOverrides: metadata.propertyOverrides ?? [],
		structuralOverrides,
		componentOverrides: metadata.componentOverrides ?? { additions: [], removals: [] },
		confirm: true,
	});
	return { ...result, structuralOverrides };
}

/** Returns bounded metadata-component inventories and the current add/remove override set. */
export async function inspectPrefabVariantComponents(_scene: Scene, data: any): Promise<any> {
	const resolution = await resolvePrefabDocument(resolvePrefabPath(data.path));
	const componentOverrides = validateComponentOverrides(resolution.document.metadata?.babylonEditorPrefabVariant?.componentOverrides);
	const nodes = serializedPrefabNodes(resolution.document).slice(0, 2048);
	return {
		path: resolution.path,
		variant: resolution.variant,
		revision: prefabRevision(resolution.document),
		stale: resolution.stale,
		conflicts: resolution.conflicts,
		componentOverrides,
		truncated: serializedPrefabNodes(resolution.document).length > nodes.length,
		nodes: nodes.map((node) => ({
			nodeName: sourceNodeName(node),
			components: Object.entries(node.metadata ?? {})
				.filter(
					([key]) =>
						!["babylonEditorPrefabSourceNodeName", "babylonEditorPrefabAddedNode", "babylonEditorPrefabAddedKind", "babylonEditorNestedPrefabPath", "prefab"].includes(
							key
						)
				)
				.slice(0, 128)
				.map(([componentKey, value]) => ({
					componentKey,
					valueType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
					bytes: JSON.stringify(value)?.length ?? 0,
					addedHere: componentOverrides.additions.some((entry) => entry.nodeName === sourceNodeName(node) && entry.componentKey === componentKey),
				})),
		})),
	};
}

/** Replaces one variant's complete component add/remove set under an exact resolved-revision lease. */
export async function setPrefabVariantComponents(scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to replace prefab variant component overrides.");
	}
	const path = resolvePrefabPath(data.path);
	const current = await resolvePrefabDocument(path);
	if (!current.variant) {
		throw new Error("Component add/remove overrides require a prefab variant.");
	}
	const metadata = current.document.metadata.babylonEditorPrefabVariant;
	const componentOverrides = validateComponentOverrides(data.componentOverrides);
	const result = await setPrefabVariantOverrides(scene, {
		path,
		expectedRevision: data.expectedRevision,
		rootOverrides: metadata.rootOverrides ?? {},
		nodeOverrides: metadata.nodeOverrides ?? [],
		propertyOverrides: metadata.propertyOverrides ?? [],
		structuralOverrides: metadata.structuralOverrides ?? { removals: [], additions: [], reparents: [] },
		componentOverrides,
		confirm: true,
	});
	return { ...result, componentOverrides };
}

/** Persists the currently resolved base plus variant overrides after an exact-base-revision lease. */
export async function rebasePrefabVariant(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to persist a prefab variant rebase.");
	}
	const path = resolvePrefabPath(data.path);
	const resolution = await resolvePrefabDocument(path);
	if (!resolution.variant) {
		throw new Error("The selected prefab is not a variant.");
	}
	if (resolution.conflicts.length) {
		throw new Error("Prefab variant rebase has unresolved missing or ambiguous node overrides. Inspect conflicts before persisting.");
	}
	if (typeof data.expectedBaseRevision !== "string" || data.expectedBaseRevision !== resolution.baseRevision) {
		throw new Error("Prefab base changed since rebase inspection. Refresh diagnostics and use the exact current expectedBaseRevision.");
	}
	await writeJSON(path, resolution.document, { encoding: "utf-8", spaces: "\t" });
	return {
		rebased: true,
		path: resolution.path,
		basePath: resolution.basePath,
		baseRevision: resolution.baseRevision,
		staleBefore: resolution.stale,
		resolvedRevision: prefabRevision(resolution.document),
		chain: resolution.chain,
	};
}

/** Replaces a variant's complete bounded override set under an exact resolved-revision lease. */
export async function setPrefabVariantOverrides(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to replace prefab variant overrides.");
	}
	const path = resolvePrefabPath(data.path);
	const current = await resolvePrefabDocument(path);
	if (!current.variant) {
		throw new Error("The selected prefab is not a variant.");
	}
	const currentRevision = prefabRevision(current.document);
	if (typeof data.expectedRevision !== "string" || data.expectedRevision !== currentRevision) {
		throw new Error("Prefab changed since variant inspection. Refresh diagnostics and use the exact current expectedRevision.");
	}
	const raw = await readRawPrefab(path);
	const basePath = resolvePrefabPath(raw.metadata.babylonEditorPrefabVariant.basePath);
	const base = await resolvePrefabDocument(basePath, [path]);
	if (base.conflicts.length) {
		throw new Error("The base prefab variant chain has unresolved conflicts and cannot accept derived overrides.");
	}
	const rootOverrides = validatePrefabProperties(data.rootOverrides ?? {}, "rootOverrides");
	const nodeOverrides = validateVariantNodeOverrides(data.nodeOverrides ?? []);
	const propertyOverrides = validatePropertyOverrides(data.propertyOverrides ?? []);
	const structuralOverrides = validateStructuralOverrides(data.structuralOverrides ?? current.document.metadata?.babylonEditorPrefabVariant?.structuralOverrides);
	const componentOverrides = validateComponentOverrides(data.componentOverrides ?? current.document.metadata?.babylonEditorPrefabVariant?.componentOverrides);
	const document = structuredClone(base.document);
	markPrefabSourceIdentities(document);
	const structuralConflicts: IPrefabVariantResolution["conflicts"] = [];
	await applyStructuralOverrides(document, structuralOverrides, structuralConflicts, [path, basePath]);
	applyComponentOverrides(document, componentOverrides, structuralConflicts);
	if (structuralConflicts.length) {
		throw new Error(`Prefab structural overrides are invalid against the current base: ${structuralConflicts.map((conflict) => conflict.message).join(" ")}`);
	}
	applyPrefabProperties(document.meshes[0], rootOverrides);
	for (const override of nodeOverrides) {
		const matches = findSerializedPrefabNodes(document, override.nodeName);
		if (matches.length !== 1) {
			throw new Error(
				matches.length
					? `Prefab source node "${override.nodeName}" is ambiguous in the current base.`
					: `Prefab source node "${override.nodeName}" is missing from the current base.`
			);
		}
		applyPrefabProperties(matches[0], override.properties);
	}
	for (const override of propertyOverrides) {
		const matches = findSerializedPrefabNodes(document, override.nodeName);
		if (matches.length !== 1) {
			throw new Error(
				matches.length
					? `Prefab source node "${override.nodeName}" is ambiguous in the current base.`
					: `Prefab source node "${override.nodeName}" is missing from the current base.`
			);
		}
		applyPropertyOverride(matches[0], override);
	}
	const baseRevision = prefabRevision(base.document);
	document.metadata ??= {};
	document.metadata.babylonEditorPrefab = {
		...(document.metadata.babylonEditorPrefab ?? {}),
		version: 1,
		rootName: document.meshes[0].name,
		rootClassName: document.meshes[0].type ?? "Mesh",
	};
	document.metadata.babylonEditorPrefabVariant = {
		version: 2,
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision,
		rootOverrides,
		nodeOverrides,
		propertyOverrides,
		structuralOverrides,
		componentOverrides,
	};
	await writeJSON(path, document, { encoding: "utf-8", spaces: "\t" });
	return {
		updated: true,
		path: current.path,
		basePath: relative(getProjectDirectory(), basePath),
		baseRevision,
		rootOverrides,
		nodeOverrides,
		propertyOverrides,
		structuralOverrides,
		componentOverrides,
		previousRevision: currentRevision,
		revision: prefabRevision(document),
	};
}

/** Updates one serialized prefab source node, preserving the change as a variant override when applicable. */
export async function setPrefabAssetNodeProperties(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to update prefab asset node properties.");
	}
	const path = resolvePrefabPath(data.path);
	const resolution = await resolvePrefabDocument(path);
	if (resolution.conflicts.length) {
		throw new Error("Prefab variant has unresolved rebase conflicts. Repair or remove the missing/ambiguous overrides before editing it.");
	}
	const currentRevision = prefabRevision(resolution.document);
	if (data.expectedRevision !== undefined && data.expectedRevision !== currentRevision) {
		throw new Error("Prefab changed since inspection. Refresh Prefab Mode and use the exact current expectedRevision.");
	}
	if (typeof data.sourceNodeName !== "string" || !data.sourceNodeName || data.sourceNodeName.length > 256 || /[\r\n\0]/.test(data.sourceNodeName)) {
		throw new Error("sourceNodeName must be a non-empty stable prefab source name of at most 256 characters.");
	}
	const properties = validatePrefabProperties(data.properties, "properties");
	if (!Object.keys(properties).length) {
		throw new Error("properties must contain at least one supported prefab property.");
	}
	const matches = findSerializedPrefabNodes(resolution.document, data.sourceNodeName);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `Prefab source node "${data.sourceNodeName}" is ambiguous.` : `Prefab source node "${data.sourceNodeName}" was not found.`);
	}
	applyPrefabProperties(matches[0], properties);
	if (resolution.variant) {
		const metadata = resolution.document.metadata.babylonEditorPrefabVariant;
		const rootSourceName = resolution.document.meshes[0].metadata?.babylonEditorPrefabSourceNodeName ?? resolution.document.meshes[0].name;
		if (data.sourceNodeName === rootSourceName) {
			metadata.rootOverrides = { ...(metadata.rootOverrides ?? {}), ...properties };
		} else {
			const overrides = Array.isArray(metadata.nodeOverrides) ? metadata.nodeOverrides : [];
			const existing = overrides.find((override: any) => override.nodeName === data.sourceNodeName);
			if (existing) {
				existing.properties = { ...(existing.properties ?? {}), ...properties };
			} else {
				overrides.push({ nodeName: data.sourceNodeName, properties });
			}
			metadata.nodeOverrides = overrides;
		}
		metadata.version = 2;
		metadata.baseRevision = resolution.baseRevision;
	}
	resolution.document.metadata ??= {};
	resolution.document.metadata.babylonEditorPrefab ??= { version: 1, rootClassName: resolution.document.meshes[0].type ?? "Mesh" };
	resolution.document.metadata.babylonEditorPrefab.rootName = resolution.document.meshes[0].name;
	await writeJSON(path, resolution.document, { encoding: "utf-8", spaces: "\t" });
	return {
		updated: true,
		path: resolution.path,
		variant: resolution.variant,
		sourceNodeName: data.sourceNodeName,
		properties,
		previousRevision: currentRevision,
		revision: prefabRevision(resolution.document),
	};
}

/** Reads one existing arbitrary serialized node property and its exact override/revision state. */
export async function inspectPrefabAssetNodeProperty(_scene: Scene, data: any): Promise<any> {
	const path = resolvePrefabPath(data.path);
	const sourceNodeName = validateSourceNodeName(data.sourceNodeName);
	const propertyPath = typeof data.propertyPath === "string" ? data.propertyPath : "";
	parsePropertyPointer(propertyPath, "propertyPath");
	const resolution = await resolvePrefabDocument(path);
	const matches = findSerializedPrefabNodes(resolution.document, sourceNodeName);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `Prefab source node "${sourceNodeName}" is ambiguous.` : `Prefab source node "${sourceNodeName}" was not found.`);
	}
	const property = getPropertyAtPointer(matches[0], propertyPath);
	const propertyOverrides = validatePropertyOverrides(resolution.document.metadata?.babylonEditorPrefabVariant?.propertyOverrides ?? []);
	return {
		path: resolution.path,
		variant: resolution.variant,
		sourceNodeName,
		propertyPath,
		value: structuredClone(property.value),
		overridden: propertyOverrides.some((override) => override.nodeName === sourceNodeName && override.path === propertyPath),
		revision: prefabRevision(resolution.document),
		stale: resolution.stale,
		conflicts: resolution.conflicts,
	};
}

/** Updates one existing arbitrary serialized node property, storing variant changes as exact path overrides. */
export async function setPrefabAssetNodeProperty(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to update a serialized prefab node property.");
	}
	const path = resolvePrefabPath(data.path);
	const sourceNodeName = validateSourceNodeName(data.sourceNodeName);
	const propertyPath = typeof data.propertyPath === "string" ? data.propertyPath : "";
	parsePropertyPointer(propertyPath, "propertyPath");
	const value = validatePropertyValue(data.value);
	const resolution = await resolvePrefabDocument(path);
	if (resolution.conflicts.length) {
		throw new Error("Prefab variant has unresolved rebase conflicts. Repair or remove its overrides before editing it.");
	}
	const currentRevision = prefabRevision(resolution.document);
	if (typeof data.expectedRevision !== "string" || data.expectedRevision !== currentRevision) {
		throw new Error("Prefab changed since property inspection. Refresh and use the exact current expectedRevision.");
	}
	const matches = findSerializedPrefabNodes(resolution.document, sourceNodeName);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `Prefab source node "${sourceNodeName}" is ambiguous.` : `Prefab source node "${sourceNodeName}" was not found.`);
	}
	applyPropertyOverride(matches[0], { nodeName: sourceNodeName, path: propertyPath, value });
	if (resolution.variant) {
		const metadata = resolution.document.metadata.babylonEditorPrefabVariant;
		const overrides = validatePropertyOverrides(metadata.propertyOverrides ?? []);
		const existing = overrides.find((override) => override.nodeName === sourceNodeName && override.path === propertyPath);
		if (existing) {
			existing.value = value;
		} else {
			overrides.push({ nodeName: sourceNodeName, path: propertyPath, value });
		}
		metadata.propertyOverrides = overrides;
		metadata.version = 2;
		metadata.baseRevision = resolution.baseRevision;
	}
	await writeJSON(path, resolution.document, { encoding: "utf-8", spaces: "\t" });
	return {
		updated: true,
		path: resolution.path,
		variant: resolution.variant,
		sourceNodeName,
		propertyPath,
		value,
		previousRevision: currentRevision,
		revision: prefabRevision(resolution.document),
	};
}

function getPrefabInstanceRoot(scene: Scene, data: any): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || !node.metadata?.prefab?.path) {
		throw new Error("Select a prefab instance root created by instantiate_prefab.");
	}
	return node;
}
function getPrefabInstanceNode(scene: Scene, data: any): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || !node.metadata?.prefab?.path) {
		throw new Error("Select a mesh node created by instantiate_prefab.");
	}
	return node;
}

function getRuntimePrefabLinks(node: Mesh): IPrefabLink[] {
	const raw = node.metadata?.prefab?.links;
	const candidates = Array.isArray(raw)
		? raw
		: node.metadata?.prefab?.path && node.metadata?.prefab?.sourceNodeName
			? [{ path: node.metadata.prefab.path, sourceNodeName: node.metadata.prefab.sourceNodeName }]
			: [];
	if (!candidates.length || candidates.length > maximumVariantDepth + 1) {
		throw new Error("The selected prefab instance has no valid bounded source-link stack.");
	}
	return candidates.map((entry: any, index: number) => {
		if (!entry || typeof entry.path !== "string" || entry.path.length > 512 || typeof entry.sourceNodeName !== "string") {
			throw new Error(`Prefab instance source link ${index} is malformed.`);
		}
		const path = relative(getProjectDirectory(), resolvePrefabPath(entry.path));
		return {
			path,
			sourceNodeName: validateSourceNodeName(entry.sourceNodeName),
			...(typeof entry.boundarySourceNodeName === "string" ? { boundarySourceNodeName: validateSourceNodeName(entry.boundarySourceNodeName) } : {}),
		};
	});
}

function selectRuntimePrefabLink(node: Mesh, targetPath: unknown): { link: IPrefabLink; index: number } {
	const links = getRuntimePrefabLinks(node);
	if (targetPath === undefined) {
		return { link: links[0], index: 0 };
	}
	if (typeof targetPath !== "string") {
		throw new Error("targetPath must identify one source path returned by inspect_prefab_instance_links.");
	}
	const normalized = relative(getProjectDirectory(), resolvePrefabPath(targetPath));
	const index = links.findIndex((entry) => entry.path === normalized);
	if (index === -1) {
		throw new Error(`The selected instance node is not linked to ${normalized}. Inspect its source links and select an available targetPath.`);
	}
	return { link: links[index], index };
}

function publicRuntimeComponentKeys(node: Mesh): string[] {
	return Object.keys(node.metadata ?? {})
		.filter(
			(key) =>
				![
					"prefab",
					"babylonEditorPrefabSourceNodeName",
					"babylonEditorPrefabAddedNode",
					"babylonEditorPrefabAddedKind",
					"babylonEditorNestedPrefabPath",
					"babylonEditorNestedPrefabLinks",
				].includes(key)
		)
		.sort();
}

/** Inspects every outer/nested source asset boundary available for one live prefab instance node. */
export async function inspectPrefabInstanceLinks(scene: Scene, data: any): Promise<any> {
	const node = getPrefabInstanceNode(scene, data);
	const links = getRuntimePrefabLinks(node);
	const inspected: any[] = [];
	for (const [index, link] of links.entries()) {
		const resolution = await resolvePrefabDocument(resolvePrefabPath(link.path));
		const matches = findSerializedPrefabNodes(resolution.document, link.sourceNodeName);
		inspected.push({
			index,
			path: link.path,
			sourceNodeName: link.sourceNodeName,
			boundarySourceNodeName: link.boundarySourceNodeName ?? null,
			variant: resolution.variant,
			revision: prefabRevision(resolution.document),
			stale: resolution.stale,
			conflicts: resolution.conflicts,
			targetExists: matches.length === 1,
		});
	}
	return {
		nodeId: node.id,
		nodeName: node.name,
		instanceId: node.metadata.prefab.instanceId ?? null,
		properties: rootProperties(node),
		componentKeys: publicRuntimeComponentKeys(node),
		links: inspected,
	};
}

function livePrefabNodeProperties(node: any): any {
	return {
		position: node.position?.asArray?.() ?? [0, 0, 0],
		rotation: node.rotation?.asArray?.() ?? [0, 0, 0],
		scaling: node.scaling?.asArray?.() ?? [1, 1, 1],
		...("visibility" in node ? { visibility: node.visibility } : {}),
		...("isVisible" in node ? { isVisible: node.isVisible } : {}),
	};
}

function prefabPropertiesEqual(serialized: any, live: any): boolean {
	return ["position", "rotation", "scaling", "visibility", "isVisible"].every((key) => {
		if (serialized[key] === undefined && live[key] === undefined) {
			return true;
		}
		return JSON.stringify(serialized[key]) === JSON.stringify(live[key]);
	});
}

function livePrefabInstanceScope(scene: Scene, selected: Mesh): { instanceId: string; root: any; nodes: any[] } {
	const instanceId = selected.metadata?.prefab?.instanceId;
	if (typeof instanceId !== "string" || !instanceId) {
		throw new Error("The selected prefab instance has no stable instance id. Reinstantiate it before comparing live structure.");
	}
	const linked = [...scene.meshes, ...scene.transformNodes].filter((node: any) => node.metadata?.prefab?.instanceId === instanceId);
	const linkedSet = new Set(linked);
	const roots = linked.filter((node: any) => !node.parent || !linkedSet.has(node.parent));
	if (roots.length !== 1) {
		throw new Error("The selected prefab instance does not have one unambiguous live hierarchy root.");
	}
	const root = roots[0];
	const nodes = [root, ...root.getDescendants(false)].filter((node: any) => "position" in node);
	return { instanceId, root, nodes };
}

function runtimePrefabLinkForPath(node: any, targetPath: string): IPrefabLink | null {
	if (!node.metadata?.prefab) {
		return null;
	}
	try {
		return getRuntimePrefabLinks(node as Mesh).find((link) => link.path === targetPath) ?? null;
	} catch {
		return null;
	}
}

function proposedLiveSourceName(instanceId: string, node: any): string {
	const persisted = node.metadata?.babylonEditorPrefabPendingSourceNodeName;
	if (typeof persisted === "string" && persisted.length <= 256) {
		return persisted;
	}
	return `live-${createHash("sha256").update(`${instanceId}\0${node.id}\0${node.name}`).digest("hex").slice(0, 24)}`;
}

/** Detects live additions, removals, reparents, and transform differences without changing the scene or source asset. */
export async function inspectPrefabInstanceStructure(scene: Scene, data: any): Promise<any> {
	const selected = getPrefabInstanceNode(scene, data);
	const scope = livePrefabInstanceScope(scene, selected);
	const selectedLink = selectRuntimePrefabLink(selected, data.targetPath);
	const targetPath = selectedLink.link.path;
	const resolution = await resolvePrefabDocument(resolvePrefabPath(targetPath));
	const expectedNodes = serializedPrefabNodes(resolution.document);
	const expectedByName = new Map(expectedNodes.map((node) => [sourceNodeName(node), node]));
	const expectedById = new Map(expectedNodes.map((node) => [node.id, node]));
	const expectedParent = new Map(
		expectedNodes.map((node) => [sourceNodeName(node), node.parentId && expectedById.has(node.parentId) ? sourceNodeName(expectedById.get(node.parentId)) : null])
	);
	const linkedByName = new Map<string, any[]>();
	for (const node of scope.nodes) {
		const link = runtimePrefabLinkForPath(node, targetPath);
		if (link) {
			const matches = linkedByName.get(link.sourceNodeName) ?? [];
			matches.push(node);
			linkedByName.set(link.sourceNodeName, matches);
		}
	}
	for (const matches of linkedByName.values()) {
		matches.sort((a, b) => a.uniqueId - b.uniqueId || a.id.localeCompare(b.id));
	}
	const canonicalLive = new Map([...linkedByName.entries()].map(([name, nodes]) => [name, nodes[0]]));
	const removals: string[] = [];
	const reparents: { nodeName: string; parentNodeName: string | null }[] = [];
	const modified: { nodeName: string; properties: any }[] = [];
	const additions: IPrefabStructuralAddition[] = [];
	const additionNodeIds: Record<string, string> = {};
	const additionRuntimeBindings: Record<string, { nodeId: string; sourceNodeName: string; nestedLinks: IPrefabLink[] }[]> = {};
	const blockers: { nodeId: string | null; nodeName: string; message: string }[] = [];
	const rootSourceName = sourceNodeName(expectedNodes[0]);

	for (const [nodeName, expected] of expectedByName) {
		const live = canonicalLive.get(nodeName);
		if (!live) {
			if (nodeName === rootSourceName) {
				blockers.push({ nodeId: null, nodeName, message: "The prefab root is missing from the live hierarchy and cannot be captured as a removal." });
			} else {
				removals.push(nodeName);
			}
			continue;
		}
		const parentLink = live.parent ? runtimePrefabLinkForPath(live.parent, targetPath) : null;
		const liveParentName = parentLink?.sourceNodeName ?? null;
		if (nodeName !== rootSourceName && liveParentName !== expectedParent.get(nodeName)) {
			reparents.push({ nodeName, parentNodeName: liveParentName });
		}
		const properties = livePrefabNodeProperties(live);
		if (!prefabPropertiesEqual(expected, properties)) {
			modified.push({ nodeName, properties });
		}
	}

	const addedNames = new Map<any, string>();
	const additionCandidates: { node: any; cloneSourceNodeName?: string; prefabPath?: string; nestedInstanceId?: string }[] = [];
	for (const [sourceName, matches] of linkedByName) {
		if (!expectedByName.has(sourceName)) {
			for (const stale of matches) {
				blockers.push({
					nodeId: stale.id,
					nodeName: stale.name,
					message: `Live node "${stale.name}" still links to source identity "${sourceName}", which is not present in the current prefab revision. Reload or unpack the stale instance before capture.`,
				});
			}
			continue;
		}
		for (const duplicate of matches.slice(1)) {
			additionCandidates.push({ node: duplicate, cloneSourceNodeName: sourceName });
		}
	}
	for (const node of scope.nodes) {
		if (runtimePrefabLinkForPath(node, targetPath)) {
			continue;
		}
		const foreignInstanceId = node.metadata?.prefab?.instanceId;
		if (typeof foreignInstanceId === "string" && foreignInstanceId !== scope.instanceId) {
			const parentForeignId = node.parent?.metadata?.prefab?.instanceId;
			if (parentForeignId !== foreignInstanceId) {
				additionCandidates.push({
					node,
					prefabPath: relative(getProjectDirectory(), resolvePrefabPath(node.metadata.prefab.path)),
					nestedInstanceId: foreignInstanceId,
				});
			}
			continue;
		}
		if (node.parent && additionCandidates.some((candidate) => candidate.node === node.parent && candidate.prefabPath)) {
			continue;
		}
		additionCandidates.push({ node });
	}
	for (const candidate of additionCandidates) {
		addedNames.set(candidate.node, proposedLiveSourceName(scope.instanceId, candidate.node));
	}
	for (const candidate of additionCandidates) {
		const node = candidate.node;
		const parentLink = node.parent ? runtimePrefabLinkForPath(node.parent, targetPath) : null;
		const parentNodeName = parentLink?.sourceNodeName ?? addedNames.get(node.parent) ?? null;
		let kind: IPrefabStructuralAddition["kind"];
		let serializedMesh: any;
		if (candidate.prefabPath) {
			kind = "nestedPrefab";
		} else if (candidate.cloneSourceNodeName) {
			kind = "cloneMesh";
		} else if (node.getClassName?.() === "TransformNode" || (node.getClassName?.() === "Mesh" && !node.geometry)) {
			kind = "transform";
		} else {
			try {
				serializedMesh = await SceneSerializer.SerializeMesh(node, false, false);
				kind = "mesh";
			} catch (error: any) {
				blockers.push({ nodeId: node.id, nodeName: node.name, message: `Live mesh serialization failed: ${error.message}` });
				continue;
			}
		}
		const nodeName = addedNames.get(node)!;
		additionNodeIds[nodeName] = node.id;
		if (candidate.nestedInstanceId) {
			const nestedNodes = scope.nodes.filter((candidateNode: any) => candidateNode.metadata?.prefab?.instanceId === candidate.nestedInstanceId);
			additionRuntimeBindings[nodeName] = nestedNodes.map((nestedNode: any) => {
				const nestedLinks = getRuntimePrefabLinks(nestedNode as Mesh);
				const innerSourceName = nestedLinks[0].sourceNodeName;
				return {
					nodeId: nestedNode.id,
					sourceNodeName: nestedNode === node ? nodeName : `${nodeName}/${innerSourceName}`,
					nestedLinks,
				};
			});
		} else {
			additionRuntimeBindings[nodeName] = [{ nodeId: node.id, sourceNodeName: nodeName, nestedLinks: [] }];
		}
		additions.push({
			nodeName,
			displayName: node.name,
			parentNodeName,
			kind,
			...(candidate.cloneSourceNodeName ? { cloneSourceNodeName: candidate.cloneSourceNodeName } : {}),
			...(candidate.prefabPath ? { prefabPath: candidate.prefabPath } : {}),
			...(serializedMesh ? { serializedMesh } : {}),
			properties: livePrefabNodeProperties(node),
		});
	}

	const currentStructural = validateStructuralOverrides(resolution.document.metadata?.babylonEditorPrefabVariant?.structuralOverrides);
	const currentAdditionNames = new Set(currentStructural.additions.map((addition) => addition.nodeName));
	const proposedStructuralOverrides: IPrefabStructuralOverrides = structuredClone(currentStructural);
	for (const nodeName of removals) {
		if (currentAdditionNames.has(nodeName)) {
			blockers.push({ nodeId: null, nodeName, message: "Removing an addition authored by this variant must be done in Prefab Mode so dependent overrides can be reviewed." });
		} else if (!proposedStructuralOverrides.removals.includes(nodeName)) {
			proposedStructuralOverrides.removals.push(nodeName);
		}
	}
	for (const addition of additions) {
		if (!proposedStructuralOverrides.additions.some((entry) => entry.nodeName === addition.nodeName)) {
			proposedStructuralOverrides.additions.push(addition);
		}
	}
	for (const reparent of reparents) {
		const addition = proposedStructuralOverrides.additions.find((entry) => entry.nodeName === reparent.nodeName);
		if (addition) {
			addition.parentNodeName = reparent.parentNodeName;
		} else {
			const existing = proposedStructuralOverrides.reparents.find((entry) => entry.nodeName === reparent.nodeName);
			if (existing) {
				existing.parentNodeName = reparent.parentNodeName;
			} else {
				proposedStructuralOverrides.reparents.push(reparent);
			}
		}
	}
	const signature = createHash("sha256")
		.update(JSON.stringify({ removals, additions, reparents, modified, blockers: blockers.map((blocker) => blocker.message) }))
		.digest("hex");
	const publicAddition = (addition: IPrefabStructuralAddition): any => {
		if (!addition.serializedMesh) {
			return structuredClone(addition);
		}
		const geometryCount = (Object.values(addition.serializedMesh.geometries ?? {}) as unknown[]).reduce<number>(
			(count, entries) => count + (Array.isArray(entries) ? entries.length : 0),
			0
		);
		const rest = structuredClone(addition);
		delete rest.serializedMesh;
		return {
			...rest,
			serializedMeshSummary: {
				byteLength: JSON.stringify(addition.serializedMesh).length,
				meshCount: addition.serializedMesh.meshes?.length ?? 0,
				geometryCount,
				materialCount: (addition.serializedMesh.materials?.length ?? 0) + (addition.serializedMesh.multiMaterials?.length ?? 0),
			},
		};
	};
	const includeSerializedMeshData = data.includeSerializedMeshData === true;
	return {
		instanceId: scope.instanceId,
		rootNodeId: scope.root.id,
		rootNodeName: scope.root.name,
		targetPath,
		targetIndex: selectedLink.index,
		variant: resolution.variant,
		revision: prefabRevision(resolution.document),
		stale: resolution.stale,
		conflicts: resolution.conflicts,
		removals,
		additions: includeSerializedMeshData ? additions : additions.map(publicAddition),
		...(includeSerializedMeshData ? { additionNodeIds, additionRuntimeBindings } : {}),
		reparents,
		modified,
		blockers,
		proposedStructuralOverrides: includeSerializedMeshData
			? proposedStructuralOverrides
			: { ...proposedStructuralOverrides, additions: proposedStructuralOverrides.additions.map(publicAddition) },
		hasStructuralOverrides: removals.length > 0 || additions.length > 0 || reparents.length > 0,
		hasOverrides: removals.length > 0 || additions.length > 0 || reparents.length > 0 || modified.length > 0,
		signature,
	};
}

/** Captures detected live add/remove/reparent differences into one exact prefab variant revision. */
export async function capturePrefabInstanceStructure(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to capture live prefab structure into a variant asset.");
	}
	const inspection = await inspectPrefabInstanceStructure(scene, { ...data, includeSerializedMeshData: true });
	if (!inspection.variant) {
		throw new Error("Live structural capture requires an instantiated prefab variant. Create a variant before capturing instance-only structure.");
	}
	if (inspection.conflicts.length) {
		throw new Error("The target prefab variant has unresolved conflicts and cannot capture live structure.");
	}
	if (inspection.blockers.length) {
		throw new Error(`Live prefab structure has unsupported changes: ${inspection.blockers.map((blocker: any) => blocker.message).join(" ")}`);
	}
	if (typeof data.expectedRevision !== "string" || data.expectedRevision !== inspection.revision) {
		throw new Error("The prefab variant changed since inspection. Inspect live structure again and use its exact revision.");
	}
	if (!inspection.hasStructuralOverrides) {
		return { captured: false, reason: "No live structural differences were detected.", ...inspection };
	}
	const result = await setPrefabVariantStructure(scene, {
		path: inspection.targetPath,
		expectedRevision: inspection.revision,
		structuralOverrides: inspection.proposedStructuralOverrides,
		confirm: true,
	});
	for (const addition of inspection.additions) {
		for (const binding of inspection.additionRuntimeBindings[addition.nodeName] ?? []) {
			const node = [...scene.meshes, ...scene.transformNodes].find((candidate: any) => candidate.id === binding.nodeId);
			if (!node) {
				continue;
			}
			node.metadata ??= {};
			node.metadata.babylonEditorPrefabPendingSourceNodeName = binding.sourceNodeName;
			node.metadata.babylonEditorPrefabSourceNodeName = binding.sourceNodeName;
			const nestedLinks = structuredClone(binding.nestedLinks) as IPrefabLink[];
			if (nestedLinks.length) {
				nestedLinks[0].boundarySourceNodeName = addition.nodeName;
				node.metadata.babylonEditorNestedPrefabPath = addition.prefabPath;
				node.metadata.babylonEditorNestedPrefabLinks = nestedLinks;
			}
			const links: IPrefabLink[] = [{ path: inspection.targetPath, sourceNodeName: binding.sourceNodeName }, ...nestedLinks];
			node.metadata.prefab = {
				...(node.metadata.prefab ?? {}),
				path: inspection.targetPath,
				version: 2,
				instanceId: inspection.instanceId,
				sourceNodeName: binding.sourceNodeName,
				links,
			};
		}
	}
	void options.editor.layout.graph.refresh();
	options.editor.layout.inspector.forceUpdate();
	return {
		captured: true,
		instanceId: inspection.instanceId,
		targetPath: inspection.targetPath,
		previousRevision: inspection.revision,
		revision: result.revision,
		capturedCounts: {
			removals: inspection.removals.length,
			additions: inspection.additions.length,
			reparents: inspection.reparents.length,
		},
		modifiedTransformCount: inspection.modified.length,
	};
}

/** Compares detected live override signatures across bounded instances of one prefab asset. */
export async function comparePrefabInstances(scene: Scene, data: any): Promise<any> {
	const targetPath = relative(getProjectDirectory(), resolvePrefabPath(data.path));
	const query = typeof data.query === "string" ? data.query.trim().toLowerCase() : "";
	const limit = Math.min(200, Math.max(1, data.limit ?? 50));
	const matchingRoots = [...scene.meshes, ...scene.transformNodes]
		.filter((node: any) => node.metadata?.prefab?.path === targetPath && node.metadata?.prefab?.instanceId)
		.filter((node: any) => !node.parent || node.parent.metadata?.prefab?.instanceId !== node.metadata.prefab.instanceId)
		.filter((node: any) => !query || `${node.name} ${node.id} ${node.metadata.prefab.instanceId}`.toLowerCase().includes(query));
	const roots = matchingRoots.slice(0, limit);
	const instances: any[] = [];
	for (const root of roots) {
		const inspection = await inspectPrefabInstanceStructure(scene, { nodeId: root.id, targetPath });
		instances.push({
			instanceId: inspection.instanceId,
			rootNodeId: inspection.rootNodeId,
			rootNodeName: inspection.rootNodeName,
			signature: inspection.signature,
			removalCount: inspection.removals.length,
			additionCount: inspection.additions.length,
			reparentCount: inspection.reparents.length,
			modifiedCount: inspection.modified.length,
			blockerCount: inspection.blockers.length,
			hasOverrides: inspection.hasOverrides,
		});
	}
	const groups = new Map<string, string[]>();
	for (const instance of instances) {
		const group = groups.get(instance.signature) ?? [];
		group.push(instance.instanceId);
		groups.set(instance.signature, group);
	}
	return {
		path: targetPath,
		query,
		instances,
		instanceCount: instances.length,
		signatureGroups: [...groups.entries()].map(([signature, instanceIds]) => ({ signature, instanceIds, count: instanceIds.length })),
		distinctSignatureCount: groups.size,
		truncated: matchingRoots.length > limit,
		limit,
	};
}

function applyVariantPropertyChanges(document: any, resolution: IPrefabVariantResolution, sourceName: string, properties: any): void {
	applyPrefabProperties(findSerializedPrefabNodes(document, sourceName)[0], properties);
	if (!resolution.variant) {
		return;
	}
	const metadata = document.metadata.babylonEditorPrefabVariant;
	const rootName = sourceNodeName(document.meshes[0]);
	if (sourceName === rootName) {
		metadata.rootOverrides = { ...(metadata.rootOverrides ?? {}), ...properties };
	} else {
		const overrides = validateVariantNodeOverrides(metadata.nodeOverrides ?? []);
		const existing = overrides.find((entry) => entry.nodeName === sourceName);
		if (existing) {
			existing.properties = { ...existing.properties, ...properties };
		} else {
			overrides.push({ nodeName: sourceName, properties });
		}
		metadata.nodeOverrides = overrides;
	}
}

function applyVariantComponentChanges(document: any, resolution: IPrefabVariantResolution, sourceName: string, changes: any[]): { action: string; componentKey: string }[] {
	if (changes.length > 64) {
		throw new Error("componentChanges must contain at most 64 entries.");
	}
	const node = findSerializedPrefabNodes(document, sourceName)[0];
	const applied: { action: string; componentKey: string }[] = [];
	const metadata = resolution.variant ? document.metadata.babylonEditorPrefabVariant : null;
	const componentOverrides = validateComponentOverrides(metadata?.componentOverrides);
	const propertyOverrides = validatePropertyOverrides(metadata?.propertyOverrides ?? []);
	const seen = new Set<string>();
	for (const [index, raw] of changes.entries()) {
		const componentKey = validateComponentKey(raw?.componentKey, `componentChanges[${index}].componentKey`);
		if (seen.has(componentKey)) {
			throw new Error("componentChanges must not contain duplicate component keys.");
		}
		seen.add(componentKey);
		if (raw?.action === "set") {
			const value = validatePropertyValue(raw.value, `componentChanges[${index}].value`);
			validateKnownComponent(componentKey, value, `componentChanges[${index}].value`);
			node.metadata ??= {};
			const exists = Object.prototype.hasOwnProperty.call(node.metadata, componentKey);
			node.metadata[componentKey] = structuredClone(value);
			if (metadata) {
				const addition = componentOverrides.additions.find((entry) => entry.nodeName === sourceName && entry.componentKey === componentKey);
				componentOverrides.removals = componentOverrides.removals.filter((entry) => !(entry.nodeName === sourceName && entry.componentKey === componentKey));
				if (addition) {
					addition.value = structuredClone(value);
				} else if (!exists) {
					componentOverrides.additions.push({ nodeName: sourceName, componentKey, value: structuredClone(value) });
				} else {
					const path = `/metadata/${componentKey.replace(/~/g, "~0").replace(/\//g, "~1")}`;
					const property = propertyOverrides.find((entry) => entry.nodeName === sourceName && entry.path === path);
					if (property) {
						property.value = structuredClone(value);
					} else {
						propertyOverrides.push({ nodeName: sourceName, path, value: structuredClone(value) });
					}
				}
			}
			applied.push({ action: "set", componentKey });
		} else if (raw?.action === "remove") {
			if (!node.metadata || !Object.prototype.hasOwnProperty.call(node.metadata, componentKey)) {
				throw new Error(`Component "${componentKey}" does not exist on source node "${sourceName}".`);
			}
			delete node.metadata[componentKey];
			if (metadata) {
				const wasAdded = componentOverrides.additions.some((entry) => entry.nodeName === sourceName && entry.componentKey === componentKey);
				componentOverrides.additions = componentOverrides.additions.filter((entry) => !(entry.nodeName === sourceName && entry.componentKey === componentKey));
				if (!wasAdded && !componentOverrides.removals.some((entry) => entry.nodeName === sourceName && entry.componentKey === componentKey)) {
					componentOverrides.removals.push({ nodeName: sourceName, componentKey });
				}
				const path = `/metadata/${componentKey.replace(/~/g, "~0").replace(/\//g, "~1")}`;
				for (let propertyIndex = propertyOverrides.length - 1; propertyIndex >= 0; propertyIndex--) {
					if (propertyOverrides[propertyIndex].nodeName === sourceName && propertyOverrides[propertyIndex].path === path) {
						propertyOverrides.splice(propertyIndex, 1);
					}
				}
			}
			applied.push({ action: "remove", componentKey });
		} else {
			throw new Error(`componentChanges[${index}].action must be set or remove.`);
		}
	}
	if (metadata) {
		metadata.componentOverrides = componentOverrides;
		metadata.propertyOverrides = propertyOverrides;
	}
	return applied;
}

/** Applies selected live transform/visibility and component values to one exact outer or nested prefab source boundary. */
export async function applyPrefabInstanceBoundary(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to apply live prefab instance values into a source asset.");
	}
	const node = getPrefabInstanceNode(scene, data);
	const { link, index } = selectRuntimePrefabLink(node, data.targetPath);
	const path = resolvePrefabPath(link.path);
	const resolution = await resolvePrefabDocument(path);
	if (resolution.conflicts.length) {
		throw new Error("The selected prefab source has unresolved conflicts. Repair it before applying instance values.");
	}
	const revision = prefabRevision(resolution.document);
	if (typeof data.expectedRevision !== "string" || data.expectedRevision !== revision) {
		throw new Error("The selected prefab source changed since inspection. Inspect instance links again and use its exact revision.");
	}
	const matches = findSerializedPrefabNodes(resolution.document, link.sourceNodeName);
	if (matches.length !== 1) {
		throw new Error(`The selected source boundary no longer contains one unique node named "${link.sourceNodeName}".`);
	}
	const properties = data.transformVisibility === false ? {} : rootProperties(node);
	if (Object.keys(properties).length) {
		applyVariantPropertyChanges(resolution.document, resolution, link.sourceNodeName, properties);
	}
	const changes = Array.isArray(data.componentChanges) ? data.componentChanges : [];
	if (!Object.keys(properties).length && !changes.length) {
		throw new Error("Select transformVisibility and/or provide at least one componentChanges entry.");
	}
	const componentChanges = applyVariantComponentChanges(resolution.document, resolution, link.sourceNodeName, changes);
	if (resolution.variant) {
		resolution.document.metadata.babylonEditorPrefabVariant.version = 2;
		resolution.document.metadata.babylonEditorPrefabVariant.baseRevision = resolution.baseRevision;
	}
	await writeJSON(path, resolution.document, { encoding: "utf-8", spaces: "\t" });
	options.editor.layout.inspector.forceUpdate();
	return {
		applied: true,
		targetPath: link.path,
		targetIndex: index,
		sourceNodeName: link.sourceNodeName,
		properties,
		componentChanges,
		previousRevision: revision,
		revision: prefabRevision(resolution.document),
	};
}

/** Reverts selected live values from one exact outer or nested prefab source boundary without writing assets. */
export async function revertPrefabInstanceBoundary(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to replace live instance values from a prefab source boundary.");
	}
	const node = getPrefabInstanceNode(scene, data);
	const { link, index } = selectRuntimePrefabLink(node, data.targetPath);
	const resolution = await resolvePrefabDocument(resolvePrefabPath(link.path));
	const revision = prefabRevision(resolution.document);
	if (typeof data.expectedRevision !== "string" || data.expectedRevision !== revision) {
		throw new Error("The selected prefab source changed since inspection. Inspect instance links again and use its exact revision.");
	}
	if (resolution.conflicts.length) {
		throw new Error("The selected prefab source has unresolved conflicts and cannot be used for revert.");
	}
	const matches = findSerializedPrefabNodes(resolution.document, link.sourceNodeName);
	if (matches.length !== 1) {
		throw new Error(`The selected source boundary no longer contains one unique node named "${link.sourceNodeName}".`);
	}
	const source = matches[0];
	const properties =
		data.transformVisibility === false
			? {}
			: {
					position: structuredClone(source.position),
					rotation: structuredClone(source.rotation),
					scaling: structuredClone(source.scaling),
					visibility: source.visibility,
					isVisible: source.isVisible,
				};
	if (Object.keys(properties).length) {
		applyRootProperties(node, properties);
	}
	const componentKeys = Array.isArray(data.componentKeys)
		? data.componentKeys.map((key: unknown, keyIndex: number) => validateComponentKey(key, `componentKeys[${keyIndex}]`))
		: [];
	if (!Object.keys(properties).length && !componentKeys.length) {
		throw new Error("Select transformVisibility and/or provide at least one componentKeys entry.");
	}
	node.metadata ??= {};
	for (const componentKey of componentKeys) {
		if (source.metadata && Object.prototype.hasOwnProperty.call(source.metadata, componentKey)) {
			node.metadata[componentKey] = structuredClone(source.metadata[componentKey]);
		} else {
			delete node.metadata[componentKey];
		}
	}
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { reverted: true, targetPath: link.path, targetIndex: index, sourceNodeName: link.sourceNodeName, revision, properties, componentKeys };
}

/** Detaches an instantiated prefab hierarchy while optionally preserving deeper nested prefab links. */
export async function unpackPrefabInstance(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to unpack a live prefab instance hierarchy.");
	}
	if (!["outermost", "completely"].includes(data.mode)) {
		throw new Error("mode must be outermost or completely.");
	}
	const selected = getPrefabInstanceNode(scene, data);
	const selection = selectRuntimePrefabLink(selected, data.targetPath);
	const instanceId = selected.metadata.prefab.instanceId;
	const candidates = [...scene.meshes, ...scene.transformNodes].filter(
		(node: any) => node.metadata?.prefab && (instanceId ? node.metadata.prefab.instanceId === instanceId : node.metadata.prefab.path === selected.metadata.prefab.path)
	);
	const nodes = candidates.filter((node: any) => node === selected || node.isDescendantOf(selected));
	let detached = 0;
	let preservedNested = 0;
	for (const node of nodes) {
		const links = getRuntimePrefabLinks(node as Mesh);
		const boundaryIndex = links.findIndex((entry) => entry.path === selection.link.path);
		if (boundaryIndex === -1) {
			continue;
		}
		const remaining = data.mode === "completely" ? [] : links.slice(boundaryIndex + 1);
		if (remaining.length) {
			node.metadata.prefab = {
				...node.metadata.prefab,
				path: remaining[0].path,
				sourceNodeName: remaining[0].sourceNodeName,
				links: remaining,
				version: 2,
			};
			preservedNested++;
		} else {
			delete node.metadata.prefab;
			delete node.metadata.babylonEditorPrefabSourceNodeName;
			delete node.metadata.babylonEditorPrefabAddedNode;
			delete node.metadata.babylonEditorPrefabAddedKind;
			delete node.metadata.babylonEditorNestedPrefabPath;
			delete node.metadata.babylonEditorNestedPrefabLinks;
			detached++;
		}
	}
	options.editor.layout.inspector.setEditedObject(selected);
	options.editor.layout.inspector.forceUpdate();
	await options.editor.layout.graph.refresh();
	return { unpacked: true, mode: data.mode, targetPath: selection.link.path, selectedNodeId: selected.id, affectedNodes: nodes.length, detached, preservedNested };
}

function upsertNodeOverride(overrides: { nodeName: string; properties: any }[], entry: { nodeName: string; properties: any }): void {
	const existing = overrides.find((candidate) => candidate.nodeName === entry.nodeName);
	if (existing) {
		existing.properties = { ...existing.properties, ...entry.properties };
	} else {
		overrides.push(structuredClone(entry));
	}
}

function upsertPropertyOverride(overrides: IPrefabPropertyOverride[], entry: IPrefabPropertyOverride): void {
	const existing = overrides.find((candidate) => candidate.nodeName === entry.nodeName && candidate.path === entry.path);
	if (existing) {
		existing.value = structuredClone(entry.value);
	} else {
		overrides.push(structuredClone(entry));
	}
}

/** Promotes containing-variant overrides into one selected nested prefab source asset and removes the promoted copies from the container. */
export async function promotePrefabInstanceBoundaryOverrides(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("confirm must be true to promote nested prefab overrides into their source asset.");
	}
	const selected = getPrefabInstanceNode(scene, data);
	const links = getRuntimePrefabLinks(selected);
	const target = selectRuntimePrefabLink(selected, data.targetPath);
	if (target.index === 0) {
		throw new Error("Override promotion requires a nested source boundary, not the outermost instance asset.");
	}
	const containerLink = links[target.index - 1];
	const boundaryName = target.link.boundarySourceNodeName;
	if (!boundaryName) {
		throw new Error("The selected nested source boundary has no stable containing-boundary identity.");
	}
	const categories = Array.isArray(data.categories) ? data.categories : [];
	if (!categories.length || categories.length > 4 || categories.some((entry: unknown) => !["transforms", "properties", "components", "structure"].includes(String(entry)))) {
		throw new Error("categories must select one or more of transforms, properties, components, or structure.");
	}
	if (new Set(categories).size !== categories.length) {
		throw new Error("categories must not contain duplicates.");
	}
	const containerPath = resolvePrefabPath(containerLink.path);
	const targetPath = resolvePrefabPath(target.link.path);
	if (containerPath === targetPath) {
		throw new Error("Containing and target prefab assets must be different files.");
	}
	const containerResolution = await resolvePrefabDocument(containerPath);
	const targetResolution = await resolvePrefabDocument(targetPath);
	const containerRevision = prefabRevision(containerResolution.document);
	const targetRevision = prefabRevision(targetResolution.document);
	if (data.expectedContainerRevision !== containerRevision || data.expectedTargetRevision !== targetRevision) {
		throw new Error("A containing or target prefab source changed since inspection. Inspect instance links again and use both exact revisions.");
	}
	if (!containerResolution.variant) {
		throw new Error("The containing prefab source is not a variant and has no variant override set to promote.");
	}
	if (containerResolution.conflicts.length || targetResolution.conflicts.length) {
		throw new Error("Containing and target prefab sources must be conflict-free before override promotion.");
	}
	const containerMetadata = containerResolution.document.metadata.babylonEditorPrefabVariant;
	const containerNodeOverrides = validateVariantNodeOverrides(containerMetadata.nodeOverrides ?? []);
	const containerPropertyOverrides = validatePropertyOverrides(containerMetadata.propertyOverrides ?? []);
	const containerComponentOverrides = validateComponentOverrides(containerMetadata.componentOverrides);
	const containerStructure = validateStructuralOverrides(containerMetadata.structuralOverrides);
	const targetRootName = sourceNodeName(targetResolution.document.meshes[0]);
	const promotedAdditionNames = new Set<string>();
	if (categories.includes("structure")) {
		let changed = true;
		while (changed) {
			changed = false;
			for (const addition of containerStructure.additions) {
				if (
					!promotedAdditionNames.has(addition.nodeName) &&
					(addition.parentNodeName === boundaryName ||
						addition.parentNodeName?.startsWith(`${boundaryName}/`) ||
						promotedAdditionNames.has(addition.parentNodeName ?? ""))
				) {
					promotedAdditionNames.add(addition.nodeName);
					changed = true;
				}
			}
		}
	}
	const translate = (name: string | null): string | null | undefined => {
		if (name === null) {
			return null;
		}
		if (name === boundaryName) {
			return targetRootName;
		}
		if (name.startsWith(`${boundaryName}/`)) {
			return name.slice(boundaryName.length + 1);
		}
		if (promotedAdditionNames.has(name)) {
			return name;
		}
		return undefined;
	};
	const promotedNodeOverrides = categories.includes("transforms")
		? containerNodeOverrides.filter((entry) => translate(entry.nodeName) !== undefined).map((entry) => ({ nodeName: translate(entry.nodeName)!, properties: entry.properties }))
		: [];
	const promotedProperties = categories.includes("properties")
		? containerPropertyOverrides
				.filter((entry) => translate(entry.nodeName) !== undefined)
				.map((entry) => ({ nodeName: translate(entry.nodeName)!, path: entry.path, value: entry.value }))
		: [];
	const promotedComponents: IPrefabComponentOverrides = categories.includes("components")
		? {
				additions: containerComponentOverrides.additions
					.filter((entry) => translate(entry.nodeName) !== undefined)
					.map((entry) => ({ ...entry, nodeName: translate(entry.nodeName)! })),
				removals: containerComponentOverrides.removals
					.filter((entry) => translate(entry.nodeName) !== undefined)
					.map((entry) => ({ ...entry, nodeName: translate(entry.nodeName)! })),
			}
		: { additions: [], removals: [] };
	const promotedStructure: IPrefabStructuralOverrides = categories.includes("structure")
		? {
				removals: containerStructure.removals.filter((name) => name !== boundaryName && translate(name) !== undefined).map((name) => translate(name)!),
				additions: containerStructure.additions
					.filter((entry) => promotedAdditionNames.has(entry.nodeName))
					.map((entry) => ({ ...entry, nodeName: translate(entry.nodeName)!, parentNodeName: translate(entry.parentNodeName)! })),
				reparents: containerStructure.reparents
					.filter((entry) => translate(entry.nodeName) !== undefined && translate(entry.parentNodeName) !== undefined)
					.map((entry) => ({ nodeName: translate(entry.nodeName)!, parentNodeName: translate(entry.parentNodeName)! })),
			}
		: { removals: [], additions: [], reparents: [] };
	const promotedCount =
		promotedNodeOverrides.length +
		promotedProperties.length +
		promotedComponents.additions.length +
		promotedComponents.removals.length +
		promotedStructure.removals.length +
		promotedStructure.additions.length +
		promotedStructure.reparents.length;
	if (!promotedCount) {
		throw new Error("No selected containing-variant overrides target the chosen nested prefab boundary.");
	}

	const targetRaw = await readRawPrefab(targetPath);
	const containerRaw = await readRawPrefab(containerPath);
	let targetResult: any;
	try {
		if (targetResolution.variant) {
			const targetMetadata = targetResolution.document.metadata.babylonEditorPrefabVariant;
			const rootOverrides = validatePrefabProperties(targetMetadata.rootOverrides ?? {}, "rootOverrides");
			const nodeOverrides = validateVariantNodeOverrides(targetMetadata.nodeOverrides ?? []);
			for (const entry of promotedNodeOverrides) {
				if (entry.nodeName === targetRootName) {
					Object.assign(rootOverrides, entry.properties);
				} else {
					upsertNodeOverride(nodeOverrides, entry);
				}
			}
			const propertyOverrides = validatePropertyOverrides(targetMetadata.propertyOverrides ?? []);
			for (const entry of promotedProperties) {
				upsertPropertyOverride(propertyOverrides, entry);
			}
			const componentOverrides = validateComponentOverrides(targetMetadata.componentOverrides);
			for (const entry of promotedComponents.additions) {
				componentOverrides.removals = componentOverrides.removals.filter(
					(candidate) => !(candidate.nodeName === entry.nodeName && candidate.componentKey === entry.componentKey)
				);
				const existing = componentOverrides.additions.find((candidate) => candidate.nodeName === entry.nodeName && candidate.componentKey === entry.componentKey);
				if (existing) {
					existing.value = structuredClone(entry.value);
				} else {
					componentOverrides.additions.push(structuredClone(entry));
				}
			}
			for (const entry of promotedComponents.removals) {
				componentOverrides.additions = componentOverrides.additions.filter(
					(candidate) => !(candidate.nodeName === entry.nodeName && candidate.componentKey === entry.componentKey)
				);
				if (!componentOverrides.removals.some((candidate) => candidate.nodeName === entry.nodeName && candidate.componentKey === entry.componentKey)) {
					componentOverrides.removals.push(structuredClone(entry));
				}
			}
			const structuralOverrides = validateStructuralOverrides(targetMetadata.structuralOverrides);
			structuralOverrides.removals = [...new Set([...structuralOverrides.removals, ...promotedStructure.removals])];
			for (const entry of promotedStructure.additions) {
				if (structuralOverrides.additions.some((candidate) => candidate.nodeName === entry.nodeName)) {
					throw new Error(`Target variant already has a structural addition named "${entry.nodeName}".`);
				}
				structuralOverrides.additions.push(structuredClone(entry));
			}
			for (const entry of promotedStructure.reparents) {
				const existing = structuralOverrides.reparents.find((candidate) => candidate.nodeName === entry.nodeName);
				if (existing) {
					existing.parentNodeName = entry.parentNodeName;
				} else {
					structuralOverrides.reparents.push(structuredClone(entry));
				}
			}
			targetResult = await setPrefabVariantOverrides(scene, {
				path: target.link.path,
				expectedRevision: targetRevision,
				rootOverrides,
				nodeOverrides,
				propertyOverrides,
				componentOverrides,
				structuralOverrides,
				confirm: true,
			});
		} else {
			const document = structuredClone(targetResolution.document);
			const conflicts: IPrefabVariantResolution["conflicts"] = [];
			await applyStructuralOverrides(document, promotedStructure, conflicts, [targetPath]);
			for (const entry of promotedNodeOverrides) {
				const matches = findSerializedPrefabNodes(document, entry.nodeName);
				if (matches.length !== 1) {
					throw new Error(`Promoted transform target "${entry.nodeName}" is missing or ambiguous in the nested source.`);
				}
				applyPrefabProperties(matches[0], entry.properties);
			}
			for (const entry of promotedProperties) {
				const matches = findSerializedPrefabNodes(document, entry.nodeName);
				if (matches.length !== 1) {
					throw new Error(`Promoted property target "${entry.nodeName}" is missing or ambiguous in the nested source.`);
				}
				applyPropertyOverride(matches[0], entry);
			}
			applyComponentOverrides(document, promotedComponents, conflicts);
			if (conflicts.length) {
				throw new Error(`Promoted overrides conflict with the nested source: ${conflicts.map((entry) => entry.message).join(" ")}`);
			}
			await writeJSON(targetPath, document, { encoding: "utf-8", spaces: "\t" });
			targetResult = { previousRevision: targetRevision, revision: prefabRevision(document) };
		}

		const freshContainerRaw = await readRawPrefab(containerPath);
		if (prefabRevision(freshContainerRaw) !== prefabRevision(containerRaw)) {
			throw new Error("The containing prefab file changed while promoting overrides. The target source was restored; inspect and retry.");
		}
		const freshContainer = await resolvePrefabDocument(containerPath);
		const filteredNodeOverrides = categories.includes("transforms")
			? containerNodeOverrides.filter((entry) => translate(entry.nodeName) === undefined)
			: containerNodeOverrides;
		const filteredPropertyOverrides = categories.includes("properties")
			? containerPropertyOverrides.filter((entry) => translate(entry.nodeName) === undefined)
			: containerPropertyOverrides;
		const filteredComponentOverrides: IPrefabComponentOverrides = categories.includes("components")
			? {
					additions: containerComponentOverrides.additions.filter((entry) => translate(entry.nodeName) === undefined),
					removals: containerComponentOverrides.removals.filter((entry) => translate(entry.nodeName) === undefined),
				}
			: containerComponentOverrides;
		const filteredStructure: IPrefabStructuralOverrides = categories.includes("structure")
			? {
					removals: containerStructure.removals.filter((name) => !promotedStructure.removals.includes(translate(name) ?? "")),
					additions: containerStructure.additions.filter((entry) => !promotedAdditionNames.has(entry.nodeName)),
					reparents: containerStructure.reparents.filter(
						(entry) =>
							!promotedStructure.reparents.some(
								(promoted) => promoted.nodeName === translate(entry.nodeName) && promoted.parentNodeName === translate(entry.parentNodeName)
							)
					),
				}
			: containerStructure;
		const containerResult = await setPrefabVariantOverrides(scene, {
			path: containerLink.path,
			expectedRevision: prefabRevision(freshContainer.document),
			rootOverrides: freshContainer.document.metadata.babylonEditorPrefabVariant.rootOverrides ?? {},
			nodeOverrides: filteredNodeOverrides,
			propertyOverrides: filteredPropertyOverrides,
			componentOverrides: filteredComponentOverrides,
			structuralOverrides: filteredStructure,
			confirm: true,
		});
		options.editor.layout.inspector.forceUpdate();
		return {
			promoted: true,
			containerPath: containerLink.path,
			targetPath: target.link.path,
			boundarySourceNodeName: boundaryName,
			categories,
			counts: {
				transforms: promotedNodeOverrides.length,
				properties: promotedProperties.length,
				componentAdditions: promotedComponents.additions.length,
				componentRemovals: promotedComponents.removals.length,
				structuralRemovals: promotedStructure.removals.length,
				structuralAdditions: promotedStructure.additions.length,
				structuralReparents: promotedStructure.reparents.length,
			},
			targetRevision: targetResult.revision,
			containerRevision: containerResult.revision,
		};
	} catch (error) {
		await writeJSON(targetPath, targetRaw, { encoding: "utf-8", spaces: "\t" });
		throw error;
	}
}
function findSerializedPrefabNode(prefab: any, node: Mesh): any {
	const name = node.metadata?.prefab?.sourceNodeName ?? node.name.replace(/ \(Prefab\)$/, "");
	const matches = findSerializedPrefabNodes(prefab, name);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `The linked prefab has multiple source nodes named "${name}".` : `The linked prefab has no serialized source node named "${name}".`);
	}
	return matches[0];
}
function rootProperties(node: Mesh): any {
	return { position: node.position.asArray(), rotation: node.rotation.asArray(), scaling: node.scaling.asArray(), visibility: node.visibility, isVisible: node.isVisible };
}
function applyRootProperties(node: Mesh, properties: any): void {
	if (properties.position) {
		node.position.set(properties.position[0], properties.position[1], properties.position[2]);
	}
	if (properties.rotation) {
		node.rotation.set(properties.rotation[0], properties.rotation[1], properties.rotation[2]);
	}
	if (properties.scaling) {
		node.scaling.set(properties.scaling[0], properties.scaling[1], properties.scaling[2]);
	}
	if (properties.visibility !== undefined) {
		node.visibility = properties.visibility;
	}
	if (properties.isVisible !== undefined) {
		node.isVisible = properties.isVisible;
	}
}

/** Applies a prefab instance root's transform/visibility override back to its linked prefab asset. */
export async function applyPrefabInstanceRoot(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = getPrefabInstanceRoot(scene, data);
	const path = resolvePrefabPath(root.metadata.prefab.path);
	const properties = rootProperties(root);
	await setPrefabAssetNodeProperties(scene, { path, sourceNodeName: root.metadata.prefab.sourceNodeName, properties, confirm: true });
	options.editor.layout.inspector.forceUpdate();
	return { applied: true, path: relative(getProjectDirectory(), path), nodeId: root.id, properties };
}

/** Reverts a prefab instance root's transform/visibility from its linked prefab asset. */
export async function revertPrefabInstanceRoot(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = getPrefabInstanceRoot(scene, data);
	const path = resolvePrefabPath(root.metadata.prefab.path);
	const prefab = await getPrefab(scene, { path });
	if (!prefab.meshes?.[0]) {
		throw new Error("Linked prefab contains no mesh root.");
	}
	const properties = {
		position: prefab.meshes[0].position,
		rotation: prefab.meshes[0].rotation,
		scaling: prefab.meshes[0].scaling,
		visibility: prefab.meshes[0].visibility,
		isVisible: prefab.meshes[0].isVisible,
	};
	applyRootProperties(root, properties);
	options.editor.layout.inspector.setEditedObject(root);
	options.editor.layout.inspector.forceUpdate();
	return { reverted: true, path: relative(getProjectDirectory(), path), nodeId: root.id, properties };
}

/** Applies a nested prefab mesh node's transform/visibility into its linked prefab asset. */
export async function applyPrefabInstanceNode(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = getPrefabInstanceNode(scene, data);
	const path = resolvePrefabPath(node.metadata.prefab.path);
	const properties = rootProperties(node);
	await setPrefabAssetNodeProperties(scene, { path, sourceNodeName: node.metadata.prefab.sourceNodeName, properties, confirm: true });
	options.editor.layout.inspector.forceUpdate();
	return { applied: true, path: relative(getProjectDirectory(), path), nodeId: node.id, sourceNodeName: node.metadata.prefab.sourceNodeName, properties };
}

/** Reverts a nested prefab mesh node's transform/visibility from its linked prefab asset. */
export async function revertPrefabInstanceNode(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = getPrefabInstanceNode(scene, data);
	const path = resolvePrefabPath(node.metadata.prefab.path);
	const prefab = await getPrefab(scene, { path });
	const serialized = findSerializedPrefabNode(prefab, node);
	const properties = {
		position: serialized.position,
		rotation: serialized.rotation,
		scaling: serialized.scaling,
		visibility: serialized.visibility,
		isVisible: serialized.isVisible,
	};
	applyRootProperties(node, properties);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { reverted: true, path: relative(getProjectDirectory(), path), nodeId: node.id, sourceNodeName: node.metadata.prefab.sourceNodeName, properties };
}

export async function instantiatePrefab(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const path = resolvePrefabPath(data.path);
	const resolution = await resolvePrefabDocument(path);
	if (resolution.conflicts.length) {
		throw new Error("Prefab variant has unresolved rebase conflicts and cannot be instantiated. Inspect the variant before loading it.");
	}
	const prefab = resolution.document;
	const result = await SceneLoader.ImportMeshAsync("", "", `data:${JSON.stringify(prefab)}`, scene, undefined, ".babylon");
	const meshes = result.meshes.filter((mesh) => mesh instanceof AbstractMesh) as AbstractMesh[];
	const transformNodes = result.transformNodes ?? [];
	if (!meshes.length) {
		throw new Error(`Prefab contains no mesh data: ${data.path}`);
	}

	const root = meshes[0];
	const instanceNodes = [...meshes, ...transformNodes];
	const sourceNodeNames = new Map(instanceNodes.map((node) => [node, node.metadata?.babylonEditorPrefabSourceNodeName ?? node.name]));
	const instanceId = Tools.RandomId();
	const outerPath = relative(getProjectDirectory(), path);
	const linksForNode = (node: any): IPrefabLink[] => [
		{ path: outerPath, sourceNodeName: sourceNodeNames.get(node)! },
		...(Array.isArray(node.metadata?.babylonEditorNestedPrefabLinks) ? structuredClone(node.metadata.babylonEditorNestedPrefabLinks) : []),
	];
	root.name = data.name ?? `${prefab.metadata?.babylonEditorPrefab?.rootName ?? root.name} (Prefab)`;
	root.id = Tools.RandomId();
	root.uniqueId = UniqueNumber.Get();
	root.metadata ??= {};
	root.metadata.prefab = {
		path: outerPath,
		version: 2,
		instanceId,
		sourceNodeName: sourceNodeNames.get(root),
		variantOf: prefab.metadata?.babylonEditorPrefabVariant?.basePath,
		links: linksForNode(root),
	};

	for (const node of [...meshes.slice(1), ...transformNodes]) {
		node.id = Tools.RandomId();
		node.uniqueId = UniqueNumber.Get();
		node.metadata ??= {};
		node.metadata.prefab = {
			path: outerPath,
			version: 2,
			instanceId,
			sourceNodeName: sourceNodeNames.get(node),
			variantOf: prefab.metadata?.babylonEditorPrefabVariant?.basePath,
			links: linksForNode(node),
		};
	}

	if (data.position && "position" in root) {
		(root as any).position.set(data.position[0], data.position[1], data.position[2]);
	}

	await options.editor.layout.graph.refresh();
	options.editor.layout.graph.setSelectedNode(root);
	options.editor.layout.inspector.setEditedObject(root);

	return {
		path: relative(getProjectDirectory(), path),
		variant: resolution.variant,
		dynamicallyRebased: resolution.stale,
		root: toNodeSummary(root),
		meshes: meshes.map(toNodeSummary),
		transformNodes: transformNodes.map(toNodeSummary),
	};
}
