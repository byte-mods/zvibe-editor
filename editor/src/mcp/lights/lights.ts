import {
	Scene,
	Node,
	Light,
	ShadowGenerator,
	CascadedShadowGenerator,
	IShadowLight,
	DirectionalLight,
	SpotLight,
	PointLight,
	ReflectionProbe,
	MultiMaterial,
	Vector3,
	Texture,
	CubeTexture,
} from "babylonjs";
import { dirname, extname, isAbsolute, join, relative } from "path/posix";
import { pathExists, stat } from "fs-extra";

import {
	activeLightingScenarioMetadataKey,
	bakedLightingScenarioBackend,
	configureLightingScenarios,
	ILightingScenario,
	ILightingScenarioBakedLighting,
	lightingScenariosMetadataKey,
	snapshotLightingScenarioLight,
	validateLightingScenarios,
	validateLightProbeVolumes,
	lightProbeVolumesMetadataKey,
	getDeferredLightingRuntimes,
	getLightCookieEvidence,
	getLightCookieTexture,
	setLightCookie,
	reflectionProbeBlendModel,
	reflectionProbeMetadataKey,
	validateReflectionProbeBlendDistance,
	getAreaLightEvidence,
} from "babylonjs-editor-tools";

import { isLight, isRectAreaLight } from "../../tools/guards/nodes";

import { addPointLight, addDirectionalLight, addSpotLight, addHemisphericLight } from "../../project/add/light";

import { IMCPActionOptions } from "../action";
import { deepSet, resolveNode, toNodeSummary, toColor3, toVector3 } from "../tools/resolve";
import { readBakedGlobalIlluminationManifest, releaseRetainedBakedGiScenarioResources } from "./baked-gi";
import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { projectConfiguration } from "../../project/configuration";
import {
	getIblShadowsRenderingPipeline,
	createIblShadowsRenderingPipeline,
	disposeIblShadowsRenderingPipeline,
	parseIblShadowsRenderingPipeline,
	serializeIblShadowsRenderingPipeline,
} from "../../editor/rendering/ibl-shadows";

function readLightingScenarios(scene: Scene): ILightingScenario[] {
	return validateLightingScenarios(scene.metadata?.[lightingScenariosMetadataKey]);
}

function writeLightingScenarios(scene: Scene, scenarios: ILightingScenario[]): void {
	scene.metadata ??= {};
	scene.metadata[lightingScenariosMetadataKey] = validateLightingScenarios(scenarios);
	configureLightingScenarios(scene as any);
}

function findLightingScenario(scene: Scene, data: any): ILightingScenario {
	const scenario = readLightingScenarios(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!scenario) {
		throw new Error("Lighting scenario not found. Provide its id (preferred) or name.");
	}
	if (data.expectedRevision !== undefined && data.expectedRevision !== scenario.revision) {
		throw new Error(`Lighting scenario changed after inspection. Expected revision ${data.expectedRevision}, but the current revision is ${scenario.revision}.`);
	}
	return scenario;
}

function summarizeLightingScenario(scenario: ILightingScenario): Record<string, unknown> {
	return {
		version: scenario.version,
		id: scenario.id,
		name: scenario.name,
		revision: scenario.revision,
		lights: structuredClone(scenario.lights),
		bakedLighting: scenario.bakedLighting
			? {
					backend: scenario.bakedLighting.backend,
					sourceBakeId: scenario.bakedLighting.bakedGi?.sourceBakeId ?? null,
					outputDirectory: scenario.bakedLighting.bakedGi?.outputDirectory ?? null,
					evidence: structuredClone(scenario.bakedLighting.evidence),
				}
			: null,
	};
}

function captureBakedLighting(scene: Scene, scenarios: ILightingScenario[]): ILightingScenarioBakedLighting | null {
	const manifest = readBakedGlobalIlluminationManifest(scene);
	const activeScenarioId = scene.metadata?.[activeLightingScenarioMetadataKey];
	const activeScenario = typeof activeScenarioId === "string" ? scenarios.find((scenario) => scenario.id === activeScenarioId) : undefined;
	const retainedBakedGi = manifest
		? {
				sourceBakeId: manifest.bakeId,
				outputDirectory: manifest.outputDirectory,
				meshEntries: manifest.meshEntries.map((entry) => {
					const material =
						scene.materials.find((candidate) => candidate.id === entry.bakedMaterialId) ??
						scene.multiMaterials.find((candidate) => candidate.id === entry.bakedMaterialId);
					if (!material) {
						throw new Error(`Baked lighting capture could not find retained material ${entry.bakedMaterialId} for mesh "${entry.meshName}".`);
					}
					const subMaterialIds = material instanceof MultiMaterial ? material.subMaterials.map((candidate) => candidate?.id ?? null) : [material.id];
					return {
						meshId: entry.meshId,
						meshName: entry.meshName,
						materialId: material.id,
						subMaterialIds,
						lightmapPath: entry.lightmapPath,
						coordinatesIndex: entry.coordinatesIndex,
					};
				}),
			}
		: activeScenario?.bakedLighting?.bakedGi
			? structuredClone(activeScenario.bakedLighting.bakedGi)
			: null;
	const lightProbeVolumes = validateLightProbeVolumes(scene.metadata?.[lightProbeVolumesMetadataKey]);
	if (!retainedBakedGi && !lightProbeVolumes.length) {
		return null;
	}
	return {
		backend: bakedLightingScenarioBackend,
		bakedGi: retainedBakedGi,
		lightProbeVolumes,
		evidence: {
			lightmapMeshCount: retainedBakedGi?.meshEntries.length ?? 0,
			probeVolumeCount: lightProbeVolumes.length,
			probeCount: lightProbeVolumes.reduce((sum, volume) => sum + (volume.bake?.probes.length ?? 0), 0),
			cellCount: lightProbeVolumes.reduce((sum, volume) => sum + (volume.bake?.cells.length ?? 0), 0),
		},
	};
}

