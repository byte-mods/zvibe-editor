import { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Material } from "@babylonjs/core/Materials/material";
import { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { Scene } from "@babylonjs/core/scene";

export const lightProbeVolumesMetadataKey = "babylonEditorLightProbeVolumes";
export const lightProbeRuntimeBackend = "bounded-adaptive-sh9-material-plugin-v1";
export const maximumLightProbeVolumes = 16;
export const maximumLightProbesPerVolume = 4096;
export const maximumLightProbeCellsPerVolume = 8192;
export const maximumLightProbeTargetsPerVolume = 256;

export interface ILightProbeSample {
	position: [number, number, number];
	/** Nine pre-scaled RGB spherical-harmonic coefficients in Babylon l00..l22 order. */
	coefficients: number[];
	validity: number;
	rays: number;
}

export interface ILightProbeCell {
	minimum: [number, number, number];
	maximum: [number, number, number];
	/** Corner order is x + 2*y + 4*z. */
	probeIndices: [number, number, number, number, number, number, number, number];
	level: number;
}

export interface ILightProbeBakeEvidence {
	probeCount: number;
	cellCount: number;
	baseCellCount: number;
	refinedCellCount: number;
	totalRays: number;
	minimumValidity: number;
	averageValidity: number;
	maximumCoefficient: number;
	geometryMeshCount: number;
}

export interface ILightProbeBake {
	bakeId: string;
	backend: "bounded-cpu-adaptive-sh9-v1";
	bakedAt: string;
	samples: number;
	maxDistance: number;
	shadowBias: number;
	environmentIntensity: number;
	directIntensity: number;
	bounceIntensity: number;
	probes: ILightProbeSample[];
	cells: ILightProbeCell[];
	evidence: ILightProbeBakeEvidence;
}

export interface ILightProbeVolume {
	version: 1;
	id: string;
	name: string;
	revision: number;
	enabled: boolean;
	priority: number;
	minimum: [number, number, number];
	maximum: [number, number, number];
	baseResolution: [number, number, number];
	adaptiveLevels: number;
	blendDistance: number;
	targetMeshIds: string[];
	bake: ILightProbeBake | null;
}

export interface ILightProbeEvaluation {
	coefficients: number[];
	volumeIds: string[];
	weights: number[];
	cellLevels: number[];
}

export interface ILightProbeRuntimeEvidence {
	backend: typeof lightProbeRuntimeBackend;
	configured: boolean;
	volumeCount: number;
	bakedVolumeCount: number;
	targetMeshCount: number;
	materialPluginCount: number;
	shaderLanguages: ["GLSL", "WGSL"];
	queries: number;
	matchedQueries: number;
	lastMeshId: string | null;
	lastVolumeIds: string[];
	lastCellLevels: number[];
	lastPosition: number[] | null;
	lastL00: number[] | null;
	scenarioBlend: {
		active: boolean;
		weight: number;
		targetVolumeCount: number;
	};
	error: string | null;
}

function finiteTuple(value: unknown, field: string): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		throw new Error(`${field} must contain exactly three finite numbers.`);
	}
	return [value[0], value[1], value[2]];
}

function validateBounds(minimum: [number, number, number], maximum: [number, number, number], field: string): void {
	for (let axis = 0; axis < 3; axis++) {
		if (maximum[axis] <= minimum[axis]) {
			throw new Error(`${field}.maximum must be greater than minimum on every axis.`);
		}
	}
}

