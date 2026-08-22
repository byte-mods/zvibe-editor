import { useEffect, useRef, useState } from "react";

import { RecastNavigationJSPluginV2 } from "babylonjs-addons";
import { Engine, Scene, Mesh, Vector3, ArcRotateCamera } from "babylonjs";

import { INavMeshAreaConfiguration } from "./types";
import { createNavMeshAreaDebugMeshes } from "./debug";

export interface INavMeshEditorPreviewProps {
	meshes: readonly Mesh[];
	plugin: RecastNavigationJSPluginV2;
	areas: readonly INavMeshAreaConfiguration[];
}

export function NavMeshEditorPreview(props: INavMeshEditorPreviewProps) {
	const [scene, setScene] = useState<Scene | null>(null);
	const [meshes, setMeshes] = useState<Mesh[]>([]);
	const [camera, setCamera] = useState<ArcRotateCamera | null>(null);

	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const engine = new Engine(canvasRef.current!, true, {
			adaptToDeviceRatio: true,
		});

		const scene = new Scene(engine);
		scene.clearColor.set(0, 0, 0, 1);

		setScene(scene);

		const observer = new ResizeObserver(() => {
			engine.resize();
		});
		observer.observe(canvasRef.current!);

		engine.runRenderLoop(() => {
			if (scene.activeCamera) {
				scene.render();
			}
		});

		return () => {
			observer.disconnect();
			scene.dispose();
			engine.dispose();
		};
	}, []);

	useEffect(() => {
		if (meshes.length && scene && !camera) {
			const minimum = meshes.reduce(
				(value, mesh) => Vector3.Minimize(value, mesh.getBoundingInfo().boundingBox.minimumWorld),
				meshes[0].getBoundingInfo().boundingBox.minimumWorld
			);
			const maximum = meshes.reduce(
				(value, mesh) => Vector3.Maximize(value, mesh.getBoundingInfo().boundingBox.maximumWorld),
				meshes[0].getBoundingInfo().boundingBox.maximumWorld
			);
			const distance = Vector3.Distance(minimum, maximum);

			const camera = new ArcRotateCamera("camera", Math.PI * 0.25, Math.PI * 0.25, distance, Vector3.Center(minimum, maximum), scene, true);
			camera.wheelPrecision = 1;
			camera.attachControl();

			setCamera(camera);
		}
	}, [meshes, scene, camera]);

	useEffect(() => {
		if (!scene || !props.meshes.length) {
			return;
		}
		const debugMeshes = createNavMeshAreaDebugMeshes(props.plugin, scene, props.areas);
		setMeshes(debugMeshes);
		return () => {
			debugMeshes.forEach((mesh) => mesh.dispose(false, true));
		};
	}, [props.meshes, props.plugin, props.areas, scene]);

	return (
		<div className="flex-1 h-full p-2">
			<canvas ref={canvasRef} className="w-full h-full bg-black rounded-lg" />
		</div>
	);
}