/** Lists bounded summaries for saved realtime and baked lighting scenarios. */
export function listLightingScenarios(scene: Scene, data: any = {}): any {
	const scenarios = readLightingScenarios(scene)
		.filter((scenario) => !data.id || scenario.id === data.id)
		.filter((scenario) => !data.name || scenario.name === data.name);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 32;
	const page = scenarios.slice(offset, offset + limit);
	return {
		total: scenarios.length,
		count: page.length,
		offset,
		hasMore: offset + page.length < scenarios.length,
		scenarios: page.map(summarizeLightingScenario),
		runtime: ((scene as any).lightingScenarios ?? configureLightingScenarios(scene as any)).inspect(),
	};
}

/** Captures selected/all realtime lights plus current retained lightmaps and adaptive probe data. */
export function createLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) {
		throw new Error("Lighting scenarios require a non-empty name.");
	}
	const scenarios = readLightingScenarios(scene);
	if (scenarios.some((scenario) => scenario.name === data.name.trim())) {
		throw new Error(`Lighting scenario "${data.name.trim()}" already exists.`);
	}
	const requestedIds = data.lightNodeIds ?? [];
	if (new Set(requestedIds).size !== requestedIds.length) {
		throw new Error("Lighting-scenario lightNodeIds must be unique.");
	}
	const selected = requestedIds.length ? scene.lights.filter((light) => requestedIds.includes(light.id)) : scene.lights;
	if (requestedIds.length && selected.length !== requestedIds.length) {
		throw new Error("One or more lightNodeIds were not found in the active scene.");
	}
	const scenario: ILightingScenario = {
		version: 2,
		id: crypto.randomUUID(),
		name: data.name.trim(),
		revision: 1,
		lights: selected.map((light) => snapshotLightingScenarioLight(light as any)),
		bakedLighting: data.captureBakedLighting === false ? null : captureBakedLighting(scene, scenarios),
	};
	writeLightingScenarios(scene, [...scenarios, scenario]);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	const summary = summarizeLightingScenario(scenario);
	return { ...summary, scenario: summary, runtime: (scene as any).lightingScenarios.inspect() };
}

/** Applies a saved realtime plus baked-lighting scenario atomically. */
export function applyLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	const scenario = findLightingScenario(scene, data);
	const controller = (scene as any).lightingScenarios ?? configureLightingScenarios(scene as any);
	const application = controller.applyWithEvidence(scenario.id);
	if (!application) {
		throw new Error(`Lighting scenario "${scenario.name}" could not be applied.`);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { scenario: summarizeLightingScenario(scenario), ...application, runtime: controller.inspect() };
}

/** Cross-fades realtime lights, lightmaps, and adaptive SH9 data through the shared runtime. */
export function blendLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	const scenario = findLightingScenario(scene, data);
	const durationMs = data.durationMs ?? 1000;
	if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60_000) {
		throw new Error("Lighting-scenario blend durationMs must be from 0 through 60000.");
	}
	const controller = (scene as any).lightingScenarios ?? configureLightingScenarios(scene as any);
	const runtime = controller.blendToWithEvidence(scenario.id, durationMs);
	if (!runtime) {
		throw new Error(`Lighting scenario "${scenario.name}" could not start a ${durationMs} ms blend.`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { scenario: summarizeLightingScenario(scenario), durationMs, completed: durationMs === 0, runtime };
}

/** Reads exact shared editor/export runtime evidence without changing the scene. */
export function getLightingScenarioRuntime(scene: Scene): any {
	return ((scene as any).lightingScenarios ?? configureLightingScenarios(scene as any)).inspect();
}

/** Deletes one exact-leased scenario and releases final-owner retained bake resources. */
export async function deleteLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const scenario = findLightingScenario(scene, data);
	if (data.confirm !== true) {
		throw new Error("Deleting a lighting scenario can release retained baked lightmaps. Retry with confirm: true and the exact current revision.");
	}
	if (data.expectedRevision !== scenario.revision) {
		throw new Error(`Deleting lighting scenario "${scenario.name}" requires expectedRevision ${scenario.revision}.`);
	}
	if (scene.metadata?.[activeLightingScenarioMetadataKey] === scenario.id && scenario.bakedLighting) {
		throw new Error(`Lighting scenario "${scenario.name}" is active. Apply another scenario before deleting it.`);
	}
	const assignedScenarioMaterialIds = new Set(scenario.bakedLighting?.bakedGi?.meshEntries.map((entry) => entry.materialId) ?? []);
	const assignedMeshes = scene.meshes.filter((mesh) => mesh.material && assignedScenarioMaterialIds.has(mesh.material.id));
	if (assignedMeshes.length) {
		throw new Error(
			`Lighting scenario "${scenario.name}" still owns materials assigned to meshes: ${assignedMeshes.map((mesh) => mesh.name).join(", ")}. Apply another baked scenario or restore base materials before deleting it.`
		);
	}
	if (scene.metadata?.[activeLightingScenarioMetadataKey] === scenario.id) {
		delete scene.metadata[activeLightingScenarioMetadataKey];
	}
	const scenarios = readLightingScenarios(scene);
	writeLightingScenarios(
		scene,
		scenarios.filter((candidate) => candidate.id !== scenario.id)
	);
	const released = scenario.bakedLighting?.bakedGi
		? await releaseRetainedBakedGiScenarioResources(scene, scenario.id, scenario.bakedLighting.bakedGi)
		: { released: false, retainedByScenarioIds: [], retainedByActiveBake: false, deletedOutputDirectory: null };
	options.editor.layout.assets?.refresh?.();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: scenario.id, name: scenario.name, revision: scenario.revision, released, runtime: (scene as any).lightingScenarios.inspect() };
}

/**
 * Resolves an optional parent node from the given data.
 */
function resolveOptionalParent(scene: Scene, data: any): Node | undefined {
	if (data.parentId || data.parentName) {
		return resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName });
	}

	return undefined;
}

/**
 * Creates a light in the scene reusing the editor's "add" functions.
 */