function validateBake(bake: unknown, field: string): ILightProbeBake | null {
	if (bake === null || bake === undefined) {
		return null;
	}
	if (!bake || typeof bake !== "object") {
		throw new Error(`${field} must be null or a baked probe payload.`);
	}
	const source = bake as Partial<ILightProbeBake>;
	if (source.backend !== "bounded-cpu-adaptive-sh9-v1" || typeof source.bakeId !== "string" || !source.bakeId || typeof source.bakedAt !== "string") {
		throw new Error(`${field} has an unsupported backend or missing bake identity.`);
	}
	if (!Array.isArray(source.probes) || source.probes.length < 8 || source.probes.length > maximumLightProbesPerVolume) {
		throw new Error(`${field}.probes must contain 8–${maximumLightProbesPerVolume} entries.`);
	}
	if (!Array.isArray(source.cells) || source.cells.length < 1 || source.cells.length > maximumLightProbeCellsPerVolume) {
		throw new Error(`${field}.cells must contain 1–${maximumLightProbeCellsPerVolume} entries.`);
	}
	const probes = source.probes.map((probe, index): ILightProbeSample => {
		const position = finiteTuple(probe?.position, `${field}.probes[${index}].position`);
		if (!Array.isArray(probe?.coefficients) || probe.coefficients.length !== 27 || probe.coefficients.some((entry) => !Number.isFinite(entry))) {
			throw new Error(`${field}.probes[${index}].coefficients must contain exactly 27 finite numbers.`);
		}
		if (!Number.isFinite(probe.validity) || probe.validity < 0 || probe.validity > 1 || !Number.isInteger(probe.rays) || probe.rays < 0) {
			throw new Error(`${field}.probes[${index}] has invalid validity or ray evidence.`);
		}
		return { position, coefficients: [...probe.coefficients], validity: probe.validity, rays: probe.rays };
	});
	const cells = source.cells.map((cell, index): ILightProbeCell => {
		const minimum = finiteTuple(cell?.minimum, `${field}.cells[${index}].minimum`);
		const maximum = finiteTuple(cell?.maximum, `${field}.cells[${index}].maximum`);
		validateBounds(minimum, maximum, `${field}.cells[${index}]`);
		if (
			!Array.isArray(cell.probeIndices) ||
			cell.probeIndices.length !== 8 ||
			cell.probeIndices.some((entry) => !Number.isInteger(entry) || entry < 0 || entry >= probes.length)
		) {
			throw new Error(`${field}.cells[${index}].probeIndices must contain eight valid probe indices.`);
		}
		if (!Number.isInteger(cell.level) || cell.level < 0 || cell.level > 2) {
			throw new Error(`${field}.cells[${index}].level must be an integer from 0 through 2.`);
		}
		return { minimum, maximum, probeIndices: [...cell.probeIndices] as ILightProbeCell["probeIndices"], level: cell.level };
	});
	if (
		!Number.isInteger(source.samples) ||
		source.samples! < 8 ||
		source.samples! > 256 ||
		!Number.isFinite(source.maxDistance) ||
		source.maxDistance! <= 0 ||
		!Number.isFinite(source.shadowBias) ||
		source.shadowBias! <= 0 ||
		!Number.isFinite(source.environmentIntensity) ||
		source.environmentIntensity! < 0 ||
		source.environmentIntensity! > 16 ||
		!Number.isFinite(source.directIntensity) ||
		source.directIntensity! < 0 ||
		source.directIntensity! > 16 ||
		!Number.isFinite(source.bounceIntensity) ||
		source.bounceIntensity! < 0 ||
		source.bounceIntensity! > 16 ||
		!source.evidence ||
		typeof source.evidence !== "object"
	) {
		throw new Error(`${field} has invalid bake settings or evidence.`);
	}
	const evidence = source.evidence as ILightProbeBakeEvidence;
	if (
		evidence.probeCount !== probes.length ||
		evidence.cellCount !== cells.length ||
		!Number.isInteger(evidence.baseCellCount) ||
		evidence.baseCellCount < 1 ||
		!Number.isInteger(evidence.refinedCellCount) ||
		evidence.refinedCellCount < 0 ||
		evidence.refinedCellCount > cells.length ||
		!Number.isInteger(evidence.totalRays) ||
		evidence.totalRays < 0 ||
		!Number.isFinite(evidence.minimumValidity) ||
		evidence.minimumValidity < 0 ||
		evidence.minimumValidity > 1 ||
		!Number.isFinite(evidence.averageValidity) ||
		evidence.averageValidity < 0 ||
		evidence.averageValidity > 1 ||
		!Number.isFinite(evidence.maximumCoefficient) ||
		evidence.maximumCoefficient < 0 ||
		!Number.isInteger(evidence.geometryMeshCount) ||
		evidence.geometryMeshCount < 0
	) {
		throw new Error(`${field}.evidence does not match its bounded probe/cell payload.`);
	}
	return { ...(source as ILightProbeBake), probes, cells };
}

