import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Light } from "@babylonjs/core/Lights/light";
import { Material } from "@babylonjs/core/Materials/material";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Scene } from "@babylonjs/core/scene";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";

import { configureLightProbeVolumes, ILightProbeVolume, lightProbeVolumesMetadataKey, validateLightProbeVolumes } from "./light-probes";

export const lightingScenariosMetadataKey = "babylonEditorLightingScenarios";
export const activeLightingScenarioMetadataKey = "babylonEditorActiveLightingScenarioId";
export const bakedLightingScenarioBackend = "bounded-lightmap-adaptive-sh9-scenario-v1";
export const lightingScenarioRuntimeBackend = "bounded-realtime-baked-scenario-blend-v2";
export const maximumLightingScenarios = 32;
export const maximumLightingScenarioLights = 256;
export const maximumLightingScenarioMeshes = 128;

export interface ILightingScenarioLight {
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
}

export interface ILightingScenarioBakedMesh {
	meshId: string;
	meshName: string;
	materialId: string;
	subMaterialIds: (string | null)[];
	lightmapPath: string;
	coordinatesIndex: number;
}

export interface ILightingScenarioBakedGi {
	sourceBakeId: string;
	outputDirectory: string;
	meshEntries: ILightingScenarioBakedMesh[];
}

export interface ILightingScenarioBakedLighting {
	backend: typeof bakedLightingScenarioBackend;
	bakedGi: ILightingScenarioBakedGi | null;
	lightProbeVolumes: ILightProbeVolume[];
	evidence: {
		lightmapMeshCount: number;
		probeVolumeCount: number;
		probeCount: number;
		cellCount: number;
	};
}

export interface ILightingScenario {
	version: 2;
	id: string;
	name: string;
	revision: number;
	lights: ILightingScenarioLight[];
	bakedLighting: ILightingScenarioBakedLighting | null;
}

export interface ILightingScenarioApplication {
	scenarioId: string;
	scenarioName: string;
	appliedLightIds: string[];
	missingLightNames: string[];
	appliedLightmapMeshIds: string[];
	missingLightmapMeshIds: string[];
	probeVolumeCount: number;
	probeCount: number;
}

export interface ILightingScenarioRuntimeEvidence {
	backend: typeof lightingScenarioRuntimeBackend;
	configured: boolean;
	scenarioCount: number;
	activeScenarioId: string | null;
	activeScenarioName: string | null;
	blending: boolean;
	targetScenarioId: string | null;
	weight: number;
	durationMs: number;
	lightmapMeshCount: number;
	probeVolumeCount: number;
	shaderLanguages: ["GLSL", "WGSL"];
	lastApplication: ILightingScenarioApplication | null;
	error: string | null;
}

function finiteVector(value: unknown, field: string): number[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		throw new Error(`${field} must contain exactly three finite numbers.`);
	}
	return [...value];
}

function validateLightState(value: unknown, field: string): ILightingScenarioLight {
	if (!value || typeof value !== "object") {
		throw new Error(`${field} must be an object.`);
	}
	const source = value as Partial<ILightingScenarioLight>;
	if (typeof source.nodeId !== "string" || !source.nodeId || typeof source.nodeName !== "string" || !source.nodeName) {
		throw new Error(`${field} requires stable nodeId and nodeName strings.`);
	}
	if (typeof source.enabled !== "boolean" || !Number.isFinite(source.intensity) || source.intensity! < 0 || source.intensity! > 100_000) {
		throw new Error(`${field} has an invalid enabled state or intensity.`);
	}
	const diffuse = finiteVector(source.diffuse, `${field}.diffuse`)!;
	const specular = finiteVector(source.specular, `${field}.specular`)!;
	for (const [name, entry] of [
		["range", source.range],
		["angle", source.angle],
		["exponent", source.exponent],
	] as const) {
		if (entry !== undefined && (!Number.isFinite(entry) || entry < 0)) {
			throw new Error(`${field}.${name} must be a non-negative finite number.`);
		}
	}
	return {
		nodeId: source.nodeId,
		nodeName: source.nodeName,
		enabled: source.enabled,
		intensity: source.intensity!,
		diffuse,
		specular,
		position: finiteVector(source.position, `${field}.position`),
		direction: finiteVector(source.direction, `${field}.direction`),
		range: source.range,
		angle: source.angle,
		exponent: source.exponent,
	};
}

