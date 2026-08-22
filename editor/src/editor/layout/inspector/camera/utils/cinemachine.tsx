import { Fragment, useState } from "react";

import { Camera } from "babylonjs";

import { Button } from "../../../../../ui/shadcn/ui/button";
import { deleteCameraImpulseSource, fireCameraImpulse, setCameraImpulseSource } from "../../../../../mcp/virtual-cameras/impulses";
import {
	getVirtualCameraRuntime,
	setCameraNoiseProfile,
	setVirtualCameraDeoccluder,
	setVirtualCameraImpulseListener,
	setVirtualCameraNoise,
} from "../../../../../mcp/virtual-cameras/virtual-cameras";

import { IEditorInspectorImplementationProps } from "../../inspector";

import { EditorInspectorListField } from "../../fields/list";
import { EditorInspectorNumberField } from "../../fields/number";
import { EditorInspectorSectionField } from "../../fields/section";
import { EditorInspectorSwitchField } from "../../fields/switch";

interface INoiseLayer {
	amplitude: number;
	frequency: number;
	nonRandom?: boolean;
	phase?: number;
}

interface INoiseChannels {
	x: INoiseLayer[];
	y: INoiseLayer[];
	z: INoiseLayer[];
}

interface INoiseProfile {
	id: string;
	name: string;
	position: INoiseChannels;
	rotation: INoiseChannels;
}

interface IVirtualCamera {
	id: string;
	name: string;
	cameraId: string;
	impulseChannelMask?: number;
	noise?: { profileId: string; enabled: boolean; amplitudeGain: number; frequencyGain: number; pivotOffset: number[]; seed: number };
	deoccluder?: {
		enabled: boolean;
		avoidObstacles: boolean;
		strategy: "pullForward" | "preserveHeight" | "preserveDistance";
		cameraRadius: number;
		minimumOcclusionTime: number;
		damping: number;
		dampingWhenOccluded: number;
		maximumEffort: number;
		shotQuality: { enabled: boolean; optimalDistance: number; nearLimit: number; farLimit: number; maximumQualityBoost: number };
	};
}

interface IImpulseSource {
	id: string;
	name: string;
	amplitude: number;
	duration: number;
	frequency: number;
	direction: number[];
	cameraId?: string;
	channelMask?: number;
	noiseProfileId?: string;
	rotationGain?: number;
	dissipationDistance?: number;
	sourceNodeId?: string;
	trigger?: { type: "collision"; nodeId: string; minimumImpact: number; includeContinued: boolean; cooldownSeconds: number; useImpactDirection: boolean };
}

interface ICameraCinemachineInspectorProps {
	editor: IEditorInspectorImplementationProps<Camera>["editor"];
	camera: Camera;
}

const axes = ["x", "y", "z"] as const;
const noNoiseProfileValue = "__no_camera_noise_profile__";

function defaultNoiseProfile(name: string): Omit<INoiseProfile, "id"> {
	return {
		name,
		position: { x: [{ amplitude: 0.5, frequency: 0.35 }], y: [{ amplitude: 0.35, frequency: 0.5 }], z: [{ amplitude: 0.25, frequency: 0.8 }] },
		rotation: { x: [{ amplitude: 0.4, frequency: 0.45 }], y: [{ amplitude: 0.55, frequency: 0.3 }], z: [{ amplitude: 0.25, frequency: 0.9 }] },
	};
}

