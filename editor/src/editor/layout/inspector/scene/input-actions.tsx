import { ReactNode, useState } from "react";

import { Scene } from "babylonjs";
import { IInputActionDefinition, IInputBindingDefinition, IInputInteractionDefinition, IInputProcessorDefinition, InputDeviceType } from "babylonjs-editor-tools";
import { toast } from "sonner";

import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import {
	createInputAction,
	createInputActionBinding,
	createInputActionMap,
	createInputControlScheme,
	deleteInputAction,
	deleteInputActionBinding,
	deleteInputActionMap,
	deleteInputControlScheme,
	generateInputActionWrapper,
	getInputAuthoringSnapshot,
	getInputRuntime,
	getInputSystemSettings,
	listInputActionMaps,
	restoreInputAuthoringSnapshot,
	setInputAction,
	setInputActionBinding,
	setInputActionMap,
	setInputControlScheme,
	setInputSystemSettings,
} from "../../../../mcp/input/input";
import { registerUndoRedo } from "../../../../tools/undoredo";
import { Editor } from "../../../main";
import { EditorInspectorSectionField } from "../fields/section";

export interface IInputActionsSceneInspectorProps {
	scene: Scene;
	editor: Editor;
}

const deviceTypes: InputDeviceType[] = ["keyboard", "mouse", "gamepad", "touch"];

function processorDefaults(type: IInputProcessorDefinition["type"]): IInputProcessorDefinition {
	switch (type) {
		case "scale":
			return { type, factor: 1, x: 1, y: 1, z: 1 };
		case "clamp":
			return { type, min: -1, max: 1 };
		case "normalize":
			return { type, min: -1, max: 1, zero: 0 };
		case "axisDeadzone":
		case "stickDeadzone":
			return { type, min: 0.125, max: 0.925 };
		default:
			return { type, x: -1, y: -1, z: -1 };
	}
}

function interactionDefaults(type: IInputInteractionDefinition["type"]): IInputInteractionDefinition {
	switch (type) {
		case "press":
			return { type, pressPoint: 0.5, behavior: "pressOnly" };
		case "multiTap":
			return { type, pressPoint: 0.5, duration: 0.2, tapCount: 2, tapDelay: 0.75 };
		case "slowTap":
			return { type, pressPoint: 0.5, duration: 0.5 };
		case "hold":
			return { type, pressPoint: 0.5, duration: 0.4 };
		default:
			return { type, pressPoint: 0.5, duration: 0.2 };
	}
}

function numberInput(label: string, value: number | undefined, fallback: number, onChange: (value: number) => void): ReactNode {
	return (
		<label className="flex items-center justify-between gap-1 text-[11px]">
			<span>{label}</span>
			<Input
				className="h-7 w-24"
				type="number"
				step="any"
				defaultValue={String(value ?? fallback)}
				onBlur={(event) => {
					const next = Number(event.currentTarget.value);
					if (Number.isFinite(next)) {
						onChange(next);
					}
				}}
			/>
		</label>
	);
}

