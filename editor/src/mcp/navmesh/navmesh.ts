import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { mkdir, pathExists, readFile, readJSON, writeFile, writeJSON } from "fs-extra";

import { Scene, Tools, Vector3 } from "babylonjs";
import { CreateNavigationPluginAsync } from "babylonjs-addons";
import {
	configureNavAgents,
	createNavMeshSurfaceMeshProcess,
	DynamicNavMeshObstacleManager,
	getNavigationCrowdController,
	INavAgentDefinition,
	INavCrowdConfiguration,
	INavigationPlugin,
	NavMeshRecastRuntime,
} from "babylonjs-editor-tools";

import { buildConfiguredNavMesh } from "../../editor/layout/navmesh/build";
import { getNavMeshSurfaceGeometry, getStaticMeshes } from "../../editor/layout/navmesh/tools";
import { INavMeshConfiguration } from "../../editor/layout/navmesh/types";
import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";

import { IMCPActionOptions } from "../action";

type INavMeshArea = { id: number; name: string; cost: number };

function areas(configuration: any): INavMeshArea[] {
	const values = (configuration.areas ??= [{ id: 0, name: "Walkable", cost: 1 }]);
	if (!values.some((area: INavMeshArea) => area.id === 0)) {
		values.unshift({ id: 0, name: "Walkable", cost: 1 });
	}
	return values;
}

function validateAreas(values: unknown): asserts values is INavMeshArea[] {
	if (!Array.isArray(values) || !values.length || values.length > 64) {
		throw new Error("NavMesh areas must contain from one to sixty-four entries.");
	}
	const ids = new Set<number>();
	const names = new Set<string>();
	for (const area of values) {
		if (!Number.isInteger(area?.id) || area.id < 0 || area.id > 63) {
			throw new Error("Every NavMesh area requires an integer id from 0 through 63.");
		}
		if (!area.name?.trim() || area.name.trim().length > 64) {
			throw new Error("Every NavMesh area requires a name from 1 through 64 characters.");
		}
		if (!(area.cost > 0) || !Number.isFinite(area.cost) || area.cost > 1000) {
			throw new Error("Every NavMesh area requires a finite traversal cost from greater than 0 through 1000.");
		}
		if (ids.has(area.id) || names.has(area.name.trim().toLowerCase())) {
			throw new Error("NavMesh area ids and names must be unique.");
		}
		ids.add(area.id);
		names.add(area.name.trim().toLowerCase());
	}
	if (!ids.has(0)) {
		throw new Error("NavMesh areas must include area 0 (Walkable).");
	}
}

function surfaces(configuration: INavMeshConfiguration): INavMeshConfiguration["staticMeshes"] {
	configuration.staticMeshes ??= [];
	for (const surface of configuration.staticMeshes) {
		surface.area ??= 0;
	}
	return configuration.staticMeshes;
}

function validateSurfaceAreas(configuration: INavMeshConfiguration): void {
	const configuredAreaIds = new Set(areas(configuration).map((area) => area.id));
	const surfaceIds = new Set<string>();
	for (const surface of surfaces(configuration)) {
		if (!surface.id?.trim()) {
			throw new Error("Every NavMesh surface requires a scene-node id.");
		}
		if (surfaceIds.has(surface.id)) {
			throw new Error(`NavMesh surface "${surface.id}" is configured more than once.`);
		}
		if (!Number.isInteger(surface.area) || !configuredAreaIds.has(surface.area!)) {
			throw new Error(`NavMesh surface "${surface.id}" references unknown area ${surface.area}.`);
		}
		surfaceIds.add(surface.id);
	}
	for (const link of configuration.offMeshLinks ?? []) {
		if (!configuredAreaIds.has(link.area)) {
			throw new Error(`Off-mesh link "${link.id}" references unknown area ${link.area}.`);
		}
	}
}

function obstacleConfigurations(configuration: INavMeshConfiguration): INavMeshConfiguration["obstacleMeshes"] {
	configuration.obstacleMeshes ??= [];
	return configuration.obstacleMeshes;
}

