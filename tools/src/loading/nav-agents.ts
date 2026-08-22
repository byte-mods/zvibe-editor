import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import { DynamicNavMeshObstacleManager, INavMeshObstacleRuntimeState } from "./nav-obstacles";

export interface INavAgentDefinition {
	id: string;
	nodeId: string;
	navMeshPath: string;
	radius: number;
	height: number;
	maxSpeed: number;
	maxAcceleration: number;
	avoidanceEnabled?: boolean;
	avoidanceRadius?: number;
	avoidanceWeight?: number;
	collisionQueryRange?: number;
	pathOptimizationRange?: number;
	separationWeight?: number;
	updateFlags?: number;
	obstacleAvoidanceType?: number;
	queryFilterType?: number;
	reachRadius?: number;
	updateRotation?: boolean;
	angularSpeed?: number;
	autoRepath?: boolean;
	destination?: number[] | null;
	path?: number[][];
	pathIndex?: number;
	isMoving?: boolean;
}

export interface INavCrowdFilterConfiguration {
	index: number;
	includeFlags?: number;
	excludeFlags?: number;
	areaCosts?: Record<string, number>;
}

export interface INavCrowdConfiguration {
	navMeshPath: string;
	maxAgents?: number;
	maxAgentRadius?: number;
	timeStep?: number;
	maxSubStepCount?: number;
	queryExtent?: number[];
	filters?: INavCrowdFilterConfiguration[];
}

export interface INavAgentRuntimeState {
	id: string;
	navMeshPath: string;
	crowdAgentIndex: number;
	state: "invalid" | "walking" | "off-mesh";
	position: number[];
	velocity: number[];
	nextTarget: number[];
	corners: number[][];
	overOffMeshConnection: boolean;
	remainingDistance: number;
	destination: number[] | null;
	isMoving: boolean;
	replanCount: number;
	lastReplanReason: string | null;
}

interface IDetourAgent {
	resetMoveTarget(): void;
}

export interface INavigationCrowd {
	readonly recastCrowd?: {
		navMeshQuery: {
			defaultQueryHalfExtents: { x: number; y: number; z: number };
		};
		getAgent(index: number): IDetourAgent | null;
		getFilter(index: number): {
			includeFlags: number;
			excludeFlags: number;
			setAreaCost(area: number, cost: number): void;
		};
	};
	onReachTargetObservable?: {
		add(callback: (event: { agentIndex: number; destination: Vector3 }) => void): unknown;
	};
	addAgent(position: Vector3, parameters: INavigationAgentParameters, transform: TransformNode): number;
	agentGoto(index: number, destination: Vector3): void;
	agentTeleport(index: number, destination: Vector3): void;
	updateAgentParameters(index: number, parameters: INavigationAgentParameters): void;
	removeAgent(index: number): void;
	getAgentPosition(index: number): Vector3;
	getAgentVelocity(index: number): Vector3;
	getAgentNextTargetPath(index: number): Vector3;
	getAgentState(index: number): number;
	overOffmeshConnection(index: number): boolean;
	getCorners(index: number): Vector3[];
	setDefaultQueryExtent(extent: Vector3): void;
	dispose(): void;
}

export interface INavigationPlugin {
	obstacleManager?: DynamicNavMeshObstacleManager;
	defaultAreaCosts?: Record<string, number>;
	createCrowd(maxAgents: number, maxAgentRadius: number, scene: Scene): INavigationCrowd;
	setTimeStep?(timeStep?: number): void;
	setMaximumSubStepCount?(count?: number): void;
	dispose(): void;
}

export type NavigationPluginResolver = (navMeshPath: string, scene: Scene, rootUrl: string) => Promise<INavigationPlugin>;

export interface INavigationAgentParameters {
	radius: number;
	height: number;
	maxAcceleration: number;
	maxSpeed: number;
	collisionQueryRange: number;
	pathOptimizationRange: number;
	separationWeight: number;
	reachRadius: number;
	updateFlags: number;
	obstacleAvoidanceType: number;
	queryFilterType: number;
	userData: unknown;
}

