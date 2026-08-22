import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { createHash } from "crypto";
import { copy, ensureDir, move, pathExists, readJSON, remove, writeJSON } from "fs-extra";

import { Scene, Tools } from "babylonjs";
import {
	ComputeNodeValueType,
	getComputeNodeInputTypes,
	getComputeNodeOutputType,
	IComputeNodeGraph,
	IComputeNodeGraphEdge,
	IComputeNodeGraphNode,
	IComputeNodeSubgraphInstance,
	IComputeNodeSubgraphPort,
	validateComputeNodeGraphFragment,
} from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { getCustomComputeNodeGraph, setCustomComputeNodeGraph } from "./compute-graph";

const assetType = "babylon-editor-compute-subgraph";
const currentAssetVersion = 2 as const;

interface IComputeSubgraphAsset {
	version: 1 | 2;
	type: typeof assetType;
	name: string;
	nodes: IComputeNodeGraphNode[];
	edges: IComputeNodeGraphEdge[];
	inputs: IComputeNodeSubgraphPort[];
	output: { nodeId: string; port: "value"; type: ComputeNodeValueType };
}

interface IComputeSubgraphMigration {
	sourceVersion: 1 | 2;
	targetVersion: 2;
	migrationRequired: boolean;
	steps: Array<{ id: "v1-select-to-typed-branch"; message: string; changedNodeIds: string[]; createdNodeIds: string[] }>;
	asset: IComputeSubgraphAsset;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function assetPath(path: unknown): string {
	if (typeof path !== "string" || !path.trim()) {
		throw new Error("Compute subgraph asset path must be a non-empty project-relative path.");
	}
	if (isAbsolute(path)) {
		throw new Error("Compute subgraph asset paths must be relative to the open project.");
	}
	const root = projectDirectory();
	const absolutePath = normalize(join(root, path));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
		throw new Error("Compute subgraph asset paths must stay inside the open project directory.");
	}
	if (!absolutePath.toLowerCase().endsWith(".computegraph.json")) {
		throw new Error("Compute subgraph assets must use the .computegraph.json extension.");
	}
	return absolutePath;
}

function boundaryInputs(nodes: IComputeNodeGraphNode[], edges: IComputeNodeGraphEdge[]): Array<Omit<IComputeNodeSubgraphPort, "name">> {
	const connected = new Set(edges.map((edge) => `${edge.to}.${edge.toPort}`));
	return nodes.flatMap((node) =>
		Object.entries(getComputeNodeInputTypes(node.type))
			.filter(([port]) => !connected.has(`${node.id}.${port}`))
			.map(([port, type]) => ({ nodeId: node.id, port, type }))
	);
}

function validateAsset(value: any, path: string, supportedVersions: Array<1 | 2> = [currentAssetVersion]): IComputeSubgraphAsset {
	if (!supportedVersions.includes(value?.version) || value?.type !== assetType || typeof value.name !== "string" || !value.name.trim()) {
		throw new Error(`Compute subgraph asset at ${path} is invalid or uses an unsupported version.`);
	}
	if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.inputs) || !value.output) {
		throw new Error(`Compute subgraph asset at ${path} is missing nodes, edges, inputs, or output.`);
	}
	const fragment: IComputeNodeGraph = { version: 1, nodes: value.nodes, edges: value.edges };
	validateComputeNodeGraphFragment(fragment);
	const expectedInputs = boundaryInputs(fragment.nodes, fragment.edges);
	if (value.inputs.length !== expectedInputs.length) {
		throw new Error(`Compute subgraph asset at ${path} does not describe every boundary input exactly once.`);
	}
	const names = new Set<string>();
	const keys = new Set<string>();
	for (const input of value.inputs as IComputeNodeSubgraphPort[]) {
		if (!input?.name?.trim()) {
			throw new Error(`Compute subgraph asset at ${path} has an empty input name.`);
		}
		if (names.has(input.name)) {
			throw new Error(`Compute subgraph asset at ${path} has duplicate input name "${input.name}".`);
		}
		names.add(input.name);
		const key = `${input.nodeId}.${input.port}`;
		if (keys.has(key)) {
			throw new Error(`Compute subgraph asset at ${path} describes boundary input "${key}" more than once.`);
		}
		keys.add(key);
		const expected = expectedInputs.find((candidate) => candidate.nodeId === input.nodeId && candidate.port === input.port);
		if (!expected || input.type !== expected.type) {
			throw new Error(`Compute subgraph asset at ${path} has invalid boundary input "${key}".`);
		}
	}
	const outputNode = fragment.nodes.find((node) => node.id === value.output.nodeId);
	const outputType = outputNode && getComputeNodeOutputType(outputNode.type);
	if (!outputNode || value.output.port !== "value" || !outputType || value.output.type !== outputType) {
		throw new Error(`Compute subgraph asset at ${path} has an invalid typed output.`);
	}
	const reachesOutput = new Set([outputNode.id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of fragment.edges) {
			if (reachesOutput.has(edge.to) && !reachesOutput.has(edge.from)) {
				reachesOutput.add(edge.from);
				changed = true;
			}
		}
	}
	if (reachesOutput.size !== fragment.nodes.length) {
		throw new Error(`Compute subgraph asset at ${path} contains nodes that do not contribute to its output.`);
	}
	return structuredClone(value) as IComputeSubgraphAsset;
}