export function createLight(scene: Scene, data: any, options: IMCPActionOptions): any {
	const parent = resolveOptionalParent(scene, data);
	const editor = options.editor;

	let light: Light;
	switch (data.type) {
		case "directional":
			light = addDirectionalLight(editor, parent);
			break;
		case "point":
			light = addPointLight(editor, parent);
			break;
		case "spot":
			light = addSpotLight(editor, parent);
			break;
		case "hemispheric":
			light = addHemisphericLight(editor, parent);
			break;
		default:
			throw new Error(`Unknown light type: ${data.type}`);
	}

	if (data.name) {
		light.name = data.name;
	}

	if (data.position !== undefined && (light as any).position) {
		(light as any).position.copyFrom(toVector3(data.position));
	}

	if (data.direction !== undefined && (light as any).direction) {
		(light as any).direction.copyFrom(toVector3(data.direction));
	}

	if (data.color !== undefined) {
		light.diffuse.copyFrom(toColor3(data.color));
	}

	if (data.intensity !== undefined) {
		light.intensity = data.intensity;
	}

	if (data.range !== undefined && (light instanceof PointLight || light instanceof SpotLight)) {
		light.range = data.range;
	}

	if (data.angle !== undefined && light instanceof SpotLight) {
		light.angle = data.angle;
	}

	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(light);
}

/**
 * Enables/disables a shadow generator on a light and configures it.
 */
const shadowFilterValues = {
	hard: ShadowGenerator.FILTER_NONE,
	poisson: ShadowGenerator.FILTER_POISSONSAMPLING,
	exponential: ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP,
	"blur-exponential": ShadowGenerator.FILTER_BLUREXPONENTIALSHADOWMAP,
	"close-exponential": ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP,
	"blur-close-exponential": ShadowGenerator.FILTER_BLURCLOSEEXPONENTIALSHADOWMAP,
	pcf: ShadowGenerator.FILTER_PCF,
	pcss: ShadowGenerator.FILTER_PCSS,
} as const;

const shadowQualityValues = {
	low: ShadowGenerator.QUALITY_LOW,
	medium: ShadowGenerator.QUALITY_MEDIUM,
	high: ShadowGenerator.QUALITY_HIGH,
} as const;

function summarizeShadowGenerator(generator: ShadowGenerator | null): Record<string, unknown> | null {
	if (!generator) {
		return null;
	}
	const map = generator.getShadowMap();
	return {
		generatorType: generator instanceof CascadedShadowGenerator ? "cascaded" : "classic",
		filter: Object.entries(shadowFilterValues).find(([, value]) => value === generator.filter)?.[0] ?? `unknown-${generator.filter}`,
		filteringQuality: Object.entries(shadowQualityValues).find(([, value]) => value === generator.filteringQuality)?.[0] ?? "unknown",
		mapSize: map?.getSize().width ?? 0,
		mapReady: generator.getShadowMapForRendering()?.isReadyForRendering() ?? false,
		casterCount: map?.renderList?.length ?? 0,
		bias: generator.bias,
		normalBias: generator.normalBias,
		darkness: generator.getDarkness(),
		blurScale: generator.blurScale,
		blurKernel: generator.blurKernel,
		blurBoxOffset: generator.blurBoxOffset,
		useKernelBlur: generator.useKernelBlur,
		depthScale: generator.depthScale,
		contactHardeningLightSizeUVRatio: generator.contactHardeningLightSizeUVRatio,
		transparencyShadow: generator.transparencyShadow,
		enableSoftTransparentShadow: generator.enableSoftTransparentShadow,
		refreshRate: map?.refreshRate ?? null,
		...(generator instanceof CascadedShadowGenerator
			? {
					numCascades: generator.numCascades,
					lambda: generator.lambda,
					stabilizeCascades: generator.stabilizeCascades,
					depthClamp: generator.depthClamp,
					autoCalcDepthBounds: generator.autoCalcDepthBounds,
					autoCalcDepthBoundsRefreshRate: generator.autoCalcDepthBoundsRefreshRate,
					cascadeBlendPercentage: generator.cascadeBlendPercentage,
					penumbraDarkness: generator.penumbraDarkness,
				}
			: {}),
	};
}

export function setLightShadows(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}

	const light = node as IShadowLight;

	if (data.enabled) {
		if (isRectAreaLight(node)) {
			throw new Error(`Area light "${node.name}" does not support realtime shadow generators. Use baked GI or baked SH probes for soft area-light shadows.`);
		}
		const mapSize = data.mapSize ?? 1024;
		const generatorType = data.generatorType ?? "classic";
		const requestedFilter = data.filter ?? (data.useBlurExponentialShadowMap ? "blur-exponential" : light instanceof PointLight ? "hard" : "pcf");

		if (generatorType === "cascaded" && !(light instanceof DirectionalLight)) {
			throw new Error(
				`A CascadedShadowGenerator can only be created on a directional light. Light "${light.name}" is a ${(light as Light).getClassName()}. ` +
					`Use generatorType "classic" instead, or change the light to a directional light.`
			);
		}
		if (generatorType === "cascaded" && !["hard", "pcf", "pcss"].includes(requestedFilter)) {
			throw new Error(`Cascaded shadows support filter "hard", "pcf", or "pcss"; received "${requestedFilter}".`);
		}
		if (light instanceof PointLight && ["pcf", "pcss", "blur-exponential", "blur-close-exponential"].includes(requestedFilter)) {
			throw new Error(
				`Point-light cube shadows do not support "${requestedFilter}" natively. Use "poisson" for soft cube filtering, "exponential", "close-exponential", or "hard".`
			);
		}
		light.getShadowGenerator()?.dispose();

		const generator = generatorType === "cascaded" ? new CascadedShadowGenerator(mapSize, light as DirectionalLight, true) : new ShadowGenerator(mapSize, light, true);

		if (generator instanceof CascadedShadowGenerator) {
			generator.lambda = data.lambda ?? 1;
			generator.depthClamp = true;
			generator.autoCalcDepthBounds = true;
			generator.autoCalcDepthBoundsRefreshRate = 60;

			if (data.numCascades !== undefined) {
				generator.numCascades = data.numCascades;
			}
			generator.stabilizeCascades = data.stabilizeCascades ?? generator.stabilizeCascades;
			generator.depthClamp = data.depthClamp ?? generator.depthClamp;
			generator.autoCalcDepthBounds = data.autoCalcDepthBounds ?? generator.autoCalcDepthBounds;
			generator.autoCalcDepthBoundsRefreshRate = data.autoCalcDepthBoundsRefreshRate ?? generator.autoCalcDepthBoundsRefreshRate;
			generator.cascadeBlendPercentage = data.cascadeBlendPercentage ?? generator.cascadeBlendPercentage;
			generator.penumbraDarkness = data.penumbraDarkness ?? generator.penumbraDarkness;
		}

		generator.filter = shadowFilterValues[requestedFilter as keyof typeof shadowFilterValues];
		generator.filteringQuality = shadowQualityValues[(data.filteringQuality ?? "high") as keyof typeof shadowQualityValues];
		generator.bias = data.bias ?? generator.bias;
		generator.normalBias = data.normalBias ?? generator.normalBias;
		generator.blurScale = data.blurScale ?? generator.blurScale;
		generator.blurKernel = data.blurKernel ?? generator.blurKernel;
		generator.blurBoxOffset = data.blurBoxOffset ?? generator.blurBoxOffset;
		generator.useKernelBlur = data.useKernelBlur ?? generator.useKernelBlur;
		generator.depthScale = data.depthScale ?? generator.depthScale;
		generator.contactHardeningLightSizeUVRatio = data.contactHardeningLightSizeUVRatio ?? generator.contactHardeningLightSizeUVRatio;
		generator.transparencyShadow = data.transparencyShadow ?? true;
		generator.enableSoftTransparentShadow = data.enableSoftTransparentShadow ?? true;

		if (data.darkness !== undefined) {
			generator.setDarkness(data.darkness);
		}

		const shadowMap = generator.getShadowMap();
		shadowMap?.renderList?.push(...scene.meshes);
		if (shadowMap && data.refreshRate !== undefined) {
			shadowMap.refreshRate = data.refreshRate;
		}
	} else {
		light.getShadowGenerator()?.dispose();
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return {
		light: toNodeSummary(node),
		shadow: summarizeShadowGenerator(light.getShadowGenerator() as ShadowGenerator | null),
	};
}