function normalizeObstacle(configuration: INavMeshConfiguration["obstacleMeshes"][number]): void {
	configuration.enabled ??= true;
	configuration.carving ??= true;
	configuration.dynamic ??= true;
	configuration.carveOnlyStationary ??= true;
	configuration.moveThreshold ??= 10;
	configuration.timeToStationary ??= 0.5;
	configuration.updateInterval ??= 0.1;
}

function validateObstacles(configuration: INavMeshConfiguration): void {
	const ids = new Set<string>();
	for (const obstacle of obstacleConfigurations(configuration)) {
		normalizeObstacle(obstacle);
		if (!obstacle.id?.trim() || ids.has(obstacle.id)) {
			throw new Error("Every NavMesh obstacle requires a unique scene-node id.");
		}
		if (obstacle.type !== "box" && obstacle.type !== "cylinder") {
			throw new Error(`NavMesh obstacle "${obstacle.id}" requires type box or cylinder.`);
		}
		if (
			!(obstacle.moveThreshold! > 0) ||
			!Number.isFinite(obstacle.moveThreshold) ||
			!(obstacle.timeToStationary! >= 0) ||
			!Number.isFinite(obstacle.timeToStationary) ||
			!(obstacle.updateInterval! > 0) ||
			!Number.isFinite(obstacle.updateInterval)
		) {
			throw new Error(`NavMesh obstacle "${obstacle.id}" has invalid carving thresholds or update interval.`);
		}
		ids.add(obstacle.id);
	}
}

function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveNavMeshPath(path: string): string {
	const directory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) {
		throw new Error("NavMesh paths must stay inside the open project directory.");
	}
	if (!absolutePath.endsWith(".navmesh")) {
		throw new Error("NavMesh paths must end in .navmesh.");
	}
	return absolutePath;
}

async function withNavigationPlugin<T>(path: string, callback: (plugin: any) => Promise<T> | T): Promise<T> {
	const absolutePath = resolveNavMeshPath(path);
	const dataPath = join(absolutePath, "navmesh.bin");
	if (!(await pathExists(dataPath))) {
		throw new Error(`NavMesh data not found: ${path}. Rebuild the NavMesh first.`);
	}
	const RecastCore = require("@recast-navigation/core");
	const RecastGenerators = require("@recast-navigation/generators");
	const recastRuntime = { ...RecastCore, ...RecastGenerators } as NavMeshRecastRuntime;
	await recastRuntime.init();
	const plugin = await CreateNavigationPluginAsync({ instance: recastRuntime });
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
	if (!agent) {
		throw new Error(`Nav agent "${data.id}" was not found.`);
	}
	return agent;
}

function crowds(scene: Scene): INavCrowdConfiguration[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorNavCrowds ??= []);
}

async function createEditorNavigationPlugin(path: string, scene: Scene): Promise<INavigationPlugin> {
	const configuration = await getConfig(path);
	const tileCachePath = join(resolveNavMeshPath(path), "tilecache.bin");
	if (!(await pathExists(tileCachePath))) {
		throw new Error(`NavMesh tile-cache data not found: ${path}. Rebuild the NavMesh before creating agents.`);
	}
	const RecastCore = require("@recast-navigation/core");
	const RecastGenerators = require("@recast-navigation/generators");
	const recastRuntime = { ...RecastCore, ...RecastGenerators } as NavMeshRecastRuntime;
	await recastRuntime.init();
	const plugin = await CreateNavigationPluginAsync({ instance: recastRuntime });
	const offMeshConnections = (configuration.offMeshLinks ?? []).map((link) => ({
		startPosition: Vector3.FromArray(link.start),
		endPosition: Vector3.FromArray(link.end),
		radius: link.radius,
		bidirectional: link.bidirectional,
		area: link.area,
		flags: link.flags,
		userId: link.userId,
	}));
	plugin.buildFromTileCacheData(
		new Uint8Array(await readFile(tileCachePath)),
		createNavMeshSurfaceMeshProcess(recastRuntime, configuration.surfaceAreaEncoding ?? [], offMeshConnections)
	);
	(plugin as any).obstacleManager = new DynamicNavMeshObstacleManager(plugin as any, scene as any, configuration.obstacleMeshes ?? []);
	(plugin as any).defaultAreaCosts = Object.fromEntries(areas(configuration).map((area) => [String(area.id), area.cost]));
	return plugin as unknown as INavigationPlugin;
}

