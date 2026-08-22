import { createHash } from "crypto";

import sharp from "sharp";

import { AbstractMesh, Color3, Color4, Constants, Layer, Light, RenderTargetTexture, Scene, StandardMaterial, Texture } from "babylonjs";

import { IMCPActionOptions } from "../action";

export type RenderDebugViewMode = "disabled" | "overdraw" | "light-complexity";

export interface IRenderDebugViewReport {
	revision: number;
	mode: RenderDebugViewMode;
	active: boolean;
	ready: boolean;
	backend: "babylon-rtt-material-override-debug-view-v1";
	shaderLanguage: "GLSL" | "WGSL";
	width: number;
	height: number;
	meshCount: number;
	lightCount: number;
	maximumOverdraw: number;
	maximumLightCount: number;
	lightCountHistogram: number[];
	renderedFrames: number;
	lastRenderedFrameId: number | null;
	limitations: string[];
}

export interface IRenderDebugViewCapture extends IRenderDebugViewReport {
	capturedFrameId: number;
	pixelCount: number;
	coloredPixelCount: number;
	coloredCoverage: number;
	minimumRgba: number[];
	maximumRgba: number[];
	averageRgba: number[];
	pixelSha256: string;
	preview: {
		width: number;
		height: number;
		byteLength: number;
		sha256: string;
		pngBase64: string | null;
	};
}

export interface ISetRenderDebugViewData {
	expectedRevision: number;
	mode: RenderDebugViewMode;
	maximumOverdraw?: number;
	maximumLightCount?: number;
}

export interface ICaptureRenderDebugViewData {
	expectedRevision: number;
	width?: number;
	height?: number;
	includeImage?: boolean;
}

interface IRenderDebugViewState {
	mode: Exclude<RenderDebugViewMode, "disabled">;
	maximumOverdraw: number;
	maximumLightCount: number;
	target: RenderTargetTexture;
	layer: Layer;
	overdrawMaterial: StandardMaterial | null;
	lightMaterials: StandardMaterial[];
	beforeRenderObserver: any;
	afterTargetRenderObserver: any;
	disposeObserver: any;
	renderedFrames: number;
	lastRenderedFrameId: number | null;
	meshCount: number;
	lightCount: number;
	lightCountHistogram: number[];
}

const states = new WeakMap<Scene, IRenderDebugViewState>();
const revisions = new WeakMap<Scene, number>();
const debugResourceName = "Babylon Editor Render Debug View";
const maximumDebugDimension = 2048;
const maximumDebugPixels = 2048 * 2048;

function revision(scene: Scene): number {
	return revisions.get(scene) ?? 1;
}

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function mode(value: unknown): RenderDebugViewMode {
	if (value !== "disabled" && value !== "overdraw" && value !== "light-complexity") {
		throw new Error('Render debug view mode must be "disabled", "overdraw", or "light-complexity".');
	}
	return value;
}

function eligibleMeshes(scene: Scene): AbstractMesh[] {
	return scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0 && Boolean(mesh.material));
}

function eligibleLights(scene: Scene, mesh: AbstractMesh): Light[] {
	return scene.lights.filter((light) => light.isEnabled() && light.intensity > 0 && light.canAffectMesh(mesh));
}

function heatColor(value: number): Color3 {
	const stops: Array<[number, Color3]> = [
		[0, new Color3(0.02, 0.03, 0.14)],
		[0.2, new Color3(0.02, 0.25, 1)],
		[0.4, new Color3(0, 0.9, 0.8)],
		[0.6, new Color3(0.85, 0.95, 0.05)],
		[0.8, new Color3(1, 0.25, 0)],
		[1, new Color3(1, 1, 1)],
	];
	const normalized = Math.min(1, Math.max(0, value));
	for (let index = 1; index < stops.length; index++) {
		if (normalized <= stops[index][0]) {
			const [leftPosition, leftColor] = stops[index - 1];
			const [rightPosition, rightColor] = stops[index];
			return Color3.Lerp(leftColor, rightColor, (normalized - leftPosition) / (rightPosition - leftPosition));
		}
	}
	return stops.at(-1)![1].clone();
}

function debugMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
	const material = new StandardMaterial(name, scene);
	material.doNotSerialize = true;
	material.disableLighting = true;
	material.diffuseColor = Color3.Black();
	material.specularColor = Color3.Black();
	material.ambientColor = Color3.Black();
	material.emissiveColor = color;
	material.backFaceCulling = true;
	material.alpha = 1;
	material.alphaMode = Constants.ALPHA_DISABLE;
	return material;
}