/** Authors the persisted Cinemachine-style noise, deocclusion, shot-quality, and impulse pipeline for one real camera. */
export function CameraCinemachineInspector(props: ICameraCinemachineInspectorProps) {
	const [, setVersion] = useState(0);
	const scene = props.editor.layout.preview.scene;
	const options = { editor: props.editor } as any;
	const virtualCameras = ((scene.metadata?.babylonEditorVirtualCameras ?? []) as IVirtualCamera[]).filter((value) => value.cameraId === props.camera.id);
	const profiles = (scene.metadata?.babylonEditorCameraNoiseProfiles ?? []) as INoiseProfile[];
	const impulses = ((scene.metadata?.babylonEditorCameraImpulseSources ?? []) as IImpulseSource[]).filter((value) => value.cameraId === props.camera.id);
	const collisionNodes = scene.meshes.filter((mesh) => mesh.physicsAggregate?.body);

	function refresh(): void {
		setVersion((value) => value + 1);
		props.editor.layout.inspector.setEditedObject(props.camera);
		props.editor.layout.inspector.forceUpdate();
	}

	function createProfile(): INoiseProfile {
		const baseName = "Handheld Camera";
		let name = baseName;
		let index = 2;
		while (profiles.some((value) => value.name === name)) {
			name = `${baseName} ${index++}`;
		}
		const result = setCameraNoiseProfile(scene, defaultNoiseProfile(name), options) as INoiseProfile;
		refresh();
		return result;
	}

	function updateProfile(profile: INoiseProfile): void {
		setCameraNoiseProfile(scene, { noiseProfileId: profile.id, name: profile.name, position: profile.position, rotation: profile.rotation }, options);
		refresh();
	}

	function setNoise(virtualCamera: IVirtualCamera, changes: Record<string, unknown>): void {
		setVirtualCameraNoise(scene, { virtualCameraId: virtualCamera.id, ...changes }, options);
		refresh();
	}

	function setDeoccluder(virtualCamera: IVirtualCamera, changes: Record<string, unknown>): void {
		setVirtualCameraDeoccluder(scene, { virtualCameraId: virtualCamera.id, ...changes }, options);
		refresh();
	}

	function createImpulse(): void {
		const baseName = `${props.camera.name} Impact`;
		let name = baseName;
		let index = 2;
		while (((scene.metadata?.babylonEditorCameraImpulseSources ?? []) as IImpulseSource[]).some((value) => value.name === name)) {
			name = `${baseName} ${index++}`;
		}
		setCameraImpulseSource(scene, { name, cameraId: props.camera.id, amplitude: 10, duration: 0.5, frequency: 4, direction: [1, 0, 0], channelMask: 1 }, options);
		refresh();
	}

	function updateImpulse(source: IImpulseSource, changes: Partial<IImpulseSource>): void {
		setCameraImpulseSource(scene, { ...source, ...changes, impulseId: source.id }, options);
		refresh();
	}

	return (
		<>
			<EditorInspectorSectionField
				title="Virtual Camera Noise Profiles"
				tooltip="Reusable layered six-axis smooth-noise profiles shared by continuous camera motion and event/collision impulses."
			>
				{!profiles.length && (
					<Button variant="secondary" className="w-full" onClick={createProfile}>
						Create Handheld Noise Profile
					</Button>
				)}
				{profiles.map((profile) => (
					<div key={profile.id} className="flex flex-col gap-2 rounded border border-border p-2">
						<div className="text-sm font-medium">{profile.name}</div>
						{(["position", "rotation"] as const).map((transform) => (
							<Fragment key={transform}>
								<div className="text-xs font-medium uppercase text-muted-foreground">{transform} layers</div>
								{axes.map((axis) => (
									<div key={axis} className="flex flex-col gap-1 rounded bg-muted/30 p-1">
										<div className="text-xs text-muted-foreground">{axis.toUpperCase()}</div>
										{profile[transform][axis].map((layer, layerIndex) => (
											<div key={layerIndex} className="flex flex-col gap-1">
												<EditorInspectorNumberField
													label={transform === "position" ? "Amplitude (cm)" : "Amplitude (°)"}
													object={layer}
													property="amplitude"
													step={0.05}
													onChange={(amplitude) => {
														layer.amplitude = amplitude;
														updateProfile(profile);
													}}
												/>
												<EditorInspectorNumberField
													label="Frequency (Hz)"
													object={layer}
													property="frequency"
													min={0.001}
													max={120}
													step={0.05}
													onChange={(frequency) => {
														layer.frequency = frequency;
														updateProfile(profile);
													}}
												/>
												<EditorInspectorSwitchField
													label="Periodic Sine"
													object={layer}
													property="nonRandom"
													onChange={(nonRandom) => {
														layer.nonRandom = nonRandom;
														updateProfile(profile);
													}}
												/>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														profile[transform][axis].splice(layerIndex, 1);
														updateProfile(profile);
													}}
												>
													Remove Layer
												</Button>
											</div>
										))}
										<Button
											size="sm"
											variant="secondary"
											disabled={profile[transform][axis].length >= 8}
											onClick={() => {
												profile[transform][axis].push({ amplitude: transform === "position" ? 0.25 : 0.5, frequency: 1 });
												updateProfile(profile);
											}}
										>
											Add {axis.toUpperCase()} Layer
										</Button>
									</div>
								))}
							</Fragment>
						))}
					</div>
				))}
				<Button variant="secondary" className="w-full" onClick={createProfile}>
					Add Noise Profile
				</Button>
			</EditorInspectorSectionField>

			<EditorInspectorSectionField
				title="Virtual Camera Deocclusion & Noise"
				tooltip="Post-composition obstacle avoidance, shot quality, continuous noise, and impulse listener settings."
			>
				{!virtualCameras.length && <div className="px-2 text-sm text-muted-foreground">Create a Virtual Camera in the Dolly section first.</div>}
				{virtualCameras.map((virtualCamera) => {
					const runtime = getVirtualCameraRuntime(scene, { virtualCameraId: virtualCamera.id }).runtime;
					return (
						<div key={virtualCamera.id} className="flex flex-col gap-2 rounded border border-border p-2">
							<div className="text-sm font-medium">{virtualCamera.name}</div>
							<EditorInspectorListField
								label="Noise Profile"
								object={{ profileId: virtualCamera.noise?.profileId ?? noNoiseProfileValue }}
								property="profileId"
								items={[
									{ key: noNoiseProfileValue, text: "None", value: noNoiseProfileValue },
									...profiles.map((profile) => ({ key: profile.id, text: profile.name, value: profile.id })),
								]}
								onChange={(profileId) => setNoise(virtualCamera, { noiseProfileId: profileId === noNoiseProfileValue ? null : profileId })}
							/>
							{virtualCamera.noise && (
								<>
									<EditorInspectorSwitchField
										label="Noise Enabled"
										object={virtualCamera.noise}
										property="enabled"
										onChange={(enabled) => setNoise(virtualCamera, { enabled })}
									/>
									<EditorInspectorNumberField
										label="Amplitude Gain"
										object={virtualCamera.noise}
										property="amplitudeGain"
										min={0}
										max={1000}
										step={0.05}
										onChange={(amplitudeGain) => setNoise(virtualCamera, { amplitudeGain })}
									/>
									<EditorInspectorNumberField
										label="Frequency Gain"
										object={virtualCamera.noise}
										property="frequencyGain"
										min={0}
										max={1000}
										step={0.05}
										onChange={(frequencyGain) => setNoise(virtualCamera, { frequencyGain })}
									/>
								</>
							)}
							<Button size="sm" variant="secondary" onClick={() => setDeoccluder(virtualCamera, { enabled: !(virtualCamera.deoccluder?.enabled ?? false) })}>
								{virtualCamera.deoccluder?.enabled ? "Disable" : "Enable"} Deoccluder
							</Button>
							{virtualCamera.deoccluder && (
								<>
									<EditorInspectorSwitchField
										label="Avoid Obstacles"
										object={virtualCamera.deoccluder}
										property="avoidObstacles"
										onChange={(avoidObstacles) => setDeoccluder(virtualCamera, { avoidObstacles })}
									/>
									<EditorInspectorListField
										label="Strategy"
										object={virtualCamera.deoccluder}
										property="strategy"
										items={[
											{ key: "pullForward", text: "Pull Camera Forward", value: "pullForward" },
											{ key: "preserveHeight", text: "Preserve Camera Height", value: "preserveHeight" },
											{ key: "preserveDistance", text: "Preserve Camera Distance", value: "preserveDistance" },
										]}
										onChange={(strategy) => setDeoccluder(virtualCamera, { strategy })}
									/>
									<EditorInspectorNumberField
										label="Camera Radius (cm)"
										object={virtualCamera.deoccluder}
										property="cameraRadius"
										min={0}
										step={1}
										onChange={(cameraRadius) => setDeoccluder(virtualCamera, { cameraRadius })}
									/>
									<EditorInspectorNumberField
										label="Damping"
										object={virtualCamera.deoccluder}
										property="damping"
										min={0}
										max={60}
										step={0.05}
										onChange={(damping) => setDeoccluder(virtualCamera, { damping })}
									/>
									<EditorInspectorSwitchField
										label="Evaluate Shot Quality"
										object={virtualCamera.deoccluder.shotQuality}
										property="enabled"
										onChange={(enabled) => setDeoccluder(virtualCamera, { shotQuality: { enabled } })}
									/>
								</>
							)}
							<EditorInspectorNumberField
								label="Impulse Channel Mask"
								object={virtualCamera}
								property="impulseChannelMask"
								min={1}
								max={0x7fffffff}
								step={1}
								onChange={(channelMask) => {
									setVirtualCameraImpulseListener(scene, { virtualCameraId: virtualCamera.id, channelMask: Math.round(channelMask) }, options);
									refresh();
								}}
							/>
							{runtime && (
								<div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
									<div>Shot quality: {runtime.shotQuality.toFixed(3)}</div>
									<div>{runtime.targetObscured ? `Obscured by ${runtime.obstacleNodeId ?? "unknown"}` : "Line of sight clear"}</div>
									<div>Displacement: {runtime.displacementDistance.toFixed(3)} cm</div>
									<div>Noise position: {runtime.noisePositionOffset.map((value: number) => value.toFixed(3)).join(", ")} cm</div>
								</div>
							)}
						</div>
					);
				})}
			</EditorInspectorSectionField>

			<EditorInspectorSectionField
				title="Camera Impulse Sources"
				tooltip="Manual/script-event or collision-triggered sources using channel-filtered listeners, spatial dissipation, and optional layered noise profiles."
			>
				{impulses.map((source) => (
					<div key={source.id} className="flex flex-col gap-2 rounded border border-border p-2">
						<div className="text-sm font-medium">{source.name}</div>
						<EditorInspectorNumberField
							label="Amplitude"
							object={source}
							property="amplitude"
							min={0}
							step={0.5}
							onChange={(amplitude) => updateImpulse(source, { amplitude })}
						/>
						<EditorInspectorNumberField
							label="Duration (s)"
							object={source}
							property="duration"
							min={0.001}
							step={0.05}
							onChange={(duration) => updateImpulse(source, { duration })}
						/>
						<EditorInspectorNumberField
							label="Frequency (Hz)"
							object={source}
							property="frequency"
							min={0.001}
							step={0.25}
							onChange={(frequency) => updateImpulse(source, { frequency })}
						/>
						<EditorInspectorListField
							label="Noise Profile"
							object={{ noiseProfileId: source.noiseProfileId ?? noNoiseProfileValue }}
							property="noiseProfileId"
							items={[
								{ key: noNoiseProfileValue, text: "Directional Sine", value: noNoiseProfileValue },
								...profiles.map((profile) => ({ key: profile.id, text: profile.name, value: profile.id })),
							]}
							onChange={(noiseProfileId) => updateImpulse(source, { noiseProfileId: noiseProfileId === noNoiseProfileValue ? undefined : noiseProfileId })}
						/>
						<EditorInspectorSwitchField
							label="Collision Trigger"
							object={{ enabled: !!source.trigger }}
							property="enabled"
							onChange={(enabled) =>
								updateImpulse(source, {
									trigger:
										enabled && collisionNodes[0]
											? {
													type: "collision",
													nodeId: collisionNodes[0].id,
													minimumImpact: 0,
													includeContinued: false,
													cooldownSeconds: 0.1,
													useImpactDirection: true,
												}
											: undefined,
								})
							}
						/>
						{source.trigger && (
							<>
								<EditorInspectorListField
									label="Collision Node"
									object={source.trigger}
									property="nodeId"
									search
									items={collisionNodes.map((node) => ({ key: node.id, text: node.name, value: node.id }))}
									onChange={(nodeId) => updateImpulse(source, { trigger: { ...source.trigger!, nodeId } })}
								/>
								<EditorInspectorNumberField
									label="Minimum Impact"
									object={source.trigger}
									property="minimumImpact"
									min={0}
									step={0.1}
									onChange={(minimumImpact) => updateImpulse(source, { trigger: { ...source.trigger!, minimumImpact } })}
								/>
							</>
						)}
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" className="flex-1" onClick={() => fireCameraImpulse(scene, { impulseId: source.id }, options)}>
								Fire Impulse
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="flex-1 hover:bg-destructive"
								onClick={() => {
									deleteCameraImpulseSource(scene, { impulseId: source.id }, options);
									refresh();
								}}
							>
								Delete
							</Button>
						</div>
					</div>
				))}
				<Button variant="secondary" className="w-full" onClick={createImpulse}>
					Add Camera Impulse Source
				</Button>
			</EditorInspectorSectionField>
		</>
	);
}