function validateBakedLighting(value: unknown, field: string): ILightingScenarioBakedLighting | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (!value || typeof value !== "object") {
		throw new Error(`${field} must be null or a baked-lighting snapshot.`);
	}
	const source = value as Partial<ILightingScenarioBakedLighting>;
	if (source.backend !== bakedLightingScenarioBackend) {
		throw new Error(`${field}.backend is unsupported.`);
	}
	const lightProbeVolumes = validateLightProbeVolumes(source.lightProbeVolumes);
	let bakedGi: ILightingScenarioBakedGi | null = null;
	if (source.bakedGi !== null && source.bakedGi !== undefined) {
		const gi = source.bakedGi as Partial<ILightingScenarioBakedGi>;
		if (typeof gi.sourceBakeId !== "string" || !gi.sourceBakeId || typeof gi.outputDirectory !== "string" || !gi.outputDirectory) {
			throw new Error(`${field}.bakedGi requires a source bake id and output directory.`);
		}
		if (!Array.isArray(gi.meshEntries) || gi.meshEntries.length < 1 || gi.meshEntries.length > maximumLightingScenarioMeshes) {
			throw new Error(`${field}.bakedGi.meshEntries must contain 1–${maximumLightingScenarioMeshes} entries.`);
		}
		const meshIds = new Set<string>();
		const meshEntries = gi.meshEntries.map((entry, index): ILightingScenarioBakedMesh => {
			if (
				!entry ||
				typeof entry.meshId !== "string" ||
				!entry.meshId ||
				meshIds.has(entry.meshId) ||
				typeof entry.meshName !== "string" ||
				!entry.meshName ||
				typeof entry.materialId !== "string" ||
				!entry.materialId ||
				typeof entry.lightmapPath !== "string" ||
				!entry.lightmapPath ||
				!Number.isInteger(entry.coordinatesIndex) ||
				entry.coordinatesIndex < 0 ||
				entry.coordinatesIndex > 1 ||
				!Array.isArray(entry.subMaterialIds) ||
				entry.subMaterialIds.length > 64 ||
				entry.subMaterialIds.some((id) => id !== null && (typeof id !== "string" || !id))
			) {
				throw new Error(`${field}.bakedGi.meshEntries[${index}] is malformed or duplicated.`);
			}
			meshIds.add(entry.meshId);
			return {
				meshId: entry.meshId,
				meshName: entry.meshName,
				materialId: entry.materialId,
				subMaterialIds: [...entry.subMaterialIds],
				lightmapPath: entry.lightmapPath,
				coordinatesIndex: entry.coordinatesIndex,
			};
		});
		bakedGi = { sourceBakeId: gi.sourceBakeId, outputDirectory: gi.outputDirectory, meshEntries };
	}
	if (!source.evidence || typeof source.evidence !== "object") {
		throw new Error(`${field}.evidence is required.`);
	}
	const probeCount = lightProbeVolumes.reduce((sum, volume) => sum + (volume.bake?.probes.length ?? 0), 0);
	const cellCount = lightProbeVolumes.reduce((sum, volume) => sum + (volume.bake?.cells.length ?? 0), 0);
	if (
		source.evidence.lightmapMeshCount !== (bakedGi?.meshEntries.length ?? 0) ||
		source.evidence.probeVolumeCount !== lightProbeVolumes.length ||
		source.evidence.probeCount !== probeCount ||
		source.evidence.cellCount !== cellCount
	) {
		throw new Error(`${field}.evidence does not match its baked payload.`);
	}
	return {
		backend: bakedLightingScenarioBackend,
		bakedGi,
		lightProbeVolumes,
		evidence: { lightmapMeshCount: bakedGi?.meshEntries.length ?? 0, probeVolumeCount: lightProbeVolumes.length, probeCount, cellCount },
	};
}