interface INavCrowdGroup {
	configuration: INavCrowdConfiguration;
	plugin: INavigationPlugin;
	crowd: INavigationCrowd;
	agents: Map<string, number>;
}

const controllers = new WeakMap<Scene, NavigationCrowdController>();

function getAgentDefinitions(scene: Scene): INavAgentDefinition[] {
	const definitions = scene.metadata?.babylonEditorNavAgents;
	return Array.isArray(definitions) ? definitions : [];
}

function getCrowdConfigurations(scene: Scene): INavCrowdConfiguration[] {
	const configurations = scene.metadata?.babylonEditorNavCrowds;
	return Array.isArray(configurations) ? configurations : [];
}

function toAgentParameters(agent: INavAgentDefinition): INavigationAgentParameters {
	const avoidanceEnabled = agent.avoidanceEnabled !== false;
	return {
		radius: agent.radius,
		height: agent.height,
		maxAcceleration: agent.maxAcceleration * 100,
		maxSpeed: agent.maxSpeed * 100,
		collisionQueryRange: agent.collisionQueryRange ?? agent.avoidanceRadius ?? Math.max(agent.radius * 2, 1),
		pathOptimizationRange: agent.pathOptimizationRange ?? Math.max(agent.radius * 30, 1),
		separationWeight: avoidanceEnabled ? (agent.separationWeight ?? agent.avoidanceWeight ?? 1) : 0,
		reachRadius: agent.reachRadius ?? agent.radius,
		updateFlags: avoidanceEnabled ? (agent.updateFlags ?? 31) : (agent.updateFlags ?? 31) & ~6,
		obstacleAvoidanceType: agent.obstacleAvoidanceType ?? 0,
		queryFilterType: agent.queryFilterType ?? 0,
		userData: agent.id,
	};
}

function normalizeCrowdConfiguration(path: string, agents: INavAgentDefinition[], saved?: INavCrowdConfiguration): INavCrowdConfiguration {
	const largestRadius = Math.max(1, ...agents.map((agent) => agent.radius));
	return {
		navMeshPath: path,
		maxAgents: Math.max(saved?.maxAgents ?? 64, agents.length, 1),
		maxAgentRadius: Math.max(saved?.maxAgentRadius ?? largestRadius, largestRadius),
		timeStep: saved?.timeStep ?? 1 / 60,
		maxSubStepCount: saved?.maxSubStepCount ?? 10,
		queryExtent: saved?.queryExtent ?? [Math.max(largestRadius * 2, 100), Math.max(largestRadius * 4, 200), Math.max(largestRadius * 2, 100)],
		filters: saved?.filters ?? [],
	};
}

function configureFilters(crowd: INavigationCrowd, filters: INavCrowdFilterConfiguration[]): void {
	if (!crowd.recastCrowd) {
		return;
	}
	for (const configuration of filters) {
		if (!Number.isInteger(configuration.index) || configuration.index < 0 || configuration.index > 15) {
			throw new Error(`Navigation crowd filter index ${configuration.index} must be from 0 through 15.`);
		}
		const filter = crowd.recastCrowd.getFilter(configuration.index);
		if (configuration.includeFlags !== undefined) {
			filter.includeFlags = configuration.includeFlags;
		}
		if (configuration.excludeFlags !== undefined) {
			filter.excludeFlags = configuration.excludeFlags;
		}
		for (const [area, cost] of Object.entries(configuration.areaCosts ?? {})) {
			const areaId = Number(area);
			if (!Number.isInteger(areaId) || areaId < 0 || areaId > 63 || !(cost > 0) || !Number.isFinite(cost)) {
				throw new Error(`Navigation crowd filter ${configuration.index} has an invalid area cost for area "${area}".`);
			}
			filter.setAreaCost(areaId, cost);
		}
	}
}

async function defaultNavigationPluginResolver(navMeshPath: string, scene: Scene, rootUrl: string): Promise<INavigationPlugin> {
	const { preloadNavMeshScriptAsset } = await import("./script/preload/plugins/navmesh");
	return preloadNavMeshScriptAsset({ key: navMeshPath, rootUrl, scene } as any) as Promise<INavigationPlugin>;
}

