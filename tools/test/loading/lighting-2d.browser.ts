import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { SpriteMap } from "@babylonjs/core/Sprites/spriteMap";

import { configureLighting2D, getLighting2DRuntimeEvidence } from "../../src/loading/lighting-2d";
import type { SpriteMapNode } from "../../src/tools/sprite";

function delay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 16));
}

async function run(): Promise<void> {
	const canvas = document.createElement("canvas");
	canvas.width = 128;
	canvas.height = 128;
	document.body.appendChild(canvas);
	const engine = new Engine(canvas, false, { disableWebGL2Support: false, preserveDrawingBuffer: true, stencil: true });
	engine.getCaps().parallelShaderCompile = undefined;
	const scene = new Scene(engine);
	scene.clearColor = new Color4(0, 0, 0, 1);
	scene.imageProcessingConfiguration.toneMappingEnabled = false;
	const camera = new FreeCamera("Lighting2D Camera", new Vector3(0, 0, -300), scene);
	camera.setTarget(Vector3.Zero());
	camera.minZ = 1;
	camera.maxZ = 1000;
	scene.activeCamera = camera;

	const spriteSheet = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
	const spriteMap = new SpriteMap(
		"Lighting2DGpuConformance",
		{
			frames: [
				{
					filename: "white.png",
					frame: { x: 0, y: 0, w: 1, h: 1 },
					rotated: false,
					trimmed: false,
					spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
					sourceSize: { w: 1, h: 1 },
				},
			],
		},
		spriteSheet,
		{ stageSize: new Vector2(1, 1), outputSize: new Vector2(160, 160) },
		scene
	);
	const owner = new TransformNode("Lit SpriteMap", scene) as SpriteMapNode;
	owner.isSpriteMap = true;
	owner.spriteMap = spriteMap;
	const light = new TransformNode("Red Global Light2D", scene);
	light.metadata = {
		babylonEditorComponentStack: {
			version: 1,
			components: [
				{
					id: "gpu-global-light",
					type: "light2d",
					enabled: true,
					data: { lightType: "global", providerId: "builtin.global", color: [1, 0, 0, 1], intensity: 1 },
				},
			],
		},
	};
	configureLighting2D(scene);

	const material = (spriteMap as any)._material;
	const output = (spriteMap as any)._output;
	let readyFrame = 0;
	for (let frame = 1; frame <= 120; frame++) {
		engine.beginFrame();
		scene.render();
		engine.endFrame();
		if (material.isReady(output)) {
			readyFrame = frame;
			break;
		}
		await delay();
	}
	if (!readyFrame) {
		throw new Error(`SpriteMap Light2D shader did not become ready: ${material.getEffect()?.getCompilationError() || "no compilation detail"}`);
	}
	engine.beginFrame();
	scene.render();
	engine.endFrame();
	const pixels = await engine.readPixels(0, 0, 128, 128);
	const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	const offset = (64 * 128 + 64) * 4;
	const centerPixel = Array.from(bytes.subarray(offset, offset + 4));
	const evidence = getLighting2DRuntimeEvidence(scene) as any;
	const compilationError = material.getEffect()?.getCompilationError() || null;
	const passed =
		compilationError === null &&
		centerPixel[0] > 120 &&
		centerPixel[0] > centerPixel[1] * 3 &&
		centerPixel[0] > centerPixel[2] * 3 &&
		evidence.activeLightCount === 1 &&
		evidence.spriteMapCount === 1;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify({ backend: engine.getClassName(), readyFrame, centerPixel, compilationError, evidence });

	spriteMap.dispose();
	spriteSheet.dispose();
	owner.dispose();
	light.dispose();
	scene.dispose();
	engine.dispose();
}

run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