/** Restores real Detour Crowd agents after a scene is loaded in the editor. */
export async function restoreNavAgents(scene: Scene): Promise<void> {
	await configureNavAgents(scene as any, "", (path) => createEditorNavigationPlugin(path, scene));
}

function getEditorCrowdController(scene: Scene): ReturnType<typeof getNavigationCrowdController> {
	return getNavigationCrowdController(scene as any);
}

async function getConfig(path: string): Promise<INavMeshConfiguration> {
	const configPath = join(resolveNavMeshPath(path), "config.json");
	if (!(await pathExists(configPath))) {
		throw new Error(`NavMesh configuration not found: ${path}`);
	}
	const configuration = (await readJSON(configPath, { encoding: "utf-8" })) as INavMeshConfiguration;
	areas(configuration);
	surfaces(configuration);
	validateObstacles(configuration);
	return configuration;
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
	if (await pathExists(absolutePath)) {
		throw new Error(`An asset already exists at ${data.path}`);
	}
	const configuration = data.configuration ?? {
		navMeshParameters: { ch: 1, cs: 10, walkableHeight: 1, walkableRadius: 1, keepIntermediates: true },
		staticMeshes: [],
		obstacleMeshes: [],
		areas: [{ id: 0, name: "Walkable", cost: 1 }],
	};
	areas(configuration);
	surfaces(configuration);
	validateSurfaceAreas(configuration);
	validateObstacles(configuration);
	await mkdir(absolutePath, { recursive: true });
	await writeJSON(join(absolutePath, "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { created: true, path: relative(getProjectDirectory(), absolutePath), configuration };
}

export async function setNavMeshConfiguration(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const current = await getConfig(data.path);
	const configuration = { ...current, ...data.configuration, navMeshParameters: { ...current.navMeshParameters, ...(data.configuration?.navMeshParameters ?? {}) } };
	if (data.configuration?.staticMeshes || data.configuration?.areas) {
		configuration.surfaceAreaEncoding = undefined;
	}
	validateAreas(areas(configuration));
	surfaces(configuration);
	validateSurfaceAreas(configuration);
	validateObstacles(configuration);
	await writeJSON(join(absolutePath, "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	if (data.configuration?.obstacleMeshes && getEditorCrowdController(_scene)) {
		try {
			await restoreNavAgents(_scene);
		} catch (error) {
			await writeJSON(join(absolutePath, "config.json"), current, { spaces: "\t", encoding: "utf-8" });
			throw error;
		}
	}
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
	const previousAreas = structuredClone(areas(configuration));
	const retainedAreaIds = new Set(data.areas.map((area: INavMeshArea) => area.id));
	const referencedSurface = surfaces(configuration).find((surface) => !retainedAreaIds.has(surface.area ?? 0));
	if (referencedSurface) {
		throw new Error(`Area ${referencedSurface.area} is still assigned to NavMesh surface "${referencedSurface.id}".`);
	}
	const referencedLink = links(configuration).find((link) => !retainedAreaIds.has(link.area));
	if (referencedLink) {
		throw new Error(`Area ${referencedLink.area} is still assigned to off-mesh link "${referencedLink.id}".`);
	}
	configuration.areas = data.areas.map((area: INavMeshArea) => ({ id: area.id, name: area.name.trim(), cost: area.cost }));
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	if (getEditorCrowdController(_scene)) {
		try {
			await restoreNavAgents(_scene);
		} catch (error) {
			configuration.areas = previousAreas;
			await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
			throw error;
		}
	}
	options.editor.layout.assets.refresh();
	return { path: data.path, areas: structuredClone(configuration.areas), rebuildRequired: true };
}

/** Lists every static source surface and its authored traversal area. */
export async function listNavMeshSurfaces(scene: Scene, data: any): Promise<any> {
	const configuration = await getConfig(data.path);
	return {
		path: data.path,
		surfaces: surfaces(configuration).map((surface) => {
			const node = scene.getNodeById(surface.id);
			return { ...structuredClone(surface), nodeName: node?.name ?? null, missing: !node };
		}),
	};
}

/** Paints one configured source surface with a named Detour area and requires a rebuild to apply the raster-time boundary. */
export async function setNavMeshSurfaceArea(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const area = areas(configuration).find((candidate) => candidate.id === data.area);
	if (!area) {
		throw new Error(`NavMesh area ${data.area} is not defined in "${data.path}".`);
	}
	const surface = surfaces(configuration).find((candidate) => candidate.id === data.nodeId);
	if (!surface) {
		throw new Error(`NavMesh surface "${data.nodeId}" is not configured in "${data.path}".`);
	}
	surface.area = area.id;
	configuration.surfaceAreaEncoding = undefined;
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { path: data.path, surface: structuredClone(surface), area: structuredClone(area), rebuildRequired: true };
}

export async function rebuildNavMesh(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveNavMeshPath(data.path);
	const configuration = await getConfig(data.path);
	validateSurfaceAreas(configuration);
	validateObstacles(configuration);
	const meshes = getStaticMeshes(scene, configuration.staticMeshes ?? []);
	if (!meshes.effectiveStaticMeshEntries.length) {
		throw new Error("NavMesh requires at least one enabled static mesh.");
	}
	const RecastCore = require("@recast-navigation/core");
	const RecastGenerators = require("@recast-navigation/generators");
	const recastRuntime = { ...RecastCore, ...RecastGenerators } as NavMeshRecastRuntime;
	await recastRuntime.init();
	const plugin = await CreateNavigationPluginAsync({ instance: recastRuntime });
	try {
		const geometry = getNavMeshSurfaceGeometry(meshes.effectiveStaticMeshEntries, configuration.navMeshParameters.doNotReverseIndices);
		const result = buildConfiguredNavMesh(plugin, recastRuntime, configuration, geometry);
		await Promise.all([
			writeJSON(join(absolutePath, "config.json"), configuration, { spaces: "\t", encoding: "utf-8" }),
			writeFile(join(absolutePath, "navmesh.bin"), Buffer.from(result.navMeshData)),
			writeFile(join(absolutePath, "tilecache.bin"), Buffer.from(result.tileCacheData)),
		]);
	} finally {
		meshes.clonedMeshes.forEach((mesh) => mesh.dispose(false, false));
		plugin.dispose();
	}
	if (getEditorCrowdController(scene)) {
		await restoreNavAgents(scene);
	}
	options.editor.layout.assets.refresh();
	return { rebuilt: true, path: relative(getProjectDirectory(), absolutePath), surfaceAreaEncoding: structuredClone(configuration.surfaceAreaEncoding ?? []) };
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
	if (links(configuration).some((value) => value.id === link.id)) {
		throw new Error(`Off-mesh link "${link.id}" already exists.`);
	}
	links(configuration).push(link);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { ...structuredClone(link), navMeshPath: data.path, rebuildRequired: true };
}

/** Updates an authored off-mesh connection; rebuild the NavMesh afterwards to apply it. */
export async function setNavMeshLink(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const link = links(configuration).find((value) => value.id === data.id);
	if (!link) {
		throw new Error(`Off-mesh link "${data.id}" was not found.`);
	}
	for (const key of ["start", "end", "radius", "bidirectional", "area", "flags", "userId"] as const) {
		if (data[key] !== undefined) {
			link[key] = data[key];
		}
	}
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { ...structuredClone(link), navMeshPath: data.path, rebuildRequired: true };
}

/** Removes an authored off-mesh connection from a NavMesh asset. */
export async function deleteNavMeshLink(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const index = links(configuration).findIndex((value) => value.id === data.id);
	if (index === -1) {
		throw new Error(`Off-mesh link "${data.id}" was not found.`);
	}
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
			if (!(cost > 0) || !Number.isFinite(cost) || cost > 1000) {
				throw new Error(`NavMesh area ${area.id} requires a traversal cost from greater than 0 through 1000.`);
			}
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

/** Samples the final Detour polygon area nearest a world-space point for authoring and automated verification. */
export async function sampleNavMeshArea(_scene: Scene, data: any): Promise<any> {
	const configuration = await getConfig(data.path);
	return withNavigationPlugin(data.path, (plugin) => {
		if (!plugin.navMesh) {
			throw new Error("The rebuilt NavMesh has no polygon data.");
		}
		const RecastCore = require("@recast-navigation/core");
		const query = new RecastCore.NavMeshQuery(plugin.navMesh);
		try {
			const position = Vector3.FromArray(data.position);
			const halfExtents = Vector3.FromArray(data.halfExtents ?? [100, 100, 100]);
			const nearest = query.findNearestPoly(position, { halfExtents });
			if (!nearest.success || !nearest.nearestRef) {
				throw new Error("No NavMesh polygon was found within the requested sampling extents.");
			}
			const areaId = plugin.navMesh.getPolyArea(nearest.nearestRef).area;
			return {
				path: data.path,
				position: data.position,
				nearestPoint: [nearest.nearestPoint.x, nearest.nearestPoint.y, nearest.nearestPoint.z],
				polygonReference: nearest.nearestRef,
				area: structuredClone(areas(configuration).find((area) => area.id === areaId) ?? { id: areaId, name: "Unknown", cost: 1 }),
			};
		} finally {
			query.destroy();
		}
	});
}

/** Lists authored carving obstacles with scene-node and live tile-cache evidence. */
export async function listNavMeshObstacles(scene: Scene, data: any): Promise<any> {
	const configuration = await getConfig(data.path);
	const controller = getEditorCrowdController(scene);
	return {
		path: data.path,
		obstacles: obstacleConfigurations(configuration).map((obstacle) => {
			let runtime: any = null;
			try {
				runtime = controller?.getObstacleRuntime(data.path, obstacle.id) ?? null;
			} catch {
				// Authored settings remain inspectable when no live crowd currently uses the asset.
			}
			const node = scene.getNodeById(obstacle.id);
			return { ...structuredClone(obstacle), nodeName: node?.name ?? null, missing: !node, runtime };
		}),
	};
}

/** Adds a node-bound box or cylinder obstacle with Unity-style carving/stationary thresholds. */
export async function createNavMeshObstacle(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const node = scene.getNodeById(data.nodeId) as any;
	if (!node) {
		throw new Error(`NavMesh obstacle node "${data.nodeId}" was not found.`);
	}
	if (typeof node.getBoundingInfo !== "function") {
		throw new Error(`NavMesh obstacle node "${data.nodeId}" must be a bounded mesh.`);
	}
	if (obstacleConfigurations(configuration).some((obstacle) => obstacle.id === data.nodeId)) {
		throw new Error(`NavMesh obstacle "${data.nodeId}" already exists.`);
	}
	const obstacle = {
		id: data.nodeId,
		enabled: data.enabled ?? true,
		type: data.type ?? "box",
		carving: data.carving ?? true,
		dynamic: data.dynamic ?? true,
		carveOnlyStationary: data.carveOnlyStationary ?? true,
		moveThreshold: data.moveThreshold ?? 10,
		timeToStationary: data.timeToStationary ?? 0.5,
		updateInterval: data.updateInterval ?? 0.1,
	};
	obstacleConfigurations(configuration).push(obstacle);
	validateObstacles(configuration);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	if (getEditorCrowdController(scene)) {
		try {
			await restoreNavAgents(scene);
		} catch (error) {
			obstacleConfigurations(configuration).splice(obstacleConfigurations(configuration).indexOf(obstacle), 1);
			await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
			throw error;
		}
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return { path: data.path, obstacle: structuredClone(obstacle) };
}

/** Updates one carving obstacle and refreshes the active tile cache without rebuilding source geometry. */
export async function setNavMeshObstacle(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const obstacle = obstacleConfigurations(configuration).find((value) => value.id === data.nodeId);
	if (!obstacle) {
		throw new Error(`NavMesh obstacle "${data.nodeId}" was not found.`);
	}
	const previous = structuredClone(obstacle);
	for (const property of ["enabled", "type", "carving", "dynamic", "carveOnlyStationary", "moveThreshold", "timeToStationary", "updateInterval"] as const) {
		if (data[property] !== undefined) {
			(obstacle as any)[property] = data[property];
		}
	}
	validateObstacles(configuration);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	if (getEditorCrowdController(scene)) {
		try {
			await restoreNavAgents(scene);
		} catch (error) {
			Object.assign(obstacle, previous);
			await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
			throw error;
		}
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return { path: data.path, obstacle: structuredClone(obstacle) };
}

/** Deletes one authored carving obstacle and removes it from any active runtime on synchronization. */
export async function deleteNavMeshObstacle(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = await getConfig(data.path);
	const index = obstacleConfigurations(configuration).findIndex((obstacle) => obstacle.id === data.nodeId);
	if (index === -1) {
		throw new Error(`NavMesh obstacle "${data.nodeId}" was not found.`);
	}
	const [obstacle] = obstacleConfigurations(configuration).splice(index, 1);
	await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
	if (getEditorCrowdController(scene)) {
		try {
			await restoreNavAgents(scene);
		} catch (error) {
			obstacleConfigurations(configuration).splice(index, 0, obstacle);
			await writeJSON(join(resolveNavMeshPath(data.path), "config.json"), configuration, { spaces: "\t", encoding: "utf-8" });
			throw error;
		}
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, path: data.path, nodeId: data.nodeId };
}

/** Returns stationary timing, current/carved positions, rebuild count, and errors for one live obstacle. */
export function getNavMeshObstacleRuntime(scene: Scene, data: any): any {
	const controller = getEditorCrowdController(scene);
	if (!controller) {
		throw new Error(`NavMesh "${data.path}" does not have an active dynamic-obstacle runtime.`);
	}
	return controller.getObstacleRuntime(data.path, data.nodeId);
}

/** Immediately samples all obstacle transforms, drains tile-cache rebuilds, and reissues moving-agent destinations. */
export function refreshNavMeshObstacles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = getEditorCrowdController(scene)?.refreshObstacles(data.path);
	if (!result) {
		throw new Error(`NavMesh "${data.path}" does not have an active dynamic-obstacle runtime.`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { path: data.path, ...result };
}

function validateAgent(agent: INavAgentDefinition): void {
	if (
		!(agent.radius > 0) ||
		!(agent.height > 0) ||
		!(agent.maxSpeed > 0) ||
		!(agent.maxAcceleration > 0) ||
		!((agent.collisionQueryRange ?? agent.avoidanceRadius ?? agent.radius) > 0) ||
		!((agent.pathOptimizationRange ?? agent.radius) > 0) ||
		!((agent.separationWeight ?? agent.avoidanceWeight ?? 1) >= 0) ||
		!((agent.reachRadius ?? agent.radius) > 0) ||
		!Number.isInteger(agent.obstacleAvoidanceType ?? 0) ||
		(agent.obstacleAvoidanceType ?? 0) < 0 ||
		(agent.obstacleAvoidanceType ?? 0) > 7 ||
		!Number.isInteger(agent.queryFilterType ?? 0) ||
		(agent.queryFilterType ?? 0) < 0 ||
		(agent.queryFilterType ?? 0) > 15
	) {
		throw new Error("Nav agent movement, collision, reach, avoidance, and query-filter parameters are outside their supported ranges.");
	}
}

function validateCrowd(configuration: INavCrowdConfiguration): void {
	if (
		!configuration.navMeshPath?.trim() ||
		!Number.isInteger(configuration.maxAgents ?? 64) ||
		(configuration.maxAgents ?? 64) < 1 ||
		(configuration.maxAgents ?? 64) > 10000 ||
		!((configuration.maxAgentRadius ?? 1) > 0) ||
		!((configuration.timeStep ?? 1 / 60) > 0) ||
		!Number.isInteger(configuration.maxSubStepCount ?? 10) ||
		(configuration.maxSubStepCount ?? 10) < 0 ||
		(configuration.maxSubStepCount ?? 10) > 100 ||
		(configuration.queryExtent !== undefined && (configuration.queryExtent.length !== 3 || configuration.queryExtent.some((value) => !(value > 0) || !Number.isFinite(value))))
	) {
		throw new Error("Navigation crowd capacity, radius, timestep, substeps, or query extent is outside its supported range.");
	}
}

/** Lists persisted agent definitions and live Detour state when their crowds are active. */
export function listNavAgents(scene: Scene): any {
	const controller = getEditorCrowdController(scene);
	return {
		agents: agents(scene).map((agent) => {
			let runtime: any = null;
			try {
				runtime = controller?.getAgentRuntime(agent.id) ?? null;
			} catch {
				// The persisted definition remains useful while its NavMesh asset is unavailable.
			}
			return { ...structuredClone(agent), runtime };
		}),
	};
}

/** Creates a navigation agent bound to an existing scene node and NavMesh asset. */
export async function createNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = scene.getNodeById(data.nodeId);
	if (!node) {
		throw new Error(`Agent node "${data.nodeId}" was not found.`);
	}
	const id = data.id ?? Tools.RandomId();
	if (agents(scene).some((value) => value.id === id)) {
		throw new Error(`Nav agent "${id}" already exists.`);
	}
	const position = (node as any).getAbsolutePosition?.() ?? (node as any).position;
	if (!position) {
		throw new Error("Nav agents require a transform node with a position.");
	}
	const agent: INavAgentDefinition = {
		id,
		nodeId: node.id,
		navMeshPath: data.navMeshPath,
		radius: data.radius ?? 50,
		height: data.height ?? 180,
		maxSpeed: data.maxSpeed ?? 6,
		maxAcceleration: data.maxAcceleration ?? 8,
		avoidanceEnabled: data.avoidanceEnabled ?? true,
		avoidanceRadius: data.avoidanceRadius ?? data.collisionQueryRange ?? data.radius ?? 100,
		avoidanceWeight: data.avoidanceWeight ?? 1,
		collisionQueryRange: data.collisionQueryRange ?? data.avoidanceRadius ?? (data.radius ?? 50) * 2,
		pathOptimizationRange: data.pathOptimizationRange ?? (data.radius ?? 50) * 30,
		separationWeight: data.separationWeight ?? data.avoidanceWeight ?? 1,
		updateFlags: data.updateFlags,
		obstacleAvoidanceType: data.obstacleAvoidanceType ?? 0,
		queryFilterType: data.queryFilterType ?? 0,
		reachRadius: data.reachRadius ?? data.radius ?? 50,
		updateRotation: data.updateRotation ?? true,
		angularSpeed: data.angularSpeed ?? Math.PI * 4,
		autoRepath: data.autoRepath ?? true,
		destination: null,
		path: [],
		pathIndex: 0,
		isMoving: false,
	};
	validateAgent(agent);
	agents(scene).push(agent);
	try {
		await restoreNavAgents(scene);
	} catch (error) {
		agents(scene).splice(agents(scene).indexOf(agent), 1);
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Updates persisted navigation-agent movement and native Detour steering/avoidance tuning. */
export async function setNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	const previous = structuredClone(agent);
	for (const property of [
		"radius",
		"height",
		"maxSpeed",
		"maxAcceleration",
		"avoidanceEnabled",
		"avoidanceRadius",
		"avoidanceWeight",
		"collisionQueryRange",
		"pathOptimizationRange",
		"separationWeight",
		"updateFlags",
		"obstacleAvoidanceType",
		"queryFilterType",
		"reachRadius",
		"updateRotation",
		"angularSpeed",
		"autoRepath",
	]) {
		if (data[property] !== undefined) {
			agent[property] = data[property];
		}
	}
	validateAgent(agent);
	try {
		await restoreNavAgents(scene);
	} catch (error) {
		for (const property of Object.keys(agent)) {
			delete agent[property];
		}
		Object.assign(agent, previous);
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Plans a real Recast route for a persisted agent without forcing a runtime crowd controller. */
export async function setNavAgentDestination(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	const node = scene.getNodeById(agent.nodeId) as any;
	if (!node) {
		throw new Error(`Agent node "${agent.nodeId}" no longer exists.`);
	}
	const start = node.getAbsolutePosition?.() ?? node.position;
	const result = await computeNavMeshPath(scene, { path: agent.navMeshPath, start: start.asArray(), destination: data.destination });
	agent.destination = data.destination;
	agent.path = result.path;
	agent.pathIndex = result.path.length > 1 ? 1 : 0;
	agent.isMoving = data.startMoving ?? false;
	if (agent.isMoving) {
		getEditorCrowdController(scene)?.startAgent(agent.id);
	}
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(agent), pointCount: result.pointCount };
}

/** Starts native Detour Crowd movement toward a previously planned destination. */
export async function startNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	if (!agent.destination || !agent.path?.length || agent.path.length < 2) {
		throw new Error("Plan an agent destination before starting movement.");
	}
	await restoreNavAgents(scene);
	getEditorCrowdController(scene)!.startAgent(agent.id);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Stops a native Detour move request without discarding its destination or planned route. */
export async function stopNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	await restoreNavAgents(scene);
	getEditorCrowdController(scene)!.stopAgent(agent.id);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(agent);
}

/** Removes a persisted navigation-agent definition. */
export async function deleteNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	const index = agents(scene).indexOf(agent);
	agents(scene).splice(index, 1);
	try {
		await restoreNavAgents(scene);
	} catch (error) {
		agents(scene).splice(index, 0, agent);
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Lists persisted crowd capacities, stepping, spatial-query extents, and Detour query filters. */
export function listNavCrowds(scene: Scene): any {
	return { crowds: structuredClone(crowds(scene)) };
}

/** Creates or updates the Detour Crowd configuration for one NavMesh asset and rebuilds its live controller. */
export async function setNavCrowd(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const values = crowds(scene);
	const existing = values.find((configuration) => configuration.navMeshPath === data.navMeshPath);
	const previous = existing ? structuredClone(existing) : null;
	const configuration = existing ?? { navMeshPath: data.navMeshPath };
	Object.assign(configuration, data);
	validateCrowd(configuration);
	if (!existing) {
		values.push(configuration);
	}
	try {
		await restoreNavAgents(scene);
	} catch (error) {
		if (previous) {
			Object.assign(configuration, previous);
		} else {
			values.splice(values.indexOf(configuration), 1);
		}
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(configuration);
}

/** Returns live position, velocity, corridor corners, state, off-mesh status, and remaining distance from Detour Crowd. */
export function getNavAgentRuntime(scene: Scene, data: any): any {
	const agent = findAgent(scene, data);
	const controller = getEditorCrowdController(scene);
	if (!controller) {
		throw new Error(`Navigation agent "${agent.id}" does not have an active Detour Crowd.`);
	}
	return controller.getAgentRuntime(agent.id);
}

/** Warps a live Detour agent to a world position while retaining its destination. */
export async function teleportNavAgent(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const agent = findAgent(scene, data);
	await restoreNavAgents(scene);
	getEditorCrowdController(scene)!.teleportAgent(agent.id, data.position);
	options.editor.layout.inspector.forceUpdate();
	return getEditorCrowdController(scene)!.getAgentRuntime(agent.id);
}
