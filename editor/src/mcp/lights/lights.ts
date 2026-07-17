import { Scene, Node, Light, ShadowGenerator, CascadedShadowGenerator, IShadowLight, DirectionalLight, SpotLight, PointLight, ReflectionProbe, Color3, Vector3 } from "babylonjs";

import { isLight } from "../../tools/guards/nodes";

import { addPointLight, addDirectionalLight, addSpotLight, addHemisphericLight } from "../../project/add/light";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toColor3, toVector3 } from "../tools/resolve";
import {
	getIblShadowsRenderingPipeline,
	createIblShadowsRenderingPipeline,
	disposeIblShadowsRenderingPipeline,
	parseIblShadowsRenderingPipeline,
	serializeIblShadowsRenderingPipeline,
} from "../../editor/rendering/ibl-shadows";

type ILightingScenarioLight = {
	nodeId: string;
	nodeName: string;
	enabled: boolean;
	intensity: number;
	diffuse: number[];
	specular: number[];
	position?: number[];
	direction?: number[];
	range?: number;
	angle?: number;
	exponent?: number;
};
type ILightingScenario = { id: string; name: string; lights: ILightingScenarioLight[] };
const activeScenarioBlends = new WeakMap<Scene, any>();

function lightingScenarios(scene: Scene): ILightingScenario[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorLightingScenarios ??= []);
}

function snapshotLight(light: Light): ILightingScenarioLight {
	const source = light as any;
	return {
		nodeId: light.id,
		nodeName: light.name,
		enabled: light.isEnabled(),
		intensity: light.intensity,
		diffuse: light.diffuse.asArray(),
		specular: light.specular.asArray(),
		position: source.position?.asArray(),
		direction: source.direction?.asArray(),
		range: source.range,
		angle: source.angle,
		exponent: source.exponent,
	};
}

/** Lists saved realtime lighting scenarios in the active scene. */
export function listLightingScenarios(scene: Scene): any {
	return { scenarios: structuredClone(lightingScenarios(scene)) };
}

/** Captures selected or all scene lights into a named reusable realtime lighting scenario. */
export function createLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) throw new Error("Lighting scenarios require a non-empty name.");
	if (lightingScenarios(scene).some((scenario) => scenario.name === data.name)) throw new Error(`Lighting scenario \"${data.name}\" already exists.`);
	const selected = data.lightNodeIds?.length ? scene.lights.filter((light) => data.lightNodeIds.includes(light.id)) : scene.lights;
	if (data.lightNodeIds?.length && selected.length !== data.lightNodeIds.length) throw new Error("One or more lightNodeIds were not found in the active scene.");
	const scenario: ILightingScenario = { id: crypto.randomUUID(), name: data.name.trim(), lights: selected.map(snapshotLight) };
	lightingScenarios(scene).push(scenario);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(scenario);
}

/** Applies a saved realtime lighting scenario by stable light id, falling back to its captured name. */
export function applyLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	const scenario = lightingScenarios(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!scenario) throw new Error("Lighting scenario not found. Provide its id (preferred) or name.");
	const applied: string[] = [];
	const missing: string[] = [];
	for (const state of scenario.lights) {
		const light = scene.lights.find((candidate) => candidate.id === state.nodeId || candidate.name === state.nodeName) as any;
		if (!light) {
			missing.push(state.nodeName);
			continue;
		}
		light.setEnabled(state.enabled);
		light.intensity = state.intensity;
		light.diffuse.copyFrom(toColor3(state.diffuse));
		light.specular.copyFrom(toColor3(state.specular));
		if (state.position && light.position) light.position.copyFrom(toVector3(state.position));
		if (state.direction && light.direction) light.direction.copyFrom(toVector3(state.direction));
		if (state.range !== undefined) light.range = state.range;
		if (state.angle !== undefined) light.angle = state.angle;
		if (state.exponent !== undefined) light.exponent = state.exponent;
		applied.push(light.id);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { scenario: structuredClone(scenario), appliedLightIds: applied, missingLightNames: missing };
}

