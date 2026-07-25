import { IEditorSceneWorkspaceSettings } from "./typings";
import { maximumLoadedAuthoringScenes } from "./scene-workspace";

export interface IEditorLoadedSceneState {
	path: string;
	isActive: boolean;
	isLighting: boolean;
	isDirty: boolean;
	ownedObjectCount: number;
}

export interface IEditorLoadedSceneHandle {
	configuration: unknown;
	applyLighting?(): void | Promise<void>;
	dispose(): void;
}

/** Owns transient additive-scene state without serializing Babylon object references. */
export class EditorSceneWorkspace {
	private _settings: IEditorSceneWorkspaceSettings = { version: 1, loadedScenes: [], activeScene: null, lightingScene: null };
	private _dirtyScenes = new Set<string>();
	private _owners = new WeakMap<object, string>();
	private _objectsByScene = new Map<string, Set<object>>();
	private _handles = new Map<string, IEditorLoadedSceneHandle>();
	private _listeners = new Set<() => void>();

	/** Replaces the workspace when a project or preview scene is opened. */
	public configure(settings: IEditorSceneWorkspaceSettings): void {
		this._assertSettings(settings);
		this._handles.forEach((handle) => handle.dispose());
		this._settings = structuredClone(settings);
		this._dirtyScenes.clear();
		this._owners = new WeakMap<object, string>();
		this._objectsByScene = new Map(settings.loadedScenes.map((path) => [path, new Set<object>()]));
		this._handles.clear();
		this._notify();
	}

	/** Applies persisted selection/order changes while retaining surviving object ownership and dirtiness. */
	public applySettings(settings: IEditorSceneWorkspaceSettings): void {
		this._assertSettings(settings);
		const retainedPaths = new Set(settings.loadedScenes);
		for (const [path, objects] of this._objectsByScene) {
			if (!retainedPaths.has(path)) {
				this._handles.get(path)?.dispose();
				this._handles.delete(path);
				objects.forEach((object) => this._owners.delete(object));
				this._dirtyScenes.delete(path);
			}
		}
		this._objectsByScene = new Map(settings.loadedScenes.map((path) => [path, this._objectsByScene.get(path) ?? new Set<object>()]));
		this._settings = structuredClone(settings);
		this._notify();
	}

	/** Returns a detached settings value safe to persist or expose to clients. */
	public getSettings(): IEditorSceneWorkspaceSettings {
		return structuredClone(this._settings);
	}

	/** Returns immutable UI/MCP status for every loaded scene in authored order. */
	public getLoadedSceneStates(): IEditorLoadedSceneState[] {
		return this._settings.loadedScenes.map((path) => ({
			path,
			isActive: path === this._settings.activeScene,
			isLighting: path === this._settings.lightingScene,
			isDirty: this._dirtyScenes.has(path),
			ownedObjectCount: this._objectsByScene.get(path)?.size ?? 0,
		}));
	}

	/** Adds an unloaded scene while preserving the bounded authored load order. */
	public addLoadedScene(path: string): void {
		if (this._objectsByScene.has(path)) {
			return;
		}
		if (this._settings.loadedScenes.length >= maximumLoadedAuthoringScenes) {
			throw new Error(`At most ${maximumLoadedAuthoringScenes} scenes can be loaded for authoring.`);
		}

		this._settings.loadedScenes.push(path);
		this._objectsByScene.set(path, new Set<object>());
		this._settings.activeScene ??= path;
		this._settings.lightingScene ??= path;
		this._notify();
	}

	/** Removes runtime ownership and selects deterministic active/lighting fallbacks. */
	public removeLoadedScene(path: string): object[] {
		this._assertLoaded(path);
		this._handles.get(path)?.dispose();
		this._handles.delete(path);
		const objects = [...(this._objectsByScene.get(path) ?? [])];
		objects.forEach((object) => this._owners.delete(object));
		this._objectsByScene.delete(path);
		this._dirtyScenes.delete(path);
		this._settings.loadedScenes = this._settings.loadedScenes.filter((candidate) => candidate !== path);
		const fallback = this._settings.loadedScenes[0] ?? null;
		if (this._settings.activeScene === path) {
			this._settings.activeScene = fallback;
		}
		if (this._settings.lightingScene === path) {
			this._settings.lightingScene = this._settings.activeScene ?? fallback;
		}
		this._notify();
		return objects;
	}

	/** Attaches the exact resource disposer produced by a successful authored-scene load. */
	public setLoadedSceneHandle(path: string, handle: IEditorLoadedSceneHandle): void {
		this._assertLoaded(path);
		this._handles.get(path)?.dispose();
		this._handles.set(path, handle);
	}