/** Validates and clones persisted light-probe metadata before runtime use. */
export function validateLightProbeVolumes(value: unknown): ILightProbeVolume[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumLightProbeVolumes) {
		throw new Error(`Light-probe metadata must be an array of at most ${maximumLightProbeVolumes} volumes.`);
	}
	const ids = new Set<string>();
	return value.map((entry, index): ILightProbeVolume => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`Light-probe volume ${index} must be an object.`);
		}
		const source = entry as Partial<ILightProbeVolume>;
		if (source.version !== 1 || typeof source.id !== "string" || source.id.length < 1 || source.id.length > 128 || ids.has(source.id)) {
			throw new Error(`Light-probe volume ${index} has an unsupported version, invalid id, or duplicate id.`);
		}
		ids.add(source.id);
		if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 128) {
			throw new Error(`Light-probe volume ${index}.name must contain 1–128 characters.`);
		}
		if (!Number.isInteger(source.revision) || source.revision! < 1 || typeof source.enabled !== "boolean") {
			throw new Error(`Light-probe volume ${index} has an invalid revision or enabled state.`);
		}
		if (!Number.isInteger(source.priority) || source.priority! < -100 || source.priority! > 100) {
			throw new Error(`Light-probe volume ${index}.priority must be an integer from -100 through 100.`);
		}
		const minimum = finiteTuple(source.minimum, `Light-probe volume ${index}.minimum`);
		const maximum = finiteTuple(source.maximum, `Light-probe volume ${index}.maximum`);
		validateBounds(minimum, maximum, `Light-probe volume ${index}`);
		if (!Array.isArray(source.baseResolution) || source.baseResolution.length !== 3 || source.baseResolution.some((axis) => !Number.isInteger(axis) || axis < 2 || axis > 8)) {
			throw new Error(`Light-probe volume ${index}.baseResolution must contain three integers from 2 through 8.`);
		}
		if (!Number.isInteger(source.adaptiveLevels) || source.adaptiveLevels! < 0 || source.adaptiveLevels! > 2) {
			throw new Error(`Light-probe volume ${index}.adaptiveLevels must be an integer from 0 through 2.`);
		}
		if (!Number.isFinite(source.blendDistance) || source.blendDistance! < 0 || source.blendDistance! > 100_000) {
			throw new Error(`Light-probe volume ${index}.blendDistance must be from 0 through 100000 centimeters.`);
		}
		if (
			!Array.isArray(source.targetMeshIds) ||
			source.targetMeshIds.length > maximumLightProbeTargetsPerVolume ||
			source.targetMeshIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
			new Set(source.targetMeshIds).size !== source.targetMeshIds.length
		) {
			throw new Error(`Light-probe volume ${index}.targetMeshIds must contain at most ${maximumLightProbeTargetsPerVolume} unique bounded mesh ids.`);
		}
		const bake = validateBake(source.bake, `Light-probe volume ${index}.bake`);
		if (bake) {
			for (const [probeIndex, probe] of bake.probes.entries()) {
				if (probe.position.some((coordinate, axis) => coordinate < minimum[axis] - 1e-5 || coordinate > maximum[axis] + 1e-5)) {
					throw new Error(`Light-probe volume ${index}.bake.probes[${probeIndex}] lies outside the authored volume bounds.`);
				}
			}
			for (const [cellIndex, cell] of bake.cells.entries()) {
				if (cell.minimum.some((coordinate, axis) => coordinate < minimum[axis] - 1e-5) || cell.maximum.some((coordinate, axis) => coordinate > maximum[axis] + 1e-5)) {
					throw new Error(`Light-probe volume ${index}.bake.cells[${cellIndex}] lies outside the authored volume bounds.`);
				}
			}
		}
		return {
			version: 1,
			id: source.id,
			name: source.name.trim(),
			revision: source.revision!,
			enabled: source.enabled,
			priority: source.priority!,
			minimum,
			maximum,
			baseResolution: [...source.baseResolution] as [number, number, number],
			adaptiveLevels: source.adaptiveLevels!,
			blendDistance: source.blendDistance!,
			targetMeshIds: [...source.targetMeshIds],
			bake,
		};
	});
}

