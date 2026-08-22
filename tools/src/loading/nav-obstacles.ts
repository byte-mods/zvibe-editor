import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observer, Observable } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

export interface INavMeshRuntimeObstacleConfiguration {
	id: string;
	enabled: boolean;
	type: "box" | "cylinder";
	position?: number[];
	extent?: number[];
	angle?: number;
	radius?: number;
	height?: number;
	carving?: boolean;
	dynamic?: boolean;
	carveOnlyStationary?: boolean;
	moveThreshold?: number;
	timeToStationary?: number;
	updateInterval?: number;
}

export interface INavMeshObstacleRuntimeState {
	id: string;
	active: boolean;
	carved: boolean;
	moving: boolean;
	stationarySeconds: number;
	position: number[] | null;
	lastCarvedPosition: number[] | null;
	updateCount: number;
	error: string | null;
}

interface INavigationObstacle {
	type: "box" | "cylinder";
	ref: unknown;
}

export interface INavigationObstaclePlugin {
	navMesh?: unknown;
	tileCache?: {
		update(navMesh: unknown): { success: boolean; status: number; upToDate: boolean };
	};
	addCylinderObstacle(position: Vector3, radius: number, height: number, doNotWaitForCacheUpdate?: boolean): INavigationObstacle | null;
	addBoxObstacle(position: Vector3, extent: Vector3, angle: number, doNotWaitForCacheUpdate?: boolean): INavigationObstacle | null;
	removeObstacle(obstacle: INavigationObstacle, doNotWaitForCacheUpdate?: boolean): void;
}

interface IObstacleEntry {
	configuration: INavMeshRuntimeObstacleConfiguration;
	obstacle: INavigationObstacle | null;
	position: Vector3 | null;
	lastCarvedPosition: Vector3 | null;
	lastExtent: Vector3 | null;
	lastMovedAt: number;
	lastCheckedAt: number;
	moving: boolean;
	updateCount: number;
	error: string | null;
}

export interface INavMeshObstacleCarvingEvent {
	obstacleIds: string[];
	version: number;
}

/** Tracks authored obstacle transforms, carves changed tiles, and exposes deterministic runtime evidence. */
export class DynamicNavMeshObstacleManager {
	public readonly onCarvedObservable = new Observable<INavMeshObstacleCarvingEvent>();

	private _entries = new Map<string, IObstacleEntry>();
	private _observer: Observer<Scene> | null = null;
	private _elapsedSeconds = 0;
	private _version = 0;

	public constructor(
		private _plugin: INavigationObstaclePlugin,
		private _scene: Scene,
		configurations: INavMeshRuntimeObstacleConfiguration[]
	) {
		for (const configuration of configurations) {
			this._entries.set(configuration.id, {
				configuration,
				obstacle: null,
				position: null,
				lastCarvedPosition: null,
				lastExtent: null,
				lastMovedAt: 0,
				lastCheckedAt: Number.NEGATIVE_INFINITY,
				moving: false,
				updateCount: 0,
				error: null,
			});
		}
		this.refresh(true);
		this._observer = this._scene.onBeforeAnimationsObservable.add(() => this._update());
	}

	/** Re-evaluates all configured obstacles and immediately drains queued tile-cache changes. */
	public refresh(force = false): INavMeshObstacleCarvingEvent {
		const changedIds: string[] = [];
		for (const entry of this._entries.values()) {
			if (this._refreshEntry(entry, force)) {
				changedIds.push(entry.configuration.id);
			}
		}
		return this._flush(changedIds);
	}

	/** Returns one obstacle's live carving/stationary state. */
	public getRuntimeState(id: string): INavMeshObstacleRuntimeState {
		const entry = this._entries.get(id);
		if (!entry) {
			throw new Error(`Navigation obstacle "${id}" is not tracked by this NavMesh runtime.`);
		}
		return {
			id,
			active: entry.configuration.enabled && entry.configuration.carving !== false,
			carved: entry.obstacle !== null,
			moving: entry.moving,
			stationarySeconds: Math.max(0, this._elapsedSeconds - entry.lastMovedAt),
			position: entry.position?.asArray() ?? null,
			lastCarvedPosition: entry.lastCarvedPosition?.asArray() ?? null,
			updateCount: entry.updateCount,
			error: entry.error,
		};
	}

	/** Lists live carving evidence for every obstacle in the asset. */
	public listRuntimeStates(): INavMeshObstacleRuntimeState[] {
		return Array.from(this._entries.keys()).map((id) => this.getRuntimeState(id));
	}

	/** Removes the scene observer. Native obstacle resources are owned by the plugin's tile cache. */
	public dispose(): void {
		if (this._observer) {
			this._scene.onBeforeAnimationsObservable.remove(this._observer);
			this._observer = null;
		}
		this.onCarvedObservable.clear();
		this._entries.clear();
	}