/** Validates and migrates persisted realtime/baked lighting scenarios before runtime use. */
export function validateLightingScenarios(value: unknown): ILightingScenario[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumLightingScenarios) {
		throw new Error(`Lighting scenarios must be an array of at most ${maximumLightingScenarios} entries.`);
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	return value.map((entry, index): ILightingScenario => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`Lighting scenario ${index} must be an object.`);
		}
		const source = entry as Partial<ILightingScenario>;
		if (typeof source.id !== "string" || !source.id || ids.has(source.id)) {
			throw new Error(`Lighting scenario ${index} has an invalid or duplicate id.`);
		}
		if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128 || names.has(source.name.trim())) {
			throw new Error(`Lighting scenario ${index} has an invalid or duplicate name.`);
		}
		if (source.version !== undefined && source.version !== 2) {
			throw new Error(`Lighting scenario ${index} has an unsupported version.`);
		}
		if (source.revision !== undefined && (!Number.isInteger(source.revision) || source.revision < 1)) {
			throw new Error(`Lighting scenario ${index}.revision must be a positive integer.`);
		}
		if (!Array.isArray(source.lights) || source.lights.length > maximumLightingScenarioLights) {
			throw new Error(`Lighting scenario ${index}.lights must contain at most ${maximumLightingScenarioLights} entries.`);
		}
		ids.add(source.id);
		names.add(source.name.trim());
		return {
			version: 2,
			id: source.id,
			name: source.name.trim(),
			revision: source.revision ?? 1,
			lights: source.lights.map((light, lightIndex) => validateLightState(light, `Lighting scenario ${index}.lights[${lightIndex}]`)),
			bakedLighting: validateBakedLighting(source.bakedLighting, `Lighting scenario ${index}.bakedLighting`),
		};
	});
}