/** Owns one real Detour Crowd per NavMesh asset and keeps persisted editor agents synchronized with it. */
export class NavigationCrowdController {
	private _groups = new Map<string, INavCrowdGroup>();
	private _rotationObserver: Observer<Scene> | null = null;
	private _replans = new Map<string, { count: number; reason: string | null }>();

	public constructor(
		private _scene: Scene,
		private _rootUrl: string,
		private _resolver: NavigationPluginResolver
	) {
		this._rotationObserver = this._scene.onBeforeRenderObservable.add(() => this._updateRotations());
		this._scene.onDisposeObservable.addOnce(() => this.dispose());
	}

	/** Rebuilds crowds atomically from scene metadata. Existing crowds remain active if loading the replacement fails. */
	public async synchronize(): Promise<void> {
		const definitions = getAgentDefinitions(this._scene);
		const definitionsByPath = new Map<string, INavAgentDefinition[]>();
		for (const definition of definitions) {
			if (!definition.navMeshPath?.trim()) {
				throw new Error(`Navigation agent "${definition.id}" has no NavMesh asset path.`);
			}
			const pathAgents = definitionsByPath.get(definition.navMeshPath) ?? [];
			pathAgents.push(definition);
			definitionsByPath.set(definition.navMeshPath, pathAgents);
		}

		const replacement = new Map<string, INavCrowdGroup>();
		try {
			for (const [path, pathAgents] of definitionsByPath) {
				const saved = getCrowdConfigurations(this._scene).find((configuration) => configuration.navMeshPath === path);
				const configuration = normalizeCrowdConfiguration(path, pathAgents, saved);
				const plugin = await this._resolver(path, this._scene, this._rootUrl);
				if (!configuration.filters?.length && plugin.defaultAreaCosts) {
					configuration.filters = [{ index: 0, areaCosts: plugin.defaultAreaCosts }];
				}
				plugin.setTimeStep?.(configuration.timeStep);
				plugin.setMaximumSubStepCount?.(configuration.maxSubStepCount);
				const crowd = plugin.createCrowd(configuration.maxAgents!, configuration.maxAgentRadius!, this._scene);
				const group: INavCrowdGroup = { configuration, plugin, crowd, agents: new Map() };
				replacement.set(path, group);
				const queryExtent = Vector3.FromArray(configuration.queryExtent!);
				crowd.setDefaultQueryExtent(queryExtent);
				if (crowd.recastCrowd) {
					crowd.recastCrowd.navMeshQuery.defaultQueryHalfExtents = { x: queryExtent.x, y: queryExtent.y, z: queryExtent.z };
				}
				configureFilters(crowd, configuration.filters ?? []);
				for (const agent of pathAgents) {
					const node = this._scene.getNodeById(agent.nodeId);
					if (!node || !(node as TransformNode).position || typeof (node as TransformNode).getAbsolutePosition !== "function") {
						throw new Error(`Navigation agent "${agent.id}" requires a transform node; "${agent.nodeId}" was not found.`);
					}
					const transform = node as TransformNode;
					const index = crowd.addAgent(transform.getAbsolutePosition(), toAgentParameters(agent), transform);
					group.agents.set(agent.id, index);
					if (agent.isMoving && agent.destination?.length === 3) {
						crowd.agentGoto(index, Vector3.FromArray(agent.destination));
					}
				}
				crowd.onReachTargetObservable?.add(({ agentIndex }) => {
					const entry = Array.from(group.agents).find(([, index]) => index === agentIndex);
					const agent = entry ? getAgentDefinitions(this._scene).find((definition) => definition.id === entry[0]) : undefined;
					if (agent) {
						agent.isMoving = false;
						crowd.recastCrowd?.getAgent(agentIndex)?.resetMoveTarget();
					}
				});
				plugin.obstacleManager?.onCarvedObservable.add((event) => {
					this.replanAgentsForPath(path, `Obstacle tiles updated: ${event.obstacleIds.join(", ")}`);
				});
			}
		} catch (error) {
			this._disposeGroups(replacement);
			throw error;
		}

		this._disposeGroups(this._groups);
		this._groups = replacement;
	}