function contains(point: Vector3, minimum: number[], maximum: number[]): boolean {
	return point.x >= minimum[0] && point.x <= maximum[0] && point.y >= minimum[1] && point.y <= maximum[1] && point.z >= minimum[2] && point.z <= maximum[2];
}

function distanceToBounds(point: Vector3, minimum: number[], maximum: number[]): number {
	const dx = Math.max(minimum[0] - point.x, 0, point.x - maximum[0]);
	const dy = Math.max(minimum[1] - point.y, 0, point.y - maximum[1]);
	const dz = Math.max(minimum[2] - point.z, 0, point.z - maximum[2]);
	return Math.hypot(dx, dy, dz);
}

function interpolateCell(volume: ILightProbeVolume, point: Vector3): { coefficients: number[]; level: number } | null {
	const bake = volume.bake;
	if (!bake) {
		return null;
	}
	const clamped = new Vector3(
		Math.min(volume.maximum[0], Math.max(volume.minimum[0], point.x)),
		Math.min(volume.maximum[1], Math.max(volume.minimum[1], point.y)),
		Math.min(volume.maximum[2], Math.max(volume.minimum[2], point.z))
	);
	let selected: ILightProbeCell | null = null;
	for (const cell of bake.cells) {
		if (contains(clamped, cell.minimum, cell.maximum) && (!selected || cell.level > selected.level)) {
			selected = cell;
		}
	}
	if (!selected) {
		return null;
	}
	const tx = Math.min(1, Math.max(0, (clamped.x - selected.minimum[0]) / (selected.maximum[0] - selected.minimum[0])));
	const ty = Math.min(1, Math.max(0, (clamped.y - selected.minimum[1]) / (selected.maximum[1] - selected.minimum[1])));
	const tz = Math.min(1, Math.max(0, (clamped.z - selected.minimum[2]) / (selected.maximum[2] - selected.minimum[2])));
	const output = new Array<number>(27).fill(0);
	for (let corner = 0; corner < 8; corner++) {
		const xWeight = corner & 1 ? tx : 1 - tx;
		const yWeight = corner & 2 ? ty : 1 - ty;
		const zWeight = corner & 4 ? tz : 1 - tz;
		const weight = xWeight * yWeight * zWeight;
		const probe = bake.probes[selected.probeIndices[corner]];
		for (let coefficient = 0; coefficient < 27; coefficient++) {
			output[coefficient] += probe.coefficients[coefficient] * weight;
		}
	}
	return { coefficients: output, level: selected.level };
}

/** Evaluates one validated volume set without changing runtime counters. */
function evaluateVolumeSet(volumes: ILightProbeVolume[], mesh: AbstractMesh, position: Vector3): ILightProbeEvaluation | null {
	const candidates: { volume: ILightProbeVolume; weight: number; coefficients: number[]; level: number }[] = [];
	for (const volume of volumes) {
		if (!volume.enabled || !volume.bake || !volume.targetMeshIds.includes(mesh.id)) {
			continue;
		}
		const distance = distanceToBounds(position, volume.minimum, volume.maximum);
		if (distance > volume.blendDistance || (volume.blendDistance === 0 && distance > 0)) {
			continue;
		}
		const interpolated = interpolateCell(volume, position);
		if (!interpolated) {
			continue;
		}
		const weight = distance === 0 || volume.blendDistance === 0 ? 1 : Math.max(0, 1 - distance / volume.blendDistance);
		candidates.push({ volume, weight, coefficients: interpolated.coefficients, level: interpolated.level });
	}
	if (!candidates.length) {
		return null;
	}
	const maximumPriority = Math.max(...candidates.map((candidate) => candidate.volume.priority));
	let totalWeight = 0;
	for (const candidate of candidates) {
		candidate.weight *= Math.pow(0.5, maximumPriority - candidate.volume.priority);
		totalWeight += candidate.weight;
	}
	if (totalWeight <= 0) {
		return null;
	}
	const coefficients = new Array<number>(27).fill(0);
	for (const candidate of candidates) {
		const normalized = candidate.weight / totalWeight;
		for (let index = 0; index < coefficients.length; index++) {
			coefficients[index] += candidate.coefficients[index] * normalized;
		}
	}
	return {
		coefficients,
		volumeIds: candidates.map((candidate) => candidate.volume.id),
		weights: candidates.map((candidate) => candidate.weight / totalWeight),
		cellLevels: candidates.map((candidate) => candidate.level),
	};
}

