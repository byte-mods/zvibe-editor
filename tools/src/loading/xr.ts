import { SixDofDragBehavior } from "@babylonjs/core/Behaviors/Meshes/sixDofDragBehavior";
import { PointerEventTypes, PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import { WebXRDefaultExperience, WebXRDefaultExperienceOptions } from "@babylonjs/core/XR/webXRDefaultExperience";
import "@babylonjs/core/XR/features/WebXRControllerMovement";
import { WebXRFeatureName } from "@babylonjs/core/XR/webXRFeaturesManager";
import { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";
import { WebXRState } from "@babylonjs/core/XR/webXRTypes";

import { getSceneXRConfiguration, IEditorXRConfiguration, IXRInteractableDefinition, XRHandednessPreference } from "./xr-model";

export type XRRuntimePhase = "disabled" | "idle" | "initializing" | "ready" | "entering" | "in-xr" | "exiting" | "error" | "disposed";
export type XRRuntimeTraceType = "initialize" | "ready" | "enter" | "entered" | "exit" | "exited" | "controller-added" | "controller-removed" | "hover" | "select" | "error";

export interface IXRRuntimeTraceEvent {
	sequence: number;
	timestamp: number;
	type: XRRuntimeTraceType;
	message: string;
	controllerId: string | null;
	meshId: string | null;
}

export interface IXRControllerState {
	id: string;
	handedness: XRHandedness;
	targetRayMode: XRTargetRayMode;
	profiles: string[];
	motionControllerProfile: string | null;
}

export interface IXRResolvedInteractable {
	id: string;
	meshId: string;
	resolved: boolean;
	modes: string[];
}

export interface IXRRuntimeSnapshot {
	phase: XRRuntimePhase;
	configurationRevision: number;
	sessionMode: string;
	referenceSpaceType: string;
	experienceInitialized: boolean;
	inSession: boolean;
	lastError: string | null;
	controllers: IXRControllerState[];
	enabledFeatures: string[];
	interactables: IXRResolvedInteractable[];
	trace: IXRRuntimeTraceEvent[];
}

export interface IConfigureXROptions {
	experienceFactory?: (scene: Scene, options: WebXRDefaultExperienceOptions) => Promise<WebXRDefaultExperience>;
	now?: () => number;
	warn?: (message: string, error: unknown) => void;
}

interface IXRInteractableLease {
	mesh: AbstractMesh;
	wasPickable: boolean;
	wasNearPickable: boolean;
	wasNearGrabbable: boolean;
	behavior: SixDofDragBehavior | null;
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		xrExperience?: WebXRDefaultExperience;
	}
}

const runtimes = new WeakMap<Scene, XRRuntime>();

/** Maps editor preference semantics onto the WebXR handedness vocabulary. */
function toXRHandedness(value: XRHandednessPreference): XRHandedness | undefined {
	return value === "any" ? undefined : value;
}

/** Produces actionable errors without leaking browser-specific object internals. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Deduplicates authored floor areas and teleport interactables while preserving order. */
function resolveFloorMeshes(scene: Scene, configuration: IEditorXRConfiguration): AbstractMesh[] {
	const ids = [
		...configuration.origin.floorMeshIds,
		...configuration.interactables.filter((entry) => entry.enabled && entry.modes.includes("teleport")).map((entry) => entry.meshId),
	];
	return [...new Set(ids)].map((id) => scene.getMeshById(id)).filter((mesh): mesh is AbstractMesh => mesh !== null);
}

/** Builds the exact Babylon default-experience options from the canonical authoring model. */
export function createXRExperienceOptions(scene: Scene, configuration: IEditorXRConfiguration): WebXRDefaultExperienceOptions {
	const floorMeshes = resolveFloorMeshes(scene, configuration);
	const handedness = toXRHandedness(configuration.interaction.preferredHandedness);
	return {
		floorMeshes,
		disableDefaultUI: !configuration.session.showEnterExitUI,
		disablePointerSelection: !configuration.interaction.pointerSelection,
		disableTeleportation: !configuration.locomotion.teleportation,
		disableNearInteraction: !configuration.interaction.nearInteraction,
		disableHandTracking: !configuration.interaction.handTracking,
		optionalFeatures: configuration.session.optionalFeatures,
		pointerSelectionOptions: {
			forceGazeMode: configuration.interaction.gazeMode,
			maxPointerDistance: configuration.interaction.maxPointerDistance,
			timeToSelect: configuration.interaction.gazeSelectionTimeMs,
			preferredHandedness: handedness,
			enablePointerSelectionOnAllControllers: handedness === undefined,
		},
		nearInteractionOptions: {
			preferredHandedness: handedness,
			enableNearInteractionOnAllControllers: handedness === undefined,
		},
		teleportationOptions: {
			floorMeshes,
			snapPointsOnly: configuration.locomotion.snapPointsOnly,
			snapPositions: configuration.locomotion.snapPoints.map((point) => new Vector3(point[0], point[1], point[2])),
			snapToPositionRadius: configuration.locomotion.snapRadius,
			forceHandedness: handedness,
		},
		uiOptions: {
			sessionMode: configuration.session.mode,
			referenceSpaceType: configuration.session.referenceSpaceType,
			requiredFeatures: configuration.session.requiredFeatures,
			optionalFeatures: configuration.session.optionalFeatures,
		},
	};
}

/** Owns one scene's WebXR helper, authored affordances, traces, and exact cleanup. */
export class XRRuntime {
	private _phase: XRRuntimePhase;
	private _experience: WebXRDefaultExperience | null = null;
	private _initializePromise: Promise<IXRRuntimeSnapshot> | null = null;
	private _lastError: string | null = null;
	private _sequence = 0;
	private _trace: IXRRuntimeTraceEvent[] = [];
	private _interactableLeases: IXRInteractableLease[] = [];
	private _hoveredMeshes = new Map<number, string | null>();
	private _pointerObserver: Observer<PointerInfo> | null = null;
	private _stateObserver: Observer<WebXRState> | null = null;
	private _controllerAddedObserver: Observer<WebXRInputSource> | null = null;
	private _controllerRemovedObserver: Observer<WebXRInputSource> | null = null;

	public constructor(
		private readonly _scene: Scene,
		private readonly _configuration: IEditorXRConfiguration,
		private readonly _options: IConfigureXROptions = {}
	) {
		this._phase = _configuration.enabled ? "idle" : "disabled";
		this._scene.onDisposeObservable.addOnce(() => this.dispose());
	}

	/** Returns the immutable authored configuration used for this runtime lease. */
	public get configuration(): IEditorXRConfiguration {
		return structuredClone(this._configuration);
	}

	/** Initializes once and records failure as inspectable state instead of an unhandled rejection. */
	public async initialize(): Promise<IXRRuntimeSnapshot> {
		if (this._phase === "disabled" || this._phase === "disposed" || this._experience) {
			return this.snapshot();
		}
		if (this._initializePromise) {
			return this._initializePromise;
		}
		this._initializePromise = this._initializeInternal();
		return this._initializePromise;
	}

	/** Enters the authored headset session; browsers still require this call from a user gesture. */
	public async enterSession(): Promise<IXRRuntimeSnapshot> {
		await this.initialize();
		if (!this._experience || this._phase === "error") {
			throw new Error(this._lastError ?? "XR experience is not initialized.");
		}
		if (this._phase === "in-xr") {
			return this.snapshot();
		}
		this._phase = "entering";
		this._pushTrace("enter", `Entering ${this._configuration.session.mode}.`);
		try {
			await this._experience.baseExperience.enterXRAsync(this._configuration.session.mode, this._configuration.session.referenceSpaceType, this._experience.renderTarget, {
				requiredFeatures: this._configuration.session.requiredFeatures,
				optionalFeatures: this._configuration.session.optionalFeatures,
			});
			this._phase = "in-xr";
			this._pushTrace("entered", `Entered ${this._configuration.session.mode}.`);
			return this.snapshot();
		} catch (error) {
			this._recordError("Unable to enter the authored XR session", error);
			throw error;
		}
	}

	/** Exits the active session without destroying the reusable experience helper. */
	public async exitSession(): Promise<IXRRuntimeSnapshot> {
		if (!this._experience || this._phase === "ready" || this._phase === "idle" || this._phase === "disabled") {
			return this.snapshot();
		}
		this._phase = "exiting";
		this._pushTrace("exit", "Exiting XR session.");
		try {
			await this._experience.baseExperience.exitXRAsync();
			this._phase = "ready";
			this._pushTrace("exited", "Exited XR session.");
			return this.snapshot();
		} catch (error) {
			this._recordError("Unable to exit the XR session", error);
			throw error;
		}
	}

	/** Returns bounded runtime evidence safe for diagnostics and external agents. */
	public snapshot(traceLimit = 64): IXRRuntimeSnapshot {
		const experience = this._experience;
		return {
			phase: this._phase,
			configurationRevision: this._configuration.revision,
			sessionMode: this._configuration.session.mode,
			referenceSpaceType: this._configuration.session.referenceSpaceType,
			experienceInitialized: experience !== null,
			inSession: this._phase === "in-xr",
			lastError: this._lastError,
			controllers: experience?.input.controllers.map((controller) => this._controllerState(controller)) ?? [],
			enabledFeatures: experience?.baseExperience.featuresManager.getEnabledFeatures() ?? [],
			interactables: this._configuration.interactables.map((entry) => ({
				id: entry.id,
				meshId: entry.meshId,
				resolved: this._scene.getMeshById(entry.meshId) !== null,
				modes: entry.modes.slice(),
			})),
			trace: this._trace.slice(-Math.max(0, Math.min(traceLimit, this._configuration.maxTraceEvents))),
		};
	}

	/** Disposes observers, helper-owned assets, behaviors, and transient scene references exactly once. */
	public dispose(): void {
		if (this._phase === "disposed") {
			return;
		}
		if (this._pointerObserver) {
			this._scene.onPointerObservable.remove(this._pointerObserver);
			this._pointerObserver = null;
		}
		this._restoreInteractables();
		this._disposeExperience();
		this._phase = "disposed";
		if (runtimes.get(this._scene) === this) {
			runtimes.delete(this._scene);
		}
	}

	/** Performs the sole asynchronous initialization transaction. */
	private async _initializeInternal(): Promise<IXRRuntimeSnapshot> {
		this._phase = "initializing";
		this._pushTrace("initialize", `Initializing ${this._configuration.session.mode}.`);
		try {
			const camera = this._configuration.origin.cameraId ? this._scene.getCameraById(this._configuration.origin.cameraId) : null;
			if (camera) {
				this._scene.activeCamera = camera;
			}
			this._applyInteractables();
			const factory = this._options.experienceFactory ?? WebXRDefaultExperience.CreateAsync;
			const experience = await factory(this._scene, createXRExperienceOptions(this._scene, this._configuration));
			if (this._isDisposed() || this._scene.isDisposed) {
				experience.dispose();
				return this.snapshot();
			}
			this._experience = experience;
			this._scene.xrExperience = experience;
			this._configureExperience(experience);
			this._attachExperienceObservers(experience);
			this._attachPointerObserver();
			this._phase = "ready";
			this._pushTrace("ready", "XR experience is ready for a user-gesture session start.");
		} catch (error) {
			if (this._isDisposed()) {
				return this.snapshot();
			}
			this._restoreInteractables();
			this._disposeExperience();
			this._recordError("Unable to initialize the exported XR experience", error);
		}
		return this.snapshot();
	}

	/** Applies locomotion/world-scale values that Babylon exposes after helper creation. */
	private _configureExperience(experience: WebXRDefaultExperience): void {
		experience.baseExperience.sessionManager.worldScalingFactor = this._configuration.origin.worldScale;
		if (experience.teleportation) {
			experience.teleportation.rotationAngle = (this._configuration.locomotion.rotationAngleDegrees * Math.PI) / 180;
		}
		if (this._configuration.locomotion.continuousMove || this._configuration.locomotion.continuousTurn) {
			experience.baseExperience.featuresManager.enableFeature(WebXRFeatureName.MOVEMENT, "latest", {
				xrInput: experience.input,
				movementEnabled: this._configuration.locomotion.continuousMove,
				movementOrientationFollowsViewerPose: true,
				movementOrientationFollowsController: false,
				movementSpeed: this._configuration.locomotion.movementSpeed,
				rotationEnabled: this._configuration.locomotion.continuousTurn,
				rotationSpeed: this._configuration.locomotion.rotationSpeed,
			});
		}
	}

	/** Applies portable mesh affordances and retains exact values for cleanup/reconfiguration. */
	private _applyInteractables(): void {
		for (const definition of this._configuration.interactables.filter((entry) => entry.enabled)) {
			const mesh = this._scene.getMeshById(definition.meshId);
			if (!mesh) {
				continue;
			}
			const lease: IXRInteractableLease = {
				mesh,
				wasPickable: mesh.isPickable,
				wasNearPickable: mesh.isNearPickable,
				wasNearGrabbable: mesh.isNearGrabbable,
				behavior: null,
			};
			mesh.isPickable = definition.modes.includes("select") || definition.modes.includes("grab");
			mesh.isNearPickable = definition.modes.includes("select");
			mesh.isNearGrabbable = definition.modes.includes("grab");
			if (definition.modes.includes("grab") && mesh instanceof Mesh && !mesh.getBehaviorByName("SixDofDrag")) {
				const behavior = new SixDofDragBehavior();
				behavior.dragDeltaRatio = definition.dragSmoothing;
				behavior.rotateWithMotionController = definition.rotateWithController;
				mesh.addBehavior(behavior);
				lease.behavior = behavior;
			}
			this._interactableLeases.push(lease);
		}
	}

	/** Restores pre-runtime mesh flags and detaches only behaviors owned by this lease. */
	private _restoreInteractables(): void {
		for (const lease of this._interactableLeases.splice(0)) {
			lease.mesh.isPickable = lease.wasPickable;
			lease.mesh.isNearPickable = lease.wasNearPickable;
			lease.mesh.isNearGrabbable = lease.wasNearGrabbable;
			if (lease.behavior && lease.mesh instanceof Mesh) {
				lease.mesh.removeBehavior(lease.behavior);
				lease.behavior.detach();
			}
		}
	}

	/** Mirrors Babylon state changes even when the built-in enter/exit UI owns the transition. */
	private _attachExperienceObservers(experience: WebXRDefaultExperience): void {
		this._stateObserver = experience.baseExperience.onStateChangedObservable.add((state) => {
			if (state === WebXRState.ENTERING_XR) {
				this._phase = "entering";
			}
			if (state === WebXRState.IN_XR) {
				this._phase = "in-xr";
			}
			if (state === WebXRState.EXITING_XR) {
				this._phase = "exiting";
			}
			if (state === WebXRState.NOT_IN_XR && this._phase !== "initializing") {
				this._phase = "ready";
			}
		});
		this._controllerAddedObserver = experience.input.onControllerAddedObservable.add((controller) => {
			this._pushTrace("controller-added", `Controller ${controller.uniqueId} connected.`, controller.uniqueId);
			controller.onMotionControllerInitObservable.addOnce(() => {
				this._pushTrace("controller-added", `Controller ${controller.uniqueId} motion profile initialized.`, controller.uniqueId);
			});
		});
		this._controllerRemovedObserver = experience.input.onControllerRemovedObservable.add((controller) => {
			this._pushTrace("controller-removed", `Controller ${controller.uniqueId} disconnected.`, controller.uniqueId);
		});
	}

	/** Removes observers before the helper disposes their observable owners. */
	private _detachExperienceObservers(): void {
		if (!this._experience) {
			return;
		}
		if (this._stateObserver) {
			this._experience.baseExperience.onStateChangedObservable.remove(this._stateObserver);
		}
		if (this._controllerAddedObserver) {
			this._experience.input.onControllerAddedObservable.remove(this._controllerAddedObserver);
		}
		if (this._controllerRemovedObserver) {
			this._experience.input.onControllerRemovedObservable.remove(this._controllerRemovedObserver);
		}
		this._stateObserver = null;
		this._controllerAddedObserver = null;
		this._controllerRemovedObserver = null;
	}

	/** Converts WebXR-generated pointer events into bounded authored interaction evidence. */
	private _attachPointerObserver(): void {
		const definitions = new Map(this._configuration.interactables.filter((entry) => entry.enabled).map((entry) => [entry.meshId, entry]));
		this._pointerObserver = this._scene.onPointerObservable.add((pointerInfo) => {
			const eventPointerId = "pointerId" in pointerInfo.event ? pointerInfo.event.pointerId : 0;
			const pointerId = typeof eventPointerId === "number" ? eventPointerId : 0;
			const definition = this._findInteractable(pointerInfo.pickInfo?.pickedMesh ?? null, definitions);
			const meshId = definition?.meshId ?? null;
			if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
				const previous = this._hoveredMeshes.get(pointerId) ?? null;
				const next = definition ? meshId : null;
				if (next !== previous) {
					this._hoveredMeshes.set(pointerId, next);
					this._pushTrace("hover", next ? `Pointer entered ${next}.` : `Pointer left ${previous ?? "scene"}.`, null, next ?? previous);
				}
				return;
			}
			if (!definition || !definition.modes.some((mode) => mode === "select" || mode === "grab")) {
				return;
			}
			if (pointerInfo.type === PointerEventTypes.POINTERDOWN || pointerInfo.type === PointerEventTypes.POINTERPICK) {
				this._pushTrace("select", `Selected ${definition.meshId}.`, null, definition.meshId);
				this._pulse(pointerId, definition);
			}
		});
	}

	/** Resolves child picks to the nearest authored interactable ancestor. */
	private _findInteractable(mesh: AbstractMesh | null, definitions: Map<string, IXRInteractableDefinition>): IXRInteractableDefinition | undefined {
		let candidate: AbstractMesh | null = mesh;
		while (candidate) {
			const definition = definitions.get(candidate.id);
			if (definition) {
				return definition;
			}
			candidate = candidate.parent instanceof AbstractMesh ? candidate.parent : null;
		}
		return undefined;
	}

	/** Re-reads disposal state after awaited calls, avoiding stale control-flow narrowing. */
	private _isDisposed(): boolean {
		return this._phase === "disposed";
	}

	/** Clears the current helper and scene reference after normal disposal or failed setup. */
	private _disposeExperience(): void {
		const experience = this._experience;
		this._detachExperienceObservers();
		experience?.dispose();
		if (this._scene.xrExperience === experience) {
			delete this._scene.xrExperience;
		}
		this._experience = null;
	}

	/** Sends optional authored haptics through the controller that generated a pointer event. */
	private _pulse(pointerId: number, definition: IXRInteractableDefinition): void {
		if (!this._experience || definition.hapticAmplitude <= 0 || definition.hapticDurationMs <= 0) {
			return;
		}
		const controller = this._experience.pointerSelection?.getXRControllerByPointerId(pointerId);
		if (controller?.motionController) {
			void controller.motionController.pulse(definition.hapticAmplitude, definition.hapticDurationMs);
		}
	}

	/** Projects a controller into a stable serializable diagnostic record. */
	private _controllerState(controller: WebXRInputSource): IXRControllerState {
		return {
			id: controller.uniqueId,
			handedness: controller.inputSource.handedness,
			targetRayMode: controller.inputSource.targetRayMode,
			profiles: [...controller.inputSource.profiles],
			motionControllerProfile: controller.motionController?.profileId ?? null,
		};
	}

	/** Retains newest-first-bounded diagnostics without allocating an unbounded session log. */
	private _pushTrace(type: XRRuntimeTraceType, message: string, controllerId: string | null = null, meshId: string | null = null): void {
		this._trace.push({ sequence: ++this._sequence, timestamp: (this._options.now ?? Date.now)(), type, message, controllerId, meshId });
		if (this._trace.length > this._configuration.maxTraceEvents) {
			this._trace.splice(0, this._trace.length - this._configuration.maxTraceEvents);
		}
	}

	/** Moves the runtime to inspectable error state and keeps warnings off stdout. */
	private _recordError(context: string, error: unknown): void {
		this._lastError = `${context}: ${errorMessage(error)}`;
		this._phase = "error";
		this._pushTrace("error", this._lastError);
		(this._options.warn ?? ((message, cause) => console.warn(message, cause)))(context, error);
	}
}