/** Captures one realtime light state in the portable scenario model. */
export function snapshotLightingScenarioLight(light: Light): ILightingScenarioLight {
	const source = light as Light & { position?: Vector3; direction?: Vector3; range?: number; angle?: number; exponent?: number };
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

function applyLight(light: Light, state: ILightingScenarioLight, weight = 1, source = snapshotLightingScenarioLight(light)): void {
	const target = light as Light & { position?: Vector3; direction?: Vector3; range?: number; angle?: number; exponent?: number };
	light.setEnabled(weight < 1 ? source.enabled || state.enabled : state.enabled);
	light.intensity = source.intensity + (state.intensity - source.intensity) * weight;
	light.diffuse.copyFrom(Color3.Lerp(Color3.FromArray(source.diffuse), Color3.FromArray(state.diffuse), weight));
	light.specular.copyFrom(Color3.Lerp(Color3.FromArray(source.specular), Color3.FromArray(state.specular), weight));
	if (state.position && target.position) {
		target.position.copyFrom(Vector3.Lerp(Vector3.FromArray(source.position ?? target.position.asArray()), Vector3.FromArray(state.position), weight));
	}
	if (state.direction && target.direction) {
		target.direction.copyFrom(Vector3.Lerp(Vector3.FromArray(source.direction ?? target.direction.asArray()), Vector3.FromArray(state.direction), weight));
	}
	for (const property of ["range", "angle", "exponent"] as const) {
		if (state[property] !== undefined && typeof target[property] === "number") {
			target[property] = source[property]! + (state[property]! - source[property]!) * weight;
		}
	}
}

function findMaterial(scene: Scene, id: string): Material | null {
	return scene.materials.find((material) => material.id === id) ?? scene.multiMaterials.find((material) => material.id === id) ?? null;
}

function materialLeaves(material: Material): (PBRMaterial | StandardMaterial | null)[] {
	const leaves = material instanceof MultiMaterial ? material.subMaterials : [material];
	return leaves.map((leaf) => (leaf instanceof PBRMaterial || leaf instanceof StandardMaterial ? leaf : null));
}

class BakedLightingScenarioMaterialPlugin extends MaterialPluginBase {
	private _target: BaseTexture;
	private _weight = 0;

	public constructor(
		material: PBRMaterial | StandardMaterial,
		target: BaseTexture,
		private readonly _pbr: boolean
	) {
		super(material, "BabylonEditorBakedLightingScenario", 195, undefined, true, true);
		this._target = target;
		this.doNotSerialize = true;
	}

	public override getClassName(): string {
		return "BabylonEditorBakedLightingScenarioMaterialPlugin";
	}

	public override isCompatible(shaderLanguage: ShaderLanguage): boolean {
		return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
	}

	public override isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean {
		return this._target.isReady();
	}

	public override getSamplers(samplers: string[]): void {
		samplers.push("babylonEditorScenarioLightmapSampler");
	}

	public override getUniforms(): { externalUniforms: string[] } {
		return { externalUniforms: ["babylonEditorScenarioLightmapWeight"] };
	}

	public override bindForSubMesh(_uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
		const effect = subMesh.effect;
		if (effect) {
			effect.setTexture("babylonEditorScenarioLightmapSampler", this._target);
			effect.setFloat("babylonEditorScenarioLightmapWeight", this._weight);
		}
	}

	public setTarget(target: BaseTexture, weight: number): void {
		this._target = target;
		this._weight = Math.max(0, Math.min(1, weight));
	}

	public setWeight(weight: number): void {
		this._weight = Math.max(0, Math.min(1, weight));
	}

	public override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
		if (shaderType !== "fragment") {
			return null;
		}
		if (shaderLanguage === ShaderLanguage.WGSL) {
			return this._pbr
				? {
						CUSTOM_FRAGMENT_DEFINITIONS: `uniform babylonEditorScenarioLightmapWeight: f32;
var babylonEditorScenarioLightmapSampler: texture_2d<f32>;
var babylonEditorScenarioLightmapSamplerSampler: sampler;`,
						CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `var babylonEditorScenarioLightmap: vec4f = TEXRD(babylonEditorScenarioLightmapSampler, babylonEditorScenarioLightmapSamplerSampler, fragmentInputs.vLightmapUV + uvOffset);
lightmapColor = mix(lightmapColor, babylonEditorScenarioLightmap, uniforms.babylonEditorScenarioLightmapWeight);`,
					}
				: {
						CUSTOM_FRAGMENT_DEFINITIONS: `uniform babylonEditorScenarioLightmapWeight: f32;
var babylonEditorScenarioLightmapSampler: texture_2d<f32>;
var babylonEditorScenarioLightmapSamplerSampler: sampler;`,
						CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `var babylonEditorScenarioLightmap: vec4f = TEXRD(babylonEditorScenarioLightmapSampler, babylonEditorScenarioLightmapSamplerSampler, fragmentInputs.vLightmapUV + uvOffset);
color = vec4f(color.rgb + (babylonEditorScenarioLightmap.rgb - lightmapColor.rgb) * baseColor.rgb * uniforms.babylonEditorScenarioLightmapWeight, color.a);`,
					};
		}
		return this._pbr
			? {
					CUSTOM_FRAGMENT_DEFINITIONS: `uniform float babylonEditorScenarioLightmapWeight;
uniform sampler2D babylonEditorScenarioLightmapSampler;`,
					CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `vec4 babylonEditorScenarioLightmap = TEXRD(babylonEditorScenarioLightmapSampler, vLightmapUV + uvOffset);
lightmapColor = mix(lightmapColor, babylonEditorScenarioLightmap, babylonEditorScenarioLightmapWeight);`,
				}
			: {
					CUSTOM_FRAGMENT_DEFINITIONS: `uniform float babylonEditorScenarioLightmapWeight;
uniform sampler2D babylonEditorScenarioLightmapSampler;`,
					CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `vec4 babylonEditorScenarioLightmap = TEXRD(babylonEditorScenarioLightmapSampler, vLightmapUV + uvOffset);
color.rgb += (babylonEditorScenarioLightmap.rgb - lightmapColor.rgb) * baseColor.rgb * babylonEditorScenarioLightmapWeight;`,
				};
	}
}