function targetSize(scene: Scene): { width: number; height: number } {
	const engine = scene.getEngine();
	const sourceWidth = Math.max(1, engine.getRenderWidth());
	const sourceHeight = Math.max(1, engine.getRenderHeight());
	const scale = Math.min(1, maximumDebugDimension / sourceWidth, maximumDebugDimension / sourceHeight, Math.sqrt(maximumDebugPixels / (sourceWidth * sourceHeight)));
	return { width: Math.max(1, Math.round(sourceWidth * scale)), height: Math.max(1, Math.round(sourceHeight * scale)) };
}

function createStateUnchecked(scene: Scene, debugMode: Exclude<RenderDebugViewMode, "disabled">, maximumOverdraw: number, maximumLightCount: number): IRenderDebugViewState {
	const size = targetSize(scene);
	const target = new RenderTargetTexture(debugResourceName, size, scene, false, true, Constants.TEXTURETYPE_UNSIGNED_BYTE);
	(target as RenderTargetTexture & { doNotSerialize: boolean }).doNotSerialize = true;
	target.name = debugResourceName;
	target.gammaSpace = false;
	target.ignoreCameraViewport = true;
	target.renderParticles = false;
	target.renderSprites = false;
	target.clearColor = new Color4(0, 0, 0, 1);
	target.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
	if (!scene.customRenderTargets.includes(target)) {
		scene.customRenderTargets.push(target);
	}

	const layer = new Layer(debugResourceName, null, scene, false, new Color4(1, 1, 1, 1));
	(layer as Layer & { doNotSerialize: boolean }).doNotSerialize = true;
	layer.texture = target;
	layer.alphaTest = false;
	layer.alphaBlendingMode = Constants.ALPHA_DISABLE;
	layer.applyPostProcess = false;
	layer.renderOnlyInRenderTargetTextures = false;
	layer.renderTargetTextures = [];

	const overdrawMaterial = debugMode === "overdraw" ? debugMaterial(scene, `${debugResourceName} Overdraw`, new Color3(1, 0.22, 0.01)) : null;
	if (overdrawMaterial) {
		overdrawMaterial.alpha = 1 / maximumOverdraw;
		overdrawMaterial.alphaMode = Constants.ALPHA_ADD;
		overdrawMaterial.backFaceCulling = false;
		overdrawMaterial.disableDepthWrite = true;
		overdrawMaterial.depthFunction = Constants.ALWAYS;
	}

	const lightMaterials =
		debugMode === "light-complexity"
			? Array.from({ length: maximumLightCount + 1 }, (_, index) => debugMaterial(scene, `${debugResourceName} Light ${index}`, heatColor(index / maximumLightCount)))
			: [];
	const state: IRenderDebugViewState = {
		mode: debugMode,
		maximumOverdraw,
		maximumLightCount,
		target,
		layer,
		overdrawMaterial,
		lightMaterials,
		beforeRenderObserver: null,
		afterTargetRenderObserver: null,
		disposeObserver: null,
		renderedFrames: 0,
		lastRenderedFrameId: null,
		meshCount: 0,
		lightCount: 0,
		lightCountHistogram: new Array(maximumLightCount + 1).fill(0),
	};
	state.beforeRenderObserver = scene.onBeforeRenderObservable.add(() => synchronize(scene, state));
	state.afterTargetRenderObserver = target.onAfterRenderObservable.add(() => {
		state.renderedFrames++;
		state.lastRenderedFrameId = scene.getFrameId();
	});
	state.disposeObserver = scene.onDisposeObservable.add(() => disposeState(scene, state));
	synchronize(scene, state);
	return state;
}