function ProcessorList(props: { value: IInputProcessorDefinition[]; onChange: (value: IInputProcessorDefinition[]) => void }): ReactNode {
	const update = (index: number, patch: Partial<IInputProcessorDefinition>): void => {
		const next = structuredClone(props.value);
		next[index] = { ...next[index], ...patch };
		props.onChange(next);
	};
	return (
		<div className="space-y-1 rounded bg-background/50 p-1">
			<div className="flex items-center justify-between text-[11px] text-muted-foreground">
				<span>Processors</span>
				<Button size="sm" variant="ghost" onClick={() => props.onChange([...props.value, processorDefaults("scale")])}>
					+
				</Button>
			</div>
			{props.value.map((processor, index) => (
				<div key={index} className="space-y-1 rounded border border-border p-1">
					<div className="flex gap-1">
						<select
							className="h-7 min-w-0 flex-1 rounded bg-input px-1 text-xs"
							value={processor.type}
							onChange={(event) => {
								const next = structuredClone(props.value);
								next[index] = processorDefaults(event.currentTarget.value as IInputProcessorDefinition["type"]);
								props.onChange(next);
							}}
						>
							{["invert", "scale", "clamp", "normalize", "axisDeadzone", "stickDeadzone"].map((type) => (
								<option key={type} value={type}>
									{type}
								</option>
							))}
						</select>
						<Button size="sm" variant="ghost" onClick={() => props.onChange(props.value.filter((_, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
					{processor.type === "scale" && numberInput("Factor", processor.factor, 1, (factor) => update(index, { factor }))}
					{["clamp", "normalize", "axisDeadzone", "stickDeadzone"].includes(processor.type) && (
						<>
							{numberInput("Min", processor.min, processor.type.endsWith("Deadzone") ? 0.125 : -1, (min) => update(index, { min }))}
							{numberInput("Max", processor.max, processor.type.endsWith("Deadzone") ? 0.925 : 1, (max) => update(index, { max }))}
						</>
					)}
					{processor.type === "normalize" && numberInput("Zero", processor.zero, 0, (zero) => update(index, { zero }))}
					{(processor.type === "invert" || processor.type === "scale") && (
						<div className="grid grid-cols-3 gap-1">
							{(["x", "y", "z"] as const).map((axis) =>
								numberInput(axis.toUpperCase(), processor[axis], processor.type === "invert" ? -1 : 1, (value) => update(index, { [axis]: value }))
							)}
						</div>
					)}
				</div>
			))}
		</div>
	);
}

function InteractionList(props: { value: IInputInteractionDefinition[]; onChange: (value: IInputInteractionDefinition[]) => void }): ReactNode {
	const update = (index: number, patch: Partial<IInputInteractionDefinition>): void => {
		const next = structuredClone(props.value);
		next[index] = { ...next[index], ...patch };
		props.onChange(next);
	};
	return (
		<div className="space-y-1 rounded bg-background/50 p-1">
			<div className="flex items-center justify-between text-[11px] text-muted-foreground">
				<span>Interactions</span>
				<Button size="sm" variant="ghost" onClick={() => props.onChange([...props.value, interactionDefaults("press")])}>
					+
				</Button>
			</div>
			{props.value.map((interaction, index) => (
				<div key={index} className="space-y-1 rounded border border-border p-1">
					<div className="flex gap-1">
						<select
							className="h-7 min-w-0 flex-1 rounded bg-input px-1 text-xs"
							value={interaction.type}
							onChange={(event) => {
								const next = structuredClone(props.value);
								next[index] = interactionDefaults(event.currentTarget.value as IInputInteractionDefinition["type"]);
								props.onChange(next);
							}}
						>
							{["press", "hold", "tap", "slowTap", "multiTap"].map((type) => (
								<option key={type} value={type}>
									{type}
								</option>
							))}
						</select>
						<Button size="sm" variant="ghost" onClick={() => props.onChange(props.value.filter((_, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
					{numberInput("Press point", interaction.pressPoint, 0.5, (pressPoint) => update(index, { pressPoint }))}
					{interaction.type === "press" && (
						<select
							className="h-7 w-full rounded bg-input px-1 text-xs"
							value={interaction.behavior ?? "pressOnly"}
							onChange={(event) => update(index, { behavior: event.currentTarget.value as IInputInteractionDefinition["behavior"] })}
						>
							<option value="pressOnly">Press only</option>
							<option value="releaseOnly">Release only</option>
							<option value="pressAndRelease">Press and release</option>
						</select>
					)}
					{interaction.type !== "press" &&
						numberInput("Duration", interaction.duration, interaction.type === "slowTap" ? 0.5 : 0.2, (duration) => update(index, { duration }))}
					{interaction.type === "multiTap" && (
						<>
							{numberInput("Tap count", interaction.tapCount, 2, (tapCount) => update(index, { tapCount }))}
							{numberInput("Tap delay", interaction.tapDelay, 0.75, (tapDelay) => update(index, { tapDelay }))}
						</>
					)}
				</div>
			))}
		</div>
	);
}

export function InputActionsSceneInspector(props: IInputActionsSceneInspectorProps): ReactNode {
	const [version, setVersion] = useState(0);
	const [selectedMapId, setSelectedMapId] = useState("");
	const [wrapperSource, setWrapperSource] = useState("");
	const maps = listInputActionMaps(props.scene).maps;
	const map = maps.find((candidate: any) => candidate.id === selectedMapId) ?? maps[0];
	const settings = getInputSystemSettings(props.scene).settings;
	const options = { editor: props.editor } as any;

	const run = (mutation: () => void): void => {
		const before = getInputAuthoringSnapshot(props.scene);
		try {
			mutation();
			const after = getInputAuthoringSnapshot(props.scene);
			registerUndoRedo({
				undo: () => restoreInputAuthoringSnapshot(props.scene, before, options),
				redo: () => restoreInputAuthoringSnapshot(props.scene, after, options),
			});
			setVersion((value) => value + 1);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Input authoring failed.");
		}
	};
	const updateAction = (action: IInputActionDefinition, changes: Record<string, unknown>): void =>
		run(() => void setInputAction(props.scene, { mapId: map.id, actionId: action.id, expectedRevision: map.revision, changes }, options));
	const updateBinding = (action: IInputActionDefinition, binding: IInputBindingDefinition, changes: Record<string, unknown>): void =>
		run(() => void setInputActionBinding(props.scene, { mapId: map.id, actionId: action.id, bindingId: binding.id, expectedRevision: map.revision, changes }, options));

	let runtimeEvidence: any = null;
	try {
		runtimeEvidence = getInputRuntime(props.scene, { limit: 12 });
	} catch {
		// Authoring remains available while preview/runtime is stopped.
	}

	return (
		<EditorInspectorSectionField
			title="Input Actions"
			tooltip="Unity-style maps, actions, bindings, composites, processors, interactions, schemes, settings, wrappers, and live phase diagnostics."
		>
			<div key={version} className="flex flex-col gap-2 text-xs">
				<div className="grid grid-cols-2 gap-1 rounded bg-input/40 p-2">
					<label>
						<span className="text-[11px] text-muted-foreground">Update</span>
						<select
							className="h-7 w-full rounded bg-input px-1"
							value={settings.updateMode}
							onChange={(event) =>
								run(
									() =>
										void setInputSystemSettings(
											props.scene,
											{ expectedRevision: settings.revision, changes: { updateMode: event.currentTarget.value } },
											options
										)
								)
							}
						>
							<option value="dynamic">Dynamic</option>
							<option value="fixed">Fixed</option>
							<option value="manual">Manual</option>
						</select>
					</label>
					<Button
						size="sm"
						variant={settings.autoSwitchControlScheme ? "secondary" : "ghost"}
						onClick={() =>
							run(
								() =>
									void setInputSystemSettings(
										props.scene,
										{ expectedRevision: settings.revision, changes: { autoSwitchControlScheme: !settings.autoSwitchControlScheme } },
										options
									)
							)
						}
					>
						Auto scheme
					</Button>
					{numberInput("Deadzone min", settings.defaultDeadzoneMin, 0.125, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultDeadzoneMin: value } }, options))
					)}
					{numberInput("Deadzone max", settings.defaultDeadzoneMax, 0.925, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultDeadzoneMax: value } }, options))
					)}
					{numberInput("Press point", settings.defaultButtonPressPoint, 0.5, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultButtonPressPoint: value } }, options))
					)}
					{numberInput("Tap time", settings.defaultTapTime, 0.2, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultTapTime: value } }, options))
					)}
					{numberInput("Slow tap", settings.defaultSlowTapTime, 0.5, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultSlowTapTime: value } }, options))
					)}
					{numberInput("Hold time", settings.defaultHoldTime, 0.4, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultHoldTime: value } }, options))
					)}
					{numberInput("Multi-tap", settings.defaultMultiTapDelay, 0.75, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { defaultMultiTapDelay: value } }, options))
					)}
					{numberInput("Trace cap", settings.maxTraceEvents, 256, (value) =>
						run(() => void setInputSystemSettings(props.scene, { expectedRevision: settings.revision, changes: { maxTraceEvents: Math.round(value) } }, options))
					)}
				</div>

				<div className="flex gap-1">
					<select className="h-8 min-w-0 flex-1 rounded bg-input px-2" value={map?.id ?? ""} onChange={(event) => setSelectedMapId(event.currentTarget.value)}>
						{maps.map((candidate: any) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name} · r{candidate.revision}
							</option>
						))}
					</select>
					<Button
						size="sm"
						onClick={() =>
							run(() => {
								const created = createInputActionMap(props.scene, { name: `Gameplay ${maps.length + 1}` }, options);
								setSelectedMapId(created.id);
							})
						}
					>
						Add map
					</Button>
					{map && (
						<Button
							size="sm"
							variant="destructive"
							onClick={() => run(() => void deleteInputActionMap(props.scene, { mapId: map.id, expectedRevision: map.revision }, options))}
						>
							Delete
						</Button>
					)}
				</div>

				{map && (
					<>
						<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
							<Input
								defaultValue={map.name}
								onBlur={(event) =>
									event.currentTarget.value.trim() !== map.name &&
									run(() => void setInputActionMap(props.scene, { mapId: map.id, expectedRevision: map.revision, name: event.currentTarget.value }, options))
								}
							/>
							<Button
								size="sm"
								variant={map.enabled ? "secondary" : "ghost"}
								onClick={() => run(() => void setInputActionMap(props.scene, { mapId: map.id, expectedRevision: map.revision, enabled: !map.enabled }, options))}
							>
								{map.enabled ? "Enabled" : "Disabled"}
							</Button>
						</div>

						<div className="space-y-2 rounded border border-border p-2">
							<div className="flex items-center justify-between font-medium">
								<span>Actions</span>
								<Button
									size="sm"
									onClick={() =>
										run(
											() =>
												void createInputAction(
													props.scene,
													{ mapId: map.id, expectedRevision: map.revision, action: { name: `Action ${map.actions.length + 1}` } },
													options
												)
										)
									}
								>
									Add
								</Button>
							</div>
							{map.actions.map((action: IInputActionDefinition) => (
								<div key={action.id} className="space-y-1 rounded bg-input/40 p-2">
									<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
										<Input
											defaultValue={action.name}
											onBlur={(event) => event.currentTarget.value.trim() !== action.name && updateAction(action, { name: event.currentTarget.value })}
										/>
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												run(() => void deleteInputAction(props.scene, { mapId: map.id, actionId: action.id, expectedRevision: map.revision }, options))
											}
										>
											×
										</Button>
									</div>
									<div className="grid grid-cols-3 gap-1">
										<select
											className="h-7 rounded bg-input px-1"
											value={action.type}
											onChange={(event) => updateAction(action, { type: event.currentTarget.value })}
										>
											<option value="button">Button</option>
											<option value="value">Value</option>
											<option value="passThrough">Pass-Through</option>
										</select>
										<select
											className="h-7 rounded bg-input px-1"
											value={action.expectedControlType}
											onChange={(event) => updateAction(action, { expectedControlType: event.currentTarget.value })}
										>
											<option value="button">Button</option>
											<option value="axis">Axis</option>
											<option value="vector2">Vector2</option>
											<option value="vector3">Vector3</option>
										</select>
										<Button size="sm" variant={action.enabled ? "secondary" : "ghost"} onClick={() => updateAction(action, { enabled: !action.enabled })}>
											{action.enabled ? "On" : "Off"}
										</Button>
									</div>
									<Button
										size="sm"
										variant={action.initialStateCheck ? "secondary" : "ghost"}
										onClick={() => updateAction(action, { initialStateCheck: !action.initialStateCheck })}
									>
										Initial state check
									</Button>
									<ProcessorList value={action.processors} onChange={(processors) => updateAction(action, { processors })} />
									<InteractionList value={action.interactions} onChange={(interactions) => updateAction(action, { interactions })} />
									<div className="space-y-1 rounded border border-border p-1">
										<div className="flex items-center justify-between text-[11px] text-muted-foreground">
											<span>Bindings</span>
											<div className="flex gap-1">
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														run(
															() =>
																void createInputActionBinding(
																	props.scene,
																	{ mapId: map.id, actionId: action.id, expectedRevision: map.revision, binding: { path: "<keyboard>/space" } },
																	options
																)
														)
													}
												>
													+ Path
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														run(
															() =>
																void createInputActionBinding(
																	props.scene,
																	{
																		mapId: map.id,
																		actionId: action.id,
																		expectedRevision: map.revision,
																		binding: {
																			composite: {
																				type: "vector2",
																				parts: [
																					{ name: "Up", path: "<keyboard>/keyw" },
																					{ name: "Down", path: "<keyboard>/keys" },
																					{ name: "Left", path: "<keyboard>/keya" },
																					{ name: "Right", path: "<keyboard>/keyd" },
																				],
																			},
																		},
																	},
																	options
																)
														)
													}
												>
													+ Composite
												</Button>
											</div>
										</div>
										{action.bindings.map((binding: IInputBindingDefinition) => (
											<div key={binding.id} className="space-y-1 rounded bg-background/70 p-1">
												<div className="flex gap-1">
													<span className="min-w-0 flex-1 truncate text-[11px]">{binding.composite ? binding.composite.type : binding.path}</span>
													<Button
														size="sm"
														variant="ghost"
														onClick={() =>
															run(
																() =>
																	void deleteInputActionBinding(
																		props.scene,
																		{ mapId: map.id, actionId: action.id, bindingId: binding.id, expectedRevision: map.revision },
																		options
																	)
															)
														}
													>
														×
													</Button>
												</div>
												{binding.path !== undefined ? (
													<Input
														defaultValue={binding.path}
														onBlur={(event) =>
															event.currentTarget.value.trim() !== binding.path && updateBinding(action, binding, { path: event.currentTarget.value })
														}
													/>
												) : (
													<>
														<select
															className="h-7 w-full rounded bg-input px-1"
															value={binding.composite!.type}
															onChange={(event) =>
																updateBinding(action, binding, { composite: { ...binding.composite!, type: event.currentTarget.value } })
															}
														>
															{["axis1d", "vector2", "vector3", "oneModifier", "twoModifiers"].map((type) => (
																<option key={type}>{type}</option>
															))}
														</select>
														{binding.composite!.parts.map((part, partIndex) => (
															<div key={partIndex} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-1">
																<Input
																	defaultValue={part.name}
																	onBlur={(event) => {
																		const parts = structuredClone(binding.composite!.parts);
																		parts[partIndex].name = event.currentTarget.value;
																		updateBinding(action, binding, { composite: { ...binding.composite!, parts } });
																	}}
																/>
																<Input
																	defaultValue={part.path}
																	onBlur={(event) => {
																		const parts = structuredClone(binding.composite!.parts);
																		parts[partIndex].path = event.currentTarget.value;
																		updateBinding(action, binding, { composite: { ...binding.composite!, parts } });
																	}}
																/>
															</div>
														))}
													</>
												)}
												<Input
													defaultValue={(binding.groups ?? []).join(", ")}
													placeholder="Binding groups"
													onBlur={(event) =>
														updateBinding(action, binding, {
															groups: event.currentTarget.value
																.split(",")
																.map((value) => value.trim())
																.filter(Boolean),
														})
													}
												/>
												<ProcessorList value={binding.processors ?? []} onChange={(processors) => updateBinding(action, binding, { processors })} />
												<InteractionList value={binding.interactions ?? []} onChange={(interactions) => updateBinding(action, binding, { interactions })} />
											</div>
										))}
									</div>
								</div>
							))}
						</div>

						<div className="space-y-1 rounded border border-border p-2">
							<div className="flex items-center justify-between font-medium">
								<span>Control schemes</span>
								<Button
									size="sm"
									onClick={() =>
										run(
											() =>
												void createInputControlScheme(
													props.scene,
													{
														mapId: map.id,
														expectedRevision: map.revision,
														scheme: { name: `Scheme ${map.controlSchemes.length + 1}`, devices: ["keyboard"] },
													},
													options
												)
										)
									}
								>
									Add
								</Button>
							</div>
							{map.controlSchemes.map((scheme: any) => (
								<div key={scheme.id} className="space-y-1 rounded bg-input/40 p-1">
									<div className="flex gap-1">
										<Input
											defaultValue={scheme.name}
											onBlur={(event) =>
												event.currentTarget.value.trim() !== scheme.name &&
												run(
													() =>
														void setInputControlScheme(
															props.scene,
															{ mapId: map.id, schemeId: scheme.id, expectedRevision: map.revision, changes: { name: event.currentTarget.value } },
															options
														)
												)
											}
										/>
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												run(
													() =>
														void deleteInputControlScheme(props.scene, { mapId: map.id, schemeId: scheme.id, expectedRevision: map.revision }, options)
												)
											}
										>
											×
										</Button>
									</div>
									<div className="grid grid-cols-4 gap-1">
										{deviceTypes.map((device) => (
											<Button
												key={device}
												size="sm"
												variant={scheme.devices.includes(device) ? "secondary" : "ghost"}
												onClick={() => {
													const devices = scheme.devices.includes(device)
														? scheme.devices.filter((value: string) => value !== device)
														: [...scheme.devices, device];
													if (devices.length) {
														run(
															() =>
																void setInputControlScheme(
																	props.scene,
																	{ mapId: map.id, schemeId: scheme.id, expectedRevision: map.revision, changes: { devices } },
																	options
																)
														);
													}
												}}
											>
												{device}
											</Button>
										))}
									</div>
								</div>
							))}
						</div>

						<div className="space-y-1 rounded border border-border p-2">
							<div className="flex items-center justify-between font-medium">
								<span>TypeScript wrapper</span>
								<Button
									size="sm"
									onClick={() => {
										try {
											setWrapperSource(generateInputActionWrapper(props.scene, { mapId: map.id }).source);
										} catch (error) {
											toast.error(error instanceof Error ? error.message : "Could not generate wrapper.");
										}
									}}
								>
									Generate
								</Button>
							</div>
							{wrapperSource && <pre className="max-h-48 overflow-auto rounded bg-input p-1 text-[10px]">{wrapperSource}</pre>}
						</div>
					</>
				)}

				<div className="space-y-1 rounded border border-border p-2">
					<div className="flex items-center justify-between font-medium">
						<span>Runtime diagnostics</span>
						<Button size="sm" variant="ghost" onClick={() => setVersion((value) => value + 1)}>
							Refresh
						</Button>
					</div>
					{runtimeEvidence ? (
						<>
							<div className="text-[11px] text-muted-foreground">
								Devices:{" "}
								{runtimeEvidence.devices
									.filter((device: any) => device.connected)
									.map((device: any) => device.displayName)
									.join(", ") || "none"}{" "}
								· Last: {runtimeEvidence.lastUsedDevice ?? "none"}
							</div>
							{runtimeEvidence.actions.map((state: any) => (
								<div key={state.actionId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1 text-[11px]">
									<span className="truncate">
										{state.mapName}/{state.actionName}
									</span>
									<span>{state.phase}</span>
									<code>{JSON.stringify(state.value)}</code>
								</div>
							))}
						</>
					) : (
						<div className="text-[11px] text-muted-foreground">Start preview/runtime to inspect devices, schemes, phases, values, controls, and trace.</div>
					)}
				</div>
			</div>
		</EditorInspectorSectionField>
	);
}