const scenarioPlugins = new WeakMap<Material, BakedLightingScenarioMaterialPlugin>();

function configureScenarioPlugin(material: PBRMaterial | StandardMaterial, target: BaseTexture, weight: number): BakedLightingScenarioMaterialPlugin {
	let plugin = scenarioPlugins.get(material);
	if (!plugin) {
		plugin = new BakedLightingScenarioMaterialPlugin(material, target, material instanceof PBRMaterial);
		scenarioPlugins.set(material, plugin);
		material.onDisposeObservable.addOnce(() => scenarioPlugins.delete(material));
	}
	plugin.setTarget(target, weight);
	return plugin;
}

interface IPreparedLightmapBlend {
	mesh: AbstractMesh;
	targetMaterial: Material;
	plugins: BakedLightingScenarioMaterialPlugin[];
}

/** Shared runtime controller for realtime lights, retained lightmaps, and adaptive SH9 scenarios. */
export class LightingScenarioController {
	private _observer: { remove: () => void } | null = null;
	private _blendPlugins: BakedLightingScenarioMaterialPlugin[] = [];
	private _targetScenario: ILightingScenario | null = null;
	private _blendWeight = 0;
	private _durationMs = 0;
	private _lastApplication: ILightingScenarioApplication | null = null;

	public constructor(
		private readonly _scene: Scene,
		private readonly _scenarios: ILightingScenario[],
		private readonly _error: string | null = null
	) {}

	public apply(idOrName: string): boolean {
		return this.applyWithEvidence(idOrName) !== null;
	}

	public applyWithEvidence(idOrName: string): ILightingScenarioApplication | null {
		const scenario = this._find(idOrName);
		if (!scenario) {
			return null;
		}
		this._cancelBlend();
		const targets = this._prepareLightmapTargets(scenario, false);
		const appliedLightIds: string[] = [];
		const missingLightNames: string[] = [];
		for (const state of scenario.lights) {
			const light = this._scene.lights.find((candidate) => candidate.id === state.nodeId || candidate.name === state.nodeName);
			if (light) {
				applyLight(light, state);
				appliedLightIds.push(light.id);
			} else {
				missingLightNames.push(state.nodeName);
			}
		}
		for (const target of targets.assignments) {
			target.mesh.material = target.targetMaterial;
		}
		if (scenario.bakedLighting) {
			this._scene.metadata ??= {};
			this._scene.metadata[lightProbeVolumesMetadataKey] = structuredClone(scenario.bakedLighting.lightProbeVolumes);
			configureLightProbeVolumes(this._scene);
		}
		this._scene.metadata ??= {};
		this._scene.metadata[activeLightingScenarioMetadataKey] = scenario.id;
		this._lastApplication = {
			scenarioId: scenario.id,
			scenarioName: scenario.name,
			appliedLightIds,
			missingLightNames,
			appliedLightmapMeshIds: targets.assignments.map((target) => target.mesh.id),
			missingLightmapMeshIds: targets.missingMeshIds,
			probeVolumeCount: scenario.bakedLighting?.evidence.probeVolumeCount ?? 0,
			probeCount: scenario.bakedLighting?.evidence.probeCount ?? 0,
		};
		return structuredClone(this._lastApplication);
	}

	public blendTo(idOrName: string, durationMs: number): boolean {
		return this.blendToWithEvidence(idOrName, durationMs) !== null;
	}