class LightProbeVolumeMaterialPlugin extends MaterialPluginBase {
	public constructor(
		material: Material,
		private readonly _scene: Scene,
		private readonly _pbr: boolean
	) {
		super(material, "BabylonEditorLightProbeVolume", 190, undefined, true, true);
		this.doNotSerialize = true;
	}

	public override getClassName(): string {
		return "BabylonEditorLightProbeVolumeMaterialPlugin";
	}

	public override isCompatible(shaderLanguage: ShaderLanguage): boolean {
		return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
	}

	public override isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean {
		return true;
	}

	public override getUniforms(): { externalUniforms: string[] } {
		return { externalUniforms: ["babylonEditorProbeEnabled", "babylonEditorProbeSH"] };
	}

	public override bindForSubMesh(_uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
		const effect = subMesh.effect;
		if (!effect) {
			return;
		}
		// The shared registry is declared after the plugin class so it can retain the concrete runtime type.
		// eslint-disable-next-line no-use-before-define
		const controller = lightProbeRuntimes.get(this._scene);
		const mesh = subMesh.getEffectiveMesh();
		const evaluation = controller?.evaluate(mesh) ?? null;
		effect.setFloat("babylonEditorProbeEnabled", evaluation ? 1 : 0);
		// eslint-disable-next-line no-use-before-define
		effect.setArray3("babylonEditorProbeSH", evaluation?.coefficients ?? zeroCoefficients);
	}

	public override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
		if (shaderType !== "fragment") {
			return null;
		}
		if (shaderLanguage === ShaderLanguage.WGSL) {
			return {
				CUSTOM_FRAGMENT_DEFINITIONS: `
uniform babylonEditorProbeEnabled: f32;
uniform babylonEditorProbeSH: array<vec3f, 9>;
fn babylonEditorEvaluateProbe(normal: vec3f) -> vec3f {
	var result = uniforms.babylonEditorProbeSH[0]
		+ uniforms.babylonEditorProbeSH[1] * normal.y
		+ uniforms.babylonEditorProbeSH[2] * normal.z
		+ uniforms.babylonEditorProbeSH[3] * normal.x
		+ uniforms.babylonEditorProbeSH[4] * (normal.y * normal.x)
		+ uniforms.babylonEditorProbeSH[5] * (normal.y * normal.z)
		+ uniforms.babylonEditorProbeSH[6] * ((3.0 * normal.z * normal.z) - 1.0)
		+ uniforms.babylonEditorProbeSH[7] * (normal.z * normal.x)
		+ uniforms.babylonEditorProbeSH[8] * ((normal.x * normal.x) - (normal.y * normal.y));
	return max(result, vec3f(0.0)) * uniforms.babylonEditorProbeEnabled;
}`,
				...(this._pbr
					? { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "finalDiffuse += babylonEditorEvaluateProbe(normalW) * surfaceAlbedo.rgb;" }
					: { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "color = vec4f(color.rgb + babylonEditorEvaluateProbe(normalW) * baseColor.rgb, color.a);" }),
			};
		}
		return {
			CUSTOM_FRAGMENT_DEFINITIONS: `
uniform float babylonEditorProbeEnabled;
uniform vec3 babylonEditorProbeSH[9];
vec3 babylonEditorEvaluateProbe(vec3 normal) {
	vec3 result = babylonEditorProbeSH[0]
		+ babylonEditorProbeSH[1] * normal.y
		+ babylonEditorProbeSH[2] * normal.z
		+ babylonEditorProbeSH[3] * normal.x
		+ babylonEditorProbeSH[4] * (normal.y * normal.x)
		+ babylonEditorProbeSH[5] * (normal.y * normal.z)
		+ babylonEditorProbeSH[6] * ((3.0 * normal.z * normal.z) - 1.0)
		+ babylonEditorProbeSH[7] * (normal.z * normal.x)
		+ babylonEditorProbeSH[8] * ((normal.x * normal.x) - (normal.y * normal.y));
	return max(result, vec3(0.0)) * babylonEditorProbeEnabled;
}`,
			...(this._pbr
				? { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: "finalDiffuse += babylonEditorEvaluateProbe(normalW) * surfaceAlbedo.rgb;" }
				: { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "color.rgb += babylonEditorEvaluateProbe(normalW) * baseColor.rgb;" }),
		};
	}
}