/**
 * Removes the shadow generator (if any) from a light, so it stops casting shadows.
 * After this, a non-shadow light can be moved into the ClusteredLightContainer for performance.
 */
export function removeLightShadows(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}

	const light = node as IShadowLight;

	const generator = light.getShadowGenerator();
	if (generator) {
		generator.dispose();
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

/**
 * Creates the scene's ClusteredLightContainer (or returns the existing one).
 * The container is always present in the editor preview, so this returns its summary.
 */
export function createClusteredLightContainer(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	const container = options.editor.layout.preview.clusteredLightContainer;

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(container);
	});
	options.editor.layout.inspector.setEditedObject(container);

	return toNodeSummary(container);
}

/**
 * Moves a non-shadow light into the scene's ClusteredLightContainer.
 */
export function addLightToClusteredContainer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}

	const light = node as Light;

	if (light.getShadowGenerator()) {
		throw new Error(`Light "${light.name}" casts shadows and cannot be added to the clustered light container.`);
	}
	if (getLightCookieEvidence(light as any)) {
		throw new Error(`Light "${light.name}" has a light cookie and cannot be added to the clustered light container. Clear the cookie first.`);
	}
	if (isRectAreaLight(light)) {
		throw new Error(`Area light "${light.name}" requires Babylon LTC textures and cannot be added to the clustered light container.`);
	}

	if (light instanceof DirectionalLight || light instanceof SpotLight) {
		// These are still supported as clustered lights in Babylon, fall through.
	}

	options.editor.layout.preview.clusteredLightContainer.addLight(light);

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(light);
	});
	options.editor.layout.inspector.setEditedObject(light);

	return toNodeSummary(light);
}

/**
 * Removes a light from the scene's ClusteredLightContainer.
 * The light is automatically added back to the scene as a regular light.
 */
export function removeLightFromClusteredContainer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const container = options.editor.layout.preview.clusteredLightContainer;
	let node: Node;
	try {
		node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	} catch {
		// Clustered lights are detached from the scene's regular light list, so resolve them
		// directly from the container when callers provide the id/name returned by add_light_to_clustered_container.
		const clusteredLight = container.lights.find((light) => light.id === data.nodeId || light.name === data.nodeName);
		if (!clusteredLight) {
			throw new Error(`Clustered light not found: ${data.nodeId ?? data.nodeName ?? "unspecified"}.`);
		}
		node = clusteredLight;
	}

	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}

	const light = node as Light;
	if (!container.lights.includes(light)) {
		throw new Error(`Light "${light.name}" is not part of the clustered light container.`);
	}

	container.removeLight(light);

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(light);
	});
	options.editor.layout.inspector.setEditedObject(light);

	return toNodeSummary(light);
}

export function getLight(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	const light = node as any;
	const shadow = light.getShadowGenerator?.();
	return {
		...toNodeSummary(light),
		className: light.getClassName(),
		position: light.position?.asArray?.() ?? null,
		direction: light.direction?.asArray?.() ?? null,
		diffuse: light.diffuse?.asArray?.() ?? null,
		specular: light.specular?.asArray?.() ?? null,
		intensity: light.intensity,
		range: light.range ?? null,
		angle: light.angle ?? null,
		cookie: getLightCookieEvidence(light as any),
		areaLight: isRectAreaLight(light) ? getAreaLightEvidence(light as any) : null,
		shadow: shadow ? { className: shadow.getClassName(), mapSize: shadow.getShadowMap()?.getSize().width ?? null, darkness: shadow.getDarkness?.() ?? null } : null,
	};
}

function lightCookieProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveLightCookiePath(path: string): string {
	const root = lightCookieProjectDirectory();
	const absolutePath = isAbsolute(path) ? path : join(root, path);
	const containment = relative(root, absolutePath).replace(/\\/g, "/");
	if (containment === ".." || containment.startsWith("../")) {
		throw new Error("Light-cookie textures must stay inside the open project directory.");
	}
	return absolutePath;
}