function revision(asset: unknown): string {
	return createHash("sha256").update(JSON.stringify(asset)).digest("hex");
}

function uniqueNodeId(existing: Set<string>, base: string): string {
	let value = base;
	let suffix = 2;
	while (existing.has(value)) {
		value = `${base}_${suffix++}`;
	}
	existing.add(value);
	return value;
}

function migrateAsset(value: any, path: string): IComputeSubgraphMigration {
	const source = validateAsset(value, path, [1, 2]);
	if (source.version === currentAssetVersion) {
		return { sourceVersion: currentAssetVersion, targetVersion: currentAssetVersion, migrationRequired: false, steps: [], asset: source };
	}
	const asset = structuredClone(source);
	asset.version = currentAssetVersion;
	const existingIds = new Set(asset.nodes.map((node) => node.id));
	const changedNodeIds: string[] = [];
	const createdNodeIds: string[] = [];
	for (const node of asset.nodes.filter((candidate) => candidate.type === "select")) {
		const compareId = uniqueNodeId(existingIds, `${node.id}__condition`);
		const thresholdId = uniqueNodeId(existingIds, `${node.id}__threshold`);
		node.type = "branch";
		changedNodeIds.push(node.id);
		createdNodeIds.push(compareId, thresholdId);
		const incomingCondition = asset.edges.find((edge) => edge.to === node.id && edge.toPort === "condition");
		if (incomingCondition) {
			incomingCondition.to = compareId;
			incomingCondition.toPort = "a";
		}
		for (const input of asset.inputs) {
			if (input.nodeId === node.id && input.port === "condition") {
				input.nodeId = compareId;
				input.port = "a";
			}
		}
		asset.nodes.push(
			{ id: compareId, type: "compare", position: [node.position[0] - 100, node.position[1] + 60], comparison: "greaterEqual" },
			{ id: thresholdId, type: "constant-color", position: [node.position[0] - 220, node.position[1] + 120], value: [0.5, 0.5, 0.5, 0.5] }
		);
		asset.edges.push({ from: thresholdId, fromPort: "value", to: compareId, toPort: "b" }, { from: compareId, fromPort: "value", to: node.id, toPort: "condition" });
	}
	const migrated = validateAsset(asset, path);
	return {
		sourceVersion: 1,
		targetVersion: currentAssetVersion,
		migrationRequired: true,
		steps: [
			{
				id: "v1-select-to-typed-branch",
				message: changedNodeIds.length
					? `Converted ${changedNodeIds.length} numeric select node(s) to typed comparison and branch control.`
					: "Advanced the asset schema; no legacy select nodes required semantic conversion.",
				changedNodeIds,
				createdNodeIds,
			},
		],
		asset: migrated,
	};
}