/** Cross-fades realtime light values to a saved lighting scenario in the editor preview. */
export function blendLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	const scenario = lightingScenarios(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!scenario) throw new Error("Lighting scenario not found. Provide its id (preferred) or name.");
	const durationMs = data.durationMs ?? 1000;
	if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60000) throw new Error("Lighting-scenario blend durationMs must be from 0 through 60000.");
	activeScenarioBlends.get(scene)?.remove();
	if (durationMs === 0) return { ...applyLightingScenario(scene, data, options), durationMs: 0, completed: true };
	const starts = new Map<string, ILightingScenarioLight>();
	for (const state of scenario.lights) {
		const light = scene.lights.find((candidate) => candidate.id === state.nodeId || candidate.name === state.nodeName);
		if (light) starts.set(state.nodeId, snapshotLight(light));
	}
	const startedAt = Date.now();
	const observer = scene.onBeforeRenderObservable.add(() => {
		const weight = Math.min(1, (Date.now() - startedAt) / durationMs);
		for (const target of scenario.lights) {
			const source = starts.get(target.nodeId);
			const light = scene.lights.find((candidate) => candidate.id === target.nodeId || candidate.name === target.nodeName) as any;
			if (!source || !light) continue;
			light.setEnabled(weight < 1 ? source.enabled || target.enabled : target.enabled);
			light.intensity = source.intensity + (target.intensity - source.intensity) * weight;
			light.diffuse.copyFrom(Color3.Lerp(Color3.FromArray(source.diffuse), Color3.FromArray(target.diffuse), weight));
			light.specular.copyFrom(Color3.Lerp(Color3.FromArray(source.specular), Color3.FromArray(target.specular), weight));
			if (source.position && target.position && light.position)
				light.position.copyFrom(Vector3.Lerp(Vector3.FromArray(source.position), Vector3.FromArray(target.position), weight));
			if (source.direction && target.direction && light.direction)
				light.direction.copyFrom(Vector3.Lerp(Vector3.FromArray(source.direction), Vector3.FromArray(target.direction), weight));
			for (const property of ["range", "angle", "exponent"] as const)
				if (source[property] !== undefined && target[property] !== undefined && typeof light[property] === "number")
					light[property] = source[property]! + (target[property]! - source[property]!) * weight;
		}
		if (weight === 1) {
			observer.remove();
			activeScenarioBlends.delete(scene);
			options.editor.layout.inspector.forceUpdate();
		}
	});
	activeScenarioBlends.set(scene, observer);
	options.editor.layout.inspector.forceUpdate();
	return { scenario: structuredClone(scenario), durationMs, completed: false };
}

/** Deletes one saved lighting scenario without altering the current scene lights. */
export function deleteLightingScenario(scene: Scene, data: any, options: IMCPActionOptions): any {
	const scenarios = lightingScenarios(scene);
	const index = scenarios.findIndex((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (index < 0) throw new Error("Lighting scenario not found. Provide its id (preferred) or name.");
	const [deleted] = scenarios.splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: deleted.id, name: deleted.name };
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
export function setLightShadows(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isLight(node)) {
		throw new Error(`Node "${node.name}" is not a light.`);
	}

	const light = node as IShadowLight;

	const existing = light.getShadowGenerator();
	if (existing) {
		existing.dispose();
	}

	if (data.enabled) {
		const mapSize = data.mapSize ?? 1024;
		const generatorType = data.generatorType ?? "classic";

		if (generatorType === "cascaded" && !(light instanceof DirectionalLight)) {
			throw new Error(
				`A CascadedShadowGenerator can only be created on a directional light. Light "${light.name}" is a ${(light as Light).getClassName()}. ` +
					`Use generatorType "classic" instead, or change the light to a directional light.`
			);
		}

		const generator = generatorType === "cascaded" ? new CascadedShadowGenerator(mapSize, light as DirectionalLight, true) : new ShadowGenerator(mapSize, light, true);

		if (generator instanceof CascadedShadowGenerator) {
			generator.lambda = data.lambda ?? 1;
			generator.depthClamp = true;
			generator.autoCalcDepthBounds = true;
			generator.autoCalcDepthBoundsRefreshRate = 60;

			if (data.numCascades !== undefined) {
				generator.numCascades = data.numCascades;
			}
		}

		if (!(light instanceof PointLight)) {
			generator.usePercentageCloserFiltering = true;
			generator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
		}

		generator.transparencyShadow = true;
		generator.enableSoftTransparentShadow = true;

		if (data.useBlurExponentialShadowMap !== undefined) {
			generator.useBlurExponentialShadowMap = data.useBlurExponentialShadowMap;
		}

		if (data.darkness !== undefined) {
			generator.setDarkness(data.darkness);
		}

		generator.getShadowMap()?.renderList?.push(...scene.meshes);
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
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
	if (!isLight(node)) throw new Error(`Node "${node.name}" is not a light.`);
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
		shadow: shadow ? { className: shadow.getClassName(), mapSize: shadow.getShadowMap()?.getSize().width ?? null, darkness: shadow.getDarkness?.() ?? null } : null,
	};
}

export function setLightProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isLight(node)) throw new Error(`Node "${node.name}" is not a light.`);
	const light = node as any;
	if (data.position && light.position) light.position.copyFrom(toVector3(data.position));
	if (data.direction && light.direction) light.direction.copyFrom(toVector3(data.direction));
	if (data.diffuse) light.diffuse.copyFrom(toColor3(data.diffuse));
	if (data.specular) light.specular.copyFrom(toColor3(data.specular));
	Object.assign(light, data.properties ?? {});
	options.editor.layout.inspector.setEditedObject(light);
	options.editor.layout.inspector.forceUpdate();
	return getLight(scene, { nodeId: light.id });
}