export function getLightCookie(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	return {
		light: toNodeSummary(node),
		cookie: getLightCookieEvidence(node as any),
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

export async function setLightCookieProperties(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	if (![0, 1, 2].includes(node.getTypeID())) {
		throw new Error(`Light "${node.name}" (${node.getClassName()}) does not support cookies. Use a point, directional, or spot light.`);
	}
	const current = getLightCookieEvidence(node as any);
	if (current && data.expectedRevision !== current.revision) {
		throw new Error(`Light cookie changed after inspection. Expected revision ${data.expectedRevision ?? "missing"}, but the current revision is ${current.revision}.`);
	}
	if (!current && data.expectedRevision !== undefined) {
		throw new Error(`Light "${node.name}" has no cookie revision to lease. Omit expectedRevision when assigning the first texture.`);
	}
	const effectiveNear = data.near ?? current?.near ?? 0.000001;
	const effectiveFar = data.far ?? current?.far ?? 1000;
	if (effectiveFar <= effectiveNear) {
		throw new Error(`Spot-cookie far clip (${effectiveFar}) must be greater than near clip (${effectiveNear}).`);
	}
	if (data.upDirection && Vector3.FromArray(data.upDirection).lengthSquared() < 0.000001) {
		throw new Error("Light-cookie upDirection must be a non-zero vector.");
	}
	let texture: any = getLightCookieTexture(node as any);
	if (data.texturePath !== undefined) {
		const absolutePath = resolveLightCookiePath(data.texturePath);
		if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
			throw new Error(`Light-cookie texture does not exist or is not a file: ${data.texturePath}.`);
		}
		if (node.getTypeID() === 0) {
			const extension = extname(absolutePath).toLowerCase();
			if (![".env", ".dds", ".ktx", ".ktx2"].includes(extension)) {
				throw new Error(`Point-light cookies require a cubemap asset (.env, .dds, .ktx, or .ktx2); received "${extension || "no extension"}".`);
			}
			texture = configureImportedTexture(extension === ".env" ? CubeTexture.CreateFromPrefilteredData(absolutePath, scene) : new CubeTexture(absolutePath, scene));
		} else {
			texture = configureImportedTexture(new Texture(absolutePath, scene));
		}
		const authoredPath = relative(lightCookieProjectDirectory(), absolutePath).replace(/\\/g, "/");
		texture.name = authoredPath;
		(texture as Texture).url = authoredPath;
	}
	if (!texture) {
		throw new Error(`Light "${node.name}" has no cookie texture. Supply texturePath for the initial assignment.`);
	}
	const cookie = setLightCookie(node as any, texture, {
		enabled: data.enabled,
		intensity: data.intensity,
		size: data.size,
		offset: data.offset,
		near: data.near,
		far: data.far,
		upDirection: data.upDirection,
	});
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { light: toNodeSummary(node), cookie, deferredCameras: getDeferredLightingRuntimes(scene as any) };
}

export function clearLightCookie(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Clearing a light cookie requires confirm=true.");
	}
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	const current = getLightCookieEvidence(node as any);
	if (!current) {
		throw new Error(`Light "${node.name}" has no cookie to clear.`);
	}
	if (data.expectedRevision !== current.revision) {
		throw new Error(`Light cookie changed after inspection. Expected revision ${data.expectedRevision}, but the current revision is ${current.revision}.`);
	}
	setLightCookie(node as any, null);
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { light: toNodeSummary(node), cookie: null, deferredCameras: getDeferredLightingRuntimes(scene as any) };
}

export function setLightProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}
	const light = node as any;
	if (isRectAreaLight(light)) {
		throw new Error(`Use set_area_light with the exact current revision to modify area light "${light.name}".`);
	}
	if (data.position && light.position) {
		light.position.copyFrom(toVector3(data.position));
	}
	if (data.direction && light.direction) {
		light.direction.copyFrom(toVector3(data.direction));
	}
	if (data.diffuse) {
		light.diffuse.copyFrom(toColor3(data.diffuse));
	}
	if (data.specular) {
		light.specular.copyFrom(toColor3(data.specular));
	}
	for (const [path, value] of Object.entries(data.properties ?? {})) {
		deepSet(light, path, value);
	}
	options.editor.layout.inspector.setEditedObject(light);
	options.editor.layout.inspector.forceUpdate();
	return getLight(scene, { nodeId: light.id });
}

export function setIblShadows(_scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.enabled === false) {
		disposeIblShadowsRenderingPipeline();
		return { enabled: false, config: null };
	}
	if (!getIblShadowsRenderingPipeline()) {
		createIblShadowsRenderingPipeline(options.editor);
	}
	const current = serializeIblShadowsRenderingPipeline();
	const pipeline = parseIblShadowsRenderingPipeline(options.editor, { ...current, ...(data.properties ?? {}) });
	return {
		enabled: Boolean(getIblShadowsRenderingPipeline()),
		config: {
			resolutionExp: pipeline.resolutionExp,
			sampleDirections: pipeline.sampleDirections,
			shadowRemanence: pipeline.shadowRemanence,
			shadowOpacity: pipeline.shadowOpacity,
		},
	};
}

interface IReflectionProbeMetadata {
	version: 2;
	id: string;
	revision: number;
	intensity: number;
	boxProjection: boolean;
	influencePosition: [number, number, number];
	influenceSize: [number, number, number];
	importance: number;
	blendDistance: number;
	assignedMaterialIds: string[];
}

function reflectionProbeTuple(value: number[]): [number, number, number] {
	return [value[0], value[1], value[2]];
}

function nativeReflectionProbeAssignedMaterials(scene: Scene, probe: ReflectionProbe, includeRuntime = false): any[] {
	return scene.materials.filter((material: any) => {
		if (!includeRuntime && material.doNotSerialize) {
			return false;
		}
		const slot = reflectionProbeTextureSlot(material);
		return slot ? material[slot] === probe.cubeTexture : false;
	});
}