	public blendToWithEvidence(idOrName: string, durationMs: number): ILightingScenarioRuntimeEvidence | null {
		const scenario = this._find(idOrName);
		if (!scenario || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60_000) {
			return null;
		}
		if (durationMs === 0) {
			this.applyWithEvidence(idOrName);
			return this.inspect();
		}
		const targets = this._prepareLightmapTargets(scenario, true);
		this._cancelBlend();
		const starts = new Map<string, ILightingScenarioLight>();
		for (const state of scenario.lights) {
			const light = this._scene.lights.find((candidate) => candidate.id === state.nodeId || candidate.name === state.nodeName);
			if (light) {
				starts.set(state.nodeId, snapshotLightingScenarioLight(light));
			}
		}
		this._blendPlugins = targets.assignments.flatMap((target) => target.plugins);
		this._targetScenario = scenario;
		this._durationMs = durationMs;
		this._blendWeight = 0;
		if (scenario.bakedLighting) {
			const probeRuntime = this._scene.lightProbeVolumes ?? configureLightProbeVolumes(this._scene);
			probeRuntime.setScenarioBlend(scenario.bakedLighting.lightProbeVolumes, 0);
		}
		const startedAt = Date.now();
		this._observer = this._scene.onBeforeRenderObservable.add(() => {
			const weight = Math.min(1, (Date.now() - startedAt) / durationMs);
			this._blendWeight = weight;
			for (const target of scenario.lights) {
				const light = this._scene.lights.find((candidate) => candidate.id === target.nodeId || candidate.name === target.nodeName);
				const start = starts.get(target.nodeId);
				if (light && start) {
					applyLight(light, target, weight, start);
				}
			}
			this._blendPlugins.forEach((plugin) => plugin.setWeight(weight));
			if (scenario.bakedLighting) {
				this._scene.lightProbeVolumes?.setScenarioBlend(scenario.bakedLighting.lightProbeVolumes, weight);
			}
			if (weight === 1) {
				this.applyWithEvidence(scenario.id);
			}
		});
		return this.inspect();
	}

	public inspect(): ILightingScenarioRuntimeEvidence {
		const activeId = (this._scene.metadata?.[activeLightingScenarioMetadataKey] as string | undefined) ?? null;
		const active = activeId ? this._find(activeId) : null;
		return {
			backend: lightingScenarioRuntimeBackend,
			configured: this._scenarios.length > 0 && !this._error,
			scenarioCount: this._scenarios.length,
			activeScenarioId: activeId,
			activeScenarioName: active?.name ?? null,
			blending: this._observer !== null,
			targetScenarioId: this._targetScenario?.id ?? null,
			weight: this._blendWeight,
			durationMs: this._durationMs,
			lightmapMeshCount: this._targetScenario?.bakedLighting?.evidence.lightmapMeshCount ?? 0,
			probeVolumeCount: this._targetScenario?.bakedLighting?.evidence.probeVolumeCount ?? 0,
			shaderLanguages: ["GLSL", "WGSL"],
			lastApplication: this._lastApplication ? structuredClone(this._lastApplication) : null,
			error: this._error,
		};
	}

	/** Stops an in-progress blend owned by this controller. */
	public dispose(): void {
		this._cancelBlend();
	}

