import { ReactNode, useState } from "react";

import { Scene } from "babylonjs";
import { IEditorXRConfiguration, IXRTargetValidationReport, XR_SESSION_FEATURES, XRSessionFeature } from "babylonjs-editor-tools";
import { toast } from "sonner";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import {
	applyXRSimulationInput,
	createXRInteractable,
	deleteXRInteractable,
	enterXRRuntimeSession,
	exitXRRuntimeSession,
	getXRAuthoringSnapshot,
	getXRConfiguration,
	getXRRuntimeState,
	getXRSimulationState,
	initializeXRRuntime,
	reconfigureXRRuntime,
	restoreXRAuthoringSnapshot,
	setXRConfiguration,
	setXRInteractable,
	startXRDesktopSimulation,
	stopXRDesktopSimulation,
	validateXRConfigurationTarget,
} from "../../../../mcp/xr/xr";
import { registerUndoRedo } from "../../../../tools/undoredo";
import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

export interface IXRSceneInspectorProps {
	scene: Scene;
	editor: Editor;
}

type XRConfigurationChanges = Parameters<typeof setXRConfiguration>[1] extends { changes: infer T } ? T : Record<string, unknown>;

/** Uses one compact numeric editor for the many XR values that share blur-to-commit semantics. */
function numberField(label: string, value: number, onChange: (value: number) => void, step = "any"): ReactNode {
	return (
		<label className="flex items-center justify-between gap-2 text-[11px]">
			<span>{label}</span>
			<Input
				key={value}
				className="h-7 w-24"
				type="number"
				step={step}
				defaultValue={value}
				onBlur={(event) => {
					const next = Number(event.currentTarget.value);
					if (Number.isFinite(next) && next !== value) {
						onChange(next);
					}
				}}
			/>
		</label>
	);
}

/** Renders a compact Boolean authoring button with explicit current state. */
function toggle(label: string, value: boolean, onChange: (value: boolean) => void): ReactNode {
	return (
		<Button size="sm" variant={value ? "secondary" : "ghost"} className="h-7 justify-start px-2 text-[11px]" onClick={() => onChange(!value)}>
			{label}: {value ? "On" : "Off"}
		</Button>
	);
}

/** Parses comma-separated stable scene ids without admitting duplicates or whitespace aliases. */
function idList(value: string): string[] {
	return [
		...new Set(
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		),
	];
}

/** Parses simulator pose triples while leaving invalid drafts uncommitted. */
function tuple(value: string): [number, number, number] | null {
	const result = value.split(",").map((entry) => Number(entry.trim()));
	return result.length === 3 && result.every(Number.isFinite) ? (result as [number, number, number]) : null;
}

/** Parses semicolon-separated XYZ triples used by teleport snap-point authoring. */
function tuples(value: string): [number, number, number][] | null {
	if (!value.trim()) {
		return [];
	}
	const result = value.split(";").map(tuple);
	return result.every((entry) => entry !== null) ? (result as [number, number, number][]) : null;
}