	/** Applies updated movement/avoidance parameters without rebuilding the containing crowd. */
	public updateAgent(agent: INavAgentDefinition): void {
		const { group, index } = this._getAgent(agent.id);
		group.crowd.updateAgentParameters(index, toAgentParameters(agent));
	}

	/** Sends or re-sends the persisted destination to Detour Crowd. */
	public startAgent(id: string): void {
		const agent = getAgentDefinitions(this._scene).find((definition) => definition.id === id);
		if (!agent?.destination || agent.destination.length !== 3) {
			throw new Error("Set an agent destination before starting movement.");
		}
		const { group, index } = this._getAgent(id);
		group.crowd.agentGoto(index, Vector3.FromArray(agent.destination));
		agent.isMoving = true;
	}

	/** Cancels Detour's active move request while preserving the destination for resume. */
	public stopAgent(id: string): void {
		const agent = getAgentDefinitions(this._scene).find((definition) => definition.id === id);
		const { group, index } = this._getAgent(id);
		group.crowd.recastCrowd?.getAgent(index)?.resetMoveTarget();
		if (agent) {
			agent.isMoving = false;
		}
	}

	/** Warps an agent and its bound transform to the nearest location accepted by Detour. */
	public teleportAgent(id: string, destination: number[]): void {
		const { group, index } = this._getAgent(id);
		group.crowd.agentTeleport(index, Vector3.FromArray(destination));
	}

	/** Reissues active destinations after a NavMesh tile update, matching NavMeshAgent autoRepath behavior. */
	public replanAgentsForPath(navMeshPath: string, reason = "NavMesh changed"): string[] {
		const group = this._groups.get(navMeshPath);
		if (!group) {
			return [];
		}
		const replanned: string[] = [];
		for (const definition of getAgentDefinitions(this._scene)) {
			if (definition.navMeshPath !== navMeshPath || definition.isMoving !== true || definition.autoRepath === false || definition.destination?.length !== 3) {
				continue;
			}
			const index = group.agents.get(definition.id);
			if (index === undefined) {
				continue;
			}
			group.crowd.recastCrowd?.getAgent(index)?.resetMoveTarget();
			group.crowd.agentGoto(index, Vector3.FromArray(definition.destination));
			const evidence = this._replans.get(definition.id) ?? { count: 0, reason: null };
			evidence.count++;
			evidence.reason = reason;
			this._replans.set(definition.id, evidence);
			replanned.push(definition.id);
		}
		return replanned;
	}

	/** Returns live runtime carving evidence for one obstacle. */
	public getObstacleRuntime(navMeshPath: string, id: string): INavMeshObstacleRuntimeState {
		const manager = this._groups.get(navMeshPath)?.plugin.obstacleManager;
		if (!manager) {
			throw new Error(`NavMesh "${navMeshPath}" does not have an active dynamic-obstacle manager.`);
		}
		return manager.getRuntimeState(id);
	}

	/** Forces obstacle transforms to be sampled, affected tiles to rebuild, and active destinations to replan. */
	public refreshObstacles(navMeshPath: string): { obstacleIds: string[]; version: number; replannedAgentIds: string[] } {
		const manager = this._groups.get(navMeshPath)?.plugin.obstacleManager;
		if (!manager) {
			throw new Error(`NavMesh "${navMeshPath}" does not have an active dynamic-obstacle manager.`);
		}
		const event = manager.refresh(true);
		const replannedAgentIds = getAgentDefinitions(this._scene)
			.filter(
				(definition) => definition.navMeshPath === navMeshPath && definition.isMoving === true && definition.autoRepath !== false && definition.destination?.length === 3
			)
			.map((definition) => definition.id);
		return { ...event, replannedAgentIds };
	}