	private _prepareLightmapTargets(
		scenario: ILightingScenario,
		forBlend: boolean
	): { assignments: { mesh: AbstractMesh; targetMaterial: Material; plugins: BakedLightingScenarioMaterialPlugin[] }[]; missingMeshIds: string[] } {
		const prepared: { mesh: AbstractMesh; targetMaterial: Material; pairs: { source: PBRMaterial | StandardMaterial; target: PBRMaterial | StandardMaterial }[] }[] = [];
		const missingMeshIds: string[] = [];
		for (const entry of scenario.bakedLighting?.bakedGi?.meshEntries ?? []) {
			const mesh = this._scene.getMeshById(entry.meshId);
			if (!mesh) {
				missingMeshIds.push(entry.meshId);
				continue;
			}
			const targetMaterial = findMaterial(this._scene, entry.materialId);
			if (!targetMaterial) {
				throw new Error(`Lighting scenario "${scenario.name}" is missing retained material ${entry.materialId} for mesh "${entry.meshName}".`);
			}
			const targetLeaves = materialLeaves(targetMaterial);
			if (targetLeaves.some((leaf) => leaf === null)) {
				throw new Error(`Lighting scenario "${scenario.name}" retained material for mesh "${entry.meshName}" is not PBR/Standard compatible.`);
			}
			const actualTargetIds = targetMaterial instanceof MultiMaterial ? targetMaterial.subMaterials.map((material) => material?.id ?? null) : [targetMaterial.id];
			if (actualTargetIds.length !== entry.subMaterialIds.length || actualTargetIds.some((id, index) => id !== entry.subMaterialIds[index])) {
				throw new Error(`Lighting scenario "${scenario.name}" retained material topology changed for mesh "${entry.meshName}".`);
			}
			const pairs: { source: PBRMaterial | StandardMaterial; target: PBRMaterial | StandardMaterial }[] = [];
			if (forBlend) {
				if (!mesh.material) {
					throw new Error(`Mesh "${entry.meshName}" has no current lightmapped material. Apply a baked scenario instantly before blending.`);
				}
				const sourceLeaves = materialLeaves(mesh.material);
				if (sourceLeaves.length !== targetLeaves.length) {
					throw new Error(`Mesh "${entry.meshName}" has incompatible source/target lightmap material topology.`);
				}
				for (let index = 0; index < sourceLeaves.length; index++) {
					const source = sourceLeaves[index];
					const target = targetLeaves[index];
					if (!source || !target || source.getClassName() !== target.getClassName() || !source.lightmapTexture || !target.lightmapTexture) {
						throw new Error(`Mesh "${entry.meshName}" requires matching PBR/Standard lightmap leaves before a baked blend.`);
					}
					if (source.lightmapTexture.coordinatesIndex !== target.lightmapTexture.coordinatesIndex) {
						throw new Error(`Mesh "${entry.meshName}" source/target lightmaps use different UV channels.`);
					}
					pairs.push({ source, target });
				}
			}
			prepared.push({ mesh, targetMaterial, pairs });
		}
		const assignments: IPreparedLightmapBlend[] = prepared.map((target) => ({
			mesh: target.mesh,
			targetMaterial: target.targetMaterial,
			plugins: target.pairs.map((pair) => configureScenarioPlugin(pair.source, pair.target.lightmapTexture!, 0)),
		}));
		return { assignments, missingMeshIds };
	}

	private _cancelBlend(): void {
		this._observer?.remove();
		this._observer = null;
		this._blendPlugins.forEach((plugin) => plugin.setWeight(0));
		this._blendPlugins = [];
		this._scene.lightProbeVolumes?.clearScenarioBlend();
		this._targetScenario = null;
		this._blendWeight = 0;
		this._durationMs = 0;
	}

	private _find(idOrName: string): ILightingScenario | undefined {
		return this._scenarios.find((scenario) => scenario.id === idOrName || scenario.name === idOrName);
	}
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		lightingScenarios?: LightingScenarioController;
	}
}

/** Rebuilds the shared editor/export controller from persisted versioned scenario metadata. */
export function configureLightingScenarios(scene: Scene): LightingScenarioController {
	scene.lightingScenarios?.dispose();
	let scenarios: ILightingScenario[] = [];
	let error: string | null = null;
	try {
		scenarios = validateLightingScenarios(scene.metadata?.[lightingScenariosMetadataKey]);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : "Lighting-scenario metadata is invalid.";
	}
	const controller = new LightingScenarioController(scene, scenarios, error);
	scene.lightingScenarios = controller;
	return controller;
}