export function setIblShadows(_scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.enabled === false) {
		disposeIblShadowsRenderingPipeline();
		return { enabled: false, config: null };
	}
	if (!getIblShadowsRenderingPipeline()) createIblShadowsRenderingPipeline(options.editor);
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

function reflectionProbeSummary(probe: ReflectionProbe): any {
	return {
		name: probe.name,
		position: probe.position.asArray(),
		size: probe.cubeTexture.getSize().width,
		refreshRate: probe.refreshRate,
		samples: probe.samples,
		attachedMeshId: (probe as any)._attachedMesh?.id ?? null,
		renderList: probe.renderList?.map((mesh) => mesh.id) ?? null,
	};
}

function reflectionProbes(scene: Scene): ReflectionProbe[] {
	return ((scene as any).reflectionProbes ??= []);
}

function findReflectionProbe(scene: Scene, data: any): ReflectionProbe {
	const probe = reflectionProbes(scene).find((value) => value.name === data.name);
	if (!probe) throw new Error(`Reflection probe "${data.name}" was not found.`);
	return probe;
}

/** Lists native realtime reflection probes that serialize with the scene. */
export function listReflectionProbes(scene: Scene): any {
	return { probes: reflectionProbes(scene).map(reflectionProbeSummary) };
}

/** Creates a native realtime cubemap reflection probe. */
export function createReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (reflectionProbes(scene).some((probe) => probe.name === data.name)) throw new Error(`A reflection probe named "${data.name}" already exists.`);
	const probe = new ReflectionProbe(data.name, data.size ?? 256, scene, data.generateMipMaps ?? true, data.useFloat ?? false, data.linearSpace ?? false);
	if (data.position) probe.position.copyFrom(toVector3(data.position));
	if (data.refreshRate !== undefined) probe.refreshRate = data.refreshRate;
	if (data.samples !== undefined) probe.samples = data.samples;
	if (data.attachedMeshId || data.attachedMeshName) {
		const mesh = resolveNode({ scene, nodeId: data.attachedMeshId, nodeName: data.attachedMeshName }) as any;
		if (!mesh.getAbsolutePosition) throw new Error("Reflection probes can only attach to meshes.");
		probe.attachToMesh(mesh);
	}
	if (data.renderListIds) {
		probe.renderList = data.renderListIds.map((id) => {
			const mesh = scene.getMeshById(id);
			if (!mesh) throw new Error(`Reflection-probe render-list mesh "${id}" was not found.`);
			return mesh;
		});
	}
	options.editor.layout.inspector.forceUpdate();
	return reflectionProbeSummary(probe);
}

/** Updates reflection-probe capture settings and material assignments. */
export function setReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	const probe = findReflectionProbe(scene, data);
	if (data.position) probe.position.copyFrom(toVector3(data.position));
	if (data.refreshRate !== undefined) probe.refreshRate = data.refreshRate;
	if (data.samples !== undefined) probe.samples = data.samples;
	if (data.attachedMeshId !== undefined || data.attachedMeshName !== undefined) {
		const mesh = data.attachedMeshId || data.attachedMeshName ? (resolveNode({ scene, nodeId: data.attachedMeshId, nodeName: data.attachedMeshName }) as any) : null;
		if (mesh && !mesh.getAbsolutePosition) throw new Error("Reflection probes can only attach to meshes.");
		probe.attachToMesh(mesh);
	}
	if (data.renderListIds !== undefined) {
		probe.renderList = data.renderListIds.map((id) => {
			const mesh = scene.getMeshById(id);
			if (!mesh) throw new Error(`Reflection-probe render-list mesh "${id}" was not found.`);
			return mesh;
		});
	}
	if (data.assignMaterialIds) {
		for (const id of data.assignMaterialIds) {
			const material = scene.getMaterialById(id) as any;
			if (!material) throw new Error(`Material "${id}" was not found.`);
			material.reflectionTexture = probe.cubeTexture;
		}
	}
	options.editor.layout.inspector.forceUpdate();
	return reflectionProbeSummary(probe);
}

/** Disposes a reflection probe and its generated cubemap. */
export function deleteReflectionProbe(scene: Scene, data: any, options: IMCPActionOptions): any {
	const probe = findReflectionProbe(scene, data);
	probe.dispose();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, name: data.name };
}