function createState(scene: Scene, debugMode: Exclude<RenderDebugViewMode, "disabled">, maximumOverdraw: number, maximumLightCount: number): IRenderDebugViewState {
	const previousTargets = new Set(scene.customRenderTargets);
	const previousLayers = new Set(scene.layers);
	const previousMaterials = new Set(scene.materials);
	const previousTextures = new Set(scene.textures);
	const previousBeforeRenderObservers = new Set(scene.onBeforeRenderObservable.observers);
	const previousDisposeObservers = new Set(scene.onDisposeObservable.observers);
	try {
		return createStateUnchecked(scene, debugMode, maximumOverdraw, maximumLightCount);
	} catch (error) {
		for (const observer of [...scene.onBeforeRenderObservable.observers]) {
			if (!previousBeforeRenderObservers.has(observer)) {
				scene.onBeforeRenderObservable.remove(observer);
			}
		}
		for (const observer of [...scene.onDisposeObservable.observers]) {
			if (!previousDisposeObservers.has(observer)) {
				scene.onDisposeObservable.remove(observer);
			}
		}
		for (const layer of [...scene.layers]) {
			if (!previousLayers.has(layer) && layer.name === debugResourceName) {
				layer.texture = null;
				layer.dispose();
			}
		}
		const disposedTextures = new Set<object>();
		for (const target of [...scene.customRenderTargets]) {
			if (!previousTargets.has(target) && target.name === debugResourceName) {
				const index = scene.customRenderTargets.indexOf(target);
				if (index !== -1) {
					scene.customRenderTargets.splice(index, 1);
				}
				target.dispose();
				disposedTextures.add(target);
			}
		}
		for (const texture of [...scene.textures]) {
			if (!previousTextures.has(texture) && !disposedTextures.has(texture) && texture.name === debugResourceName) {
				texture.dispose();
			}
		}
		for (const material of [...scene.materials]) {
			if (!previousMaterials.has(material) && material.name.startsWith(debugResourceName)) {
				material.dispose(false, false);
			}
		}
		throw error;
	}
}

function synchronize(scene: Scene, state: IRenderDebugViewState): void {
	const size = state.target.getSize();
	const { width, height } = targetSize(scene);
	if (size.width !== width || size.height !== height) {
		state.target.resize({ width, height });
	}
	const meshes = eligibleMeshes(scene);
	state.target.activeCamera = scene.activeCamera;
	state.target.renderList = meshes;
	state.layer.layerMask = scene.activeCamera?.layerMask ?? 0;
	state.meshCount = meshes.length;
	state.lightCount = scene.lights.filter((light) => light.isEnabled() && light.intensity > 0).length;
	state.lightCountHistogram = new Array(state.maximumLightCount + 1).fill(0);
	for (const mesh of meshes) {
		if (state.mode === "overdraw") {
			state.target.setMaterialForRendering(mesh, state.overdrawMaterial!);
			continue;
		}
		const count = Math.min(state.maximumLightCount, eligibleLights(scene, mesh).length);
		state.lightCountHistogram[count]++;
		state.target.setMaterialForRendering(mesh, state.lightMaterials[count]);
	}
}

function disposeState(scene: Scene, candidate: IRenderDebugViewState): void {
	if (states.get(scene) === candidate) {
		states.delete(scene);
	}
	if (!scene.isDisposed) {
		scene.onBeforeRenderObservable.remove(candidate.beforeRenderObserver);
		scene.onDisposeObservable.remove(candidate.disposeObserver);
	}
	candidate.target.onAfterRenderObservable.remove(candidate.afterTargetRenderObserver);
	const targetIndex = scene.customRenderTargets.indexOf(candidate.target);
	if (targetIndex !== -1) {
		scene.customRenderTargets.splice(targetIndex, 1);
	}
	candidate.layer.texture = null;
	candidate.layer.dispose();
	candidate.target.dispose();
	candidate.overdrawMaterial?.dispose(false, false);
	candidate.lightMaterials.forEach((material) => material.dispose(false, false));
}

function report(scene: Scene, state: IRenderDebugViewState | null): IRenderDebugViewReport {
	const size = state?.target.getSize();
	return {
		revision: revision(scene),
		mode: state?.mode ?? "disabled",
		active: Boolean(state),
		ready: Boolean(state && scene.activeCamera && state.target.isReadyForRendering() && state.layer.isReady()),
		backend: "babylon-rtt-material-override-debug-view-v1",
		shaderLanguage: scene.getEngine().isWebGPU ? "WGSL" : "GLSL",
		width: size?.width ?? 0,
		height: size?.height ?? 0,
		meshCount: state?.meshCount ?? 0,
		lightCount: state?.lightCount ?? 0,
		maximumOverdraw: state?.maximumOverdraw ?? 8,
		maximumLightCount: state?.maximumLightCount ?? 8,
		lightCountHistogram: state ? [...state.lightCountHistogram] : [],
		renderedFrames: state?.renderedFrames ?? 0,
		lastRenderedFrameId: state?.lastRenderedFrameId ?? null,
		limitations: [
			"Overdraw counts front- and back-face diagnostic fragment submissions with depth disabled and saturates at the configured display maximum; it is a transient editor view, not a production render pass.",
			"Light complexity is a bounded visible-mesh heat map of enabled lights accepted by Babylon's mesh inclusion/layer filters. It reports mesh-level eligibility rather than per-pixel attenuation cost.",
			`The transient target preserves preview aspect ratio but is capped at ${maximumDebugDimension} pixels per dimension and ${maximumDebugPixels} total pixels before readback.`,
		],
	};
}

