import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { mkdir, pathExists, readFile, readJSON, writeFile, writeJSON } from "fs-extra";

import { Scene, Tools, Vector3 } from "babylonjs";
import { CreateNavigationPluginAsync, WaitForFullTileCacheUpdate } from "babylonjs-addons";

import { getStaticMeshes } from "../../editor/layout/navmesh/tools";
import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";

import { IMCPActionOptions } from "../action";

type INavMeshArea = { id: number; name: string; cost: number };

function areas(configuration: any): INavMeshArea[] {
	const values = (configuration.areas ??= [{ id: 0, name: "Walkable", cost: 1 }]);
	if (!values.some((area: INavMeshArea) => area.id === 0)) values.unshift({ id: 0, name: "Walkable", cost: 1 });
	return values;
}

function validateAreas(values: unknown): asserts values is INavMeshArea[] {
	if (!Array.isArray(values) || !values.length || values.length > 64) throw new Error("NavMesh areas must contain from one to sixty-four entries.");
	const ids = new Set<number>();
	const names = new Set<string>();
	for (const area of values) {
		if (!Number.isInteger(area?.id) || area.id < 0 || area.id > 63) throw new Error("Every NavMesh area requires an integer id from 0 through 63.");
		if (!area.name?.trim() || area.name.trim().length > 64) throw new Error("Every NavMesh area requires a name from 1 through 64 characters.");
		if (!(area.cost > 0) || !Number.isFinite(area.cost) || area.cost > 1000)
			throw new Error("Every NavMesh area requires a finite traversal cost from greater than 0 through 1000.");
		if (ids.has(area.id) || names.has(area.name.trim().toLowerCase())) throw new Error("NavMesh area ids and names must be unique.");
		ids.add(area.id);
		names.add(area.name.trim().toLowerCase());
	}
	if (!ids.has(0)) throw new Error("NavMesh areas must include area 0 (Walkable).");
}

function getProjectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function resolveNavMeshPath(path: string): string {
	const directory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) throw new Error("NavMesh paths must stay inside the open project directory.");
	if (!absolutePath.endsWith(".navmesh")) throw new Error("NavMesh paths must end in .navmesh.");
	return absolutePath;
}

async function withNavigationPlugin<T>(path: string, callback: (plugin: any) => Promise<T> | T): Promise<T> {
	const absolutePath = resolveNavMeshPath(path);
	const dataPath = join(absolutePath, "navmesh.bin");
	if (!(await pathExists(dataPath))) throw new Error(`NavMesh data not found: ${path}. Rebuild the NavMesh first.`);
	const RecastCore = require("@recast-navigation/core");
	const RecastGenerators = require("@recast-navigation/generators");
	const plugin = await CreateNavigationPluginAsync({ instance: { ...RecastCore, ...RecastGenerators } });
	try {
		plugin.buildFromNavmeshData(new Uint8Array(await readFile(dataPath)));
		return await callback(plugin);
	} finally {
		plugin.dispose();
	}
}

function agents(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorNavAgents ??= []);
}
function findAgent(scene: Scene, data: any): any {
	const agent = agents(scene).find((value) => value.id === data.id);
	if (!agent) throw new Error(`Nav agent "${data.id}" was not found.`);
	return agent;
}
const agentObservers = new WeakMap<Scene, any>();
function ensureAgentPathFollowing(scene: Scene): void {
	if (agentObservers.has(scene)) return;
	agentObservers.set(
		scene,
		scene.onBeforeRenderObservable.add(() => {
			const deltaSeconds = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
			if (!deltaSeconds) return;
			for (const agent of agents(scene)) {
				if (!agent.isMoving || !agent.path?.length) continue;
				const node = scene.getNodeById(agent.nodeId) as any;
				if (!node?.position) {
					agent.isMoving = false;
					continue;
				}
				const waypoint = Vector3.FromArray(agent.path[agent.pathIndex ?? 0]);
				const delta = waypoint.subtract(node.position);
				const distance = delta.length();
				const travel = (agent.maxSpeed ?? 6) * 100 * deltaSeconds;
				if (distance <= travel || distance < 0.001) {
					node.position.copyFrom(waypoint);
					agent.pathIndex = (agent.pathIndex ?? 0) + 1;
					if (agent.pathIndex >= agent.path.length) agent.isMoving = false;
				} else {
					const avoidance = Vector3.Zero();
					for (const other of agents(scene)) {
						if (other === agent || other.avoidanceEnabled === false) continue;
						const otherNode = scene.getNodeById(other.nodeId) as any;
						if (!otherNode?.position) continue;
						const fromOther = node.position.subtract(otherNode.position);
						const otherDistance = fromOther.length();
						const range = Math.max(0.001, (agent.avoidanceRadius ?? agent.radius ?? 1) + (other.avoidanceRadius ?? other.radius ?? 1));
						if (otherDistance >= range) continue;
						if (otherDistance < 0.0001) fromOther.copyFromFloats(agent.id < other.id ? 1 : -1, 0, 0);
						else fromOther.scaleInPlace(1 / otherDistance);
						avoidance.addInPlace(fromOther.scale((1 - otherDistance / range) * (agent.avoidanceWeight ?? 1)));
					}
					const direction = delta.scale(1 / distance).add(avoidance);
					node.position.addInPlace(direction.lengthSquared() > 0.000001 ? direction.normalize().scale(travel) : delta.scale(travel / distance));
				}
			}
		})
	);
}