function reflectionProbeMetadata(scene: Scene, probe: ReflectionProbe): IReflectionProbeMetadata {
	const existing = probe.metadata?.[reflectionProbeMetadataKey] as Partial<IReflectionProbeMetadata> | undefined;
	const position = probe.position.asArray() as [number, number, number];
	const boxPosition = probe.cubeTexture.boundingBoxPosition?.asArray() as [number, number, number] | undefined;
	const boxSize = probe.cubeTexture.boundingBoxSize?.asArray() as [number, number, number] | undefined;
	const influenceSize = existing?.influenceSize?.length === 3 ? ([...existing.influenceSize] as [number, number, number]) : (boxSize ?? [1000, 1000, 1000]);
	const defaultBlendDistance = Math.min(100, Math.min(...influenceSize) * 0.5);
	const assignedMaterialIds =
		existing?.version === 2 && Array.isArray(existing.assignedMaterialIds)
			? [...new Set(existing.assignedMaterialIds.filter((id): id is string => typeof id === "string" && !!id && id.length <= 256))]
			: nativeReflectionProbeAssignedMaterials(scene, probe).map((material) => material.id);
	const normalized: IReflectionProbeMetadata = {
		version: 2,
		id: typeof existing?.id === "string" && existing.id ? existing.id : crypto.randomUUID(),
		revision: Number.isInteger(existing?.revision) && existing!.revision! > 0 ? existing!.revision! : 1,
		intensity: Number.isFinite(existing?.intensity) ? Math.max(0, Math.min(16, existing!.intensity!)) : 1,
		boxProjection: existing?.boxProjection ?? Boolean(probe.cubeTexture.boundingBoxSize),
		influencePosition: existing?.influencePosition?.length === 3 ? [...existing.influencePosition] : (boxPosition ?? position),
		influenceSize,
		importance: Number.isInteger(existing?.importance) ? Math.max(0, Math.min(1000, existing!.importance!)) : 1,
		blendDistance: Number.isFinite(existing?.blendDistance) ? existing!.blendDistance! : defaultBlendDistance,
		assignedMaterialIds,
	};
	validateReflectionProbeBlendDistance(normalized.influenceSize, normalized.blendDistance);
	const metadata = (existing && typeof existing === "object" ? existing : {}) as IReflectionProbeMetadata;
	Object.assign(metadata, normalized);
	probe.metadata ??= {};
	probe.metadata[reflectionProbeMetadataKey] = metadata;
	applyReflectionProbeBounds(probe, metadata);
	return metadata;
}

function applyReflectionProbeBounds(probe: ReflectionProbe, metadata: IReflectionProbeMetadata): void {
	if (metadata.boxProjection) {
		probe.cubeTexture.boundingBoxPosition = Vector3.FromArray(metadata.influencePosition);
		probe.cubeTexture.boundingBoxSize = Vector3.FromArray(metadata.influenceSize);
	} else {
		(probe.cubeTexture as any).boundingBoxPosition = null;
		(probe.cubeTexture as any).boundingBoxSize = null;
	}
}

function reflectionProbeTextureSlot(material: any): "reflectionTexture" | "environmentTexture" | "_radianceTexture" | null {
	if ("reflectionTexture" in material) {
		return "reflectionTexture";
	}
	if ("environmentTexture" in material) {
		return "environmentTexture";
	}
	if ("_radianceTexture" in material) {
		return "_radianceTexture";
	}
	return null;
}

function reflectionProbeAssignedMaterials(scene: Scene, probe: ReflectionProbe, includeRuntime = false): any[] {
	const metadata = reflectionProbeMetadata(scene, probe);
	return scene.materials.filter((material: any) =>
		material.doNotSerialize
			? includeRuntime && nativeReflectionProbeAssignedMaterials(scene, probe, true).includes(material)
			: metadata.assignedMaterialIds.includes(material.id)
	);
}

function reconcileReflectionProbeMaterialAssignments(scene: Scene): void {
	const probes = reflectionProbes(scene);
	for (const material of scene.materials.filter((candidate) => !candidate.doNotSerialize)) {
		const slot = reflectionProbeTextureSlot(material as any);
		if (!slot) {
			continue;
		}
		const candidates = probes
			.filter((probe) => reflectionProbeMetadata(scene, probe).assignedMaterialIds.includes(material.id))
			.sort((left, right) => {
				const leftMetadata = reflectionProbeMetadata(scene, left);
				const rightMetadata = reflectionProbeMetadata(scene, right);
				return rightMetadata.importance - leftMetadata.importance || leftMetadata.id.localeCompare(rightMetadata.id);
			});
		const currentTexture = (material as any)[slot];
		const currentIsProbeTexture = probes.some((probe) => currentTexture === probe.cubeTexture);
		if (candidates.length) {
			// Preserve an explicitly authored material cubemap as the exact deferred fallback.
			// Babylon's native forward slot can represent only one texture, so use the
			// highest-priority probe only when that slot is otherwise empty or probe-owned.
			if (!currentTexture || currentIsProbeTexture) {
				(material as any)[slot] = candidates[0].cubeTexture;
			}
		} else if (currentIsProbeTexture) {
			(material as any)[slot] = null;
		}
	}
}

function reflectionProbeAuthoredFingerprint(scene: Scene, probe: ReflectionProbe): string {
	const metadata = reflectionProbeMetadata(scene, probe);
	return JSON.stringify({
		name: probe.name,
		position: probe.position.asArray(),
		refreshRate: probe.refreshRate,
		samples: probe.samples,
		attachedMeshId: (probe as any)._attachedMesh?.id ?? null,
		renderList: probe.renderList?.map((mesh) => mesh.id) ?? null,
		intensity: metadata.intensity,
		boxProjection: metadata.boxProjection,
		influencePosition: metadata.influencePosition,
		influenceSize: metadata.influenceSize,
		importance: metadata.importance,
		blendDistance: metadata.blendDistance,
		assignedMaterialIds: metadata.assignedMaterialIds,
	});
}

