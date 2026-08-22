import { useEffect, useState } from "react";

import { Camera } from "babylonjs";

import { Button } from "../../../../../ui/shadcn/ui/button";
import {
	controlVirtualCameraPathTimelinePlayback,
	createVirtualCamera,
	getVirtualCameraPathTimeline,
	setVirtualCameraDolly,
	setVirtualCameraPathTimeline,
} from "../../../../../mcp/virtual-cameras/virtual-cameras";

import { IEditorInspectorImplementationProps } from "../../inspector";

import { EditorInspectorListField } from "../../fields/list";
import { EditorInspectorNumberField } from "../../fields/number";
import { EditorInspectorSectionField } from "../../fields/section";
import { EditorInspectorSwitchField } from "../../fields/switch";

interface IVirtualCameraDolly {
	splineId: string;
	t: number;
	speed: number;
	loop: boolean;
	orientToPath: boolean;
}

interface IVirtualCamera {
	id: string;
	name: string;
	cameraId: string;
	dolly?: IVirtualCameraDolly;
	pathTimeline?: ISplineCameraPathTimeline;
}

interface ISplineCameraPathTimelineKey {
	id: string;
	time: number;
	t: number;
	easing: "linear" | "easeIn" | "easeOut" | "easeInOut" | "step";
}

interface ISplineCameraPathTimeline {
	revision: number;
	duration: number;
	autoPlay: boolean;
	wrapMode: "once" | "loop" | "pingPong";
	keys: ISplineCameraPathTimelineKey[];
}

interface ICameraDollyInspectorProps {
	editor: IEditorInspectorImplementationProps<Camera>["editor"];
	camera: Camera;
}