	private _update(): void {
		this._elapsedSeconds += Math.min(Math.max(this._scene.getEngine().getDeltaTime() / 1000, 0), 0.25);
		const changedIds: string[] = [];
		for (const entry of this._entries.values()) {
			if (entry.configuration.dynamic === false) {
				continue;
			}
			const interval = entry.configuration.updateInterval ?? 0.1;
			if (this._elapsedSeconds - entry.lastCheckedAt < interval) {
				continue;
			}
			entry.lastCheckedAt = this._elapsedSeconds;
			if (this._refreshEntry(entry, false)) {
				changedIds.push(entry.configuration.id);
			}
		}
		this._flush(changedIds);
	}

	private _refreshEntry(entry: IObstacleEntry, force: boolean): boolean {
		const configuration = entry.configuration;
		if (!configuration.enabled || configuration.carving === false) {
			if (entry.obstacle) {
				this._plugin.removeObstacle(entry.obstacle, true);
				entry.obstacle = null;
				return true;
			}
			return false;
		}

		try {
			const snapshot = this._getSnapshot(configuration);
			if (!snapshot) {
				entry.error = `Scene node "${configuration.id}" was not found or has no bounds.`;
				return false;
			}
			entry.error = null;
			const threshold = configuration.moveThreshold ?? 10;
			const moved =
				force ||
				!entry.position ||
				Vector3.DistanceSquared(entry.position, snapshot.position) >= threshold * threshold ||
				!entry.lastExtent ||
				!entry.lastExtent.equalsWithEpsilon(snapshot.extent, 0.001);
			if (moved) {
				entry.position = snapshot.position;
				entry.lastExtent = snapshot.extent;
				entry.lastMovedAt = this._elapsedSeconds;
				entry.moving = !force;
				if (entry.obstacle) {
					this._plugin.removeObstacle(entry.obstacle, true);
					entry.obstacle = null;
				}
			}

			const stationarySeconds = this._elapsedSeconds - entry.lastMovedAt;
			const shouldCarve = !entry.obstacle && (force || configuration.carveOnlyStationary === false || stationarySeconds >= (configuration.timeToStationary ?? 0.5));
			if (shouldCarve) {
				entry.obstacle =
					configuration.type === "box"
						? this._plugin.addBoxObstacle(snapshot.position, snapshot.extent, snapshot.angle, true)
						: this._plugin.addCylinderObstacle(snapshot.position, snapshot.radius, snapshot.height, true);
				if (!entry.obstacle) {
					entry.error = "The Recast tile cache refused the obstacle request.";
					return moved;
				}
				entry.lastCarvedPosition = snapshot.position.clone();
				entry.updateCount++;
				entry.moving = false;
				return true;
			}
			return moved;
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	private _getSnapshot(configuration: INavMeshRuntimeObstacleConfiguration): { position: Vector3; extent: Vector3; angle: number; radius: number; height: number } | null {
		const node = this._scene.getNodeById(configuration.id) as any;
		node?.computeWorldMatrix?.(true);
		const position = node?.getAbsolutePosition?.() ?? (configuration.position ? Vector3.FromArray(configuration.position) : null);
		const boundingBox = node?.getBoundingInfo?.().boundingBox;
		const extent = boundingBox?.extendSizeWorld?.clone() ?? (configuration.extent ? Vector3.FromArray(configuration.extent) : null);
		if (!position || !extent) {
			return null;
		}
		const angle = node?.rotationQuaternion?.toEulerAngles?.().y ?? node?.rotation?.y ?? configuration.angle ?? 0;
		return {
			position: position.clone(),
			extent,
			angle,
			// A live mesh is authoritative: its world-space bounds follow runtime scaling,
			// while the persisted values are only a fallback for node-less configurations.
			radius: boundingBox ? Math.max(extent.x, extent.z) : (configuration.radius ?? Math.max(extent.x, extent.z)),
			height: boundingBox ? extent.y * 2 : (configuration.height ?? extent.y * 2),
		};
	}

	private _flush(changedIds: string[]): INavMeshObstacleCarvingEvent {
		if (!changedIds.length || !this._plugin.navMesh || !this._plugin.tileCache) {
			return { obstacleIds: [], version: this._version };
		}
		let upToDate = false;
		for (let update = 0; update < 128; update++) {
			const result = this._plugin.tileCache.update(this._plugin.navMesh);
			if (!result.success) {
				throw new Error(`Failed to rebuild Recast obstacle tiles (status ${result.status}).`);
			}
			if (result.upToDate) {
				upToDate = true;
				break;
			}
		}
		if (!upToDate) {
			throw new Error("Recast obstacle carving did not finish within 128 tile-cache updates.");
		}
		const event = { obstacleIds: Array.from(new Set(changedIds)), version: ++this._version };
		this.onCarvedObservable.notifyObservers(event);
		return event;
	}
}