function reflectionProbeSummary(scene: Scene, probe: ReflectionProbe): any {
	const metadata = reflectionProbeMetadata(scene, probe);
	const assignedMaterials = reflectionProbeAssignedMaterials(scene, probe);
	const deferredCameras = getDeferredLightingRuntimes(scene as any)
		.filter((runtime) => runtime.iblSources.some((source) => source.kind === "reflection-probe" && source.name === probe.name))
		.map((runtime) => ({
			cameraId: runtime.cameraId,
			cameraName: runtime.cameraName,
			active: runtime.active,
			ready: runtime.iblReady,
			blendModel: runtime.iblProbeBlendModel,
			blendedMeshCount: runtime.iblProbeBlendMeshCount,
		}));
	return {
		id: metadata.id,
		name: probe.name,
		revision: metadata.revision,
		position: probe.position.asArray(),
		size: probe.cubeTexture.getSize().width,
		refreshRate: probe.refreshRate,
		samples: probe.samples,
		ready: probe.cubeTexture.isReadyForRendering(),
		generateMipMaps: !(probe.cubeTexture as any).noMipmap,
		linearSpace: !probe.cubeTexture.gammaSpace,
		intensity: metadata.intensity,
		boxProjection: metadata.boxProjection,
		influencePosition: metadata.influencePosition,
		influenceSize: metadata.influenceSize,
		importance: metadata.importance,
		blendDistance: metadata.blendDistance,
		blendModel: reflectionProbeBlendModel,
		attachedMeshId: (probe as any)._attachedMesh?.id ?? null,
		renderList: probe.renderList?.map((mesh) => mesh.id) ?? null,
		assignedMaterialIds: metadata.assignedMaterialIds,
		assignedMaterialNames: assignedMaterials.map((material) => material.name),
		deferredCameras,
	};
}

function reflectionProbes(scene: Scene): ReflectionProbe[] {
	return ((scene as any).reflectionProbes ??= []);
}

function findReflectionProbe(scene: Scene, data: any): ReflectionProbe {
	if (!data.id && !data.name) {
		throw new Error("Provide the reflection probe id (preferred) or exact name returned by list_reflection_probes.");
	}
	const probe = reflectionProbes(scene).find((value) => reflectionProbeMetadata(scene, value).id === data.id || (!data.id && value.name === data.name));
	if (!probe) {
		throw new Error(`Reflection probe ${data.id ? `id "${data.id}"` : `"${data.name}"`} was not found.`);
	}
	const metadata = reflectionProbeMetadata(scene, probe);
	if (data.expectedRevision !== undefined && data.expectedRevision !== metadata.revision) {
		throw new Error(
			`Reflection probe "${probe.name}" changed after inspection. Expected revision ${data.expectedRevision}, but the current revision is ${metadata.revision}. Call list_reflection_probes again.`
		);
	}
	return probe;
}

/** Lists bounded native realtime reflection probes, assignments, revisions, and deferred execution evidence. */
export function listReflectionProbes(scene: Scene, data: any = {}): any {
	const filtered = reflectionProbes(scene)
		.filter((probe) => !data.id || reflectionProbeMetadata(scene, probe).id === data.id)
		.filter((probe) => !data.name || probe.name === data.name);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 32;
	const page = filtered.slice(offset, offset + limit);
	return {
		total: filtered.length,
		count: page.length,
		offset,
		hasMore: offset + page.length < filtered.length,
		probes: page.map((probe) => reflectionProbeSummary(scene, probe)),
	};
}

/** Creates a native realtime cubemap reflection probe. */
export function createReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	const name = data.name?.trim();
	if (!name) {
		throw new Error("Reflection probes require a non-empty name.");
	}
	if (reflectionProbes(scene).some((probe) => probe.name === name)) {
		throw new Error(`A reflection probe named "${name}" already exists.`);
	}
	const size = data.size ?? 256;
	if (size < 16 || size > 2048 || (size & (size - 1)) !== 0) {
		throw new Error("Reflection-probe size must be a power of two from 16 through 2048.");
	}
	const attachedMesh = data.attachedMeshId || data.attachedMeshName ? (resolveNode({ scene, nodeId: data.attachedMeshId, nodeName: data.attachedMeshName }) as any) : null;
	if (attachedMesh && !attachedMesh.getAbsolutePosition) {
		throw new Error("Reflection probes can only attach to meshes.");
	}
	const renderList = data.renderListIds
		? data.renderListIds.map((id: string) => {
				const mesh = scene.getMeshById(id);
				if (!mesh) {
					throw new Error(`Reflection-probe render-list mesh "${id}" was not found.`);
				}
				return mesh;
			})
		: undefined;
	const influenceSize = data.influenceSize ? reflectionProbeTuple(data.influenceSize) : ([1000, 1000, 1000] as [number, number, number]);
	if (influenceSize.some((value) => !Number.isFinite(value) || value <= 0)) {
		throw new Error("Reflection-probe influenceSize components must all be greater than zero.");
	}
	const importance = data.importance ?? 1;
	if (!Number.isInteger(importance) || importance < 0 || importance > 1000) {
		throw new Error("Reflection-probe importance must be an integer from 0 through 1000.");
	}
	const blendDistance = data.blendDistance ?? Math.min(100, Math.min(...influenceSize) * 0.5);
	validateReflectionProbeBlendDistance(influenceSize, blendDistance);
	const assignedMaterialIds: string[] = data.assignMaterialIds ?? [];
	if (!Array.isArray(assignedMaterialIds) || !assignedMaterialIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)) {
		throw new Error("Reflection-probe assignMaterialIds must be an array of non-empty material ids up to 256 characters each.");
	}
	if (new Set(assignedMaterialIds).size !== assignedMaterialIds.length) {
		throw new Error("Reflection-probe assignMaterialIds must be unique.");
	}
	for (const id of assignedMaterialIds) {
		const material = scene.getMaterialById(id) as any;
		if (!material) {
			throw new Error(`Material "${id}" was not found.`);
		}
		if (!reflectionProbeTextureSlot(material)) {
			throw new Error(`Material "${material.name}" (${material.getClassName()}) has no supported reflection/environment texture slot.`);
		}
	}
	const probe = new ReflectionProbe(name, size, scene, data.generateMipMaps ?? true, data.useFloat ?? false, data.linearSpace ?? false);
	if (data.position) {
		probe.position.copyFrom(toVector3(data.position));
	}
	if (data.refreshRate !== undefined) {
		probe.refreshRate = data.refreshRate;
	}
	if (data.samples !== undefined) {
		probe.samples = data.samples;
	}
	if (attachedMesh) {
		probe.attachToMesh(attachedMesh);
	}
	if (renderList) {
		probe.renderList = renderList;
	}
	const metadata: IReflectionProbeMetadata = {
		version: 2,
		id: crypto.randomUUID(),
		revision: 1,
		intensity: data.intensity ?? 1,
		boxProjection: data.boxProjection ?? false,
		influencePosition: data.influencePosition ? reflectionProbeTuple(data.influencePosition) : (probe.position.asArray() as [number, number, number]),
		influenceSize,
		importance,
		blendDistance,
		assignedMaterialIds: [...assignedMaterialIds],
	};
	probe.metadata ??= {};
	probe.metadata[reflectionProbeMetadataKey] = metadata;
	applyReflectionProbeBounds(probe, metadata);
	reconcileReflectionProbeMaterialAssignments(scene);
	options.editor.layout.inspector.forceUpdate();
	return reflectionProbeSummary(scene, probe);
}