	/** Returns the raw scene configuration retained for independent save/revert operations. */
	public getLoadedSceneConfiguration(path: string): unknown {
		return this._handles.get(path)?.configuration ?? null;
	}

	/** Refreshes the retained source after an independent scene save. */
	public setLoadedSceneConfiguration(path: string, configuration: unknown): void {
		const handle = this._handles.get(path);
		if (handle) {
			handle.configuration = configuration;
		}
	}

	/** Reapplies one loaded scene's retained global configuration without changing ownership. */
	public async applyLoadedSceneLighting(path: string): Promise<void> {
		this._assertLoaded(path);
		const handle = this._handles.get(path);
		if (!handle) {
			throw new Error(`Scene has no completed load handle: ${path}`);
		}
		await handle.applyLighting?.();
	}

	/** Selects which loaded scene receives newly authored root objects. */
	public setActiveScene(path: string): void {
		this._assertLoaded(path);
		if (this._settings.activeScene !== path) {
			this._settings.activeScene = path;
			this._notify();
		}
	}

	/** Selects the loaded scene that owns global lighting and render settings. */
	public setLightingScene(path: string): void {
		this._assertLoaded(path);
		if (this._settings.lightingScene !== path) {
			this._settings.lightingScene = path;
			this._notify();
		}
	}

	/** Claims objects atomically; transfers must be explicit to prevent silent data loss. */
	public claimObjects(path: string, objects: object[], transfer = false): number {
		this._assertLoaded(path);
		for (const object of objects) {
			const owner = this._owners.get(object);
			if (owner && owner !== path && !transfer) {
				throw new Error(`Object is already owned by scene "${owner}".`);
			}
		}

		let changed = 0;
		for (const object of objects) {
			const owner = this._owners.get(object);
			if (owner === path) {
				continue;
			}
			if (owner) {
				this._objectsByScene.get(owner)?.delete(object);
				this._dirtyScenes.add(owner);
			}
			this._owners.set(object, path);
			this._objectsByScene.get(path)!.add(object);
			changed++;
		}
		if (transfer && changed) {
			this._dirtyScenes.add(path);
		}
		if (changed) {
			this._notify();
		}
		return changed;
	}

	/** Resolves exact authored ownership; callers may apply active-scene fallback for new objects. */
	public getOwner(object: object): string | null {
		return this._owners.get(object) ?? null;
	}

	/** Changes one scene's dirty bit without affecting other loaded scenes. */
	public setDirty(path: string, dirty = true): void {
		this._assertLoaded(path);
		const changed = dirty ? !this._dirtyScenes.has(path) : this._dirtyScenes.has(path);
		if (!changed) {
			return;
		}
		dirty ? this._dirtyScenes.add(path) : this._dirtyScenes.delete(path);
		this._notify();
	}

	/** Claims an unowned edited object for the active scene and marks its exact owner dirty. */
	public markObjectDirty(object: object): string | null {
		let owner = this._owners.get(object) ?? null;
		if (!owner && this._settings.activeScene) {
			owner = this._settings.activeScene;
			this.claimObjects(owner, [object]);
		}
		if (owner) {
			this.setDirty(owner);
		}
		return owner;
	}

	/** Claims an exact batch produced by an editor add/import command for the active scene. */
	public claimNewObjectsForActiveScene(objects: object[]): number {
		const activeScene = this._settings.activeScene;
		if (!activeScene) {
			return 0;
		}
		const unownedObjects = [...new Set(objects)].filter((object) => !this._owners.has(object));
		const changed = this.claimObjects(activeScene, unownedObjects);
		if (changed) {
			this.setDirty(activeScene);
		}
		return changed;
	}

	/** Registers a UI subscriber and returns its deterministic cleanup callback. */
	public subscribe(listener: () => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	/** Validates the serializable half before it can diverge from runtime ownership maps. */
	private _assertSettings(settings: IEditorSceneWorkspaceSettings): void {
		const loaded = new Set(settings.loadedScenes);
		if (
			settings.version !== 1 ||
			settings.loadedScenes.length > maximumLoadedAuthoringScenes ||
			loaded.size !== settings.loadedScenes.length ||
			(settings.activeScene !== null && !loaded.has(settings.activeScene)) ||
			(settings.lightingScene !== null && !loaded.has(settings.lightingScene))
		) {
			throw new Error("Invalid additive scene workspace settings.");
		}
	}

	/** Keeps all mutators from creating status for a scene absent from the workspace. */
	private _assertLoaded(path: string): void {
		if (!this._objectsByScene.has(path)) {
			throw new Error(`Scene is not loaded for authoring: ${path}`);
		}
	}

	/** Emits synchronously so React and persistence observe the same committed state. */
	private _notify(): void {
		this._listeners.forEach((listener) => listener());
	}
}
