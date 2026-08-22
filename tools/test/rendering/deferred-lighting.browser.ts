import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Engines/Extensions/engine.readTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.readTexture";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Layer } from "@babylonjs/core/Layers/layer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { OpenPBRMaterial } from "@babylonjs/core/Materials/PBR/openpbrMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { PBRSpecularGlossinessMaterial } from "@babylonjs/core/Materials/PBR/pbrSpecularGlossinessMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateDecal } from "@babylonjs/core/Meshes/Builders/decalBuilder";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.cjs";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.cjs";

import { configureDeferredLighting, getDeferredLightingRuntime, stopDeferredLighting } from "../../src/rendering/deferred-lighting";
import { setLightCookie } from "../../src/loading/light-cookies";
import { createAreaLight, setAreaLightProperties } from "../../src/loading/area-lights";

declare const __DEFERRED_LIGHTING_TARGET__: "webgl2" | "webgpu";

async function createEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine | null> {
	if (__DEFERRED_LIGHTING_TARGET__ === "webgpu") {
		const adapter = await (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu?.requestAdapter();
		if (!adapter) {
			return null;
		}
		const glslang = glslangFactory(new URL("./glslang.wasm", location.href).href);
		const twgsl = await twgslFactory(new URL("./twgsl.wasm", location.href).href);
		return WebGPUEngine.CreateAsync(canvas, { glslangOptions: { glslang }, twgslOptions: { twgsl } });
	}
	return new Engine(canvas, false, { disableWebGL2Support: false, preserveDrawingBuffer: true, stencil: true });
}

function delay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 16));
}

function consumeWebGLErrors(engine: Engine | WebGPUEngine): number[] {
	const context = (engine as Engine & { _gl?: WebGL2RenderingContext })._gl;
	if (!context) {
		return [];
	}
	context.finish();
	const errors: number[] = [];
	for (let error = context.getError(); error !== context.NO_ERROR && errors.length < 16; error = context.getError()) {
		errors.push(error);
	}
	return errors;
}

async function renderUntil(scene: Scene, predicate: () => boolean, frames = 120): Promise<number> {
	for (let frame = 1; frame <= frames; frame++) {
		const engine = scene.getEngine();
		engine.beginFrame();
		scene.render();
		engine.endFrame();
		if (predicate()) {
			return frame;
		}
		await delay();
	}
	throw new Error(`Deferred lighting did not become ready after ${frames} frames: ${JSON.stringify(getDeferredLightingRuntime(scene))}`);
}

async function samplePixels(scene: Scene, target: RenderTargetTexture, xCoordinates: number[], y = 90): Promise<number[][]> {
	const engine = scene.getEngine();
	engine.beginFrame();
	scene.render();
	engine.endFrame();
	const pending = target.readPixels(0, 0, null, true, false, 0, 0, 320, 180);
	if (!pending) {
		throw new Error("Deferred presentation target does not support readback.");
	}
	const pixels = await pending;
	const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	return xCoordinates.map((x) => {
		const offset = (y * 320 + x) * 4;
		return Array.from(bytes.subarray(offset, offset + 4));
	});
}

async function exerciseDeferredShadowFilter(
	scene: Scene,
	camera: FreeCamera,
	presentation: RenderTargetTexture,
	expectedFilter: string,
	expectedMapType: "2d" | "cube" | "2d-array",
	expectedCascadeCount: number,
	xCoordinates: number[]
): Promise<{ runtime: ReturnType<typeof getDeferredLightingRuntime>; pixels: number[][] }> {
	const receiverStates = scene.meshes.map((mesh) => [mesh, mesh.receiveShadows] as const);
	for (const [mesh, receiveShadows] of receiverStates) {
		if (receiveShadows) {
			mesh.receiveShadows = false;
		}
	}
	let nativeFrames = 0;
	await renderUntil(scene, () => ++nativeFrames >= 4, 60);
	for (const [mesh, receiveShadows] of receiverStates) {
		mesh.receiveShadows = receiveShadows;
	}
	const configured = configureDeferredLighting(scene, camera);
	if (!configured.active) {
		throw new Error(`Deferred ${expectedFilter} shadow configuration failed: ${configured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return (
				runtime.ready &&
				runtime.shadowMapReady &&
				runtime.shadowFilter === expectedFilter &&
				runtime.shadowMapType === expectedMapType &&
				runtime.shadowCascadeCount === expectedCascadeCount &&
				runtime.shadowFrameCount >= 4
			);
		},
		240
	);
	const pixels = await samplePixels(scene, presentation, xCoordinates);
	const runtime = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	return { runtime, pixels };
}

async function exerciseDeferredCookie(
	scene: Scene,
	camera: FreeCamera,
	presentation: RenderTargetTexture,
	kind: "directional-2d" | "spot-2d" | "point-cube",
	color: [number, number, number]
): Promise<{
	kind: typeof kind;
	pixel: number[];
	runtime: ReturnType<typeof getDeferredLightingRuntime>;
	invalidated: ReturnType<typeof getDeferredLightingRuntime>;
	recovered: ReturnType<typeof getDeferredLightingRuntime>;
}> {
	stopDeferredLighting(scene);
	const meshStates = scene.meshes.map((mesh) => [mesh, mesh.isEnabled()] as const);
	const lightStates = scene.lights.map((light) => [light, light.isEnabled()] as const);
	meshStates.forEach(([mesh]) => mesh.setEnabled(false));
	lightStates.forEach(([light]) => light.setEnabled(false));
	const material = new StandardMaterial(`Deferred GPU ${kind} Cookie Material`, scene);
	material.diffuseColor = Color3.White();
	material.specularColor = Color3.Black();
	const mesh = CreateBox(`Deferred GPU ${kind} Cookie Receiver`, { size: 2 }, scene);
	mesh.material = material;
	let light: DirectionalLight | SpotLight | PointLight;
	if (kind === "directional-2d") {
		light = new DirectionalLight("Deferred GPU Directional Cookie", new Vector3(0, 0, 1), scene);
	} else if (kind === "spot-2d") {
		light = new SpotLight("Deferred GPU Spot Cookie", new Vector3(0, 0, -3), new Vector3(0, 0, 1), Math.PI / 2, 2, scene);
		light.range = 10;
	} else {
		light = new PointLight("Deferred GPU Point Cookie", new Vector3(0, 0, -3), scene);
		light.range = 10;
	}
	light.diffuse = Color3.White();
	light.intensity = 3;
	let texture: RawTexture | RawCubeTexture;
	if (kind === "point-cube") {
		const face = new Uint8Array(4 * 4 * 4);
		for (let offset = 0; offset < face.length; offset += 4) {
			face[offset] = color[0];
			face[offset + 1] = color[1];
			face[offset + 2] = color[2];
			face[offset + 3] = 255;
		}
		texture = new RawCubeTexture(
			scene,
			Array.from({ length: 6 }, () => face),
			4,
			Constants.TEXTUREFORMAT_RGBA,
			Constants.TEXTURETYPE_UNSIGNED_BYTE,
			false,
			false,
			Texture.NEAREST_SAMPLINGMODE
		);
	} else {
		texture = RawTexture.CreateRGBATexture(new Uint8Array([...color, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	}
	texture.name = `Deferred GPU ${kind} Cookie Texture`;
	texture.gammaSpace = false;
	setLightCookie(light, texture, { intensity: 1, size: [4, 4], near: 0.01, far: 10 });
	const configured = configureDeferredLighting(scene, camera);
	if (!configured.active) {
		throw new Error(`Deferred ${kind} cookie configuration failed: ${configured.errors.join(" ")}`);
	}
	await renderUntil(scene, () => {
		const runtime = getDeferredLightingRuntime(scene);
		return runtime.ready && runtime.cookieReady && runtime.cookieCount === 1 && runtime.cookieFrameCount >= 4;
	});
	const pixel = (await samplePixels(scene, presentation, [160]))[0];
	const runtime = structuredClone(getDeferredLightingRuntime(scene));
	setLightCookie(light, texture, { intensity: 0.5 });
	const invalidated = structuredClone(getDeferredLightingRuntime(scene));
	setLightCookie(light, texture, { intensity: 1, size: [4, 4], near: 0.01, far: 10, revision: 1 });
	const recoveryFrame = runtime.cookieFrameCount + 2;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).cookieFrameCount >= recoveryFrame);
	const recovered = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	mesh.dispose(false, false);
	light.dispose();
	if (kind !== "spot-2d") {
		texture.dispose();
	}
	material.dispose(false, false);
	meshStates.forEach(([existingMesh, enabled]) => existingMesh.setEnabled(enabled));
	lightStates.forEach(([existingLight, enabled]) => existingLight.setEnabled(enabled));
	return { kind, pixel, runtime, invalidated, recovered };
}

async function exerciseDeferredAreaLight(
	scene: Scene,
	camera: FreeCamera,
	presentation: RenderTargetTexture,
	shape: "rectangle" | "disc",
	color: Color3
): Promise<{
	shape: typeof shape;
	nativePixel: number[];
	pixel: number[];
	runtime: ReturnType<typeof getDeferredLightingRuntime>;
	invalidated: ReturnType<typeof getDeferredLightingRuntime>;
	recovered: ReturnType<typeof getDeferredLightingRuntime>;
}> {
	stopDeferredLighting(scene);
	const meshStates = scene.meshes.map((mesh) => [mesh, mesh.isEnabled()] as const);
	const lightStates = scene.lights.map((light) => [light, light.isEnabled()] as const);
	meshStates.forEach(([mesh]) => mesh.setEnabled(false));
	lightStates.forEach(([light]) => light.setEnabled(false));
	const material = new PBRMaterial(`Deferred GPU ${shape} Area Material`, scene);
	material.albedoColor = Color3.White();
	material.metallic = 0;
	material.roughness = 0.5;
	const mesh = CreateBox(`Deferred GPU ${shape} Area Receiver`, { size: 2 }, scene);
	mesh.material = material;
	const light = createAreaLight(`Deferred GPU ${shape} Area`, new Vector3(0, 0, -3), shape, scene, {
		width: 4,
		height: 4,
		radius: 2,
		direction: [0, 0, 1],
		upDirection: [0, 1, 0],
	});
	light.diffuse = color;
	light.specular = color;
	light.intensity = 8;
	light.range = 12;
	await renderUntil(
		scene,
		() => {
			const textures = (scene as Scene & { _ltcTextures?: { LTC1: { isReadyOrNotBlocking: () => boolean }; LTC2: { isReadyOrNotBlocking: () => boolean } } })._ltcTextures;
			return Boolean(material.isReady(mesh) && textures?.LTC1.isReadyOrNotBlocking() && textures.LTC2.isReadyOrNotBlocking());
		},
		240
	);
	const nativePixel = (await samplePixels(scene, presentation, [160]))[0];
	const configured = configureDeferredLighting(scene, camera);
	if (!configured.active) {
		throw new Error(`Deferred ${shape} area-light configuration failed: ${configured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.areaLightReady && runtime.areaLightCount === 1 && runtime.areaLightFrameCount >= 4;
		},
		240
	);
	const pixel = (await samplePixels(scene, presentation, [160]))[0];
	const runtime = structuredClone(getDeferredLightingRuntime(scene));
	setAreaLightProperties(light, shape === "disc" ? { radius: 2.5 } : { width: 5 });
	const invalidated = structuredClone(getDeferredLightingRuntime(scene));
	setAreaLightProperties(light, shape === "disc" ? { radius: 2, revision: 1 } : { width: 4, revision: 1 });
	const recoveryFrame = runtime.areaLightFrameCount + 2;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).areaLightFrameCount >= recoveryFrame);
	const recovered = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	mesh.dispose(false, false);
	light.dispose();
	material.dispose(false, false);
	meshStates.forEach(([existingMesh, enabled]) => existingMesh.setEnabled(enabled));
	lightStates.forEach(([existingLight, enabled]) => existingLight.setEnabled(enabled));
	return { shape, nativePixel, pixel, runtime, invalidated, recovered };
}