/** Updates reflection-probe capture settings and material assignments. */
export function setReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	const probe = findReflectionProbe(scene, data);
	const metadata = reflectionProbeMetadata(scene, probe);
	if (data.expectedRevision === undefined) {
		throw new Error(`Updating reflection probe "${probe.name}" requires expectedRevision ${metadata.revision} from list_reflection_probes.`);
	}
	if (
		data.assignMaterialIds !== undefined &&
		(!Array.isArray(data.assignMaterialIds) || !data.assignMaterialIds.every((id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256))
	) {
		throw new Error("Reflection-probe assignMaterialIds must be an array of non-empty material ids up to 256 characters each.");
	}
	const before = reflectionProbeAuthoredFingerprint(scene, probe);
	const nextMetadata: IReflectionProbeMetadata = {
		...metadata,
		intensity: data.intensity ?? metadata.intensity,
		boxProjection: data.boxProjection ?? metadata.boxProjection,
		influencePosition: data.influencePosition
			? reflectionProbeTuple(data.influencePosition)
			: data.position
				? reflectionProbeTuple(data.position)
				: [...metadata.influencePosition],
		influenceSize: data.influenceSize ? reflectionProbeTuple(data.influenceSize) : [...metadata.influenceSize],
		importance: data.importance ?? metadata.importance,
		blendDistance: data.blendDistance ?? metadata.blendDistance,
		assignedMaterialIds: data.assignMaterialIds === undefined ? [...metadata.assignedMaterialIds] : [...data.assignMaterialIds],
	};
	if (nextMetadata.influenceSize.some((value) => !Number.isFinite(value) || value <= 0)) {
		throw new Error("Reflection-probe influenceSize components must all be greater than zero.");
	}
	if (!Number.isInteger(nextMetadata.importance) || nextMetadata.importance < 0 || nextMetadata.importance > 1000) {
		throw new Error("Reflection-probe importance must be an integer from 0 through 1000.");
	}
	validateReflectionProbeBlendDistance(nextMetadata.influenceSize, nextMetadata.blendDistance);
	let attachedMesh: any = undefined;
	if (data.attachedMeshId !== undefined || data.attachedMeshName !== undefined) {
		attachedMesh = data.attachedMeshId || data.attachedMeshName ? (resolveNode({ scene, nodeId: data.attachedMeshId, nodeName: data.attachedMeshName }) as any) : null;
		if (attachedMesh && !attachedMesh.getAbsolutePosition) {
			throw new Error("Reflection probes can only attach to meshes.");
		}
	}
	const renderList =
		data.renderListIds === undefined
			? undefined
			: data.renderListIds === null
				? null
				: data.renderListIds.map((id: string) => {
						const mesh = scene.getMeshById(id);
						if (!mesh) {
							throw new Error(`Reflection-probe render-list mesh "${id}" was not found.`);
						}
						return mesh;
					});
	let assignments: string[] | undefined;
	if (data.assignMaterialIds !== undefined) {
		const requestedIds = data.assignMaterialIds as string[];
		if (new Set(requestedIds).size !== requestedIds.length) {
			throw new Error("Reflection-probe assignMaterialIds must be unique.");
		}
		assignments = requestedIds.map((id) => {
			const material = scene.getMaterialById(id) as any;
			if (!material) {
				throw new Error(`Material "${id}" was not found.`);
			}
			const slot = reflectionProbeTextureSlot(material);
			if (!slot) {
				throw new Error(`Material "${material.name}" (${material.getClassName()}) has no supported reflection/environment texture slot.`);
			}
			return id;
		});
	}
	if (data.position) {
		probe.position.copyFrom(toVector3(data.position));
	}
	if (data.refreshRate !== undefined) {
		probe.refreshRate = data.refreshRate;
	}
	if (data.samples !== undefined) {
		probe.samples = data.samples;
	}
	if (attachedMesh !== undefined) {
		probe.attachToMesh(attachedMesh);
	}
	if (renderList !== undefined) {
		probe.renderList = renderList;
	}
	Object.assign(metadata, nextMetadata);
	applyReflectionProbeBounds(probe, metadata);
	if (assignments) {
		metadata.assignedMaterialIds = [...assignments];
	}
	reconcileReflectionProbeMaterialAssignments(scene);
	const afterWithoutRevision = reflectionProbeAuthoredFingerprint(scene, probe);
	if (before !== afterWithoutRevision) {
		metadata.revision++;
	}
	options.editor.layout.inspector.forceUpdate();
	return reflectionProbeSummary(scene, probe);
}

/** Disposes a reflection probe and its generated cubemap. */
export function deleteReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	const probe = findReflectionProbe(scene, data);
	const metadata = reflectionProbeMetadata(scene, probe);
	if (data.confirm !== true) {
		throw new Error(`Deleting reflection probe "${probe.name}" disposes its realtime cubemap. Retry with confirm: true and expectedRevision ${metadata.revision}.`);
	}
	if (data.expectedRevision !== metadata.revision) {
		throw new Error(`Deleting reflection probe "${probe.name}" requires expectedRevision ${metadata.revision}.`);
	}
	const clearedMaterialIds = [...metadata.assignedMaterialIds];
	metadata.assignedMaterialIds = [];
	reconcileReflectionProbeMaterialAssignments(scene);
	for (const material of nativeReflectionProbeAssignedMaterials(scene, probe, true).filter((candidate) => candidate.doNotSerialize)) {
		const slot = reflectionProbeTextureSlot(material)!;
		material[slot] = null;
	}
	probe.dispose();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: metadata.id, name: probe.name, revision: metadata.revision, clearedMaterialIds };
}
