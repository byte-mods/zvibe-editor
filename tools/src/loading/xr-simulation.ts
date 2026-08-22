import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import { getSceneXRConfiguration, IEditorXRConfiguration, IXRInteractableDefinition, IXRSimulatedPose, XRInteractionMode } from "./xr-model";

export type XRSimulationPhase = "stopped" | "active" | "disposed";
export type XRSimulationDevice = "headset" | "left" | "right";
export type XRSimulationInputType = "set-pose" | "move-pose" | "press-select" | "release-select";

export interface IXRSimulationInput {
	type: XRSimulationInputType;
	device: XRSimulationDevice;
	position?: [number, number, number];
	rotation?: [number, number, number];
	deltaPosition?: [number, number, number];
	deltaRotation?: [number, number, number];
	interactionMode?: XRInteractionMode | "auto";
	interactionLayers?: string[];
}

export interface IXRSimulationTraceEvent {
	sequence: number;
	timestamp: number;
	type: "start" | "stop" | "pose" | "select" | "grab" | "release" | "teleport" | "miss";
	message: string;
	device: XRSimulationDevice | null;
	meshId: string | null;
}

export interface IXRSimulatedDeviceState extends IXRSimulatedPose {
	device: XRSimulationDevice;
	enabled: boolean;
}

export interface IXRSimulationRayState {
	controller: "left" | "right";
	origin: [number, number, number];
	direction: [number, number, number];
	hit: boolean;
	meshId: string | null;
	distance: number | null;
}

export interface IXRSimulationSnapshot {
	phase: XRSimulationPhase;
	configurationRevision: number;
	devices: IXRSimulatedDeviceState[];
	rays: IXRSimulationRayState[];
	heldInteractables: Array<{ controller: "left" | "right"; interactableId: string; meshId: string }>;
	trace: IXRSimulationTraceEvent[];
}

export interface IXRSimulationOptions {
	now?: () => number;
}

interface ITransformLease {
	mesh: AbstractMesh;
	position: Vector3;
	rotation: Vector3;
	rotationQuaternion: Quaternion | null;
}

interface ICameraLease {
	camera: TargetCamera;
	position: Vector3;
	rotation: Vector3;
	rotationQuaternion: Quaternion | null;
}

interface IHeldInteractable {
	definition: IXRInteractableDefinition;
	mesh: AbstractMesh;
	offset: Vector3;
	controllerStartRotation: Quaternion;
	meshStartRotation: Quaternion;
}

const simulators = new WeakMap<Scene, XRSimulator>();

/** Converts the persisted degrees convention into Babylon's yaw/pitch/roll quaternion order. */
function poseQuaternion(pose: IXRSimulatedPose): Quaternion {
	return Quaternion.RotationYawPitchRoll((pose.rotation[1] * Math.PI) / 180, (pose.rotation[0] * Math.PI) / 180, (pose.rotation[2] * Math.PI) / 180);
}

/** Keeps all simulated pose arithmetic in metres until it crosses into the centimetre-based scene. */
function tupleAdd(left: [number, number, number], right: [number, number, number]): [number, number, number] {
	return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

/** Rejects malformed direct API calls even when an MCP/editor schema was bypassed. */
function finiteTuple(value: unknown, label: string): asserts value is [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		throw new Error(`${label} must contain exactly three finite numbers.`);
	}
}

