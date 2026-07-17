import { useState } from "react";

import { Camera } from "babylonjs";

import { Button } from "../../../../../ui/shadcn/ui/button";
import { createVirtualCamera, setVirtualCameraDolly } from "../../../../../mcp/virtual-cameras/virtual-cameras";

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

	function refresh(): void {
		setVersion((value) => value + 1);
		props.editor.layout.inspector.setEditedObject(props.camera);
		props.editor.layout.inspector.forceUpdate();
	}

	function createVirtualCameraForCamera(): void {
		const baseName = `${props.camera.name} Virtual Camera`;
		let name = baseName;
		let index = 2;
		while (((scene.metadata?.babylonEditorVirtualCameras ?? []) as IVirtualCamera[]).some((value) => value.name === name)) name = `${baseName} ${index++}`;
		createVirtualCamera(scene, { name, cameraId: props.camera.id }, options);
		refresh();
	}

	function setDolly(virtualCamera: IVirtualCamera, changes: Partial<IVirtualCameraDolly>): void {
		const dolly = { ...virtualCamera.dolly, ...changes };
		if (!dolly.splineId) return;
		setVirtualCameraDolly(scene, { virtualCameraId: virtualCamera.id, ...dolly }, options);
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