/** Edits persisted virtual-camera spline dollies directly from a real camera's Inspector. */
export function CameraDollyInspector(props: ICameraDollyInspectorProps) {
	const [, setVersion] = useState(0);
	const scene = props.editor.layout.preview.scene;
	const virtualCameras = ((scene.metadata?.babylonEditorVirtualCameras ?? []) as IVirtualCamera[]).filter((value) => value.cameraId === props.camera.id);
	const splines = scene.meshes.filter((mesh) => mesh.metadata?.type === "Spline");
	const options = { editor: props.editor } as any;
	const hasPathTimeline = virtualCameras.some((value) => value.pathTimeline);

	useEffect(() => {
		if (!hasPathTimeline) {
			return;
		}
		const interval = setInterval(() => setVersion((value) => value + 1), 100);
		return () => clearInterval(interval);
	}, [hasPathTimeline]);

	function refresh(): void {
		setVersion((value) => value + 1);
		props.editor.layout.inspector.setEditedObject(props.camera);
		props.editor.layout.inspector.forceUpdate();
	}

	function createVirtualCameraForCamera(): void {
		const baseName = `${props.camera.name} Virtual Camera`;
		let name = baseName;
		let index = 2;
		while (((scene.metadata?.babylonEditorVirtualCameras ?? []) as IVirtualCamera[]).some((value) => value.name === name)) {
			name = `${baseName} ${index++}`;
		}
		createVirtualCamera(scene, { name, cameraId: props.camera.id }, options);
		refresh();
	}

	function setDolly(virtualCamera: IVirtualCamera, changes: Partial<IVirtualCameraDolly>): void {
		const dolly = { ...virtualCamera.dolly, ...changes };
		if (!dolly.splineId) {
			return;
		}
		setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, ...dolly }, options);
		refresh();
	}

	function setTimeline(virtualCamera: IVirtualCamera, changes: Partial<ISplineCameraPathTimeline>): void {
		const timeline = virtualCamera.pathTimeline;
		setVirtualCameraPathTimeline(
			scene,
			{
				virtualCameraId: virtualCamera.id,
				expectedRevision: timeline?.revision,
				...changes,
			},
			options
		);
		refresh();
	}

	function createTimeline(virtualCamera: IVirtualCamera): void {
		setVirtualCameraPathTimeline(
			scene,
			{
				virtualCameraId: virtualCamera.id,
				duration: 5,
				autoPlay: false,
				wrapMode: "once",
				keys: [
					{ time: 0, t: virtualCamera.dolly?.t ?? 0, easing: "easeInOut" },
					{ time: 5, t: 1, easing: "linear" },
				],
			},
			options
		);
		refresh();
	}

	function updateTimelineKey(virtualCamera: IVirtualCamera, keyId: string, changes: Partial<ISplineCameraPathTimelineKey>): void {
		const timeline = virtualCamera.pathTimeline!;
		setTimeline(virtualCamera, { keys: timeline.keys.map((key) => (key.id === keyId ? { ...key, ...changes } : key)) });
	}

	function addTimelineKey(virtualCamera: IVirtualCamera): void {
		const timeline = virtualCamera.pathTimeline!;
		let index = 0;
		for (let candidate = 1; candidate < timeline.keys.length - 1; candidate++) {
			if (timeline.keys[candidate + 1].time - timeline.keys[candidate].time > timeline.keys[index + 1].time - timeline.keys[index].time) {
				index = candidate;
			}
		}
		const before = timeline.keys[index];
		const after = timeline.keys[index + 1];
		const keys = [...timeline.keys];
		keys.splice(index + 1, 0, { id: crypto.randomUUID(), time: (before.time + after.time) / 2, t: (before.t + after.t) / 2, easing: "easeInOut" });
		setTimeline(virtualCamera, { keys });
	}

	function controlTimeline(virtualCamera: IVirtualCamera, action: "play" | "pause" | "stop" | "seek", time?: number): void {
		controlVirtualCameraPathTimelinePlayback(scene, { virtualCameraId: virtualCamera.id, expectedRevision: virtualCamera.pathTimeline!.revision, action, time }, options);
		refresh();
	}

	return (
		<EditorInspectorSectionField title="Virtual Camera Dolly" tooltip="Create a persisted virtual camera for this camera, then author its spline path and live preview pose.">
			{!virtualCameras.length && (
				<Button variant="secondary" className="w-full" onClick={createVirtualCameraForCamera}>
					Create Virtual Camera
				</Button>
			)}
			{virtualCameras.map((virtualCamera) => {
				const dolly = virtualCamera.dolly;
				if (!dolly) {
					return (
						<div key={virtualCamera.id} className="flex flex-col gap-2">
							<div className="px-2 text-sm text-muted-foreground">{virtualCamera.name}</div>
							<Button variant="secondary" className="w-full" disabled={!splines.length} onClick={() => setDolly(virtualCamera, { splineId: splines[0]?.id })}>
								Attach Dolly to {splines[0]?.name ?? "a Spline"}
							</Button>
							{!splines.length && <div className="px-2 text-sm text-muted-foreground">Create a spline before attaching a dolly.</div>}
						</div>
					);
				}
				return (
					<div key={virtualCamera.id} className="flex flex-col gap-2">
						<div className="px-2 text-sm text-muted-foreground">{virtualCamera.name}</div>
						<EditorInspectorListField
							label="Spline"
							object={dolly}
							property="splineId"
							search
							items={splines.map((spline) => ({ key: spline.id, text: spline.name, value: spline.id }))}
							onChange={(splineId) => setDolly(virtualCamera, { splineId })}
						/>
						<EditorInspectorNumberField
							label="Start Position"
							object={dolly}
							property="t"
							min={0}
							max={1}
							step={0.01}
							onChange={(t) => setDolly(virtualCamera, { t })}
						/>
						<EditorInspectorNumberField
							label="Speed (cm/s)"
							object={dolly}
							property="speed"
							min={0}
							step={1}
							onChange={(speed) => setDolly(virtualCamera, { speed })}
						/>
						<EditorInspectorSwitchField label="Loop" object={dolly} property="loop" onChange={(loop) => setDolly(virtualCamera, { loop })} />
						<EditorInspectorSwitchField
							label="Orient To Path"
							object={dolly}
							property="orientToPath"
							onChange={(orientToPath) => setDolly(virtualCamera, { orientToPath })}
						/>
						{!virtualCamera.pathTimeline ? (
							<Button size="sm" variant="secondary" className="w-full" onClick={() => createTimeline(virtualCamera)}>
								Create Path Timeline
							</Button>
						) : (
							<div className="flex flex-col gap-2 rounded border border-border p-2">
								<div className="text-xs font-medium">Path Timeline · revision {virtualCamera.pathTimeline.revision}</div>
								<EditorInspectorNumberField
									label="Duration (s)"
									object={{ ...virtualCamera.pathTimeline }}
									property="duration"
									min={(virtualCamera.pathTimeline.keys.at(-2)?.time ?? 0) + 0.01}
									max={86400}
									step={0.1}
									onChange={(duration) => {
										const keys = virtualCamera.pathTimeline!.keys.map((key, index, values) => (index === values.length - 1 ? { ...key, time: duration } : key));
										setTimeline(virtualCamera, { duration, keys });
									}}
								/>
								<EditorInspectorListField
									label="Wrap"
									object={{ ...virtualCamera.pathTimeline }}
									property="wrapMode"
									items={[
										{ key: "once", text: "Once", value: "once" },
										{ key: "loop", text: "Loop", value: "loop" },
										{ key: "pingPong", text: "Ping Pong", value: "pingPong" },
									]}
									onChange={(wrapMode) => setTimeline(virtualCamera, { wrapMode })}
								/>
								<EditorInspectorSwitchField
									label="Auto Play"
									object={{ ...virtualCamera.pathTimeline }}
									property="autoPlay"
									onChange={(autoPlay) => setTimeline(virtualCamera, { autoPlay })}
								/>
								{(() => {
									const evidence = getVirtualCameraPathTimeline(scene, { virtualCameraId: virtualCamera.id });
									return (
										<>
											<EditorInspectorNumberField
												label="Playhead (s)"
												object={evidence.runtime}
												property="time"
												min={0}
												max={virtualCamera.pathTimeline!.duration}
												step={0.01}
												onChange={(time) => controlTimeline(virtualCamera, "seek", time)}
											/>
											<div className="px-2 text-[11px] text-muted-foreground">
												Path {evidence.runtime.pathT.toFixed(3)} · {evidence.runtime.fromKeyId} → {evidence.runtime.toKeyId} ·{" "}
												{evidence.runtime.playing ? "playing" : "paused"}
											</div>
											<div className="flex gap-1">
												<Button
													size="sm"
													variant="secondary"
													className="flex-1"
													onClick={() => controlTimeline(virtualCamera, evidence.runtime.playing ? "pause" : "play")}
												>
													{evidence.runtime.playing ? "Pause" : "Play"}
												</Button>
												<Button size="sm" variant="secondary" className="flex-1" onClick={() => controlTimeline(virtualCamera, "stop")}>
													Stop
												</Button>
											</div>
										</>
									);
								})()}
								{virtualCamera.pathTimeline.keys.map((key, index, keys) => (
									<div key={key.id} className="flex flex-col gap-1 rounded bg-muted/30 p-1">
										<div className="text-[11px] text-muted-foreground">Key {index + 1}</div>
										{index === 0 || index === keys.length - 1 ? (
											<div className="flex justify-between px-2 text-xs text-muted-foreground">
												<span>Time</span>
												<span>{key.time.toFixed(3)} s · endpoint</span>
											</div>
										) : (
											<EditorInspectorNumberField
												label="Time"
												object={{ ...key }}
												property="time"
												min={keys[index - 1].time + 0.001}
												max={keys[index + 1].time - 0.001}
												step={0.01}
												onChange={(time) => updateTimelineKey(virtualCamera, key.id, { time })}
											/>
										)}
										<EditorInspectorNumberField
											label="Path T"
											object={{ ...key }}
											property="t"
											min={0}
											max={1}
											step={0.01}
											onChange={(t) => updateTimelineKey(virtualCamera, key.id, { t })}
										/>
										<EditorInspectorListField
											label="Outgoing Ease"
											object={{ ...key }}
											property="easing"
											items={[
												{ key: "linear", text: "Linear", value: "linear" },
												{ key: "easeIn", text: "Ease In", value: "easeIn" },
												{ key: "easeOut", text: "Ease Out", value: "easeOut" },
												{ key: "easeInOut", text: "Ease In Out", value: "easeInOut" },
												{ key: "step", text: "Step", value: "step" },
											]}
											onChange={(easing) => updateTimelineKey(virtualCamera, key.id, { easing })}
										/>
										{index > 0 && index < keys.length - 1 && (
											<Button
												size="sm"
												variant="ghost"
												onClick={() => setTimeline(virtualCamera, { keys: keys.filter((candidate) => candidate.id !== key.id) })}
											>
												Remove Key
											</Button>
										)}
									</div>
								))}
								<div className="flex gap-1">
									<Button
										size="sm"
										variant="secondary"
										className="flex-1"
										disabled={virtualCamera.pathTimeline.keys.length >= 512}
										onClick={() => addTimelineKey(virtualCamera)}
									>
										Add Key
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="flex-1 hover:bg-destructive"
										onClick={() => {
											setVirtualCameraPathTimeline(
												scene,
												{ virtualCameraId: virtualCamera.id, expectedRevision: virtualCamera.pathTimeline!.revision, clear: true },
												options
											);
											refresh();
										}}
									>
										Delete Timeline
									</Button>
								</div>
							</div>
						)}
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" className="flex-1" onClick={() => setDolly(virtualCamera, {})}>
								Preview Pose
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="flex-1 hover:bg-destructive"
								onClick={() => {
									setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, splineId: null }, options);
									refresh();
								}}
							>
								Detach Dolly
							</Button>
						</div>
					</div>
				);
			})}
		</EditorInspectorSectionField>
	);
}