/** Enforces the same discriminated exact-input contract for direct runtime callers as MCP schemas do. */
function validateSimulationInput(input: IXRSimulationInput): void {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("XR simulation input must be an object.");
	}
	const allowedByType: Record<XRSimulationInputType, string[]> = {
		"set-pose": ["type", "device", "position", "rotation"],
		"move-pose": ["type", "device", "deltaPosition", "deltaRotation"],
		"press-select": ["type", "device", "interactionMode", "interactionLayers"],
		"release-select": ["type", "device"],
	};
	if (!Object.hasOwn(allowedByType, input.type)) {
		throw new Error(`Unsupported XR simulation input type: ${String(input.type)}.`);
	}
	if (!["headset", "left", "right"].includes(input.device)) {
		throw new Error(`Unsupported XR simulation device: ${String(input.device)}.`);
	}
	const unknown = Object.keys(input).filter((key) => !allowedByType[input.type].includes(key));
	if (unknown.length) {
		throw new Error(`XR simulation ${input.type} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	for (const [label, tuple] of [
		["position", input.position],
		["rotation", input.rotation],
		["deltaPosition", input.deltaPosition],
		["deltaRotation", input.deltaRotation],
	] as const) {
		if (tuple !== undefined) {
			finiteTuple(tuple, `XR simulated ${label}`);
		}
	}
	if (input.interactionMode && !["auto", "select", "grab", "teleport"].includes(input.interactionMode)) {
		throw new Error(`Unsupported XR simulation interaction mode: ${input.interactionMode}.`);
	}
	if (input.interactionLayers) {
		const pattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
		if (!input.interactionLayers.length || input.interactionLayers.length > 16 || new Set(input.interactionLayers).size !== input.interactionLayers.length) {
			throw new Error("XR simulation interactionLayers must contain 1-16 unique entries.");
		}
		if (input.interactionLayers.some((entry) => typeof entry !== "string" || !pattern.test(entry))) {
			throw new Error("XR simulation interactionLayers contains an invalid value.");
		}
	}
}

/** Owns one transient desktop simulation lease and restores every transform it changes. */
export class XRSimulator {
	private _phase: XRSimulationPhase = "stopped";
	private _sequence = 0;
	private _trace: IXRSimulationTraceEvent[] = [];
	private _rays = new Map<"left" | "right", IXRSimulationRayState>();
	private _held = new Map<"left" | "right", IHeldInteractable>();
	private _meshLeases = new Map<string, ITransformLease>();
	private _cameraLease: ICameraLease | null = null;
	private readonly _headsetEyeHeight: number;
	private _devices: Record<XRSimulationDevice, IXRSimulatedDeviceState>;

	public constructor(
		private readonly _scene: Scene,
		private readonly _configuration: IEditorXRConfiguration,
		private readonly _options: IXRSimulationOptions = {}
	) {
		this._headsetEyeHeight = _configuration.simulation.headset.position[1];
		this._devices = {
			headset: this._deviceState("headset", _configuration.simulation.headset, true),
			left: this._deviceState("left", _configuration.simulation.leftController, _configuration.simulation.leftController.enabled),
			right: this._deviceState("right", _configuration.simulation.rightController, _configuration.simulation.rightController.enabled),
		};
		this._scene.onDisposeObservable.addOnce(() => this.dispose());
	}

	/** Starts a deterministic non-WebXR desktop lease using authored simulator poses. */
	public start(): IXRSimulationSnapshot {
		if (this._phase === "disposed") {
			throw new Error("The XR simulator has been disposed.");
		}
		if (!this._configuration.enabled) {
			throw new Error("XR must be enabled before simulation can start.");
		}
		if (!this._configuration.simulation.enabled) {
			throw new Error("XR desktop simulation must be enabled in the scene configuration.");
		}
		if (this._phase === "active") {
			return this.snapshot();
		}
		this._phase = "active";
		this._leaseAndApplyCamera();
		this._pushTrace("start", "Desktop XR simulation started.");
		return this.snapshot();
	}

	/** Applies one explicit pose or interaction input and returns its complete bounded evidence. */
	public applyInput(input: IXRSimulationInput): IXRSimulationSnapshot {
		if (this._phase !== "active") {
			throw new Error("XR desktop simulation is not active.");
		}
		validateSimulationInput(input);
		if ((input.type === "press-select" || input.type === "release-select") && input.device === "headset") {
			throw new Error(`${input.type} requires the left or right controller.`);
		}
		if (input.type === "set-pose" || input.type === "move-pose") {
			this._applyPoseInput(input);
		} else if (input.type === "press-select") {
			this._press(input.device as "left" | "right", input.interactionMode ?? "auto", input.interactionLayers ?? ["default"]);
		} else {
			this._release(input.device as "left" | "right");
		}
		return this.snapshot();
	}

	/** Stops simulation and exactly restores camera and grabbed mesh transforms. */
	public stop(): IXRSimulationSnapshot {
		if (this._phase !== "active") {
			return this.snapshot();
		}
		for (const controller of [...this._held.keys()]) {
			this._release(controller);
		}
		for (const lease of this._meshLeases.values()) {
			if (lease.mesh.isDisposed()) {
				continue;
			}
			lease.mesh.position.copyFrom(lease.position);
			lease.mesh.rotation.copyFrom(lease.rotation);
			lease.mesh.rotationQuaternion = lease.rotationQuaternion?.clone() ?? null;
		}
		this._meshLeases.clear();
		if (this._cameraLease && !this._cameraLease.camera.isDisposed()) {
			this._cameraLease.camera.position.copyFrom(this._cameraLease.position);
			this._cameraLease.camera.rotation.copyFrom(this._cameraLease.rotation);
			this._cameraLease.camera.rotationQuaternion = this._cameraLease.rotationQuaternion?.clone() ?? null;
		}
		this._cameraLease = null;
		this._phase = "stopped";
		this._pushTrace("stop", "Desktop XR simulation stopped and transient transforms were restored.");
		return this.snapshot();
	}

	/** Returns serializable simulator state without exposing mutable Babylon objects. */
	public snapshot(traceLimit = 64): IXRSimulationSnapshot {
		return {
			phase: this._phase,
			configurationRevision: this._configuration.revision,
			devices: ["headset", "left", "right"].map((device) => structuredClone(this._devices[device as XRSimulationDevice])),
			rays: [...this._rays.values()].map((ray) => structuredClone(ray)),
			heldInteractables: [...this._held.entries()].map(([controller, held]) => ({ controller, interactableId: held.definition.id, meshId: held.definition.meshId })),
			trace: this._trace.slice(-Math.max(0, Math.min(traceLimit, this._configuration.maxTraceEvents))),
		};
	}

	/** Stops the transient lease and removes it from scene lookup exactly once. */
	public dispose(): void {
		if (this._phase === "disposed") {
			return;
		}
		this.stop();
		this._phase = "disposed";
		if (simulators.get(this._scene) === this) {
			simulators.delete(this._scene);
		}
	}

	/** Copies one authored pose into an independently mutable simulator device state. */
	private _deviceState(device: XRSimulationDevice, pose: IXRSimulatedPose, enabled: boolean): IXRSimulatedDeviceState {
		return { device, enabled, position: [...pose.position], rotation: [...pose.rotation] };
	}

	/** Updates absolute/delta poses and carries held objects with controller motion. */
	private _applyPoseInput(input: IXRSimulationInput): void {
		const device = this._devices[input.device];
		if (!device.enabled) {
			throw new Error(`Simulated ${input.device} device is disabled.`);
		}
		let nextPosition: [number, number, number] = [...device.position];
		let nextRotation: [number, number, number] = [...device.rotation];
		if (input.type === "set-pose") {
			if (!input.position && !input.rotation) {
				throw new Error("set-pose requires position and/or rotation.");
			}
			if (input.position) {
				nextPosition = [...input.position];
			}
			if (input.rotation) {
				nextRotation = [...input.rotation];
			}
		} else {
			if (!input.deltaPosition && !input.deltaRotation) {
				throw new Error("move-pose requires deltaPosition and/or deltaRotation.");
			}
			if (input.deltaPosition) {
				nextPosition = tupleAdd(device.position, input.deltaPosition);
			}
			if (input.deltaRotation) {
				nextRotation = tupleAdd(device.rotation, input.deltaRotation);
			}
		}
		for (const value of [...nextPosition, ...nextRotation]) {
			if (Math.abs(value) > 100_000) {
				throw new Error("XR simulated pose components must remain between -100000 and 100000.");
			}
		}
		device.position = nextPosition;
		device.rotation = nextRotation;
		if (input.device === "headset") {
			this._applyCameraPose();
		} else {
			this._moveHeld(input.device, device);
		}
		this._pushTrace("pose", `Updated simulated ${input.device} pose.`, input.device);
	}

	/** Runs one layer-filtered ray press and dispatches select, grab, or teleport semantics. */
	private _press(controller: "left" | "right", requestedMode: XRInteractionMode | "auto", layers: string[]): void {
		const device = this._devices[controller];
		if (!device.enabled) {
			throw new Error(`Simulated ${controller} controller is disabled.`);
		}
		const ray = this._ray(device);
		const floorIds = new Set(this._configuration.origin.floorMeshIds);
		const definitionByMesh = new Map(this._configuration.interactables.filter((entry) => entry.enabled).map((entry) => [entry.meshId, entry]));
		const accepted = (mesh: AbstractMesh): boolean => {
			const definition = this._findInteractable(mesh, definitionByMesh);
			const matchesLayer = definition?.interactionLayers.some((layer) => layers.includes(layer)) ?? false;
			const acceptsMode = definition ? requestedMode === "auto" || definition.modes.includes(requestedMode) : false;
			const acceptsFloor = this._configuration.locomotion.teleportation && (requestedMode === "auto" || requestedMode === "teleport") && this._hasAncestorId(mesh, floorIds);
			return Boolean((definition && matchesLayer && acceptsMode) || acceptsFloor);
		};
		const pick = this._scene.pickWithRay(ray, accepted, false);
		this._rays.set(controller, {
			controller,
			origin: ray.origin.asArray() as [number, number, number],
			direction: ray.direction.asArray() as [number, number, number],
			hit: Boolean(pick?.hit),
			meshId: pick?.pickedMesh?.id ?? null,
			distance: pick?.hit ? pick.distance : null,
		});
		if (!pick?.hit || !pick.pickedMesh) {
			this._pushTrace("miss", `Simulated ${controller} ray did not hit an eligible target.`, controller);
			return;
		}
		const definition = this._findInteractable(pick.pickedMesh, definitionByMesh);
		const availableMode = this._chooseMode(definition, requestedMode, this._hasAncestorId(pick.pickedMesh, floorIds));
		if (!availableMode) {
			this._pushTrace("miss", `Simulated ${controller} ray hit a target without the requested interaction.`, controller, pick.pickedMesh.id);
			return;
		}
		if (availableMode === "teleport") {
			const destination = pick.pickedPoint ?? ray.origin.add(ray.direction.scale(pick.distance));
			const originNode = this._originNode();
			const localDestination = originNode ? Vector3.TransformCoordinates(destination, Matrix.Invert(originNode.getWorldMatrix())) : destination;
			this._devices.headset.position = [
				localDestination.x / this._configuration.origin.worldScale,
				localDestination.y / this._configuration.origin.worldScale + this._headsetEyeHeight,
				localDestination.z / this._configuration.origin.worldScale,
			];
			this._applyCameraPose();
			this._pushTrace("teleport", `Teleported simulated headset to ${pick.pickedMesh.id}.`, controller, pick.pickedMesh.id);
			return;
		}
		if (!definition) {
			return;
		}
		if (availableMode === "grab") {
			const mesh = this._scene.getMeshById(definition.meshId)!;
			this._leaseMesh(mesh);
			const controllerPosition = this._scenePosition(device.position);
			this._held.set(controller, {
				definition,
				mesh,
				offset: mesh.absolutePosition.subtract(controllerPosition),
				controllerStartRotation: poseQuaternion(device),
				meshStartRotation: mesh.rotationQuaternion?.clone() ?? Quaternion.FromEulerAngles(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z),
			});
			this._pushTrace("grab", `Grabbed ${definition.meshId}.`, controller, definition.meshId);
			return;
		}
		this._pushTrace("select", `Selected ${definition.meshId}.`, controller, definition.meshId);
	}

	/** Releases only the requested controller's active grab lease. */
	private _release(controller: "left" | "right"): void {
		const held = this._held.get(controller);
		if (held) {
			this._held.delete(controller);
			this._pushTrace("release", `Released ${held.definition.meshId}.`, controller, held.definition.meshId);
		}
	}

	/** Selects a deterministic interaction when auto mode is requested. */
	private _chooseMode(definition: IXRInteractableDefinition | undefined, requestedMode: XRInteractionMode | "auto", floor: boolean): XRInteractionMode | null {
		if (requestedMode !== "auto") {
			return definition?.modes.includes(requestedMode) || (requestedMode === "teleport" && floor) ? requestedMode : null;
		}
		if (definition?.modes.includes("grab")) {
			return "grab";
		}
		if (definition?.modes.includes("select")) {
			return "select";
		}
		return definition?.modes.includes("teleport") || floor ? "teleport" : null;
	}

	/** Builds a world-space ray from one simulated controller pose. */
	private _ray(device: IXRSimulatedDeviceState): Ray {
		const direction = Vector3.Forward(this._scene.useRightHandedSystem);
		const rotatedDirection = Vector3.Zero();
		direction.rotateByQuaternionToRef(poseQuaternion(device), rotatedDirection);
		const originNode = this._originNode();
		const worldDirection = originNode ? Vector3.TransformNormal(rotatedDirection, originNode.getWorldMatrix()).normalize() : rotatedDirection.normalize();
		return new Ray(this._scenePosition(device.position), worldDirection, this._configuration.simulation.maxRayDistance * this._configuration.origin.worldScale);
	}

	/** Resolves authored parent meshes when a child geometry surface is picked. */
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

	/** Recognizes floor authoring on a picked child mesh. */
	private _hasAncestorId(mesh: AbstractMesh | null, ids: Set<string>): boolean {
		let candidate: AbstractMesh | null = mesh;
		while (candidate) {
			if (ids.has(candidate.id)) {
				return true;
			}
			candidate = candidate.parent instanceof AbstractMesh ? candidate.parent : null;
		}
		return false;
	}

	/** Leases a grabbed mesh before the first transient transform mutation. */
	private _leaseMesh(mesh: AbstractMesh): void {
		if (!this._meshLeases.has(mesh.id)) {
			this._meshLeases.set(mesh.id, { mesh, position: mesh.position.clone(), rotation: mesh.rotation.clone(), rotationQuaternion: mesh.rotationQuaternion?.clone() ?? null });
		}
	}

	/** Carries the grabbed mesh with controller translation and optional controller rotation. */
	private _moveHeld(controller: "left" | "right", device: IXRSimulatedDeviceState): void {
		const held = this._held.get(controller);
		if (!held) {
			return;
		}
		held.mesh.setAbsolutePosition(this._scenePosition(device.position).add(held.offset));
		if (held.definition.rotateWithController) {
			const controllerDelta = poseQuaternion(device).multiply(Quaternion.Inverse(held.controllerStartRotation));
			held.mesh.rotationQuaternion = controllerDelta.multiply(held.meshStartRotation);
		}
	}

	/** Leases and applies the configured origin camera as a simulated headset. */
	private _leaseAndApplyCamera(): void {
		const camera = this._configuration.origin.cameraId ? this._scene.getCameraById(this._configuration.origin.cameraId) : this._scene.activeCamera;
		if (!(camera instanceof TargetCamera)) {
			return;
		}
		this._cameraLease = { camera, position: camera.position.clone(), rotation: camera.rotation.clone(), rotationQuaternion: camera.rotationQuaternion?.clone() ?? null };
		this._applyCameraPose();
	}

	/** Applies the current simulated headset pose without persisting it into scene metadata. */
	private _applyCameraPose(): void {
		if (!this._cameraLease) {
			return;
		}
		const originNode = this._originNode();
		const localPosition = Vector3.FromArray(this._devices.headset.position).scale(this._configuration.origin.worldScale);
		this._cameraLease.camera.position.copyFrom(this._cameraLease.camera.parent === originNode ? localPosition : this._scenePosition(this._devices.headset.position));
		this._cameraLease.camera.rotationQuaternion = poseQuaternion(this._devices.headset);
	}

	/** Resolves either a TransformNode or mesh as the authored XR Origin transform. */
	private _originNode(): TransformNode | null {
		const id = this._configuration.origin.originNodeId;
		return id ? (this._scene.getTransformNodeById(id) ?? this._scene.getMeshById(id)) : null;
	}

	/** Converts one metre pose through the authored XR Origin into scene units. */
	private _scenePosition(position: [number, number, number]): Vector3 {
		const localPosition = Vector3.FromArray(position).scale(this._configuration.origin.worldScale);
		const originNode = this._originNode();
		return originNode ? Vector3.TransformCoordinates(localPosition, originNode.getWorldMatrix()) : localPosition;
	}

	/** Retains a bounded, deterministic interaction trace for tests and external diagnostics. */
	private _pushTrace(type: IXRSimulationTraceEvent["type"], message: string, device: XRSimulationDevice | null = null, meshId: string | null = null): void {
		this._trace.push({ sequence: ++this._sequence, timestamp: (this._options.now ?? Date.now)(), type, message, device, meshId });
		if (this._trace.length > this._configuration.maxTraceEvents) {
			this._trace.splice(0, this._trace.length - this._configuration.maxTraceEvents);
		}
	}
}

/** Creates and starts one simulator lease, replacing any stopped/stale lease. */
export function startXRSimulation(scene: Scene, options: IXRSimulationOptions = {}): IXRSimulationSnapshot {
	const current = getXRSimulator(scene);
	const configuration = getSceneXRConfiguration(scene);
	if (current && current.snapshot(0).configurationRevision === configuration.revision) {
		return current.start();
	}
	current?.dispose();
	const simulator = new XRSimulator(scene, configuration, options);
	simulators.set(scene, simulator);
	try {
		return simulator.start();
	} catch (error) {
		simulator.dispose();
		throw error;
	}
}

/** Returns the current simulator lease without creating one. */
export function getXRSimulator(scene: Scene): XRSimulator | null {
	return simulators.get(scene) ?? null;
}

/** Applies one deterministic external/editor input to the active simulator. */
export function simulateXRInput(scene: Scene, input: IXRSimulationInput): IXRSimulationSnapshot {
	const simulator = getXRSimulator(scene);
	if (!simulator) {
		throw new Error("XR desktop simulation is not active.");
	}
	return simulator.applyInput(input);
}

/** Stops and releases the current simulator while returning final evidence. */
export function stopXRSimulation(scene: Scene): IXRSimulationSnapshot | null {
	const simulator = getXRSimulator(scene);
	if (!simulator) {
		return null;
	}
	const snapshot = simulator.stop();
	simulator.dispose();
	return snapshot;
}

/** Reads simulator diagnostics without exposing the mutable lease. */
export function getXRSimulationSnapshot(scene: Scene, traceLimit = 64): IXRSimulationSnapshot | null {
	return getXRSimulator(scene)?.snapshot(traceLimit) ?? null;
}