async function run(): Promise<void> {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 180;
	document.body.appendChild(canvas);
	const engine = await createEngine(canvas);
	if (!engine) {
		document.body.dataset.result = "unavailable";
		document.body.dataset.details = JSON.stringify({ target: __DEFERRED_LIGHTING_TARGET__, navigatorGpu: Boolean((navigator as unknown as { gpu?: unknown }).gpu) });
		return;
	}
	const scene = new Scene(engine);
	scene.clearColor = new Color4(0.01, 0.015, 0.025, 1);
	scene.ambientColor = Color3.Black();
	const camera = new FreeCamera("Deferred GPU Camera", new Vector3(0, 0, -6), scene);
	camera.setTarget(Vector3.Zero());
	camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
	camera.orthoLeft = -6;
	camera.orthoRight = 6;
	camera.orthoTop = 2;
	camera.orthoBottom = -2;
	const presentation = new RenderTargetTexture("Deferred GPU Presentation", { width: 320, height: 180 }, scene, {
		generateMipMaps: false,
		doNotChangeAspectRatio: true,
		generateDepthBuffer: true,
	});
	camera.outputRenderTarget = presentation;
	scene.activeCamera = camera;
	const standard = new StandardMaterial("Deferred GPU Standard", scene);
	standard.disableLighting = true;
	standard.diffuseColor = Color3.White();
	const pbr = new PBRMaterial("Deferred GPU PBR", scene);
	pbr.albedoColor = Color3.White();
	pbr.metallic = 0;
	pbr.roughness = 0.5;
	const metallicRoughness = new PBRMetallicRoughnessMaterial("Deferred GPU Metallic Roughness", scene);
	metallicRoughness.baseColor = Color3.White();
	metallicRoughness.metallic = 0;
	metallicRoughness.roughness = 0.5;
	const specularGlossiness = new PBRSpecularGlossinessMaterial("Deferred GPU Specular Glossiness", scene);
	specularGlossiness.diffuseColor = Color3.White();
	specularGlossiness.specularColor = new Color3(0.04, 0.04, 0.04);
	specularGlossiness.glossiness = 0.5;
	const openPbr = new OpenPBRMaterial("Deferred GPU OpenPBR", scene);
	openPbr.baseColor = Color3.White();
	const materials = [standard, pbr, metallicRoughness, specularGlossiness, openPbr];
	const positions = [-4, -2, 0, 2, 4];
	for (let index = 0; index < materials.length; index++) {
		const box = CreateBox(`Deferred GPU Box ${index}`, { size: 1.25 }, scene);
		box.position.x = positions[index];
		box.material = materials[index];
	}
	const light = new PointLight("Deferred GPU Point", new Vector3(0, 2, -3), scene);
	light.diffuse = new Color3(1, 0.02, 0.01);
	light.intensity = 3;
	light.range = 20;

	const configured = configureDeferredLighting(scene, camera);
	if (!configured.active) {
		throw new Error(`Deferred lighting configuration failed: ${configured.errors.join(" ")}`);
	}
	const readinessFrames = await renderUntil(scene, () => {
		const runtime = getDeferredLightingRuntime(scene);
		return runtime.ready && runtime.frameCount >= 2;
	});
	const sampleX = [53, 107, 160, 213, 267];
	const redPixels = await samplePixels(scene, presentation, sampleX);
	light.diffuse = new Color3(0.01, 1, 0.02);
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).frameCount >= 5);
	const greenPixels = await samplePixels(scene, presentation, sampleX);
	light.setEnabled(false);
	const directional = new DirectionalLight("Deferred GPU Directional", new Vector3(0, 0, 1), scene);
	directional.diffuse = new Color3(1, 0.01, 0.01);
	directional.intensity = 2;
	let targetFrame = getDeferredLightingRuntime(scene).frameCount + 2;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).frameCount >= targetFrame);
	const directionalPixel = (await samplePixels(scene, presentation, [160]))[0];
	directional.setEnabled(false);
	const spot = new SpotLight("Deferred GPU Spot", new Vector3(0, 0, -3), new Vector3(0, 0, 1), Math.PI / 2, 2, scene);
	spot.diffuse = new Color3(0.01, 1, 0.01);
	spot.intensity = 3;
	spot.range = 20;
	targetFrame = getDeferredLightingRuntime(scene).frameCount + 2;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).frameCount >= targetFrame);
	const spotPixel = (await samplePixels(scene, presentation, [160]))[0];
	spot.setEnabled(false);
	const hemispheric = new HemisphericLight("Deferred GPU Hemispheric", new Vector3(0, 0, -1), scene);
	hemispheric.diffuse = new Color3(0.01, 0.02, 1);
	hemispheric.groundColor = Color3.Black();
	hemispheric.intensity = 2;
	targetFrame = getDeferredLightingRuntime(scene).frameCount + 2;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).frameCount >= targetFrame);
	const hemisphericPixel = (await samplePixels(scene, presentation, [160]))[0];

	const whitePixel = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	const backgroundLayer = new Layer("Deferred GPU Forward Background Layer", null, scene, true, new Color4(0.01, 0.02, 0.8, 1));
	backgroundLayer.texture = whitePixel;
	const transparentMaterial = new StandardMaterial("Deferred GPU Forward Transparent", scene);
	transparentMaterial.disableLighting = true;
	transparentMaterial.emissiveColor = new Color3(1, 0, 0);
	transparentMaterial.alpha = 0.5;
	const transparent = CreateBox("Deferred GPU Forward Transparent", { size: 1 }, scene);
	transparent.position = new Vector3(0, 0, -1);
	transparent.material = transparentMaterial;
	const laterMaterial = new StandardMaterial("Deferred GPU Forward Later Group", scene);
	laterMaterial.disableLighting = true;
	laterMaterial.emissiveColor = new Color3(0, 1, 0);
	const later = CreateBox("Deferred GPU Forward Later Group", { size: 1 }, scene);
	later.position.x = -5;
	later.renderingGroupId = 1;
	later.material = laterMaterial;
	const spriteManager = new SpriteManager("Deferred GPU Forward Sprites", "", 1, 1, scene);
	spriteManager.texture = whitePixel;
	const sprite = new Sprite("Deferred GPU Forward Sprite", spriteManager);
	sprite.position = new Vector3(-3.5, 0, -1);
	sprite.width = 1;
	sprite.height = 1;
	sprite.color = new Color4(1, 0, 0, 1);
	const particles = new ParticleSystem("Deferred GPU Forward Particles", 4, scene);
	particles.particleTexture = whitePixel;
	particles.emitter = new Vector3(3.5, 0, -1);
	particles.createPointEmitter(Vector3.Zero(), Vector3.Zero());
	particles.minSize = 1;
	particles.maxSize = 1;
	particles.minLifeTime = 100;
	particles.maxLifeTime = 100;
	particles.emitRate = 0;
	particles.manualEmitCount = 1;
	particles.color1 = new Color4(1, 1, 0, 1);
	particles.color2 = new Color4(1, 1, 0, 1);
	particles.colorDead = new Color4(1, 1, 0, 1);
	particles.start();
	const runtimeBeforeHybrid = getDeferredLightingRuntime(scene);
	targetFrame = runtimeBeforeHybrid.frameCount + 6;
	const targetForwardCompositionFrame = runtimeBeforeHybrid.forwardCompositionFrameCount + 6;
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return (
				runtime.frameCount >= targetFrame &&
				runtime.compositionMode === "hybrid-forward" &&
				runtime.forwardCompositionFrameCount >= targetForwardCompositionFrame &&
				runtime.forwardMeshCount === 2 &&
				runtime.transparentMeshCount === 1 &&
				runtime.laterRenderingGroupMeshCount === 1 &&
				runtime.particleSystemCount === 1 &&
				runtime.spriteManagerCount === 1 &&
				runtime.layerCount === 1
			);
		},
		180
	);
	const backgroundPixel = (await samplePixels(scene, presentation, [10], 10))[0];
	const hybridPixels = await samplePixels(scene, presentation, [27, 67, 160, 253]);
	const laterGroupPixel = hybridPixels[0];
	const spritePixel = hybridPixels[1];
	const transparentPixel = hybridPixels[2];
	const particlePixel = hybridPixels[3];
	const active = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	for (const mesh of scene.meshes) {
		mesh.setEnabled(false);
	}
	for (const sceneLight of scene.lights) {
		sceneLight.setEnabled(false);
	}
	backgroundLayer.isEnabled = false;
	const shadowMaterial = new StandardMaterial("Deferred GPU Shadow Receiver Material", scene);
	shadowMaterial.diffuseColor = Color3.White();
	shadowMaterial.specularColor = Color3.Black();
	const shadowReceiver = CreateBox("Deferred GPU Shadow Receiver", { width: 6, height: 3, depth: 0.1 }, scene);
	shadowReceiver.position.z = 1;
	shadowReceiver.material = shadowMaterial;
	shadowReceiver.receiveShadows = true;
	const shadowCaster = CreateBox("Deferred GPU Shadow Caster", { size: 0.8 }, scene);
	shadowCaster.position = new Vector3(-1, 0, 0);
	shadowCaster.material = shadowMaterial;
	const shadowLight = new DirectionalLight("Deferred GPU Shadow Directional", new Vector3(0.5, 0, 1), scene);
	shadowLight.diffuse = Color3.White();
	shadowLight.intensity = 2;
	shadowLight.shadowMinZ = 0;
	shadowLight.shadowMaxZ = 10;
	const shadowGenerator = new ShadowGenerator(512, shadowLight, true);
	shadowGenerator.usePercentageCloserFiltering = true;
	shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
	shadowGenerator.setDarkness(0.05);
	shadowGenerator.getShadowMap()!.renderList = [shadowCaster];
	let nativeShadowFrames = 0;
	await renderUntil(scene, () => ++nativeShadowFrames >= 5, 30);
	const nativeShadowPixels = await samplePixels(scene, presentation, [120, 135, 150, 180, 220]);
	const shadowConfigured = configureDeferredLighting(scene, camera);
	if (!shadowConfigured.active) {
		throw new Error(`Deferred shadow configuration failed: ${shadowConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.shadowMapReady && runtime.shadowFrameCount >= 4;
		},
		180
	);
	const shadowPixels = await samplePixels(scene, presentation, [120, 135, 150, 180, 220]);
	const shadowMatrix = shadowGenerator.getTransformMatrix();
	const shadowProjection = [new Vector3(-1.5, 0, 0.95), new Vector3(-1, 0, 0.95), new Vector3(-0.5, 0, 0.95), new Vector3(0, 0, 0.95)].map((position) =>
		Vector3.TransformCoordinates(position, shadowMatrix).asArray()
	);
	const shadowActive = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	const classicFilterEvidence: Array<{ filter: string; runtime: ReturnType<typeof getDeferredLightingRuntime>; pixels: number[][] }> = [];
	for (const [filter, expectedFilter] of [
		[ShadowGenerator.FILTER_NONE, "hard"],
		[ShadowGenerator.FILTER_POISSONSAMPLING, "poisson"],
		[ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP, "esm"],
		[ShadowGenerator.FILTER_BLUREXPONENTIALSHADOWMAP, "blur-esm"],
		[ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP, "close-esm"],
		[ShadowGenerator.FILTER_BLURCLOSEEXPONENTIALSHADOWMAP, "blur-close-esm"],
		[ShadowGenerator.FILTER_PCSS, "pcss"],
	] as const) {
		shadowGenerator.filter = filter;
		shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
		shadowGenerator.blurScale = 2;
		shadowGenerator.blurKernel = 8;
		shadowGenerator.contactHardeningLightSizeUVRatio = 0.1;
		const evidence = await exerciseDeferredShadowFilter(scene, camera, presentation, expectedFilter, "2d", 0, [120, 135, 150, 180, 220]);
		classicFilterEvidence.push({ filter: expectedFilter, ...evidence });
	}
	shadowGenerator.dispose();
	shadowLight.dispose();

	const pointShadowLight = new PointLight("Deferred GPU Point Cube Shadow", new Vector3(0, 0, -2), scene);
	pointShadowLight.diffuse = Color3.White();
	pointShadowLight.intensity = 4;
	pointShadowLight.range = 20;
	pointShadowLight.shadowMinZ = 0.1;
	pointShadowLight.shadowMaxZ = 10;
	const pointShadowGenerator = new ShadowGenerator(512, pointShadowLight, true);
	pointShadowGenerator.filter = ShadowGenerator.FILTER_NONE;
	pointShadowGenerator.setDarkness(0.05);
	pointShadowGenerator.getShadowMap()!.renderList = [shadowCaster];
	if (pointShadowLight.getShadowGenerator() !== pointShadowGenerator) {
		throw new Error("Point light did not retain its default cube shadow generator.");
	}
	let nativePointShadowFrames = 0;
	await renderUntil(scene, () => ++nativePointShadowFrames >= 5, 30);
	if (pointShadowLight.getShadowGenerator() !== pointShadowGenerator) {
		throw new Error("Point light lost its default cube shadow generator during native-forward rendering.");
	}
	const nativePointShadowPixels = await samplePixels(scene, presentation, [105, 120, 135, 165, 195]);
	const pointShadowConfigured = configureDeferredLighting(scene, camera);
	if (!pointShadowConfigured.active) {
		throw new Error(`Deferred point-cube shadow configuration failed: ${pointShadowConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.shadowMapReady && runtime.shadowMapType === "cube" && runtime.shadowFrameCount >= 4;
		},
		180
	);
	const pointShadowPixels = await samplePixels(scene, presentation, [105, 120, 135, 165, 195]);
	const pointShadowActive = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	const pointFilterEvidence: Array<{ filter: string; runtime: ReturnType<typeof getDeferredLightingRuntime>; pixels: number[][] }> = [];
	for (const [filter, expectedFilter] of [
		[ShadowGenerator.FILTER_POISSONSAMPLING, "poisson"],
		[ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP, "esm"],
		[ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP, "close-esm"],
	] as const) {
		pointShadowGenerator.filter = filter;
		pointShadowGenerator.blurScale = 2;
		const evidence = await exerciseDeferredShadowFilter(scene, camera, presentation, expectedFilter, "cube", 0, [105, 120, 135, 165, 195]);
		pointFilterEvidence.push({ filter: expectedFilter, ...evidence });
	}
	pointShadowGenerator.dispose();
	pointShadowLight.dispose();

	const previousCameraMinZ = camera.minZ;
	const previousCameraMaxZ = camera.maxZ;
	camera.minZ = 0.1;
	camera.maxZ = 20;
	const cascadedShadowLight = new DirectionalLight("Deferred GPU Cascaded Shadow", new Vector3(0.5, 0, 1), scene);
	cascadedShadowLight.diffuse = Color3.White();
	cascadedShadowLight.intensity = 2;
	const cascadedShadowGenerator = new CascadedShadowGenerator(512, cascadedShadowLight, true, camera);
	cascadedShadowGenerator.numCascades = 4;
	cascadedShadowGenerator.filter = ShadowGenerator.FILTER_PCF;
	cascadedShadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
	cascadedShadowGenerator.cascadeBlendPercentage = 0.1;
	cascadedShadowGenerator.shadowMaxZ = 20;
	cascadedShadowGenerator.setMinMaxDistance(0, 1);
	cascadedShadowGenerator.setDarkness(0.05);
	cascadedShadowGenerator.getShadowMap()!.renderList = [shadowCaster];
	let nativeCascadedShadowPixels: number[][] = [];
	if (__DEFERRED_LIGHTING_TARGET__ === "webgl2") {
		let nativeCascadedShadowFrames = 0;
		await renderUntil(scene, () => ++nativeCascadedShadowFrames >= 5, 30);
		nativeCascadedShadowPixels = await samplePixels(scene, presentation, [120, 135, 150, 180, 220]);
	}
	const cascadedShadowConfigured = configureDeferredLighting(scene, camera);
	if (!cascadedShadowConfigured.active) {
		throw new Error(`Deferred cascaded shadow configuration failed: ${cascadedShadowConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.shadowMapReady && runtime.shadowMapType === "2d-array" && runtime.shadowCascadeCount === 4 && runtime.shadowFrameCount >= 4;
		},
		180
	);
	const cascadedShadowPixels = await samplePixels(scene, presentation, [120, 135, 150, 180, 220]);
	const cascadedShadowActive = structuredClone(getDeferredLightingRuntime(scene));
	const cascadedInternals = cascadedShadowGenerator as unknown as { _viewSpaceFrustumsZ: number[]; _frustumLengths: number[] };
	const cascadedShadowEvidence = {
		viewSpaceFrustumsZ: [...cascadedInternals._viewSpaceFrustumsZ],
		frustumLengths: [...cascadedInternals._frustumLengths],
		viewPosition: Vector3.TransformCoordinates(new Vector3(-1, 0, 0.95), camera.getViewMatrix()).asArray(),
		projections: Array.from({ length: cascadedShadowGenerator.numCascades }, (_, index) =>
			Vector3.TransformCoordinates(new Vector3(-1, 0, 0.95), cascadedShadowGenerator.getCascadeTransformMatrix(index)!).asArray()
		),
	};
	stopDeferredLighting(scene);
	const cascadedFilterEvidence: Array<{ filter: string; runtime: ReturnType<typeof getDeferredLightingRuntime>; pixels: number[][] }> = [];
	for (const [filter, expectedFilter] of [
		[ShadowGenerator.FILTER_NONE, "hard"],
		[ShadowGenerator.FILTER_PCSS, "pcss"],
	] as const) {
		cascadedShadowGenerator.filter = filter;
		cascadedShadowGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
		cascadedShadowGenerator.contactHardeningLightSizeUVRatio = 0.1;
		const evidence = await exerciseDeferredShadowFilter(scene, camera, presentation, expectedFilter, "2d-array", 4, [120, 135, 150, 180, 220]);
		cascadedFilterEvidence.push({ filter: expectedFilter, ...evidence });
	}
	cascadedShadowGenerator.dispose();
	cascadedShadowLight.dispose();
	camera.minZ = previousCameraMinZ;
	camera.maxZ = previousCameraMaxZ;
	const multiPointLight = new PointLight("Deferred GPU Multi Point Shadow", new Vector3(-2.5, 1, -3), scene);
	const multiPointLightId = multiPointLight.id;
	multiPointLight.diffuse = Color3.White();
	multiPointLight.intensity = 0.5;
	multiPointLight.range = 20;
	multiPointLight.shadowMinZ = 0.1;
	multiPointLight.shadowMaxZ = 12;
	const multiPointGenerator = new ShadowGenerator(512, multiPointLight, true);
	multiPointGenerator.filter = ShadowGenerator.FILTER_POISSONSAMPLING;
	multiPointGenerator.blurScale = 2;
	multiPointGenerator.setDarkness(0.05);
	multiPointGenerator.getShadowMap()!.renderList = [shadowCaster];
	const multiSpotLight = new SpotLight("Deferred GPU Multi Spot Shadow", new Vector3(2.5, 1, -3), new Vector3(-2.5, -1, 4), Math.PI / 2, 2, scene);
	const multiSpotLightId = multiSpotLight.id;
	multiSpotLight.diffuse = Color3.White();
	multiSpotLight.intensity = 0.75;
	multiSpotLight.range = 20;
	multiSpotLight.shadowMinZ = 0.1;
	multiSpotLight.shadowMaxZ = 12;
	const multiSpotGenerator = new ShadowGenerator(512, multiSpotLight, true);
	multiSpotGenerator.filter = ShadowGenerator.FILTER_PCF;
	multiSpotGenerator.filteringQuality = ShadowGenerator.QUALITY_LOW;
	multiSpotGenerator.setDarkness(0.05);
	multiSpotGenerator.getShadowMap()!.renderList = [shadowCaster];
	consumeWebGLErrors(engine);
	for (let frame = 0; frame < 6; frame++) {
		engine.beginFrame();
		multiPointGenerator.getShadowMap()!.render(true);
		multiSpotGenerator.getShadowMap()!.render(true);
		engine.endFrame();
		await delay();
	}
	const multiShadowWarmupErrors = consumeWebGLErrors(engine);
	const multiShadowConfigured = configureDeferredLighting(scene, camera);
	if (!multiShadowConfigured.active) {
		throw new Error(`Deferred multiple-shadow configuration failed: ${multiShadowConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.shadowMapReady && runtime.shadowLightCount === 2 && runtime.shadowSources.length === 2 && runtime.shadowFrameCount >= 4;
		},
		240
	);
	const multiShadowPixels = await samplePixels(scene, presentation, [90, 110, 130, 150, 170, 190, 210, 230]);
	const multiShadowResolveErrors = consumeWebGLErrors(engine);
	const multiShadowActive = structuredClone(getDeferredLightingRuntime(scene));
	const multiShadowTextureState = {
		pointDepthStencilTexture: Boolean(multiPointGenerator.getShadowMapForRendering()?.depthStencilTexture),
		spotDepthStencilTexture: Boolean(multiSpotGenerator.getShadowMapForRendering()?.depthStencilTexture),
		pointCube: Boolean(multiPointGenerator.getShadowMapForRendering()?.isCube),
		spotCube: Boolean(multiSpotGenerator.getShadowMapForRendering()?.isCube),
	};
	multiSpotLight.shadowEnabled = false;
	const multiShadowInvalidated = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	multiSpotGenerator.dispose();
	multiSpotLight.dispose();
	const pointOnlyConfigured = configureDeferredLighting(scene, camera);
	if (!pointOnlyConfigured.active) {
		throw new Error(`Deferred point-only recovery failed: ${pointOnlyConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.shadowMapReady && runtime.shadowLightCount === 1 && runtime.shadowFrameCount >= 4;
		},
		180
	);
	const pointOnlyShadowPixels = await samplePixels(scene, presentation, [90, 110, 130, 150, 170, 190, 210, 230]);
	const pointOnlyShadowResolveErrors = consumeWebGLErrors(engine);
	const pointOnlyShadowActive = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	multiPointGenerator.dispose();
	multiPointLight.dispose();
	for (const mesh of scene.meshes) {
		mesh.receiveShadows = false;
	}
	const enabledMeshStates = scene.meshes.map((mesh) => [mesh, mesh.isEnabled()] as const);
	for (const [mesh] of enabledMeshStates) {
		mesh.setEnabled(false);
	}
	for (const sceneLight of scene.lights) {
		sceneLight.setEnabled(false);
	}
	const previousCameraLayerMask = camera.layerMask;
	camera.layerMask = 0xffffffff;
	const greenFace = new Uint8Array(4 * 4 * 4);
	for (let offset = 0; offset < greenFace.length; offset += 4) {
		greenFace[offset] = 4;
		greenFace[offset + 1] = 255;
		greenFace[offset + 2] = 8;
		greenFace[offset + 3] = 255;
	}
	const environmentCube = new RawCubeTexture(
		scene,
		Array.from({ length: 6 }, () => greenFace),
		4,
		Constants.TEXTUREFORMAT_RGBA,
		Constants.TEXTURETYPE_UNSIGNED_BYTE,
		true,
		false,
		Texture.TRILINEAR_SAMPLINGMODE
	);
	environmentCube.name = "Deferred GPU Green Environment";
	environmentCube.gammaSpace = false;
	scene.environmentTexture = environmentCube;
	scene.iblIntensity = 1;
	const environmentMaterial = new PBRMaterial("Deferred GPU Environment IBL", scene);
	environmentMaterial.albedoColor = Color3.White();
	environmentMaterial.metallic = 1;
	environmentMaterial.roughness = 0.15;
	const environmentBox = CreateBox("Deferred GPU Environment IBL Box", { size: 1.5 }, scene);
	environmentBox.position.x = -1.5;
	environmentBox.layerMask = 0x80000000;
	environmentBox.material = environmentMaterial;
	const localProbe = new ReflectionProbe("Deferred GPU Local Probe", 32, scene, true, false, true);
	localProbe.position.set(1.5, 0, -1);
	localProbe.renderList = [];
	localProbe.cubeTexture.clearColor = new Color4(0.02, 0.04, 1, 1);
	localProbe.cubeTexture.boundingBoxPosition = new Vector3(1.5, 0, 0);
	localProbe.cubeTexture.boundingBoxSize = new Vector3(4, 4, 4);
	localProbe.metadata = {
		babylonEditorReflectionProbe: {
			version: 2,
			id: "gpu-local-probe",
			revision: 1,
			intensity: 1,
			boxProjection: true,
			influencePosition: [1.5, 0, 0],
			influenceSize: [4, 4, 4],
			importance: 1,
			blendDistance: 0,
			assignedMaterialIds: [],
		},
	};
	const redProbe = new ReflectionProbe("Deferred GPU Red Probe", 32, scene, true, false, true);
	const redFace = new Uint8Array(4 * 4 * 4);
	for (let offset = 0; offset < redFace.length; offset += 4) {
		redFace[offset] = 255;
		redFace[offset + 1] = 4;
		redFace[offset + 2] = 8;
		redFace[offset + 3] = 255;
	}
	const redRenderTarget = redProbe.cubeTexture;
	(redProbe as unknown as { _renderTargetTexture: RawCubeTexture })._renderTargetTexture = new RawCubeTexture(
		scene,
		Array.from({ length: 6 }, () => redFace),
		4,
		Constants.TEXTUREFORMAT_RGBA,
		Constants.TEXTURETYPE_UNSIGNED_BYTE,
		true,
		false,
		Texture.TRILINEAR_SAMPLINGMODE
	);
	redRenderTarget.dispose();
	redProbe.cubeTexture.name = redProbe.name;
	redProbe.cubeTexture.gammaSpace = false;
	redProbe.position.set(1.5, 0, -1);
	redProbe.cubeTexture.boundingBoxPosition = new Vector3(1.5, 0, 0);
	redProbe.cubeTexture.boundingBoxSize = new Vector3(4, 4, 4);
	redProbe.metadata = {
		babylonEditorReflectionProbe: {
			version: 2,
			id: "gpu-red-probe",
			revision: 1,
			intensity: 1,
			boxProjection: true,
			influencePosition: [1.5, 0, 0],
			influenceSize: [4, 4, 4],
			importance: 1,
			blendDistance: 0,
			assignedMaterialIds: [],
		},
	};
	const probeMaterial = new PBRMaterial("Deferred GPU Probe IBL", scene);
	probeMaterial.albedoColor = Color3.White();
	probeMaterial.metallic = 1;
	probeMaterial.roughness = 0.15;
	probeMaterial.reflectionTexture = localProbe.cubeTexture;
	localProbe.metadata.babylonEditorReflectionProbe.assignedMaterialIds = [probeMaterial.id];
	redProbe.metadata.babylonEditorReflectionProbe.assignedMaterialIds = [probeMaterial.id];
	const probeBox = CreateBox("Deferred GPU Probe IBL Box", { size: 1.5 }, scene);
	probeBox.position.x = 1.5;
	probeBox.layerMask = 1;
	probeBox.material = probeMaterial;
	const iblProjectorNormal = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 255, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	iblProjectorNormal.name = "Deferred GPU IBL Projector Normal";
	const iblProjectorReflectivity = RawTexture.CreateRGBATexture(new Uint8Array([160, 0, 0, 220]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	iblProjectorReflectivity.name = "Deferred GPU IBL Projector Reflectivity";
	const iblProjectorAo = RawTexture.CreateRGBATexture(new Uint8Array([230, 0, 0, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	iblProjectorAo.name = "Deferred GPU IBL Projector AO";
	const iblProjectorMaterial = new StandardMaterial("Deferred GPU IBL Projector Material", scene);
	iblProjectorMaterial.diffuseColor = Color3.White();
	iblProjectorMaterial.bumpTexture = iblProjectorNormal;
	iblProjectorMaterial.specularTexture = iblProjectorReflectivity;
	iblProjectorMaterial.ambientTexture = iblProjectorAo;
	const iblProjector = CreateBox("Deferred GPU IBL Layer Projector", { size: 1 }, scene);
	iblProjector.position.set(-1.5, 0, 0);
	iblProjector.scaling.set(2, 2, 2);
	iblProjector.material = iblProjectorMaterial;
	iblProjector.isVisible = false;
	iblProjector.metadata = {
		decal: {
			version: 3,
			revision: 1,
			projectionMode: "screen-space-volume",
			sizeX: 2,
			sizeY: 2,
			sizeZ: 2,
			edgeFade: 0,
			uvScale: [1, 1],
			uvOffset: [0, 0],
			channels: { albedo: false, normal: true, metallic: true, ambientOcclusion: true, emissive: false },
			normalStrength: 1,
			metallic: 0.5,
			smoothness: 0.85,
			ambientOcclusion: 0.9,
			emissiveIntensity: 1,
			decalLayerMask: 0x80000000,
		},
	};
	iblProjector.computeWorldMatrix(true);
	let nativeIblFrames = 0;
	await renderUntil(scene, () => ++nativeIblFrames >= 4, 60);
	const iblConfigured = configureDeferredLighting(scene, camera);
	if (!iblConfigured.active) {
		throw new Error(`Deferred IBL configuration failed: ${iblConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.iblReady && runtime.iblSourceCount === 3 && runtime.iblReflectionProbeCount === 2 && runtime.iblFrameCount >= 4;
		},
		180
	);
	const iblSelectorTarget = scene.customRenderTargets.find((target) => target.name === "Babylon Editor Deferred IBL Selector");
	if (!iblSelectorTarget) {
		throw new Error("Deferred IBL selector target was not allocated.");
	}
	const iblSelectorPixels = await samplePixels(scene, iblSelectorTarget, [120, 200]);
	const iblPixels = await samplePixels(scene, presentation, [120, 200]);
	const iblActive = structuredClone(getDeferredLightingRuntime(scene));
	if (iblPixels.every((pixel) => pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0)) {
		throw new Error(`Deferred IBL produced black pixels: ${JSON.stringify({ iblSelectorPixels, iblPixels, iblActive })}`);
	}
	redProbe.metadata.babylonEditorReflectionProbe.importance = 2;
	redProbe.metadata.babylonEditorReflectionProbe.revision = 2;
	const iblPriorityInvalidated = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	const iblPriorityConfigured = configureDeferredLighting(scene, camera);
	if (!iblPriorityConfigured.active) {
		throw new Error(`Deferred priority-probe IBL configuration failed: ${iblPriorityConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.iblReady && runtime.iblSourceCount === 3 && runtime.iblReflectionProbeCount === 2 && runtime.iblFrameCount >= 4;
		},
		180
	);
	const iblPriorityPixels = await samplePixels(scene, presentation, [120, 200]);
	const iblPriorityActive = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	environmentBox.dispose();
	probeBox.dispose();
	environmentMaterial.dispose(true, false);
	probeMaterial.dispose(true, false);
	iblProjector.dispose(false, false);
	iblProjectorMaterial.dispose(false, false);
	iblProjectorNormal.dispose();
	iblProjectorReflectivity.dispose();
	iblProjectorAo.dispose();
	localProbe.dispose();
	redProbe.dispose();
	scene.environmentTexture = null;
	environmentCube.dispose();
	camera.layerMask = previousCameraLayerMask;
	const emissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([0, 255, 8, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	emissiveTexture.name = "Deferred GPU Emissive Green Texture";
	const emissiveStandard = new StandardMaterial("Deferred GPU Emissive Standard", scene);
	emissiveStandard.diffuseColor = Color3.Black();
	emissiveStandard.specularColor = Color3.Black();
	emissiveStandard.emissiveColor = new Color3(1, 0.01, 0.01);
	const emissivePbr = new PBRMaterial("Deferred GPU Emissive PBR", scene);
	emissivePbr.albedoColor = Color3.Black();
	emissivePbr.emissiveColor = Color3.White();
	emissivePbr.emissiveTexture = emissiveTexture;
	emissivePbr.emissiveIntensity = 2;
	const emissiveMetallicRoughness = new PBRMetallicRoughnessMaterial("Deferred GPU Emissive Metallic Roughness", scene);
	emissiveMetallicRoughness.baseColor = Color3.Black();
	emissiveMetallicRoughness.emissiveColor = new Color3(0.01, 0.01, 1);
	const emissiveSpecularGlossiness = new PBRSpecularGlossinessMaterial("Deferred GPU Emissive Specular Glossiness", scene);
	emissiveSpecularGlossiness.diffuseColor = Color3.Black();
	emissiveSpecularGlossiness.emissiveColor = new Color3(1, 1, 0.01);
	const emissiveOpenPbr = new OpenPBRMaterial("Deferred GPU Emissive OpenPBR", scene);
	emissiveOpenPbr.baseWeight = 0;
	emissiveOpenPbr.baseColor = Color3.Black();
	emissiveOpenPbr.emissionColor = new Color3(1, 0.01, 1);
	emissiveOpenPbr.emissionLuminance = 2;
	const emissiveMaterials = [emissiveStandard, emissivePbr, emissiveMetallicRoughness, emissiveSpecularGlossiness, emissiveOpenPbr];
	const emissiveMeshes = emissiveMaterials.map((material, index) => {
		const mesh = CreateBox(`Deferred GPU Emissive Box ${index}`, { size: 1.25 }, scene);
		mesh.position.x = positions[index];
		mesh.material = material;
		return mesh;
	});
	const emissiveControlMaterial = new StandardMaterial("Deferred GPU Non-emissive Control", scene);
	emissiveControlMaterial.disableLighting = true;
	emissiveControlMaterial.diffuseColor = Color3.Black();
	const emissiveControl = CreateBox("Deferred GPU Non-emissive Control", { size: 0.8 }, scene);
	emissiveControl.position.x = 5.35;
	emissiveControl.material = emissiveControlMaterial;
	const emissiveConfigured = configureDeferredLighting(scene, camera);
	if (!emissiveConfigured.active) {
		throw new Error(`Deferred emissive configuration failed: ${emissiveConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.emissiveReady && runtime.emissiveMaterialCount === 5 && runtime.emissiveFrameCount >= 4;
		},
		180
	);
	const emissiveTarget = scene.customRenderTargets.find((target) => target.name === "Babylon Editor Deferred Emissive");
	if (!emissiveTarget) {
		throw new Error("Deferred emissive target was not allocated.");
	}
	const emissivePixels = await samplePixels(scene, presentation, [...sampleX, 303]);
	const emissiveActive = structuredClone(getDeferredLightingRuntime(scene));
	emissiveStandard.emissiveColor.g = 0.5;
	const emissiveInvalidated = structuredClone(getDeferredLightingRuntime(scene));
	emissiveStandard.emissiveColor.g = 0.01;
	const emissiveRecovered = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	for (const mesh of [...emissiveMeshes, emissiveControl]) {
		mesh.dispose(false, false);
	}
	for (const material of [...emissiveMaterials, emissiveControlMaterial]) {
		material.dispose(false, false);
	}
	emissiveTexture.dispose();
	const decalReceiverMaterial = new StandardMaterial("Deferred GPU Decal Receiver", scene);
	decalReceiverMaterial.diffuseColor = new Color3(0.01, 0.05, 1);
	decalReceiverMaterial.specularColor = Color3.Black();
	const decalReceiver = CreateBox("Deferred GPU Decal Receiver", { width: 5, height: 3, depth: 0.5 }, scene);
	decalReceiver.material = decalReceiverMaterial;
	const decalMaterial = new StandardMaterial("Deferred GPU Alpha Decal", scene);
	decalMaterial.diffuseColor = new Color3(1, 0.01, 0.01);
	decalMaterial.specularColor = Color3.Black();
	decalMaterial.alpha = 0.5;
	decalMaterial.zOffset = -2;
	const decalPosition = new Vector3(0, 0, -0.25);
	const decalNormal = new Vector3(0, 0, -1);
	const decalSize = new Vector3(2, 2, 0.75);
	const decal = CreateDecal("Deferred GPU Projected Decal", decalReceiver, {
		localMode: true,
		position: decalPosition,
		normal: decalNormal,
		size: decalSize,
		angle: 0,
	});
	decal.material = decalMaterial;
	decal.alphaIndex = 7;
	decal.metadata = {
		decal: {
			version: 1,
			revision: 1,
			meshId: decalReceiver.id,
			position: decalPosition.asArray(),
			normal: decalNormal.asArray(),
			sizeX: decalSize.x,
			sizeY: decalSize.y,
			sizeZ: decalSize.z,
			angle: 0,
		},
	};
	const decalLight = new HemisphericLight("Deferred GPU Decal Light", new Vector3(0, 0, -1), scene);
	decalLight.diffuse = Color3.White();
	decalLight.groundColor = Color3.Black();
	decalLight.intensity = 1.5;
	const decalConfigured = configureDeferredLighting(scene, camera);
	if (!decalConfigured.active) {
		throw new Error(`Deferred decal configuration failed: ${decalConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return (
				runtime.ready &&
				runtime.decalReady &&
				runtime.decalCount === 1 &&
				runtime.decalFrameCount >= 4 &&
				runtime.decalForwardSubMeshSuppressedCount === 1 &&
				runtime.decalForwardSuppressionFrameCount >= 4
			);
		},
		180
	);
	const decalPixels = await samplePixels(scene, presentation, [120, 160, 200]);
	const decalActive = structuredClone(getDeferredLightingRuntime(scene));
	const decalSuppressionFramesBeforeInvalidation = decalActive.decalForwardSuppressionFrameCount;
	decal.metadata.decal.revision = 2;
	const decalInvalidated = structuredClone(getDeferredLightingRuntime(scene));
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).decalForwardSuppressionFrameCount === decalSuppressionFramesBeforeInvalidation, 2);
	decal.metadata.decal.revision = 1;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).decalForwardSuppressionFrameCount > decalSuppressionFramesBeforeInvalidation, 30);
	const decalRecovered = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	decal.dispose(false, false);
	decalReceiver.dispose(false, false);
	decalMaterial.dispose(false, false);
	decalReceiverMaterial.dispose(false, false);
	decalLight.dispose();
	const projectorReceiverMaterial = new StandardMaterial("Deferred GPU Projector Receiver", scene);
	projectorReceiverMaterial.diffuseColor = new Color3(0.01, 0.05, 1);
	projectorReceiverMaterial.specularColor = Color3.Black();
	const projectorReceiver = CreateBox("Deferred GPU Projector Receiver", { width: 5, height: 3, depth: 0.5 }, scene);
	projectorReceiver.material = projectorReceiverMaterial;
	projectorReceiver.layerMask = 2;
	const projectorTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 8, 8, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	projectorTexture.name = "Deferred GPU Projector Texture";
	projectorTexture.hasAlpha = true;
	const projectorNormalTexture = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 255, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	projectorNormalTexture.name = "Deferred GPU Projector Normal";
	const projectorReflectivityTexture = RawTexture.CreateRGBATexture(new Uint8Array([160, 0, 0, 210]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	projectorReflectivityTexture.name = "Deferred GPU Projector Reflectivity";
	const projectorAoTexture = RawTexture.CreateRGBATexture(new Uint8Array([220, 0, 0, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	projectorAoTexture.name = "Deferred GPU Projector AO";
	const projectorEmissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([96, 4, 4, 255]), 1, 1, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
	projectorEmissiveTexture.name = "Deferred GPU Projector Emissive";
	const projectorMaterial = new StandardMaterial("Deferred GPU Volume Projector Material", scene);
	projectorMaterial.diffuseColor = Color3.White();
	projectorMaterial.diffuseTexture = projectorTexture;
	projectorMaterial.bumpTexture = projectorNormalTexture;
	projectorMaterial.specularTexture = projectorReflectivityTexture;
	projectorMaterial.ambientTexture = projectorAoTexture;
	projectorMaterial.emissiveColor = new Color3(0.4, 0.01, 0.01);
	projectorMaterial.emissiveTexture = projectorEmissiveTexture;
	projectorMaterial.alpha = 0.85;
	const projector = CreateBox("Deferred GPU Screen-space Volume Projector", { size: 1 }, scene);
	projector.position.set(0, 0, -0.25);
	projector.scaling.set(2, 2.5, 1);
	projector.material = projectorMaterial;
	projector.isVisible = false;
	projector.isPickable = true;
	projector.alphaIndex = 11;
	projector.metadata = {
		decal: {
			version: 3,
			revision: 1,
			projectionMode: "screen-space-volume",
			sizeX: 2,
			sizeY: 2.5,
			sizeZ: 1,
			position: [0, 0, -0.25],
			rotation: [0, 0, 0],
			edgeFade: 0,
			uvScale: [1, 1],
			uvOffset: [0, 0],
			channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
			normalStrength: 1,
			metallic: 0.5,
			smoothness: 0.8,
			ambientOcclusion: 0.9,
			emissiveIntensity: 1.5,
			decalLayerMask: 2,
		},
	};
	projector.computeWorldMatrix(true);
	const projectorLight = new HemisphericLight("Deferred GPU Projector Light", new Vector3(0, 0, -1), scene);
	projectorLight.diffuse = Color3.White();
	projectorLight.groundColor = Color3.Black();
	projectorLight.intensity = 1.5;
	consumeWebGLErrors(engine);
	const projectorConfigured = configureDeferredLighting(scene, camera);
	if (!projectorConfigured.active) {
		throw new Error(`Deferred projector configuration failed: ${projectorConfigured.errors.join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const runtime = getDeferredLightingRuntime(scene);
			return runtime.ready && runtime.decalReady && runtime.decalProjectorCount === 1 && runtime.decalFrameCount >= 4;
		},
		180
	);
	const projectorPixels = await samplePixels(scene, presentation, [120, 160, 200]);
	const projectorDriverErrors = consumeWebGLErrors(engine);
	const projectorActive = structuredClone(getDeferredLightingRuntime(scene));
	projector.metadata.decal.edgeFade = 0.5;
	projector.metadata.decal.revision = 2;
	const projectorInvalidated = structuredClone(getDeferredLightingRuntime(scene));
	projector.metadata.decal.edgeFade = 0;
	projector.metadata.decal.revision = 1;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene).active && getDeferredLightingRuntime(scene).decalFrameCount > projectorActive.decalFrameCount, 30);
	const projectorRecovered = structuredClone(getDeferredLightingRuntime(scene));
	stopDeferredLighting(scene);
	projector.dispose(false, false);
	projectorReceiver.dispose(false, false);
	projectorMaterial.dispose(false, false);
	projectorReceiverMaterial.dispose(false, false);
	projectorTexture.dispose();
	projectorNormalTexture.dispose();
	projectorReflectivityTexture.dispose();
	projectorAoTexture.dispose();
	projectorEmissiveTexture.dispose();
	projectorLight.dispose();
	for (const [mesh, enabled] of enabledMeshStates) {
		mesh.setEnabled(enabled);
	}
	const cookieEvidence = [
		await exerciseDeferredCookie(scene, camera, presentation, "directional-2d", [255, 8, 8]),
		await exerciseDeferredCookie(scene, camera, presentation, "spot-2d", [8, 255, 8]),
		await exerciseDeferredCookie(scene, camera, presentation, "point-cube", [8, 8, 255]),
	];
	const areaLightEvidence = [
		await exerciseDeferredAreaLight(scene, camera, presentation, "rectangle", new Color3(1, 0.01, 0.01)),
		await exerciseDeferredAreaLight(scene, camera, presentation, "disc", new Color3(0.01, 0.02, 1)),
	];
	light.setEnabled(true);
	light.diffuse = new Color3(1, 0.02, 0.01);
	const secondaryCamera = new FreeCamera("Secondary Deferred GPU Camera", new Vector3(0, 0, -6), scene);
	secondaryCamera.setTarget(Vector3.Zero());
	secondaryCamera.mode = Camera.ORTHOGRAPHIC_CAMERA;
	secondaryCamera.orthoLeft = -6;
	secondaryCamera.orthoRight = 6;
	secondaryCamera.orthoTop = 2;
	secondaryCamera.orthoBottom = -2;
	const secondaryPresentation = new RenderTargetTexture("Secondary Deferred GPU Presentation", { width: 320, height: 180 }, scene, {
		generateMipMaps: false,
		doNotChangeAspectRatio: true,
		generateDepthBuffer: true,
	});
	secondaryCamera.outputRenderTarget = secondaryPresentation;
	const previousViewport = camera.viewport;
	camera.viewport = new Viewport(0, 0, 0.5, 1);
	secondaryCamera.viewport = new Viewport(0.5, 0, 0.5, 1);
	scene.activeCameras = [camera, secondaryCamera];
	const primaryMultiConfigured = configureDeferredLighting(scene, camera);
	const secondaryMultiConfigured = configureDeferredLighting(scene, secondaryCamera);
	if (!primaryMultiConfigured.active || !secondaryMultiConfigured.active) {
		throw new Error(`Multi-camera deferred configuration failed: ${[...primaryMultiConfigured.errors, ...secondaryMultiConfigured.errors].join(" ")}`);
	}
	await renderUntil(
		scene,
		() => {
			const primaryRuntime = getDeferredLightingRuntime(scene, camera);
			const secondaryRuntime = getDeferredLightingRuntime(scene, secondaryCamera);
			return primaryRuntime.ready && secondaryRuntime.ready && primaryRuntime.frameCount >= 3 && secondaryRuntime.frameCount >= 3;
		},
		180
	);
	const primaryMultiPixels = await samplePixels(scene, presentation, [80, 160, 240]);
	const secondaryMultiPixels = await samplePixels(scene, secondaryPresentation, [80, 160, 240]);
	const primaryMultiActive = structuredClone(getDeferredLightingRuntime(scene, camera));
	const secondaryMultiActive = structuredClone(getDeferredLightingRuntime(scene, secondaryCamera));
	stopDeferredLighting(scene, camera);
	const secondaryFrameBeforePrimaryStop = getDeferredLightingRuntime(scene, secondaryCamera).frameCount;
	await renderUntil(scene, () => getDeferredLightingRuntime(scene, secondaryCamera).frameCount >= secondaryFrameBeforePrimaryStop + 2, 120);
	const secondaryAfterPrimaryStop = structuredClone(getDeferredLightingRuntime(scene, secondaryCamera));
	secondaryCamera.dispose();
	scene.activeCameras = null;
	scene.activeCamera = camera;
	camera.viewport = previousViewport;
	const restored = structuredClone(getDeferredLightingRuntime(scene));
	const multiShadowChecks = {
		active: multiShadowActive.active,
		ready: multiShadowActive.ready,
		lightCount: multiShadowActive.shadowLightCount === 2,
		maximumSources: multiShadowActive.shadowMaximumSources === 8,
		mapCount: multiShadowActive.shadowMapCount === 7,
		samplerCount: multiShadowActive.shadowSamplerCount === 3,
		mapReady: multiShadowActive.shadowMapReady,
		casterCount: multiShadowActive.shadowCasterCount === 2,
		receiverCount: multiShadowActive.shadowReceiverCount === 1,
		pointSource: multiShadowActive.shadowSources.some(
			(source) => source.lightId === multiPointLightId && source.mapType === "cube" && source.filter === "poisson" && source.mapCount === 6
		),
		spotSource: multiShadowActive.shadowSources.some(
			(source) => source.lightId === multiSpotLightId && source.mapType === "2d" && source.filter === "pcf" && source.mapCount === 1
		),
		invalidated: !multiShadowInvalidated.active && multiShadowInvalidated.errors.some((error) => error.includes("shadow generator changed")),
		pointRecoveryActive: pointOnlyShadowActive.active,
		pointRecoveryReady: pointOnlyShadowActive.ready,
		pointRecoveryCount: pointOnlyShadowActive.shadowLightCount === 1,
		pointRecoverySource: pointOnlyShadowActive.shadowSources[0]?.lightId === multiPointLightId,
		driverErrors: multiShadowWarmupErrors.length === 0 && multiShadowResolveErrors.length === 0 && pointOnlyShadowResolveErrors.length === 0,
		outputChanged: multiShadowPixels.some(
			(pixel, index) =>
				Math.abs(pixel[0] - pointOnlyShadowPixels[index][0]) + Math.abs(pixel[1] - pointOnlyShadowPixels[index][1]) + Math.abs(pixel[2] - pointOnlyShadowPixels[index][2]) >
				5
		),
	};
	const passed =
		active.active &&
		active.ready &&
		active.frameCount >= 5 &&
		active.geometryBufferWidth === 320 &&
		active.geometryBufferHeight === 180 &&
		active.albedoWidth === 320 &&
		active.albedoHeight === 180 &&
		active.meshCount === 5 &&
		active.materialCount === 5 &&
		active.lightCount === 1 &&
		active.compositionMode === "hybrid-forward" &&
		active.forwardCompositionReady &&
		active.forwardMeshCount === 2 &&
		active.transparentMeshCount === 1 &&
		active.laterRenderingGroupMeshCount === 1 &&
		active.particleSystemCount === 1 &&
		active.spriteManagerCount === 1 &&
		active.layerCount === 1 &&
		redPixels.every((pixel) => pixel[0] > pixel[1] * 2 && pixel[0] > 30) &&
		greenPixels.every((pixel) => pixel[1] > pixel[0] * 2 && pixel[1] > 30) &&
		directionalPixel[0] > directionalPixel[1] * 2 &&
		directionalPixel[0] > 30 &&
		spotPixel[1] > spotPixel[0] * 2 &&
		spotPixel[1] > 30 &&
		hemisphericPixel[2] > hemisphericPixel[0] * 2 &&
		hemisphericPixel[2] > 30 &&
		backgroundPixel[2] > backgroundPixel[0] * 4 &&
		backgroundPixel[2] > 80 &&
		laterGroupPixel[1] > laterGroupPixel[0] * 3 &&
		laterGroupPixel[1] > 80 &&
		spritePixel[0] > spritePixel[1] * 3 &&
		spritePixel[0] > 80 &&
		transparentPixel[0] > 40 &&
		transparentPixel[2] > 40 &&
		particlePixel[0] > 80 &&
		particlePixel[1] > 80 &&
		shadowActive.active &&
		shadowActive.ready &&
		shadowActive.shadowLightCount === 1 &&
		shadowActive.shadowLightId === shadowLight.id &&
		shadowActive.shadowGeneratorType === "classic" &&
		shadowActive.shadowMapType === "2d" &&
		shadowActive.shadowFilter === "pcf" &&
		shadowActive.shadowCascadeCount === 0 &&
		shadowActive.shadowMapReady &&
		shadowActive.shadowMapWidth === 512 &&
		shadowActive.shadowMapHeight === 512 &&
		shadowActive.shadowCasterCount === 1 &&
		shadowActive.shadowReceiverCount === 1 &&
		shadowActive.shadowFrameCount >= 4 &&
		Math.min(...nativeShadowPixels.map((pixel) => pixel[0])) < Math.max(...nativeShadowPixels.map((pixel) => pixel[0])) * 0.65 &&
		Math.min(...shadowPixels.map((pixel) => pixel[0])) < Math.max(...shadowPixels.map((pixel) => pixel[0])) * 0.65 &&
		classicFilterEvidence.every(
			(entry) =>
				entry.runtime.active &&
				entry.runtime.ready &&
				entry.runtime.shadowFilter === entry.filter &&
				entry.runtime.shadowMapType === "2d" &&
				entry.runtime.shadowMapReady &&
				entry.runtime.shadowFrameCount >= 4 &&
				Math.min(...entry.pixels.map((pixel) => pixel[0])) < Math.max(...entry.pixels.map((pixel) => pixel[0])) * 0.9
		) &&
		pointShadowActive.active &&
		pointShadowActive.ready &&
		pointShadowActive.shadowLightCount === 1 &&
		pointShadowActive.shadowLightId === pointShadowLight.id &&
		pointShadowActive.shadowGeneratorType === "classic" &&
		pointShadowActive.shadowMapType === "cube" &&
		pointShadowActive.shadowFilter === "hard" &&
		pointShadowActive.shadowCascadeCount === 0 &&
		pointShadowActive.shadowMapReady &&
		pointShadowActive.shadowMapWidth === 512 &&
		pointShadowActive.shadowMapHeight === 512 &&
		pointShadowActive.shadowCasterCount === 1 &&
		pointShadowActive.shadowReceiverCount === 1 &&
		pointShadowActive.shadowFrameCount >= 4 &&
		Math.min(...nativePointShadowPixels.map((pixel) => pixel[0])) < Math.max(...nativePointShadowPixels.map((pixel) => pixel[0])) * 0.65 &&
		Math.min(...pointShadowPixels.map((pixel) => pixel[0])) < Math.max(...pointShadowPixels.map((pixel) => pixel[0])) * 0.65 &&
		pointFilterEvidence.every(
			(entry) =>
				entry.runtime.active &&
				entry.runtime.ready &&
				entry.runtime.shadowFilter === entry.filter &&
				entry.runtime.shadowMapType === "cube" &&
				entry.runtime.shadowMapReady &&
				entry.runtime.shadowFrameCount >= 4 &&
				Math.min(...entry.pixels.map((pixel) => pixel[0])) < Math.max(...entry.pixels.map((pixel) => pixel[0])) * 0.9
		) &&
		cascadedShadowActive.active &&
		cascadedShadowActive.ready &&
		cascadedShadowActive.shadowLightCount === 1 &&
		cascadedShadowActive.shadowLightId === cascadedShadowLight.id &&
		cascadedShadowActive.shadowGeneratorType === "cascaded" &&
		cascadedShadowActive.shadowMapType === "2d-array" &&
		cascadedShadowActive.shadowFilter === "pcf" &&
		cascadedShadowActive.shadowCascadeCount === 4 &&
		cascadedShadowActive.shadowMapReady &&
		cascadedShadowActive.shadowMapWidth === 512 &&
		cascadedShadowActive.shadowMapHeight === 512 &&
		cascadedShadowActive.shadowCasterCount === 1 &&
		cascadedShadowActive.shadowReceiverCount === 1 &&
		cascadedShadowActive.shadowFrameCount >= 4 &&
		(__DEFERRED_LIGHTING_TARGET__ !== "webgl2" ||
			Math.min(...nativeCascadedShadowPixels.map((pixel) => pixel[0])) < Math.max(...nativeCascadedShadowPixels.map((pixel) => pixel[0])) * 0.65) &&
		Math.min(...cascadedShadowPixels.map((pixel) => pixel[0])) < Math.max(...cascadedShadowPixels.map((pixel) => pixel[0])) * 0.65 &&
		cascadedFilterEvidence.every(
			(entry) =>
				entry.runtime.active &&
				entry.runtime.ready &&
				entry.runtime.shadowFilter === entry.filter &&
				entry.runtime.shadowMapType === "2d-array" &&
				entry.runtime.shadowCascadeCount === 4 &&
				entry.runtime.shadowMapReady &&
				entry.runtime.shadowFrameCount >= 4 &&
				Math.min(...entry.pixels.map((pixel) => pixel[0])) < Math.max(...entry.pixels.map((pixel) => pixel[0])) * 0.9
		) &&
		Object.values(multiShadowChecks).every(Boolean) &&
		iblActive.active &&
		iblActive.ready &&
		iblActive.iblActive &&
		iblActive.iblReady &&
		iblActive.iblSourceCount === 3 &&
		iblActive.iblEnvironmentTextureName === environmentCube.name &&
		iblActive.iblReflectionProbeCount === 2 &&
		iblActive.iblReflectionProbeNames.includes(localProbe.name) &&
		iblActive.iblReflectionProbeNames.includes(redProbe.name) &&
		iblActive.iblProbeBlendingActive &&
		iblActive.iblProbeBlendModel === "unity-priority-box-blend-skybox-v1" &&
		iblActive.iblProbeBlendMeshCount === 1 &&
		iblActive.iblSources.some((source) => source.kind === "reflection-probe" && source.probeSlot === 0 && source.blendDistance === 0) &&
		iblActive.iblSources.some((source) => source.kind === "reflection-probe" && source.probeSlot === 1 && source.blendDistance === 0) &&
		iblActive.decalProjectorCount === 1 &&
		iblActive.decalProjectorSamplerCount === 4 &&
		iblActive.decalLayerFilteredProjectorCount === 1 &&
		iblActive.decalLayerTargetReady &&
		iblActive.decalSources[0]?.backend === "screen-space-volume-projector-v2" &&
		iblActive.decalSources[0]?.decalLayerMask === 0x80000000 &&
		!iblActive.decalSources[0]?.affectsAlbedo &&
		iblActive.decalSources[0]?.affectsNormal &&
		iblActive.decalSources[0]?.affectsReflectivity &&
		iblActive.decalSources[0]?.affectsAmbientOcclusion &&
		iblActive.decalSources[0]?.affectedMeshCount === 1 &&
		iblActive.iblFrameCount >= 4 &&
		iblActive.iblSources.some((source) => source.kind === "environment" && source.diffuseMode === "roughest-mip") &&
		iblActive.iblSources.some((source) => source.kind === "reflection-probe" && source.boxProjection) &&
		iblSelectorPixels[0][0] >= 1 &&
		iblSelectorPixels[1][0] >= 1 &&
		iblSelectorPixels[1][2] >= 2 &&
		iblPixels[0][1] > iblPixels[0][0] * 2 &&
		iblPixels[0][1] > iblPixels[0][2] * 2 &&
		iblPixels[0][1] > 25 &&
		iblPixels[1][0] > 25 &&
		iblPixels[1][2] > 25 &&
		iblPixels[1][0] > iblPixels[1][1] * 2 &&
		iblPixels[1][2] > iblPixels[1][1] * 2 &&
		iblPixels[1][0] / Math.max(iblPixels[1][2], 1) > 0.25 &&
		iblPixels[1][0] / Math.max(iblPixels[1][2], 1) < 4 &&
		!iblPriorityInvalidated.active &&
		!iblPriorityInvalidated.ready &&
		iblPriorityInvalidated.errors.some((error) => error.includes("IBL environment, probe assignment, probe settings, or intensity changed")) &&
		iblPriorityActive.active &&
		iblPriorityActive.ready &&
		iblPriorityActive.iblReady &&
		iblPriorityActive.iblProbeBlendMeshCount === 1 &&
		iblPriorityActive.iblSources.some((source) => source.name === redProbe.name && source.importance === 2) &&
		iblPriorityPixels[1][0] > iblPriorityPixels[1][2] * 2 &&
		iblPriorityPixels[1][0] > iblPriorityPixels[1][1] * 2 &&
		iblPriorityPixels[1][0] > 25 &&
		emissiveActive.active &&
		emissiveActive.ready &&
		emissiveActive.emissiveActive &&
		emissiveActive.emissiveReady &&
		emissiveActive.emissiveWidth === 320 &&
		emissiveActive.emissiveHeight === 180 &&
		emissiveActive.emissiveMeshCount === 5 &&
		emissiveActive.emissiveMaterialCount === 5 &&
		emissiveActive.emissiveTextureCount === 1 &&
		emissiveActive.emissiveFrameCount >= 4 &&
		emissiveActive.emissiveSources.length === 5 &&
		emissiveActive.emissiveSources.some((source) => source.materialClassName === "StandardMaterial" && source.color[0] === 1) &&
		emissiveActive.emissiveSources.some((source) => source.materialClassName === "PBRMaterial" && source.textureName === emissiveTexture.name && source.intensity === 2) &&
		emissiveActive.emissiveSources.some((source) => source.materialClassName === "OpenPBRMaterial" && source.intensity === 2) &&
		emissivePixels[0][0] > emissivePixels[0][1] * 3 &&
		emissivePixels[0][0] > 80 &&
		emissivePixels[1][1] > emissivePixels[1][0] * 3 &&
		emissivePixels[1][1] > emissivePixels[1][2] * 3 &&
		emissivePixels[1][1] > 80 &&
		emissivePixels[2][2] > emissivePixels[2][0] * 3 &&
		emissivePixels[2][2] > 80 &&
		emissivePixels[3][0] > emissivePixels[3][2] * 3 &&
		emissivePixels[3][1] > emissivePixels[3][2] * 3 &&
		emissivePixels[3][0] > 80 &&
		emissivePixels[3][1] > 80 &&
		emissivePixels[4][0] > emissivePixels[4][1] * 3 &&
		emissivePixels[4][2] > emissivePixels[4][1] * 3 &&
		emissivePixels[4][0] > 80 &&
		emissivePixels[4][2] > 80 &&
		Math.max(...emissivePixels[5].slice(0, 3)) < 20 &&
		!emissiveInvalidated.active &&
		emissiveInvalidated.errors.some((error) => error.includes("emissive material color, texture, intensity, or mesh assignment changed")) &&
		emissiveRecovered.active &&
		emissiveRecovered.errors.length === 0 &&
		decalActive.active &&
		decalActive.ready &&
		decalActive.decalActive &&
		decalActive.decalReady &&
		decalActive.decalCount === 1 &&
		decalActive.decalSourceMeshCount === 1 &&
		decalActive.decalMaterialCount === 1 &&
		decalActive.decalFrameCount >= 4 &&
		decalActive.decalForwardSubMeshSuppressedCount === 1 &&
		decalActive.decalForwardSuppressionFrameCount >= 4 &&
		decalActive.decalSources[0]?.backend === "projected-geometry-gbuffer-v1" &&
		decalActive.decalSources[0]?.nodeId === decal.id &&
		decalActive.decalSources[0]?.sourceMeshId === decalReceiver.id &&
		decalActive.decalSources[0]?.alphaMode === "alpha-blend" &&
		decalActive.decalSources[0]?.revision === 1 &&
		decalActive.decalSources[0]?.vertexCount > 0 &&
		decalActive.decalSources[0]?.indexCount > 0 &&
		decalPixels[1][0] > decalPixels[0][0] * 2 &&
		decalPixels[1][0] > decalPixels[2][0] * 2 &&
		decalPixels[0][2] > decalPixels[0][0] * 2 &&
		decalPixels[2][2] > decalPixels[2][0] * 2 &&
		!decalInvalidated.active &&
		decalInvalidated.errors.some((error) => error.includes("decal projection, geometry, material channel, texture, opacity, or draw-order setting changed")) &&
		decalInvalidated.decalForwardSuppressionFrameCount === decalSuppressionFramesBeforeInvalidation &&
		decalRecovered.active &&
		decalRecovered.ready &&
		decalRecovered.decalForwardSuppressionFrameCount > decalSuppressionFramesBeforeInvalidation &&
		decalRecovered.errors.length === 0 &&
		projectorActive.active &&
		projectorActive.ready &&
		projectorActive.decalActive &&
		projectorActive.decalReady &&
		projectorActive.decalCount === 1 &&
		projectorActive.decalGeometryCount === 0 &&
		projectorActive.decalProjectorCount === 1 &&
		projectorActive.decalProjectorMaximumSources === 8 &&
		projectorActive.decalProjectorSamplerCount === 6 &&
		projectorActive.decalLayerFilteredProjectorCount === 1 &&
		projectorActive.decalLayerTargetReady &&
		projectorActive.decalFrameCount >= 4 &&
		projectorActive.decalSources[0]?.backend === "screen-space-volume-projector-v2" &&
		projectorActive.decalSources[0]?.nodeId === projector.id &&
		projectorActive.decalSources[0]?.sourceMeshId === null &&
		projectorActive.decalSources[0]?.projectorTextureName === projectorTexture.name &&
		projectorActive.decalSources[0]?.projectorTextureReady &&
		projectorActive.decalSources[0]?.projectorTextureNames?.normal === projectorNormalTexture.name &&
		projectorActive.decalSources[0]?.projectorTextureNames?.reflectivity === projectorReflectivityTexture.name &&
		projectorActive.decalSources[0]?.projectorTextureNames?.ambientOcclusion === projectorAoTexture.name &&
		projectorActive.decalSources[0]?.projectorTextureNames?.emissive === projectorEmissiveTexture.name &&
		projectorActive.decalSources[0]?.projectorTexturesReady &&
		projectorActive.decalSources[0]?.decalLayerMask === 2 &&
		projectorActive.decalSources[0]?.affectsNormal &&
		projectorActive.decalSources[0]?.affectsReflectivity &&
		projectorActive.decalSources[0]?.affectsAmbientOcclusion &&
		projectorActive.decalSources[0]?.affectsEmissive &&
		projectorActive.decalSources[0]?.affectedMeshCount === 1 &&
		projectorActive.decalSources[0]?.edgeFade === 0 &&
		projectorActive.decalSources[0]?.revision === 1 &&
		projectorActive.decalSources[0]?.vertexCount === 0 &&
		projectorActive.decalSources[0]?.indexCount === 0 &&
		projectorPixels[1][0] > projectorPixels[0][0] * 2 &&
		projectorPixels[1][0] > projectorPixels[2][0] * 2 &&
		projectorPixels[1][0] > 30 &&
		projectorPixels[0][2] > projectorPixels[0][0] * 2 &&
		projectorPixels[2][2] > projectorPixels[2][0] * 2 &&
		projectorDriverErrors.length === 0 &&
		!projectorInvalidated.active &&
		projectorInvalidated.errors.some((error) => error.includes("decal projection, geometry, material channel, texture, opacity, or draw-order setting changed")) &&
		projectorRecovered.active &&
		projectorRecovered.ready &&
		projectorRecovered.decalFrameCount > projectorActive.decalFrameCount &&
		projectorRecovered.errors.length === 0 &&
		cookieEvidence.every(
			(entry) =>
				entry.runtime.active &&
				entry.runtime.ready &&
				entry.runtime.cookieActive &&
				entry.runtime.cookieReady &&
				entry.runtime.cookieCount === 1 &&
				entry.runtime.cookieFrameCount >= 4 &&
				entry.runtime.cookieSources[0]?.kind === entry.kind &&
				entry.runtime.cookieSources[0]?.revision === 1 &&
				!entry.invalidated.active &&
				entry.invalidated.errors.some((error) =>
					error.includes("deferred light cookie texture, type, revision, intensity, projection size, offset, clip range, or up direction changed")
				) &&
				entry.recovered.active &&
				entry.recovered.ready &&
				entry.recovered.cookieFrameCount > entry.runtime.cookieFrameCount &&
				entry.recovered.errors.length === 0
		) &&
		cookieEvidence[0].pixel[0] > cookieEvidence[0].pixel[1] * 3 &&
		cookieEvidence[0].pixel[0] > cookieEvidence[0].pixel[2] * 3 &&
		cookieEvidence[0].pixel[0] > 30 &&
		cookieEvidence[1].pixel[1] > cookieEvidence[1].pixel[0] * 3 &&
		cookieEvidence[1].pixel[1] > cookieEvidence[1].pixel[2] * 3 &&
		cookieEvidence[1].pixel[1] > 30 &&
		cookieEvidence[2].pixel[2] > cookieEvidence[2].pixel[0] * 3 &&
		cookieEvidence[2].pixel[2] > cookieEvidence[2].pixel[1] * 3 &&
		cookieEvidence[2].pixel[2] > 30 &&
		areaLightEvidence.every(
			(entry) =>
				entry.runtime.active &&
				entry.runtime.ready &&
				entry.runtime.areaLightActive &&
				entry.runtime.areaLightReady &&
				entry.runtime.areaLightCount === 1 &&
				entry.runtime.areaLightFrameCount >= 4 &&
				entry.runtime.areaLightSources[0]?.shape === entry.shape &&
				entry.runtime.areaLightSources[0]?.revision === 1 &&
				!entry.invalidated.active &&
				entry.invalidated.errors.some((error) => error.includes("area-light shape, size, orientation, transform, intensity, range, color, or revision changed")) &&
				entry.recovered.active &&
				entry.recovered.ready &&
				entry.recovered.areaLightFrameCount > entry.runtime.areaLightFrameCount &&
				entry.recovered.errors.length === 0
		) &&
		areaLightEvidence[0].pixel[0] > areaLightEvidence[0].pixel[1] * 3 &&
		areaLightEvidence[0].pixel[0] > areaLightEvidence[0].pixel[2] * 3 &&
		areaLightEvidence[0].pixel[0] > 30 &&
		areaLightEvidence[1].pixel[2] > areaLightEvidence[1].pixel[0] * 3 &&
		areaLightEvidence[1].pixel[2] > areaLightEvidence[1].pixel[1] * 3 &&
		areaLightEvidence[1].pixel[2] > 30 &&
		areaLightEvidence[0].nativePixel[0] > areaLightEvidence[0].nativePixel[1] * 3 &&
		areaLightEvidence[0].nativePixel[0] > areaLightEvidence[0].nativePixel[2] * 3 &&
		areaLightEvidence[0].nativePixel[0] > 20 &&
		areaLightEvidence[1].nativePixel[2] > areaLightEvidence[1].nativePixel[0] * 3 &&
		areaLightEvidence[1].nativePixel[2] > areaLightEvidence[1].nativePixel[1] * 3 &&
		areaLightEvidence[1].nativePixel[2] > 20 &&
		primaryMultiActive.active &&
		primaryMultiActive.ready &&
		primaryMultiActive.configuredCameraCount === 2 &&
		primaryMultiActive.sharedGeometryBufferHolderCount === 2 &&
		primaryMultiActive.cameraViewport.join(",") === "0,0,0.5,1" &&
		primaryMultiActive.outputRenderTargetName === presentation.name &&
		secondaryMultiActive.active &&
		secondaryMultiActive.ready &&
		secondaryMultiActive.configuredCameraCount === 2 &&
		secondaryMultiActive.sharedGeometryBufferHolderCount === 2 &&
		secondaryMultiActive.cameraViewport.join(",") === "0.5,0,0.5,1" &&
		secondaryMultiActive.outputRenderTargetName === secondaryPresentation.name &&
		primaryMultiPixels[0][0] > primaryMultiPixels[0][1] * 2 &&
		primaryMultiPixels[0][0] > 30 &&
		secondaryMultiPixels[2][0] > secondaryMultiPixels[2][1] * 2 &&
		secondaryMultiPixels[2][0] > 30 &&
		secondaryAfterPrimaryStop.active &&
		secondaryAfterPrimaryStop.configuredCameraCount === 1 &&
		secondaryAfterPrimaryStop.sharedGeometryBufferHolderCount === 1 &&
		secondaryAfterPrimaryStop.frameCount >= secondaryFrameBeforePrimaryStop + 2 &&
		!restored.active &&
		scene.customRenderTargets.length === 0 &&
		scene.geometryBufferRenderer === null;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify({
		target: __DEFERRED_LIGHTING_TARGET__,
		backend: engine.getClassName(),
		emissivePixels,
		emissiveActive,
		emissiveInvalidated,
		emissiveRecovered,
		decalPixels,
		decalActive,
		decalInvalidated,
		decalRecovered,
		projectorPixels,
		projectorDriverErrors,
		projectorActive,
		projectorInvalidated,
		projectorRecovered,
		cookieEvidence,
		areaLightEvidence,
		multiCamera: { primaryMultiPixels, secondaryMultiPixels, primaryMultiActive, secondaryMultiActive, secondaryAfterPrimaryStop },
		readinessFrames,
		redPixels,
		greenPixels,
		directionalPixel,
		spotPixel,
		hemisphericPixel,
		backgroundPixel,
		laterGroupPixel,
		spritePixel,
		transparentPixel,
		particlePixel,
		shadowPixels,
		nativeShadowPixels,
		shadowProjection,
		classicFilterEvidence,
		pointShadowPixels,
		nativePointShadowPixels,
		pointFilterEvidence,
		cascadedShadowPixels,
		nativeCascadedShadowPixels,
		cascadedFilterEvidence,
		cascadedShadowEvidence,
		multiShadowPixels,
		pointOnlyShadowPixels,
		multiShadowChecks,
		multiShadowTextureState,
		multiShadowWarmupErrors,
		multiShadowResolveErrors,
		pointOnlyShadowResolveErrors,
		multiShadowActive,
		multiShadowInvalidated,
		pointOnlyShadowActive,
		iblPixels,
		iblSelectorPixels,
		iblActive,
		iblPriorityPixels,
		iblPriorityInvalidated,
		iblPriorityActive,
		active,
		shadowActive,
		pointShadowActive,
		cascadedShadowActive,
		restored,
		customRenderTargets: scene.customRenderTargets.length,
		geometryBufferRestored: scene.geometryBufferRenderer === null,
	});
	scene.dispose();
	engine.dispose();
}

run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