const zeroCoefficients = new Array<number>(27).fill(0);
const lightProbeRuntimes = new WeakMap<Scene, LightProbeVolumeRuntime>();
const materialPlugins = new WeakMap<Material, LightProbeVolumeMaterialPlugin>();
const scenesWithDisposeCleanup = new WeakSet<Scene>();

function attachMaterialPlugin(material: Material, scene: Scene): boolean {
	if (materialPlugins.has(material)) {
		return material instanceof PBRMaterial || material instanceof StandardMaterial;
	}
	if (!(material instanceof PBRMaterial) && !(material instanceof StandardMaterial)) {
		return false;
	}
	const plugin = new LightProbeVolumeMaterialPlugin(material, scene, material instanceof PBRMaterial);
	materialPlugins.set(material, plugin);
	material.onDisposeObservable.addOnce(() => materialPlugins.delete(material));
	return true;
}

/** Shared preview/export runtime for adaptive probe lookup, overlap blending, and material binding. */
export class LightProbeVolumeRuntime {
	private _materialPluginCount = 0;
	private _queries = 0;
	private _matchedQueries = 0;
	private _lastMeshId: string | null = null;
	private _lastVolumeIds: string[] = [];
	private _lastCellLevels: number[] = [];
	private _lastPosition: number[] | null = null;
	private _lastL00: number[] | null = null;
	private _scenarioBlendVolumes: ILightProbeVolume[] | null = null;
	private _scenarioBlendWeight = 0;
	private _materialObserver: { remove: () => void } | null = null;

	public constructor(
		_scene: Scene,
		public readonly volumes: ILightProbeVolume[],
		private readonly _error: string | null = null
	) {
		for (const material of _scene.materials) {
			if (attachMaterialPlugin(material, _scene)) {
				this._materialPluginCount++;
			}
		}
		this._materialObserver = _scene.onNewMaterialAddedObservable.add((material) => {
			if (attachMaterialPlugin(material, _scene)) {
				this._materialPluginCount++;
			}
		});
	}

	public evaluate(mesh: AbstractMesh, position = mesh.getBoundingInfo().boundingBox.centerWorld): ILightProbeEvaluation | null {
		this._queries++;
		this._lastMeshId = mesh.id;
		this._lastPosition = position.asArray();
		const source = evaluateVolumeSet(this.volumes, mesh, position);
		const target = this._scenarioBlendVolumes ? evaluateVolumeSet(this._scenarioBlendVolumes, mesh, position) : null;
		let evaluation = source;
		if (this._scenarioBlendVolumes) {
			const weight = this._scenarioBlendWeight;
			const coefficients = new Array<number>(27).fill(0);
			for (let index = 0; index < coefficients.length; index++) {
				coefficients[index] = (source?.coefficients[index] ?? 0) * (1 - weight) + (target?.coefficients[index] ?? 0) * weight;
			}
			evaluation =
				source || target
					? {
							coefficients,
							volumeIds: [...(source?.volumeIds ?? []), ...(target?.volumeIds ?? [])],
							weights: [...(source?.weights.map((value) => value * (1 - weight)) ?? []), ...(target?.weights.map((value) => value * weight) ?? [])],
							cellLevels: [...(source?.cellLevels ?? []), ...(target?.cellLevels ?? [])],
						}
					: null;
		}
		if (!evaluation) {
			this._lastVolumeIds = [];
			this._lastCellLevels = [];
			this._lastL00 = null;
			return null;
		}
		this._matchedQueries++;
		this._lastVolumeIds = [...evaluation.volumeIds];
		this._lastCellLevels = [...evaluation.cellLevels];
		this._lastL00 = evaluation.coefficients.slice(0, 3);
		return evaluation;
	}