/** Returns the current scene runtime lease without creating one. */
export function getXRRuntime(scene: Scene): XRRuntime | null {
	return runtimes.get(scene) ?? null;
}

/** Disposes any prior lease, creates one canonical runtime, and optionally initializes it. */
export async function configureXR(scene: Scene, options: IConfigureXROptions = {}): Promise<XRRuntime | null> {
	const configuration = getSceneXRConfiguration(scene);
	getXRRuntime(scene)?.dispose();
	if (!configuration.enabled) {
		return null;
	}
	const runtime = new XRRuntime(scene, configuration, options);
	runtimes.set(scene, runtime);
	if (configuration.session.initializeOnStartup) {
		await runtime.initialize();
	}
	return runtime;
}

/** Rebuilds runtime state from the latest authored metadata after an editor mutation. */
export async function reconfigureXR(scene: Scene, options: IConfigureXROptions = {}): Promise<XRRuntime | null> {
	return configureXR(scene, options);
}

/** Starts a configured scene session through the explicit exported-game API. */
export async function enterXRSession(scene: Scene): Promise<IXRRuntimeSnapshot> {
	const runtime = getXRRuntime(scene) ?? (await configureXR(scene));
	if (!runtime) {
		throw new Error("XR is disabled for this scene.");
	}
	return runtime.enterSession();
}

/** Exits the current scene session while keeping the helper ready for re-entry. */
export async function exitXRSession(scene: Scene): Promise<IXRRuntimeSnapshot | null> {
	return (await getXRRuntime(scene)?.exitSession()) ?? null;
}

/** Produces bounded diagnostics without exposing the mutable runtime object. */
export function getXRRuntimeSnapshot(scene: Scene, traceLimit = 64): IXRRuntimeSnapshot | null {
	return getXRRuntime(scene)?.snapshot(traceLimit) ?? null;
}