	/** Returns live Detour state suitable for the Inspector, MCP verification, and automated tests. */
	public getAgentRuntime(id: string): INavAgentRuntimeState {
		const definition = getAgentDefinitions(this._scene).find((agent) => agent.id === id);
		if (!definition) {
			throw new Error(`Navigation agent "${id}" was not found.`);
		}
		const { group, index } = this._getAgent(id);
		const position = group.crowd.getAgentPosition(index);
		const velocity = group.crowd.getAgentVelocity(index);
		const nextTarget = group.crowd.getAgentNextTargetPath(index);
		const corners = group.crowd.getCorners(index);
		const state = group.crowd.getAgentState(index);
		const points = [position, ...corners];
		if (definition.destination?.length === 3) {
			points.push(Vector3.FromArray(definition.destination));
		}
		let remainingDistance = 0;
		for (let i = 1; i < points.length; i++) {
			remainingDistance += Vector3.Distance(points[i - 1], points[i]);
		}
		const replan = this._replans.get(id) ?? { count: 0, reason: null };
		return {
			id,
			navMeshPath: definition.navMeshPath,
			crowdAgentIndex: index,
			state: state === 2 ? "off-mesh" : state === 1 ? "walking" : "invalid",
			position: position.asArray(),
			velocity: velocity.asArray(),
			nextTarget: nextTarget.asArray(),
			corners: corners.map((corner) => corner.asArray()),
			overOffMeshConnection: group.crowd.overOffmeshConnection(index),
			remainingDistance,
			destination: definition.destination ? [...definition.destination] : null,
			isMoving: definition.isMoving === true,
			replanCount: replan.count,
			lastReplanReason: replan.reason,
		};
	}

	/** Releases native crowd and NavMesh resources plus scene observers. */
	public dispose(): void {
		this._disposeGroups(this._groups);
		this._groups.clear();
		if (this._rotationObserver) {
			this._scene.onBeforeRenderObservable.remove(this._rotationObserver);
			this._rotationObserver = null;
		}
		if (controllers.get(this._scene) === this) {
			controllers.delete(this._scene);
		}
	}

	private _getAgent(id: string): { group: INavCrowdGroup; index: number } {
		for (const group of this._groups.values()) {
			const index = group.agents.get(id);
			if (index !== undefined) {
				return { group, index };
			}
		}
		throw new Error(`Navigation agent "${id}" is not active in a Detour Crowd.`);
	}

	private _disposeGroups(groups: Map<string, INavCrowdGroup>): void {
		for (const group of groups.values()) {
			// Navigation plugins own the crowds returned by createCrowd and dispose them exactly once.
			group.plugin.obstacleManager?.dispose();
			group.plugin.dispose();
		}
	}

	private _updateRotations(): void {
		const deltaSeconds = Math.min(this._scene.getEngine().getDeltaTime() / 1000, 1 / 15);
		for (const definition of getAgentDefinitions(this._scene)) {
			if (definition.updateRotation === false) {
				continue;
			}
			let runtime: INavAgentRuntimeState;
			try {
				runtime = this.getAgentRuntime(definition.id);
			} catch {
				continue;
			}
			const velocity = Vector3.FromArray(runtime.velocity);
			if (velocity.lengthSquared() < 0.0001) {
				continue;
			}
			const node = this._scene.getNodeById(definition.nodeId) as TransformNode;
			if (!node || node.rotationQuaternion) {
				continue;
			}
			const target = Math.atan2(velocity.x, velocity.z);
			const delta = Math.atan2(Math.sin(target - node.rotation.y), Math.cos(target - node.rotation.y));
			const maxStep = (definition.angularSpeed ?? Math.PI * 4) * deltaSeconds;
			node.rotation.y += Math.max(-maxStep, Math.min(maxStep, delta));
		}
	}
}

/** Configures real Detour crowds for all persisted navigation agents in a loaded scene. */
export async function configureNavAgents(scene: Scene, rootUrl = "", resolver: NavigationPluginResolver = defaultNavigationPluginResolver): Promise<NavigationCrowdController> {
	let controller = controllers.get(scene);
	if (!controller) {
		controller = new NavigationCrowdController(scene, rootUrl, resolver);
		controllers.set(scene, controller);
	}
	await controller.synchronize();
	return controller;
}

/** Gets the live controller after configureNavAgents has completed. */
export function getNavigationCrowdController(scene: Scene): NavigationCrowdController | null {
	return controllers.get(scene) ?? null;
}