async function readAsset(path: unknown): Promise<{
	asset: IComputeSubgraphAsset;
	absolutePath: string;
	relativePath: string;
	revision: string;
	sourceRevision: string;
	migration: IComputeSubgraphMigration;
}> {
	const absolutePath = assetPath(path);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Compute subgraph asset not found: ${path}`);
	}
	const source = await readJSON(absolutePath);
	const migration = migrateAsset(source, String(path));
	return {
		asset: migration.asset,
		absolutePath,
		relativePath: relative(projectDirectory(), absolutePath),
		revision: revision(migration.asset),
		sourceRevision: revision(source),
		migration,
	};
}

function summary(asset: IComputeSubgraphAsset, path: string, migration?: IComputeSubgraphMigration): any {
	return {
		path,
		name: asset.name,
		version: asset.version,
		sourceVersion: migration?.sourceVersion ?? asset.version,
		migrationRequired: migration?.migrationRequired ?? false,
		revision: revision(asset),
		nodeCount: asset.nodes.length,
		edgeCount: asset.edges.length,
		inputs: structuredClone(asset.inputs),
		output: structuredClone(asset.output),
	};
}

/** Saves selected pure nodes from a compute pass as a reusable project-local graph-function asset. */
export async function saveCustomComputeSubgraph(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = assetPath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) {
		throw new Error(`Compute subgraph asset exists at ${data.path}. Set overwrite: true to replace it.`);
	}
	if (!Array.isArray(data.nodeIds) || !data.nodeIds.length) {
		throw new Error("Saving a compute subgraph requires at least one selected node id.");
	}
	if (new Set(data.nodeIds).size !== data.nodeIds.length) {
		throw new Error("Compute subgraph node ids must be unique.");
	}
	const source = getCustomComputeNodeGraph(scene, data);
	if (!source.graph) {
		throw new Error("The selected compute pass has no node graph.");
	}
	const selectedIds = new Set<string>(data.nodeIds);
	const nodes = source.graph.nodes.filter((node: IComputeNodeGraphNode) => selectedIds.has(node.id));
	if (nodes.length !== selectedIds.size) {
		throw new Error("One or more selected compute subgraph node ids were not found in the pass graph.");
	}
	const edges = source.graph.edges.filter((edge: IComputeNodeGraphEdge) => selectedIds.has(edge.from) && selectedIds.has(edge.to));
	const fragment: IComputeNodeGraph = { version: 1, nodes: structuredClone(nodes), edges: structuredClone(edges) };
	validateComputeNodeGraphFragment(fragment);
	const outputNode = fragment.nodes.find((node) => node.id === data.outputNodeId);
	const outputType = outputNode && getComputeNodeOutputType(outputNode.type);
	if (!outputNode || !outputType) {
		throw new Error("Compute subgraph outputNodeId must select one value-producing node in the saved fragment.");
	}
	const inputNames = data.inputNames ?? {};
	const boundary = boundaryInputs(fragment.nodes, fragment.edges);
	const boundaryKeys = new Set(boundary.map((input) => `${input.nodeId}.${input.port}`));
	for (const key of Object.keys(inputNames)) {
		if (!boundaryKeys.has(key)) {
			throw new Error(`Compute subgraph inputNames contains unknown boundary input "${key}".`);
		}
	}
	const inputs = boundary.map((input) => ({
		...input,
		name: inputNames[`${input.nodeId}.${input.port}`] ?? `${input.nodeId}.${input.port}`,
	}));
	const asset = validateAsset(
		{
			version: currentAssetVersion,
			type: assetType,
			name: data.assetName?.trim() || outputNode.id,
			nodes: fragment.nodes,
			edges: fragment.edges,
			inputs,
			output: { nodeId: outputNode.id, port: "value", type: outputType },
		},
		data.path
	);
	await ensureDir(dirname(absolutePath));
	await writeJSON(absolutePath, asset, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return summary(asset, relative(projectDirectory(), absolutePath));
}

/** Lists valid reusable compute-subgraph assets in the open project. */
export async function listCustomComputeSubgraphs(): Promise<any> {
	const root = projectDirectory();
	const paths = await normalizedGlob(join(root, "**/*.computegraph.json"), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] });
	const assets: any[] = [];
	for (const path of (paths as string[]).sort()) {
		try {
			const migration = migrateAsset(await readJSON(path), path);
			assets.push(summary(migration.asset, relative(root, path), migration));
		} catch {
			// Ignore malformed files so one unrelated JSON asset does not hide the valid library.
		}
	}
	return { assets };
}

/** Reads one reusable compute-subgraph asset without changing the scene. */
export async function getCustomComputeSubgraph(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return { ...summary(value.asset, value.relativePath, value.migration), migration: value.migration.steps, asset: value.asset };
}

/** Reports deterministic schema/semantic migration steps without changing the asset file. */
export async function getCustomComputeSubgraphMigration(_scene: Scene, data: any): Promise<any> {
	const value = await readAsset(data.path);
	return {
		path: value.relativePath,
		name: value.asset.name,
		sourceVersion: value.migration.sourceVersion,
		targetVersion: value.migration.targetVersion,
		migrationRequired: value.migration.migrationRequired,
		sourceRevision: value.sourceRevision,
		targetRevision: value.revision,
		steps: structuredClone(value.migration.steps),
		backupPath: value.migration.migrationRequired ? `${value.relativePath}.v${value.migration.sourceVersion}.${value.sourceRevision.slice(0, 12)}.bak` : null,
	};
}

/** Atomically upgrades one legacy asset to the current schema after optionally writing a content-addressed backup. */
export async function migrateCustomComputeSubgraph(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	if (!value.migration.migrationRequired) {
		return { migrated: false, path: value.relativePath, version: currentAssetVersion, revision: value.revision, backupPath: null, steps: [] };
	}
	const backupPath = `${value.absolutePath}.v${value.migration.sourceVersion}.${value.sourceRevision.slice(0, 12)}.bak`;
	if (data.backup !== false && !(await pathExists(backupPath))) {
		await copy(value.absolutePath, backupPath, { overwrite: false, errorOnExist: true });
	}
	const temporaryPath = `${value.absolutePath}.migrating`;
	try {
		await writeJSON(temporaryPath, value.asset, { spaces: "\t", encoding: "utf-8" });
		validateAsset(await readJSON(temporaryPath), value.relativePath);
		await move(temporaryPath, value.absolutePath, { overwrite: true });
	} finally {
		if (await pathExists(temporaryPath)) {
			await remove(temporaryPath);
		}
	}
	options.editor.layout.assets.refresh();
	return {
		migrated: true,
		path: value.relativePath,
		version: currentAssetVersion,
		revision: value.revision,
		backupPath: data.backup === false ? null : relative(projectDirectory(), backupPath),
		steps: structuredClone(value.migration.steps),
	};
}

/** Deletes one reusable compute-subgraph asset. */
export async function deleteCustomComputeSubgraph(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	await remove(value.absolutePath);
	options.editor.layout.assets.refresh();
	return { deleted: true, path: value.relativePath, name: value.asset.name };
}

/** Inserts a renamed instance of a reusable graph fragment and returns its typed boundary ports for wiring. */
export async function insertCustomComputeSubgraph(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readAsset(data.path);
	const current = getCustomComputeNodeGraph(scene, data);
	if (!current.graph) {
		throw new Error("The selected compute pass has no node graph.");
	}
	const prefix =
		data.prefix?.trim() ||
		`subgraph_${Tools.RandomId()
			.replace(/[^A-Za-z0-9_]/g, "_")
			.slice(0, 12)}`;
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new Error("Compute subgraph instance prefix must be a WGSL-safe identifier.");
	}
	const instanceId = data.instanceId?.trim() || prefix;
	if (!instanceId) {
		throw new Error("Compute subgraph instance id must be non-empty.");
	}
	if ((current.graph.subgraphInstances ?? []).some((instance: IComputeNodeSubgraphInstance) => instance.id === instanceId || instance.prefix === prefix)) {
		throw new Error(`Compute subgraph instance id or prefix already exists: ${instanceId}`);
	}
	const existingIds = new Set<string>(current.graph.nodes.map((node: IComputeNodeGraphNode) => node.id));
	const id = (sourceId: string): string => `${prefix}_${sourceId}`;
	for (const node of value.asset.nodes) {
		if (existingIds.has(id(node.id))) {
			throw new Error(`Compute subgraph instance node id already exists: ${id(node.id)}`);
		}
	}
	const minimumX = Math.min(...value.asset.nodes.map((node) => node.position[0]));
	const minimumY = Math.min(...value.asset.nodes.map((node) => node.position[1]));
	const position: [number, number] = data.position ?? [40, 40];
	const nodes = value.asset.nodes.map((node) => ({
		...structuredClone(node),
		id: id(node.id),
		position: [position[0] + node.position[0] - minimumX, position[1] + node.position[1] - minimumY] as [number, number],
	}));
	const edges = value.asset.edges.map((edge) => ({ ...structuredClone(edge), from: id(edge.from), to: id(edge.to) }));
	const instance: IComputeNodeSubgraphInstance = {
		id: instanceId,
		prefix,
		assetPath: value.relativePath,
		assetName: value.asset.name,
		assetVersion: value.asset.version,
		assetRevision: value.revision,
		nodeIds: nodes.map((node) => node.id),
		inputs: value.asset.inputs.map((input) => ({ ...input, nodeId: id(input.nodeId) })),
		output: { name: "output", ...value.asset.output, nodeId: id(value.asset.output.nodeId) },
		position,
		collapsed: data.collapsed ?? true,
	};
	const graph: IComputeNodeGraph = {
		...structuredClone(current.graph),
		nodes: [...structuredClone(current.graph.nodes), ...nodes],
		edges: [...structuredClone(current.graph.edges), ...edges],
		subgraphInstances: [...structuredClone(current.graph.subgraphInstances ?? []), instance],
	};
	setCustomComputeNodeGraph(scene, { id: current.passId, graph, compile: false }, options);
	return {
		passId: current.passId,
		asset: summary(value.asset, value.relativePath, value.migration),
		instance: structuredClone(instance),
		prefix,
		insertedNodeIds: nodes.map((node) => node.id),
		inputs: structuredClone(instance.inputs),
		output: structuredClone(instance.output),
	};
}

function instanceGraph(scene: Scene, data: any): { passId: string; graph: IComputeNodeGraph; instance: IComputeNodeSubgraphInstance } {
	const current = getCustomComputeNodeGraph(scene, data);
	if (!current.graph) {
		throw new Error("The selected compute pass has no node graph.");
	}
	const instance = (current.graph.subgraphInstances ?? []).find((candidate: IComputeNodeSubgraphInstance) => candidate.id === data.instanceId);
	if (!instance) {
		throw new Error(`Compute subgraph instance not found: ${data.instanceId}`);
	}
	return { passId: current.passId, graph: current.graph, instance };
}

function externalConnections(
	graph: IComputeNodeGraph,
	instance: IComputeNodeSubgraphInstance
): { incoming: IComputeNodeGraphEdge[]; outgoing: IComputeNodeGraphEdge[]; unmanaged: IComputeNodeGraphEdge[] } {
	const owned = new Set(instance.nodeIds);
	const inputKeys = new Set(instance.inputs.map((input) => `${input.nodeId}.${input.port}`));
	const incoming: IComputeNodeGraphEdge[] = [];
	const outgoing: IComputeNodeGraphEdge[] = [];
	const unmanaged: IComputeNodeGraphEdge[] = [];
	for (const edge of graph.edges) {
		const fromOwned = owned.has(edge.from);
		const toOwned = owned.has(edge.to);
		if (!fromOwned && toOwned) {
			if (inputKeys.has(`${edge.to}.${edge.toPort}`)) {
				incoming.push(edge);
			} else {
				unmanaged.push(edge);
			}
		} else if (fromOwned && !toOwned) {
			if (edge.from === instance.output.nodeId) {
				outgoing.push(edge);
			} else {
				unmanaged.push(edge);
			}
		}
	}
	return { incoming, outgoing, unmanaged };
}

function compatibleInterface(instance: IComputeNodeSubgraphInstance, asset: IComputeSubgraphAsset): boolean {
	if (instance.output.type !== asset.output.type || instance.inputs.length !== asset.inputs.length) {
		return false;
	}
	return instance.inputs.every((input) => asset.inputs.some((candidate) => candidate.name === input.name && candidate.type === input.type));
}

/** Lists tracked expanded subgraph instances for one compute pass. */
export function listCustomComputeSubgraphInstances(scene: Scene, data: any): any {
	const current = getCustomComputeNodeGraph(scene, data);
	if (!current.graph) {
		throw new Error("The selected compute pass has no node graph.");
	}
	return { passId: current.passId, instances: structuredClone(current.graph.subgraphInstances ?? []) };
}

/** Updates call-node collapse state or moves the instance and every expanded child node together. */
export function setCustomComputeSubgraphInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = instanceGraph(scene, data);
	const next = structuredClone(current.graph);
	const instance = next.subgraphInstances!.find((candidate) => candidate.id === current.instance.id)!;
	if (data.position !== undefined) {
		if (!Array.isArray(data.position) || data.position.length !== 2 || data.position.some((coordinate: unknown) => !Number.isFinite(coordinate))) {
			throw new Error("Compute subgraph instance position must be a finite [x, y] pair.");
		}
		const delta = [data.position[0] - instance.position[0], data.position[1] - instance.position[1]];
		const owned = new Set(instance.nodeIds);
		next.nodes.forEach((node) => {
			if (owned.has(node.id)) {
				node.position = [node.position[0] + delta[0], node.position[1] + delta[1]];
			}
		});
		instance.position = structuredClone(data.position);
	}
	if (data.collapsed !== undefined) {
		instance.collapsed = Boolean(data.collapsed);
	}
	setCustomComputeNodeGraph(scene, { id: current.passId, graph: next, compile: false }, options);
	return { passId: current.passId, instance: structuredClone(instance) };
}

/** Reports missing/outdated dependencies, interface compatibility, and unmanaged instance-boundary connections. */
export async function getCustomComputeSubgraphDiagnostics(scene: Scene, data: any): Promise<any> {
	const current = getCustomComputeNodeGraph(scene, data);
	if (!current.graph) {
		throw new Error("The selected compute pass has no node graph.");
	}
	const diagnostics: any[] = [];
	for (const instance of current.graph.subgraphInstances ?? []) {
		const connections = externalConnections(current.graph, instance);
		try {
			const value = await readAsset(instance.assetPath);
			const compatible = compatibleInterface(instance, value.asset);
			diagnostics.push({
				instanceId: instance.id,
				assetPath: instance.assetPath,
				status: value.revision === instance.assetRevision ? "current" : "outdated",
				storedRevision: instance.assetRevision,
				assetRevision: value.revision,
				assetVersion: value.asset.version,
				sourceAssetVersion: value.migration.sourceVersion,
				assetMigrationRequired: value.migration.migrationRequired,
				interfaceCompatible: compatible,
				refreshable: compatible && connections.unmanaged.length === 0,
				incomingConnectionCount: connections.incoming.length,
				outgoingConnectionCount: connections.outgoing.length,
				unmanagedConnections: structuredClone(connections.unmanaged),
			});
		} catch (error) {
			diagnostics.push({
				instanceId: instance.id,
				assetPath: instance.assetPath,
				status: error instanceof Error && error.message.includes("not found") ? "missing" : "invalid",
				storedRevision: instance.assetRevision,
				assetRevision: null,
				interfaceCompatible: false,
				refreshable: false,
				incomingConnectionCount: connections.incoming.length,
				outgoingConnectionCount: connections.outgoing.length,
				unmanagedConnections: structuredClone(connections.unmanaged),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { passId: current.passId, ready: diagnostics.every((entry) => entry.status === "current" && entry.unmanagedConnections.length === 0), diagnostics };
}

/** Refreshes one expanded instance from its asset while preserving compatible external connections by interface name. */
export async function refreshCustomComputeSubgraphInstance(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const current = instanceGraph(scene, data);
	const value = await readAsset(current.instance.assetPath);
	if (!compatibleInterface(current.instance, value.asset)) {
		throw new Error("Compute subgraph asset interface changed incompatibly; insert a new instance and rewire it explicitly.");
	}
	const connections = externalConnections(current.graph, current.instance);
	if (connections.unmanaged.length) {
		throw new Error("Compute subgraph instance has external connections to internal non-interface nodes; remove them before refresh.");
	}
	const oldOwned = new Set(current.instance.nodeIds);
	const id = (sourceId: string): string => `${current.instance.prefix}_${sourceId}`;
	const minimumX = Math.min(...value.asset.nodes.map((node) => node.position[0]));
	const minimumY = Math.min(...value.asset.nodes.map((node) => node.position[1]));
	const nodes = value.asset.nodes.map((node) => ({
		...structuredClone(node),
		id: id(node.id),
		position: [current.instance.position[0] + node.position[0] - minimumX, current.instance.position[1] + node.position[1] - minimumY] as [number, number],
	}));
	const internalEdges = value.asset.edges.map((edge) => ({ ...structuredClone(edge), from: id(edge.from), to: id(edge.to) }));
	const inputs = value.asset.inputs.map((input) => ({ ...input, nodeId: id(input.nodeId) }));
	const output: IComputeNodeSubgraphPort = { name: "output", ...value.asset.output, nodeId: id(value.asset.output.nodeId) };
	const oldInputByKey = new Map(current.instance.inputs.map((input) => [`${input.nodeId}.${input.port}`, input]));
	const newInputByName = new Map(inputs.map((input) => [input.name, input]));
	const incoming = connections.incoming.map((edge) => {
		const oldInput = oldInputByKey.get(`${edge.to}.${edge.toPort}`)!;
		const replacement = newInputByName.get(oldInput.name)!;
		return { ...structuredClone(edge), to: replacement.nodeId, toPort: replacement.port };
	});
	const outgoing = connections.outgoing.map((edge) => ({ ...structuredClone(edge), from: output.nodeId }));
	const replacement: IComputeNodeSubgraphInstance = {
		...structuredClone(current.instance),
		assetName: value.asset.name,
		assetVersion: value.asset.version,
		assetRevision: value.revision,
		nodeIds: nodes.map((node) => node.id),
		inputs,
		output,
	};
	const graph: IComputeNodeGraph = {
		...structuredClone(current.graph),
		nodes: [...current.graph.nodes.filter((node) => !oldOwned.has(node.id)).map((node) => structuredClone(node)), ...nodes],
		edges: [
			...current.graph.edges.filter((edge) => !oldOwned.has(edge.from) && !oldOwned.has(edge.to)).map((edge) => structuredClone(edge)),
			...internalEdges,
			...incoming,
			...outgoing,
		],
		subgraphInstances: current.graph.subgraphInstances!.map((instance) => (instance.id === replacement.id ? replacement : structuredClone(instance))),
	};
	const result = setCustomComputeNodeGraph(scene, { id: current.passId, graph, compile: data.compile === true }, options);
	return { passId: current.passId, instance: structuredClone(replacement), compiled: data.compile === true, graph: result.graph };
}

/** Removes one tracked instance, its expanded nodes, and every incident connection. */
export function deleteCustomComputeSubgraphInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = instanceGraph(scene, data);
	const owned = new Set(current.instance.nodeIds);
	const removedConnections = current.graph.edges.filter((edge) => owned.has(edge.from) || owned.has(edge.to));
	const graph: IComputeNodeGraph = {
		...structuredClone(current.graph),
		nodes: current.graph.nodes.filter((node) => !owned.has(node.id)).map((node) => structuredClone(node)),
		edges: current.graph.edges.filter((edge) => !owned.has(edge.from) && !owned.has(edge.to)).map((edge) => structuredClone(edge)),
		subgraphInstances: current.graph.subgraphInstances!.filter((instance) => instance.id !== current.instance.id).map((instance) => structuredClone(instance)),
	};
	setCustomComputeNodeGraph(scene, { id: current.passId, graph, compile: false }, options);
	return { deleted: true, passId: current.passId, instanceId: current.instance.id, removedNodeIds: [...owned], removedConnectionCount: removedConnections.length };
}