/** Restores the saved agent path follower after a scene is loaded. */
export function restoreNavAgents(scene: Scene): void {
	ensureAgentPathFollowing(scene);
}

async function getConfig(path: string): Promise<any> {
	const configPath = join(resolveNavMeshPath(path), "config.json");
	if (!(await pathExists(configPath))) throw new Error(`NavMesh configuration not found: ${path}`);
	const configuration = await readJSON(configPath, { encoding: "utf-8" });
	areas(configuration);
	return configuration;
}

function toOffMeshConnection(link: any): any {
	return {
		startPosition: { x: link.start[0], y: link.start[1], z: link.start[2] },
		endPosition: { x: link.end[0], y: link.end[1], z: link.end[2] },
		radius: link.radius,
		bidirectional: link.bidirectional,
		area: link.area,
		flags: link.flags,
		userId: link.userId,
	};
}

function links(configuration: any): any[] {
	return (configuration.offMeshLinks ??= []);
}

export async function listNavMeshes(): Promise<any> {
	const directory = getProjectDirectory();
	const paths = await normalizedGlob(join(directory, "/**/*.navmesh"), { nodir: false, ignore: ["**/node_modules/**"] });
	return { navMeshes: paths.map((path) => ({ path: relative(directory, path.toString()), hasConfig: true })) };
}

export async function getNavMesh(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const configuration = await getConfig(data.path);
	return {
		path: relative(getProjectDirectory(), absolutePath),
		configuration,
		hasNavMeshData: await pathExists(join(absolutePath, "navmesh.bin")),
		hasTileCacheData: await pathExists(join(absolutePath, "tilecache.bin")),
	};
}