function sameValues(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function XRSceneInspector(props: IXRSceneInspectorProps): ReactNode {
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState(false);
	const [validation, setValidation] = useState<IXRTargetValidationReport | null>(null);
	const [validationTarget, setValidationTarget] = useState<"authoring" | "web" | "electron-web">("web");
	const [interactableName, setInteractableName] = useState("XR Interactable");
	const [interactableMeshId, setInteractableMeshId] = useState("");
	const [interactableModes, setInteractableModes] = useState<Array<"select" | "grab" | "teleport">>(["select"]);
	const [simulationController, setSimulationController] = useState<"left" | "right">("right");
	const configuration = getXRConfiguration(props.scene);
	const runtime = getXRRuntimeState(props.scene, { traceLimit: 12 }).runtime;
	const simulation = getXRSimulationState(props.scene, { traceLimit: 12 }).simulation;
	const options = { editor: props.editor } as any;
	const meshes = props.scene.meshes.filter((mesh) => mesh.id && mesh.name);
	const cameras = props.scene.cameras.filter((camera) => camera.id && camera.name);
	const originNodes = [...props.scene.transformNodes, ...props.scene.meshes];

	/** Registers canonical before/after snapshots so every authoring control participates in global Undo/Redo. */
	async function author(action: () => Promise<unknown>): Promise<void> {
		if (busy) {
			return;
		}
		const before = getXRAuthoringSnapshot(props.scene);
		setBusy(true);
		try {
			await action();
			const after = getXRAuthoringSnapshot(props.scene);
			registerUndoRedo({
				undo: () => void restoreXRAuthoringSnapshot(props.scene, before, options).then(() => setVersion((value) => value + 1)),
				redo: () => void restoreXRAuthoringSnapshot(props.scene, after, options).then(() => setVersion((value) => value + 1)),
			});
			setVersion((value) => value + 1);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "XR authoring failed.");
		} finally {
			setBusy(false);
		}
	}

	/** Runs transient operations without placing simulator/session state in authoring history. */
	async function transient(action: () => unknown | Promise<unknown>): Promise<void> {
		if (busy) {
			return;
		}
		setBusy(true);
		try {
			await action();
			setVersion((value) => value + 1);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "XR runtime operation failed.");
		} finally {
			setBusy(false);
		}
	}

	const patch = (changes: XRConfigurationChanges): void => void author(() => setXRConfiguration(props.scene, { expectedRevision: configuration.revision, changes }, options));
	const patchSession = (changes: Partial<IEditorXRConfiguration["session"]>): void => patch({ session: changes });
	const patchOrigin = (changes: Partial<IEditorXRConfiguration["origin"]>): void => patch({ origin: changes });
	const patchInteraction = (changes: Partial<IEditorXRConfiguration["interaction"]>): void => patch({ interaction: changes });
	const patchLocomotion = (changes: Partial<IEditorXRConfiguration["locomotion"]>): void => patch({ locomotion: changes });
	const patchSimulation = (changes: Record<string, unknown>): void => patch({ simulation: changes });

	/** Cycles native WebXR features through off, optional, and required without overlap. */
	function cycleFeature(feature: XRSessionFeature): void {
		const required = configuration.session.requiredFeatures.filter((entry) => entry !== feature);
		const optional = configuration.session.optionalFeatures.filter((entry) => entry !== feature);
		if (configuration.session.optionalFeatures.includes(feature)) {
			required.push(feature);
		} else if (!configuration.session.requiredFeatures.includes(feature)) {
			optional.push(feature);
		}
		patchSession({ requiredFeatures: required, optionalFeatures: optional });
	}

	function modeButton(mode: "select" | "grab" | "teleport"): ReactNode {
		const active = interactableModes.includes(mode);
		return (
			<Button
				key={mode}
				size="sm"
				variant={active ? "secondary" : "ghost"}
				className="h-7 flex-1 text-[11px]"
				onClick={() => setInteractableModes(active ? interactableModes.filter((entry) => entry !== mode) : [...interactableModes, mode])}
			>
				{mode}
			</Button>
		);
	}

	return (
		<EditorInspectorSectionField
			title="XR / WebXR"
			tooltip="Unity-style XR Origin, session/provider settings, interaction, locomotion, interactables, deterministic desktop simulation, validation, and live WebXR diagnostics."
		>
			<div key={version} className="flex flex-col gap-2 text-xs">
				<div className="flex items-center justify-between rounded bg-input/40 p-2">
					<div>
						<div className="font-medium">Portable WebXR · revision {configuration.revision}</div>
						<div className="text-[10px] text-muted-foreground">Native OpenXR, visionOS, ARCore, and ARKit remain provider integrations.</div>
					</div>
					<Button disabled={busy} size="sm" variant={configuration.enabled ? "secondary" : "default"} onClick={() => patch({ enabled: !configuration.enabled })}>
						{configuration.enabled ? "Enabled" : "Enable"}
					</Button>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="font-medium">Session & provider</div>
					<div className="grid grid-cols-2 gap-1">
						<select
							className="h-8 rounded bg-input px-2"
							value={configuration.session.mode}
							onChange={(event) => patchSession({ mode: event.currentTarget.value as any })}
						>
							<option value="immersive-vr">Immersive VR</option>
							<option value="immersive-ar">Immersive AR</option>
						</select>
						<select
							className="h-8 rounded bg-input px-2"
							value={configuration.session.referenceSpaceType}
							onChange={(event) => patchSession({ referenceSpaceType: event.currentTarget.value as any })}
						>
							{["local", "local-floor", "bounded-floor", "unbounded"].map((value) => (
								<option key={value}>{value}</option>
							))}
						</select>
						{toggle("Initialize on startup", configuration.session.initializeOnStartup, (value) => patchSession({ initializeOnStartup: value }))}
						{toggle("Enter/Exit UI", configuration.session.showEnterExitUI, (value) => patchSession({ showEnterExitUI: value }))}
					</div>
					<div className="grid grid-cols-2 gap-1">
						{XR_SESSION_FEATURES.map((feature) => {
							const state = configuration.session.requiredFeatures.includes(feature)
								? "Required"
								: configuration.session.optionalFeatures.includes(feature)
									? "Optional"
									: "Off";
							return (
								<Button
									key={feature}
									size="sm"
									variant={state === "Off" ? "ghost" : "secondary"}
									className="h-7 justify-between px-2 text-[10px]"
									onClick={() => cycleFeature(feature)}
								>
									<span>{feature}</span>
									<span>{state}</span>
								</Button>
							);
						})}
					</div>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="font-medium">XR Origin</div>
					<label className="block text-[11px]">
						<span className="text-muted-foreground">Origin node</span>
						<select
							className="h-8 w-full rounded bg-input px-2"
							value={configuration.origin.originNodeId ?? ""}
							onChange={(event) => patchOrigin({ originNodeId: event.currentTarget.value || null })}
						>
							<option value="">World origin</option>
							{originNodes.map((node) => (
								<option key={`${node.getClassName()}-${node.id}`} value={node.id}>
									{node.name} · {node.id}
								</option>
							))}
						</select>
					</label>
					<label className="block text-[11px]">
						<span className="text-muted-foreground">Tracked camera</span>
						<select
							className="h-8 w-full rounded bg-input px-2"
							value={configuration.origin.cameraId ?? ""}
							onChange={(event) => patchOrigin({ cameraId: event.currentTarget.value || null })}
						>
							<option value="">Active camera</option>
							{cameras.map((camera) => (
								<option key={camera.id} value={camera.id}>
									{camera.name} · {camera.id}
								</option>
							))}
						</select>
					</label>
					{numberField("Scene units per metre", configuration.origin.worldScale, (worldScale) => patchOrigin({ worldScale }))}
					{numberField("Runtime trace cap", configuration.maxTraceEvents, (maxTraceEvents) => patch({ maxTraceEvents: Math.round(maxTraceEvents) }), "1")}
					<label className="block text-[11px]">
						<span className="text-muted-foreground">Floor mesh ids (comma-separated)</span>
						<Input
							key={configuration.origin.floorMeshIds.join(",")}
							className="h-7"
							defaultValue={configuration.origin.floorMeshIds.join(", ")}
							onBlur={(event) => {
								const floorMeshIds = idList(event.currentTarget.value);
								if (!sameValues(floorMeshIds, configuration.origin.floorMeshIds)) {
									patchOrigin({ floorMeshIds });
								}
							}}
						/>
					</label>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="font-medium">Interaction & locomotion</div>
					<div className="grid grid-cols-2 gap-1">
						{toggle("Pointer", configuration.interaction.pointerSelection, (value) => patchInteraction({ pointerSelection: value }))}
						{toggle("Near", configuration.interaction.nearInteraction, (value) => patchInteraction({ nearInteraction: value }))}
						{toggle("Hands", configuration.interaction.handTracking, (value) => patchInteraction({ handTracking: value }))}
						{toggle("Gaze", configuration.interaction.gazeMode, (value) => patchInteraction({ gazeMode: value }))}
						{toggle("Teleport", configuration.locomotion.teleportation, (value) => patchLocomotion({ teleportation: value }))}
						{toggle("Continuous move", configuration.locomotion.continuousMove, (value) => patchLocomotion({ continuousMove: value }))}
						{toggle("Continuous turn", configuration.locomotion.continuousTurn, (value) => patchLocomotion({ continuousTurn: value }))}
						{toggle("Snap points only", configuration.locomotion.snapPointsOnly, (value) => patchLocomotion({ snapPointsOnly: value }))}
					</div>
					<select
						className="h-8 w-full rounded bg-input px-2"
						value={configuration.interaction.preferredHandedness}
						onChange={(event) => patchInteraction({ preferredHandedness: event.currentTarget.value as any })}
					>
						<option value="any">Both controllers</option>
						<option value="left">Left preferred</option>
						<option value="right">Right preferred</option>
					</select>
					<div className="grid grid-cols-2 gap-x-4 gap-y-1">
						{numberField("Pointer distance", configuration.interaction.maxPointerDistance, (maxPointerDistance) => patchInteraction({ maxPointerDistance }))}
						{numberField("Gaze dwell ms", configuration.interaction.gazeSelectionTimeMs, (gazeSelectionTimeMs) => patchInteraction({ gazeSelectionTimeMs }))}
						{numberField("Move speed", configuration.locomotion.movementSpeed, (movementSpeed) => patchLocomotion({ movementSpeed }))}
						{numberField("Turn speed", configuration.locomotion.rotationSpeed, (rotationSpeed) => patchLocomotion({ rotationSpeed }))}
						{numberField("Snap angle", configuration.locomotion.rotationAngleDegrees, (rotationAngleDegrees) => patchLocomotion({ rotationAngleDegrees }))}
						{numberField("Snap radius", configuration.locomotion.snapRadius, (snapRadius) => patchLocomotion({ snapRadius }))}
					</div>
					<label className="block text-[11px]">
						<span className="text-muted-foreground">Teleport snap points (x,y,z; x,y,z)</span>
						<Input
							key={configuration.locomotion.snapPoints.map((point) => point.join(",")).join(";")}
							className="h-7"
							defaultValue={configuration.locomotion.snapPoints.map((point) => point.join(", ")).join("; ")}
							onBlur={(event) => {
								const snapPoints = tuples(event.currentTarget.value);
								if (snapPoints && !sameValues(snapPoints, configuration.locomotion.snapPoints)) {
									patchLocomotion({ snapPoints });
								}
							}}
						/>
					</label>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="flex items-center justify-between">
						<span className="font-medium">Interactables ({configuration.interactables.length})</span>
					</div>
					{configuration.interactables.map((interactable) => (
						<div key={interactable.id} className="space-y-1 rounded bg-input/40 p-2">
							<div className="flex gap-1">
								<Input
									key={`${interactable.id}-${interactable.name}`}
									className="h-7 flex-1"
									defaultValue={interactable.name}
									onBlur={(event) =>
										event.currentTarget.value.trim() !== interactable.name &&
										void author(() =>
											setXRInteractable(
												props.scene,
												{ expectedRevision: configuration.revision, id: interactable.id, changes: { name: event.currentTarget.value.trim() } },
												options
											)
										)
									}
								/>
								<Button
									size="sm"
									variant={interactable.enabled ? "secondary" : "ghost"}
									className="h-7"
									onClick={() =>
										void author(() =>
											setXRInteractable(
												props.scene,
												{ expectedRevision: configuration.revision, id: interactable.id, changes: { enabled: !interactable.enabled } },
												options
											)
										)
									}
								>
									{interactable.enabled ? "On" : "Off"}
								</Button>
								<Button
									size="sm"
									variant="destructive"
									className="h-7"
									onClick={() =>
										void author(() =>
											deleteXRInteractable(props.scene, { expectedRevision: configuration.revision, id: interactable.id, confirm: true }, options)
										)
									}
								>
									×
								</Button>
							</div>
							<select
								className="h-7 w-full rounded bg-input px-2 text-[11px]"
								value={interactable.meshId}
								onChange={(event) =>
									void author(() =>
										setXRInteractable(
											props.scene,
											{ expectedRevision: configuration.revision, id: interactable.id, changes: { meshId: event.currentTarget.value } },
											options
										)
									)
								}
							>
								{meshes.map((mesh) => (
									<option key={mesh.id} value={mesh.id}>
										{mesh.name} · {mesh.id}
									</option>
								))}
							</select>
							<div className="flex gap-1">
								{(["select", "grab", "teleport"] as const).map((mode) => {
									const active = interactable.modes.includes(mode);
									const modes = active ? interactable.modes.filter((entry) => entry !== mode) : [...interactable.modes, mode];
									return (
										<Button
											key={mode}
											size="sm"
											variant={active ? "secondary" : "ghost"}
											className="h-7 flex-1 text-[10px]"
											disabled={active && interactable.modes.length === 1}
											onClick={() =>
												void author(() =>
													setXRInteractable(props.scene, { expectedRevision: configuration.revision, id: interactable.id, changes: { modes } }, options)
												)
											}
										>
											{mode}
										</Button>
									);
								})}
								<Button
									size="sm"
									variant={interactable.rotateWithController ? "secondary" : "ghost"}
									className="h-7 text-[10px]"
									onClick={() =>
										void author(() =>
											setXRInteractable(
												props.scene,
												{
													expectedRevision: configuration.revision,
													id: interactable.id,
													changes: { rotateWithController: !interactable.rotateWithController },
												},
												options
											)
										)
									}
								>
									Rotate
								</Button>
							</div>
							<Input
								key={`${interactable.id}-${interactable.interactionLayers.join(",")}`}
								className="h-7"
								defaultValue={interactable.interactionLayers.join(", ")}
								onBlur={(event) => {
									const interactionLayers = idList(event.currentTarget.value);
									if (interactionLayers.length && !sameValues(interactionLayers, interactable.interactionLayers)) {
										void author(() =>
											setXRInteractable(
												props.scene,
												{ expectedRevision: configuration.revision, id: interactable.id, changes: { interactionLayers } },
												options
											)
										);
									}
								}}
							/>
							<div className="grid grid-cols-3 gap-2">
								{numberField(
									"Drag",
									interactable.dragSmoothing,
									(dragSmoothing) =>
										void author(() =>
											setXRInteractable(props.scene, { expectedRevision: configuration.revision, id: interactable.id, changes: { dragSmoothing } }, options)
										)
								)}
								{numberField(
									"Haptic",
									interactable.hapticAmplitude,
									(hapticAmplitude) =>
										void author(() =>
											setXRInteractable(props.scene, { expectedRevision: configuration.revision, id: interactable.id, changes: { hapticAmplitude } }, options)
										)
								)}
								{numberField(
									"Haptic ms",
									interactable.hapticDurationMs,
									(hapticDurationMs) =>
										void author(() =>
											setXRInteractable(
												props.scene,
												{ expectedRevision: configuration.revision, id: interactable.id, changes: { hapticDurationMs } },
												options
											)
										)
								)}
							</div>
						</div>
					))}
					<div className="space-y-1 rounded border border-dashed border-border p-2">
						<Input className="h-7" value={interactableName} onChange={(event) => setInteractableName(event.currentTarget.value)} placeholder="Interaction name" />
						<select className="h-8 w-full rounded bg-input px-2" value={interactableMeshId} onChange={(event) => setInteractableMeshId(event.currentTarget.value)}>
							<option value="">Select mesh…</option>
							{meshes.map((mesh) => (
								<option key={mesh.id} value={mesh.id}>
									{mesh.name} · {mesh.id}
								</option>
							))}
						</select>
						<div className="flex gap-1">{(["select", "grab", "teleport"] as const).map(modeButton)}</div>
						<Button
							disabled={busy || !interactableName.trim() || !interactableMeshId || !interactableModes.length}
							size="sm"
							className="w-full"
							onClick={() =>
								void author(() =>
									createXRInteractable(
										props.scene,
										{
											expectedRevision: configuration.revision,
											interactable: { name: interactableName, meshId: interactableMeshId, modes: interactableModes, interactionLayers: ["default"] },
										},
										options
									)
								)
							}
						>
							Add interactable
						</Button>
					</div>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="flex items-center justify-between">
						<span className="font-medium">Desktop XR Simulation</span>
						{toggle("Enabled", configuration.simulation.enabled, (value) => patchSimulation({ enabled: value }))}
					</div>
					<label className="block text-[10px] text-muted-foreground">
						Environment mesh ids
						<Input
							key={configuration.simulation.environmentMeshIds.join(",")}
							className="h-7"
							defaultValue={configuration.simulation.environmentMeshIds.join(", ")}
							onBlur={(event) => {
								const environmentMeshIds = idList(event.currentTarget.value);
								if (!sameValues(environmentMeshIds, configuration.simulation.environmentMeshIds)) {
									patchSimulation({ environmentMeshIds });
								}
							}}
						/>
					</label>
					{numberField("Ray distance (m)", configuration.simulation.maxRayDistance, (maxRayDistance) => patchSimulation({ maxRayDistance }))}
					<div className="grid grid-cols-2 gap-1">
						{(["leftController", "rightController"] as const).map((device) => (
							<label key={device} className="text-[10px] text-muted-foreground">
								<div className="flex items-center justify-between">
									<span>{device === "leftController" ? "Left pose" : "Right pose"}</span>
									<Button
										size="sm"
										variant={configuration.simulation[device].enabled ? "secondary" : "ghost"}
										className="h-6 px-1 text-[9px]"
										onClick={() => patchSimulation({ [device]: { enabled: !configuration.simulation[device].enabled } })}
									>
										{configuration.simulation[device].enabled ? "On" : "Off"}
									</Button>
								</div>
								<Input
									key={`${device}-position:${configuration.simulation[device].position.join(",")}`}
									className="h-7"
									defaultValue={configuration.simulation[device].position.join(", ")}
									onBlur={(event) => {
										const position = tuple(event.currentTarget.value);
										if (position && !sameValues(position, configuration.simulation[device].position)) {
											patchSimulation({ [device]: { position } });
										}
									}}
								/>
								<Input
									key={`${device}-rotation:${configuration.simulation[device].rotation.join(",")}`}
									className="mt-1 h-7"
									defaultValue={configuration.simulation[device].rotation.join(", ")}
									onBlur={(event) => {
										const rotation = tuple(event.currentTarget.value);
										if (rotation && !sameValues(rotation, configuration.simulation[device].rotation)) {
											patchSimulation({ [device]: { rotation } });
										}
									}}
								/>
							</label>
						))}
					</div>
					<label className="block text-[10px] text-muted-foreground">
						Headset pose (m / degrees)
						<div className="grid grid-cols-2 gap-1">
							<Input
								key={`headset-position:${configuration.simulation.headset.position.join(",")}`}
								className="h-7"
								defaultValue={configuration.simulation.headset.position.join(", ")}
								onBlur={(event) => {
									const position = tuple(event.currentTarget.value);
									if (position && !sameValues(position, configuration.simulation.headset.position)) {
										patchSimulation({ headset: { position } });
									}
								}}
							/>
							<Input
								key={`headset-rotation:${configuration.simulation.headset.rotation.join(",")}`}
								className="h-7"
								defaultValue={configuration.simulation.headset.rotation.join(", ")}
								onBlur={(event) => {
									const rotation = tuple(event.currentTarget.value);
									if (rotation && !sameValues(rotation, configuration.simulation.headset.rotation)) {
										patchSimulation({ headset: { rotation } });
									}
								}}
							/>
						</div>
					</label>
					<div className="flex gap-1">
						<Button
							disabled={busy || simulation?.phase === "active"}
							size="sm"
							onClick={() => void transient(() => startXRDesktopSimulation(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Start
						</Button>
						<Button
							disabled={busy || !simulation}
							size="sm"
							variant="secondary"
							onClick={() => void transient(() => stopXRDesktopSimulation(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Stop
						</Button>
						<select
							className="h-8 flex-1 rounded bg-input px-2"
							value={simulationController}
							onChange={(event) => setSimulationController(event.currentTarget.value as "left" | "right")}
						>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
						<Button
							disabled={!simulation}
							size="sm"
							variant="secondary"
							onClick={() =>
								void transient(() =>
									applyXRSimulationInput(
										props.scene,
										{
											expectedRevision: configuration.revision,
											input: { type: "press-select", device: simulationController, interactionMode: "auto", interactionLayers: ["default"] },
										},
										options
									)
								)
							}
						>
							Press
						</Button>
						<Button
							disabled={!simulation}
							size="sm"
							variant="ghost"
							onClick={() =>
								void transient(() =>
									applyXRSimulationInput(
										props.scene,
										{ expectedRevision: configuration.revision, input: { type: "release-select", device: simulationController } },
										options
									)
								)
							}
						>
							Release
						</Button>
					</div>
					<div className="text-[10px] text-muted-foreground">
						{simulation ? `${simulation.phase} · ${simulation.heldInteractables.length} held · ${simulation.rays.length} ray(s)` : "Stopped"}
					</div>
				</div>

				<div className="space-y-2 rounded border border-border p-2">
					<div className="font-medium">Validation & runtime</div>
					<div className="flex gap-1">
						<select
							className="h-8 flex-1 rounded bg-input px-2"
							value={validationTarget}
							onChange={(event) => setValidationTarget(event.currentTarget.value as typeof validationTarget)}
						>
							<option value="authoring">Authoring</option>
							<option value="web">Web</option>
							<option value="electron-web">Electron Web</option>
						</select>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => void transient(async () => setValidation(await validateXRConfigurationTarget(props.scene, { target: validationTarget })))}
						>
							Validate
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								void transient(async () => setValidation(await validateXRConfigurationTarget(props.scene, { target: validationTarget, checkCurrentDevice: true })))
							}
						>
							Probe device
						</Button>
					</div>
					{validation && (
						<div className={validation.valid ? "rounded bg-green-950/30 p-2 text-[10px] text-green-300" : "rounded bg-red-950/30 p-2 text-[10px] text-red-300"}>
							{validation.valid ? "Ready" : `${validation.errors.length} error(s)`}
							{[...validation.errors, ...validation.warnings].map((entry) => (
								<div key={`${entry.code}-${entry.message}`}>
									{entry.code}: {entry.message}
								</div>
							))}
						</div>
					)}
					<div className="flex flex-wrap gap-1">
						<Button
							disabled={busy || !configuration.enabled}
							size="sm"
							onClick={() => void transient(() => initializeXRRuntime(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Initialize
						</Button>
						<Button
							disabled={busy || !configuration.enabled}
							size="sm"
							variant="secondary"
							onClick={() => void transient(() => reconfigureXRRuntime(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Reconfigure
						</Button>
						<Button
							disabled={busy || !configuration.enabled}
							size="sm"
							variant="secondary"
							onClick={() => void transient(() => enterXRRuntimeSession(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Enter XR
						</Button>
						<Button
							disabled={busy || !runtime?.inSession}
							size="sm"
							variant="ghost"
							onClick={() => void transient(() => exitXRRuntimeSession(props.scene, { expectedRevision: configuration.revision }, options))}
						>
							Exit XR
						</Button>
					</div>
					<div className="text-[10px] text-muted-foreground">
						{runtime
							? `${runtime.phase} · ${runtime.controllers.length} controller(s) · ${runtime.enabledFeatures.join(", ") || "no native features"}${runtime.lastError ? ` · ${runtime.lastError}` : ""}`
							: "Runtime not initialized"}
					</div>
				</div>
			</div>
		</EditorInspectorSectionField>
	);
}