/** Returns the transient renderer diagnostic view and exact live evidence. */
export function getRenderDebugView(scene: Scene): IRenderDebugViewReport {
	const state = states.get(scene) ?? null;
	if (state) {
		synchronize(scene, state);
	}
	return report(scene, state);
}

/** Exact-leased activation, reconfiguration, or disposal of the transient renderer diagnostic view. */
export function setRenderDebugView(scene: Scene, data: ISetRenderDebugViewData, options: IMCPActionOptions): IRenderDebugViewReport {
	const currentRevision = revision(scene);
	if (data.expectedRevision !== currentRevision) {
		throw new Error(`Render debug view revision is stale. Expected ${currentRevision}.`);
	}
	const nextMode = mode(data.mode);
	const current = states.get(scene) ?? null;
	const maximumOverdraw = finiteInteger(data.maximumOverdraw ?? current?.maximumOverdraw ?? 8, "maximumOverdraw", 4, 32);
	const maximumLightCount = finiteInteger(data.maximumLightCount ?? current?.maximumLightCount ?? 8, "maximumLightCount", 1, 16);
	const next = nextMode === "disabled" ? null : createState(scene, nextMode, maximumOverdraw, maximumLightCount);
	if (current) {
		disposeState(scene, current);
	}
	if (nextMode !== "disabled") {
		states.set(scene, next!);
	}
	revisions.set(scene, currentRevision + 1);
	options.editor.layout.inspector.forceUpdate();
	return report(scene, states.get(scene) ?? null);
}

/** Captures bounded pixels and statistics from the currently active transient diagnostic target. */
export async function captureRenderDebugView(scene: Scene, data: ICaptureRenderDebugViewData): Promise<IRenderDebugViewCapture> {
	const currentRevision = revision(scene);
	if (data.expectedRevision !== currentRevision) {
		throw new Error(`Render debug view revision is stale. Expected ${currentRevision}.`);
	}
	const state = states.get(scene);
	if (!state) {
		throw new Error("No render debug view is active. Enable overdraw or light-complexity first.");
	}
	if (!scene.activeCamera) {
		throw new Error("No active camera is available for the render debug view.");
	}
	synchronize(scene, state);
	state.target.render(true);
	const size = state.target.getSize();
	const pixels = await state.target.readPixels(0, 0, null, true, false, 0, 0, size.width, size.height);
	if (!pixels) {
		throw new Error("The render debug target did not return readable pixels on this backend.");
	}
	const bytes = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	let coloredPixelCount = 0;
	const minimum = [255, 255, 255, 255];
	const maximum = [0, 0, 0, 0];
	const totals = [0, 0, 0, 0];
	for (let index = 0; index < bytes.length; index += 4) {
		if (bytes[index] + bytes[index + 1] + bytes[index + 2] > 3) {
			coloredPixelCount++;
		}
		for (let channel = 0; channel < 4; channel++) {
			const value = bytes[index + channel];
			minimum[channel] = Math.min(minimum[channel], value);
			maximum[channel] = Math.max(maximum[channel], value);
			totals[channel] += value;
		}
	}
	const pixelCount = size.width * size.height;
	const previewWidth = finiteInteger(data.width ?? 256, "width", 16, 512);
	const previewHeight = finiteInteger(data.height ?? 256, "height", 16, 512);
	const encoded = await sharp(bytes, { raw: { width: size.width, height: size.height, channels: 4 } })
		.resize({ width: previewWidth, height: previewHeight, fit: "inside", withoutEnlargement: true })
		.png({ compressionLevel: 9, palette: false })
		.toBuffer({ resolveWithObject: true });
	return {
		...report(scene, state),
		capturedFrameId: scene.getFrameId(),
		pixelCount,
		coloredPixelCount,
		coloredCoverage: pixelCount ? coloredPixelCount / pixelCount : 0,
		minimumRgba: minimum,
		maximumRgba: maximum,
		averageRgba: totals.map((value) => (pixelCount ? value / pixelCount : 0)),
		pixelSha256: createHash("sha256").update(bytes).digest("hex"),
		preview: {
			width: encoded.info.width,
			height: encoded.info.height,
			byteLength: encoded.data.length,
			sha256: createHash("sha256").update(encoded.data).digest("hex"),
			pngBase64: data.includeImage === true ? encoded.data.toString("base64") : null,
		},
	};
}

/** Releases transient resources without changing persisted scene data. */
export function clearRenderDebugView(scene: Scene): void {
	const state = states.get(scene);
	if (state) {
		disposeState(scene, state);
	}
}