export async function createNavMesh(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	if (await pathExists(absolutePath)) throw new Error(`An asset already exists at ${data.path}`);
	const configuration = data.configuration ?? {
		navMeshParameters: { ch: 1, cs: 10, walkableHeight: 1, walkableRadius: 1, keepIntermediates: true },
		staticMeshes: [],
		obstacleMeshes: [],
		areas: [{ id: 0, name: "Walkable", cost: 1 }],
	};
	areas(configuration);
	await mkdir(absolutePath, { recursive: true });
	await writeJSON(join(absolutePath, "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { created: true, path: relative(getProjectDirectory(), absolutePath), configuration };
}

export async function setNavMeshConfiguration(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const current = await getConfig(data.path);
	const configuration = { ...current, ...data.configuration, navMeshParameters: { ...current.navMeshParameters, ...(data.configuration?.navMeshParameters ?? {}) } };
	validateAreas(areas(configuration));
	await writeJSON(join(absolutePath, "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { path: relative(getProjectDirectory(), absolutePath), configuration };
}

/** Lists named traversal areas and costs for a NavMesh asset. Areas affect off-mesh links and path-query filters. */
export async function listNavMeshAreas(_scene: Scene, data: any): Promise<any> {
	const configuration = await getConfig(data.path);
	return { path: data.path, areas: structuredClone(areas(configuration)) };
}

/** Replaces named traversal areas and costs for a NavMesh asset. Rebuild if off-mesh-link area assignments changed. */
export async function setNavMeshAreas(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	validateAreas(data.areas);
	const configuration = await getConfig(data.path);
	configuration.areas = data.areas.map((area: INavMeshArea) => ({ id: area.id, name: area.name.trim(), cost: area.cost }));
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { path: data.path, areas: structuredClone(configuration.areas), rebuildRequired: true };
}

export async function rebuildNavMesh(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const configuration = await getConfig(data.path);
	const meshes = getStaticMeshes(scene, configuration.staticMeshes ?? []);
	if (!meshes.effectiveStaticMeshes.length) throw new Error("NavMesh requires at least one enabled static mesh.");
	const RecastCore = require("@recast-navigation/core");
	const RecastGenerators = require("@recast-navigation/generators");
	const plugin = await CreateNavigationPluginAsync({ instance: { ...RecastCore, ...RecastGenerators } });
	try {
		const navMeshParameters = { ...configuration.navMeshParameters, offMeshConnections: links(configuration).map(toOffMeshConnection) };
		const result = await plugin.createNavMeshAsync(meshes.effectiveStaticMeshes, navMeshParameters);
		if (!result) throw new Error("Recast did not produce a NavMesh result.");
		WaitForFullTileCacheUpdate(result.navMesh, result.tileCache);
		await Promise.all([
			writeFile(join(absolutePath, "navmesh.bin"), Buffer.from(plugin.getNavmeshData())),
			writeFile(join(absolutePath, "tilecache.bin"), Buffer.from(plugin.getTileCacheData())),
		]);
	} finally {
		meshes.clonedMeshes.forEach((mesh) => mesh.dispose(false, false));
		plugin.dispose();
	}
	options.editor.layout.assets.refresh();
	return { rebuilt: true, path: relative(getProjectDirectory(), absolutePath) };
}

/** Lists authored off-mesh links that will be embedded at the next NavMesh rebuild. */
export async function listNavMeshLinks(_scene: Scene, data: any): Promise<any> {
	const configuration = await getConfig(data.path);
	return { path: data.path, links: structuredClone(links(configuration)) };
}

/** Adds an authored off-mesh connection (jump, door, ladder, or teleport) to a NavMesh asset. */
export async function createNavMeshLink(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const link = {
		id: data.id ?? Tools.RandomId(),
		start: data.start,
		end: data.end,
		radius: data.radius ?? 10,
		bidirectional: data.bidirectional ?? true,
		area: data.area ?? 0,
		flags: data.flags ?? 1,
		userId: data.userId,
	};
	if (links(configuration).some((value) => value.id === link.id)) throw new Error(`Off-mesh link "${link.id}" already exists.`);
	links(configuration).push(link);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { ...structuredClone(link), navMeshPath: data.path, rebuildRequired: true };
}

/** Updates an authored off-mesh connection; rebuild the NavMesh afterwards to apply it. */
export async function setNavMeshLink(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const link = links(configuration).find((value) => value.id === data.id);
	if (!link) throw new Error(`Off-mesh link "${data.id}" was not found.`);
	for (const key of ["start", "end", "radius", "bidirectional", "area", "flags", "userId"] as const) if (data[key] !== undefined) link[key] = data[key];
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { ...structuredClone(link), navMeshPath: data.path, rebuildRequired: true };
}

/** Removes an authored off-mesh connection from a NavMesh asset. */
export async function deleteNavMeshLink(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const index = links(configuration).findIndex((value) => value.id === data.id);
	if (index === -1) throw new Error(`Off-mesh link "${data.id}" was not found.`);
	const [link] = links(configuration).splice(index, 1);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { deleted: true, id: link.id, navMeshPath: data.path, rebuildRequired: true };
}

export async function getNavMeshData(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const [navmesh, tileCache] = await Promise.all([readFile(join(absolutePath, "navmesh.bin")), readFile(join(absolutePath, "tilecache.bin"))]);
	return { navmeshBase64: navmesh.toString("base64"), tileCacheBase64: tileCache.toString("base64") };
}

/** Computes a real Recast path from a saved NavMesh asset. */
export async function computeNavMeshPath(_scene: Scene, data: any): Promise<any> {
	const start = Vector3.FromArray(data.start);
	const destination = Vector3.FromArray(data.destination);
	const configuration = await getConfig(data.path);
	const configuredAreas = areas(configuration);
	const overrides = data.areaCosts ?? {};
	const path = await withNavigationPlugin(data.path, (plugin) => {
		const RecastCore = require("@recast-navigation/core");
		const filter = new RecastCore.QueryFilter();
		for (const area of configuredAreas) {
			const cost = overrides[String(area.id)] ?? area.cost;
			if (!(cost > 0) || !Number.isFinite(cost) || cost > 1000) throw new Error(`NavMesh area ${area.id} requires a traversal cost from greater than 0 through 1000.`);
			filter.setAreaCost(area.id, cost);
		}
		return plugin.computePath(start, destination, { filter });
	});
	return {
		path: path.map((point: Vector3) => point.asArray()),
		pointCount: path.length,
		areaCosts: Object.fromEntries(configuredAreas.map((area) => [area.id, overrides[String(area.id)] ?? area.cost])),
	};
}

/** Lists persisted agent definitions and their latest planned Recast paths. */
export function listNavAgents(scene: Scene): any {
	return { agents: structuredClone(agents(scene)) };
}

/** Creates a navigation agent bound to an existing scene node and NavMesh asset. */
export async function createNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	ensureAgentPathFollowing(scene);
	const node = scene.getNodeById(data.nodeId);
	if (!node) throw new Error(`Agent node "${data.nodeId}" was not found.`);
	const id = data.id ?? Tools.RandomId();
	if (agents(scene).some((value) => value.id === id)) throw new Error(`Nav agent "${id}" already exists.`);
	const position = (node as any).getAbsolutePosition?.() ?? (node as any).position;
	if (!position) throw new Error("Nav agents require a transform node with a position.");
	const agent = {
		id,
		nodeId: node.id,
		navMeshPath: data.navMeshPath,
		radius: data.radius ?? 1,
		height: data.height ?? 2,
		maxSpeed: data.maxSpeed ?? 6,
		maxAcceleration: data.maxAcceleration ?? 8,
		avoidanceEnabled: data.avoidanceEnabled ?? true,
		avoidanceRadius: data.avoidanceRadius ?? data.radius ?? 1,
		avoidanceWeight: data.avoidanceWeight ?? 1,
		destination: null,
		path: [],
		pathIndex: 0,
		isMoving: false,
	};
	agents(scene).push(agent);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Updates persisted navigation-agent movement and local crowd-avoidance tuning. */
export function setNavAgent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const agent = findAgent(scene, data);
	for (const property of ["radius", "height", "maxSpeed", "maxAcceleration", "avoidanceEnabled", "avoidanceRadius", "avoidanceWeight"])
		if (data[property] !== undefined) agent[property] = data[property];
	if (!(agent.radius > 0) || !(agent.height > 0) || !(agent.maxSpeed > 0) || !(agent.maxAcceleration > 0) || !(agent.avoidanceRadius > 0) || !(agent.avoidanceWeight >= 0))
		throw new Error("Nav agents require positive radius, height, speed, acceleration, and avoidance radius, plus non-negative avoidance weight.");
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Plans a real Recast route for a persisted agent without forcing a runtime crowd controller. */
export async function setNavAgentDestination(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	const node = scene.getNodeById(agent.nodeId) as any;
	if (!node) throw new Error(`Agent node "${agent.nodeId}" no longer exists.`);
	const start = node.getAbsolutePosition?.() ?? node.position;
	const result = await computeNavMeshPath(scene, { path: agent.navMeshPath, start: start.asArray(), destination: data.destination });
	agent.destination = data.destination;
	agent.path = result.path;
	agent.pathIndex = result.path.length > 1 ? 1 : 0;
	agent.isMoving = data.startMoving ?? false;
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(agent), pointCount: result.pointCount };
}

/** Starts following a previously planned Recast route at the configured agent speed. */
export function startNavAgent(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureAgentPathFollowing(scene);
	const agent = findAgent(scene, data);
	if (!agent.path?.length || agent.path.length < 2) throw new Error("Plan an agent destination before starting movement.");
	agent.pathIndex = Math.min(Math.max(agent.pathIndex ?? 1, 1), agent.path.length - 1);
	agent.isMoving = true;
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Stops a live path follower without discarding its planned route. */
export function stopNavAgent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const agent = findAgent(scene, data);
	agent.isMoving = false;
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Removes a persisted navigation-agent definition. */
export function deleteNavAgent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const agent = findAgent(scene, data);
	agents(scene).splice(agents(scene).indexOf(agent), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}