	/** Sets a validated target volume set and normalized baked-scenario blend weight. */
	public setScenarioBlend(volumes: ILightProbeVolume[], weight: number): void {
		this._scenarioBlendVolumes = validateLightProbeVolumes(volumes);
		this._scenarioBlendWeight = Math.max(0, Math.min(1, weight));
	}

	/** Stops baked-scenario interpolation without changing persisted active volumes. */
	public clearScenarioBlend(): void {
		this._scenarioBlendVolumes = null;
		this._scenarioBlendWeight = 0;
	}

	public inspect(): ILightProbeRuntimeEvidence {
		return {
			backend: lightProbeRuntimeBackend,
			configured: this.volumes.length > 0 && !this._error,
			volumeCount: this.volumes.length,
			bakedVolumeCount: this.volumes.filter((volume) => !!volume.bake).length,
			targetMeshCount: new Set(this.volumes.flatMap((volume) => volume.targetMeshIds)).size,
			materialPluginCount: this._materialPluginCount,
			shaderLanguages: ["GLSL", "WGSL"],
			queries: this._queries,
			matchedQueries: this._matchedQueries,
			lastMeshId: this._lastMeshId,
			lastVolumeIds: [...this._lastVolumeIds],
			lastCellLevels: [...this._lastCellLevels],
			lastPosition: this._lastPosition ? [...this._lastPosition] : null,
			lastL00: this._lastL00 ? [...this._lastL00] : null,
			scenarioBlend: {
				active: this._scenarioBlendVolumes !== null,
				weight: this._scenarioBlendWeight,
				targetVolumeCount: this._scenarioBlendVolumes?.length ?? 0,
			},
			error: this._error,
		};
	}

	public dispose(): void {
		this.clearScenarioBlend();
		this._materialObserver?.remove();
		this._materialObserver = null;
	}
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		lightProbeVolumes?: LightProbeVolumeRuntime;
	}
}

/** Rebuilds the shared runtime from persisted metadata after load or an authored mutation. */
export function configureLightProbeVolumes(scene: Scene): LightProbeVolumeRuntime {
	lightProbeRuntimes.get(scene)?.dispose();
	let volumes: ILightProbeVolume[] = [];
	let error: string | null = null;
	try {
		volumes = validateLightProbeVolumes(scene.metadata?.[lightProbeVolumesMetadataKey]);
	} catch (caught) {
		error = caught instanceof Error ? caught.message : "Light-probe metadata is invalid.";
	}
	const runtime = new LightProbeVolumeRuntime(scene, volumes, error);
	lightProbeRuntimes.set(scene, runtime);
	scene.lightProbeVolumes = runtime;
	if (!scenesWithDisposeCleanup.has(scene)) {
		scenesWithDisposeCleanup.add(scene);
		scene.onDisposeObservable.addOnce(() => {
			lightProbeRuntimes.get(scene)?.dispose();
			lightProbeRuntimes.delete(scene);
		});
	}
	return runtime;
}

/** Reads exact runtime execution evidence without changing the scene. */
export function getLightProbeRuntimeEvidence(scene: Scene): ILightProbeRuntimeEvidence {
	return (
		lightProbeRuntimes.get(scene)?.inspect() ?? {
			backend: lightProbeRuntimeBackend,
			configured: false,
			volumeCount: 0,
			bakedVolumeCount: 0,
			targetMeshCount: 0,
			materialPluginCount: 0,
			shaderLanguages: ["GLSL", "WGSL"],
			queries: 0,
			matchedQueries: 0,
			lastMeshId: null,
			lastVolumeIds: [],
			lastCellLevels: [],
			lastPosition: null,
			lastL00: null,
			scenarioBlend: { active: false, weight: 0, targetVolumeCount: 0 },
			error: null,
		}
	);
}
