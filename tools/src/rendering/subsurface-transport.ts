import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase.pure";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Scene } from "@babylonjs/core/scene";

export const subsurfaceTransportCacheVersion = 1 as const;
export const subsurfaceTransportBackend = "bounded-cpu-ray-traced-offscreen-transport-v1" as const;
export const subsurfaceTransportRgbmRange = 16 as const;

export type SubsurfaceTransportUvChannel = "uv0" | "uv2";

export interface ISubsurfaceTransportCache {
	version: 1;
	backend: typeof subsurfaceTransportBackend;
	ownership: "editor-generated";
	revision: number;
	meshId: string;
	meshName: string;
	texture: Record<string, unknown>;
	texturePath: string;
	contentRevision: string;
	uvChannel: SubsurfaceTransportUvChannel;
	resolution: number;
	sampleCount: number;
	maxDistance: number;
	bias: number;
	shadowing: boolean;
	dilation: number;
	encoding: "linear-rgbm8";
	rgbmRange: 16;
	intensity: number;
	profileId: string;
	profileRevision: number;
	profileContentRevision: string | null;
	geometrySignature: string;
	lightingSignature: string;
	coveredTexels: number;
	overlapTexels: number;
	tracedTexels: number;
	hitTexels: number;
	rayCount: number;
	minimumThickness: number;
	maximumThickness: number;
	averageThickness: number;
	limitations: string[];
}

export interface ISubsurfaceTransportRuntimeCacheEvidence {
	materialId: string;
	materialName: string;
	meshId: string;
	meshName: string;
	revision: number;
	texturePath: string;
	contentRevision: string;
	uvChannel: SubsurfaceTransportUvChannel;
	resolution: number;
	sampleCount: number;
	intensity: number;
	active: boolean;
	stale: boolean;
	staleReasons: string[];
	textureName: string | null;
	textureUrl: string | null;
	textureReady: boolean;
	coveredTexels: number;
	hitTexels: number;
	rayCount: number;
	minimumThickness: number;
	maximumThickness: number;
	averageThickness: number;
}

export interface ISubsurfaceTransportRuntimeEvidence {
	enabled: boolean;
	ready: boolean;
	backend: typeof subsurfaceTransportBackend;
	shaderLanguage: "GLSL" | "WGSL";
	cacheCount: number;
	activeCacheCount: number;
	staleCacheCount: number;
	textureCount: number;
	globalIntensity: number;
	totalRayCount: number;
	caches: ISubsurfaceTransportRuntimeCacheEvidence[];
	warnings: string[];
}

export interface ISubsurfaceTransportCandidate {
	material: PBRMaterial;
	profileId: string;
	profileRevision: number;
	profileContentRevision: string | null;
	caches: ISubsurfaceTransportCache[];
}

interface ISubsurfaceTransportPluginEntry {
	meshId: string;
	texture: BaseTexture;
	uvChannel: SubsurfaceTransportUvChannel;
	intensity: number;
}

interface ISubsurfaceTransportTextureEntry {
	cacheRevision: number;
	contentRevision: string;
	texture: BaseTexture;
	owned: boolean;
}

interface ISubsurfaceTransportConfiguration {
	candidates: ISubsurfaceTransportCandidate[];
	enabled: boolean;
	globalIntensity: number;
	rootUrl: string;
}

const transportTextures = new WeakMap<PBRMaterial, Map<string, ISubsurfaceTransportTextureEntry>>();
const transportPlugins = new WeakMap<PBRMaterial, SubsurfaceTransportMaterialPlugin>();
const activeMaterialsByScene = new WeakMap<Scene, Set<PBRMaterial>>();
const transportReports = new WeakMap<Scene, ISubsurfaceTransportRuntimeEvidence>();
const transportConfigurations = new WeakMap<Scene, ISubsurfaceTransportConfiguration>();

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function boundedString(value: unknown, label: string, maximum = 1024): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value.trim();
}

function exactRevision(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 revision.`);
	}
	return value;
}

function optionalExactRevision(value: unknown, label: string): string | null {
	return value === null ? null : exactRevision(value, label);
}

function textureSnapshot(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface transport texture must be a serialized 2D texture object.");
	}
	const source = structuredClone(value as Record<string, unknown>);
	if (source.isCube === true) {
		throw new Error("Subsurface transport texture must be two-dimensional.");
	}
	if ((typeof source.name !== "string" || !source.name.trim()) && (typeof source.url !== "string" || !source.url.trim())) {
		throw new Error("Subsurface transport texture requires a non-empty name or URL.");
	}
	if (JSON.stringify(source).length > 1_000_000) {
		throw new Error("Subsurface transport texture metadata exceeds the 1 MB portable limit.");
	}
	return source;
}

/** Strictly validates one portable, camera-independent subsurface transport cache. */
export function validateSubsurfaceTransportCache(value: unknown): ISubsurfaceTransportCache {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Subsurface transport cache must be an object.");
	}
	const source = value as Record<string, unknown>;
	const fields = [
		"version",
		"backend",
		"ownership",
		"revision",
		"meshId",
		"meshName",
		"texture",
		"texturePath",
		"contentRevision",
		"uvChannel",
		"resolution",
		"sampleCount",
		"maxDistance",
		"bias",
		"shadowing",
		"dilation",
		"encoding",
		"rgbmRange",
		"intensity",
		"profileId",
		"profileRevision",
		"profileContentRevision",
		"geometrySignature",
		"lightingSignature",
		"coveredTexels",
		"overlapTexels",
		"tracedTexels",
		"hitTexels",
		"rayCount",
		"minimumThickness",
		"maximumThickness",
		"averageThickness",
		"limitations",
	];
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`Subsurface transport cache contains unknown fields: ${unknown.join(", ")}.`);
	}
	if (source.version !== subsurfaceTransportCacheVersion) {
		throw new Error("Subsurface transport cache uses an unsupported version.");
	}
	if (source.backend !== subsurfaceTransportBackend || source.ownership !== "editor-generated") {
		throw new Error("Subsurface transport cache requires the bounded CPU ray-traced backend and editor-generated ownership.");
	}
	if (source.uvChannel !== "uv0" && source.uvChannel !== "uv2") {
		throw new Error('Subsurface transport uvChannel must be "uv0" or "uv2".');
	}
	if (source.encoding !== "linear-rgbm8" || source.rgbmRange !== subsurfaceTransportRgbmRange) {
		throw new Error("Subsurface transport cache requires linear RGBM8 encoding with range 16.");
	}
	if (typeof source.shadowing !== "boolean") {
		throw new Error("Subsurface transport shadowing must be a boolean.");
	}
	if (!Array.isArray(source.limitations) || source.limitations.length > 16 || source.limitations.some((entry) => typeof entry !== "string" || entry.length > 512)) {
		throw new Error("Subsurface transport limitations must contain at most 16 bounded strings.");
	}
	const minimumThickness = finiteNumber(source.minimumThickness, "Subsurface transport minimumThickness", 0, 1_000_000);
	const maximumThickness = finiteNumber(source.maximumThickness, "Subsurface transport maximumThickness", 0, 1_000_000);
	const averageThickness = finiteNumber(source.averageThickness, "Subsurface transport averageThickness", 0, 1_000_000);
	if (maximumThickness < minimumThickness || averageThickness < minimumThickness || averageThickness > maximumThickness) {
		throw new Error("Subsurface transport thickness statistics are inconsistent.");
	}
	const coveredTexels = integer(source.coveredTexels, "Subsurface transport coveredTexels", 0, 256 * 256);
	const tracedTexels = integer(source.tracedTexels, "Subsurface transport tracedTexels", 0, 256 * 256);
	const hitTexels = integer(source.hitTexels, "Subsurface transport hitTexels", 0, 256 * 256);
	if (tracedTexels > coveredTexels || hitTexels > tracedTexels) {
		throw new Error("Subsurface transport texel statistics are inconsistent.");
	}
	return {
		version: 1,
		backend: subsurfaceTransportBackend,
		ownership: "editor-generated",
		revision: integer(source.revision, "Subsurface transport revision", 1, Number.MAX_SAFE_INTEGER),
		meshId: boundedString(source.meshId, "Subsurface transport meshId", 256),
		meshName: boundedString(source.meshName, "Subsurface transport meshName", 256),
		texture: textureSnapshot(source.texture),
		texturePath: boundedString(source.texturePath, "Subsurface transport texturePath"),
		contentRevision: exactRevision(source.contentRevision, "Subsurface transport contentRevision"),
		uvChannel: source.uvChannel,
		resolution: integer(source.resolution, "Subsurface transport resolution", 16, 256),
		sampleCount: integer(source.sampleCount, "Subsurface transport sampleCount", 1, 64),
		maxDistance: finiteNumber(source.maxDistance, "Subsurface transport maxDistance", 0.000001, 1_000_000),
		bias: finiteNumber(source.bias, "Subsurface transport bias", 0.000001, 1000),
		shadowing: source.shadowing,
		dilation: integer(source.dilation, "Subsurface transport dilation", 0, 16),
		encoding: "linear-rgbm8",
		rgbmRange: 16,
		intensity: finiteNumber(source.intensity, "Subsurface transport intensity", 0, 16),
		profileId: boundedString(source.profileId, "Subsurface transport profileId", 128),
		profileRevision: integer(source.profileRevision, "Subsurface transport profileRevision", 1, Number.MAX_SAFE_INTEGER),
		profileContentRevision: optionalExactRevision(source.profileContentRevision, "Subsurface transport profileContentRevision"),
		geometrySignature: boundedString(source.geometrySignature, "Subsurface transport geometrySignature", 128),
		lightingSignature: boundedString(source.lightingSignature, "Subsurface transport lightingSignature", 128),
		coveredTexels,
		overlapTexels: integer(source.overlapTexels, "Subsurface transport overlapTexels", 0, 256 * 256),
		tracedTexels,
		hitTexels,
		rayCount: integer(source.rayCount, "Subsurface transport rayCount", 0, Number.MAX_SAFE_INTEGER),
		minimumThickness,
		maximumThickness,
		averageThickness,
		limitations: [...source.limitations],
	};
}

/** Serializes a real 2D texture for portable normal/additive scene loading. */
export function serializeSubsurfaceTransportTexture(texture: BaseTexture): Record<string, unknown> {
	if (texture.isCube) {
		throw new Error("Subsurface transport texture must be two-dimensional.");
	}
	const serialized = texture.serialize?.() as Record<string, unknown> | null;
	if (!serialized) {
		throw new Error(`Subsurface transport texture "${texture.name}" could not be serialized.`);
	}
	return textureSnapshot(serialized);
}

function updateHash(hash: number, byte: number): number {
	return Math.imul(hash ^ byte, 0x01000193) >>> 0;
}

function hashString(hash: number, value: string): number {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		hash = updateHash(hash, code & 0xff);
		hash = updateHash(hash, code >>> 8);
	}
	return hash;
}

function hashNumbers(hash: number, values: ArrayLike<number>): number {
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	for (let index = 0; index < values.length; index++) {
		view.setFloat64(0, values[index], true);
		for (let byte = 0; byte < 8; byte++) {
			hash = updateHash(hash, view.getUint8(byte));
		}
	}
	return hash;
}

function signature(hash: number): string {
	return `fnv1a32-${hash.toString(16).padStart(8, "0")}`;
}

/** Returns the deterministic geometry/transform/UV signature carried by a bake lease. */
export function subsurfaceTransportMeshSignature(mesh: Mesh, uvChannel: SubsurfaceTransportUvChannel): string {
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
	const indices = mesh.getIndices();
	const uvs = mesh.getVerticesData(uvChannel === "uv2" ? VertexBuffer.UV2Kind : VertexBuffer.UVKind);
	if (!positions || !indices || !uvs) {
		throw new Error(`Mesh "${mesh.name}" has no complete indexed ${uvChannel.toUpperCase()} geometry for subsurface transport.`);
	}
	let hash = hashString(0x811c9dc5, `${mesh.id}|${uvChannel}|`);
	hash = hashNumbers(hash, positions);
	hash = hashNumbers(hash, indices);
	hash = hashNumbers(hash, uvs);
	hash = hashNumbers(hash, mesh.computeWorldMatrix(true).asArray());
	return signature(hash);
}

function vector(value: unknown): number[] | null {
	return value && typeof value === "object" && "asArray" in value && typeof (value as { asArray?: unknown }).asArray === "function"
		? ((value as { asArray: () => number[] }).asArray() as number[])
		: null;
}

/** Returns the deterministic static-lighting signature carried by a bake lease. */
export function subsurfaceTransportLightingSignature(scene: Scene): string {
	const lights = [...scene.lights]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((light) => {
			const source = light as any;
			return {
				id: light.id,
				className: light.getClassName(),
				enabled: light.isEnabled(),
				intensity: light.intensity,
				range: light.range,
				diffuse: light.diffuse.asArray(),
				specular: light.specular.asArray(),
				position: vector(source.position) ?? vector(source.getAbsolutePosition?.()),
				direction: vector(source.direction) ?? vector(source.getShadowDirection?.()),
				angle: source.angle ?? null,
				exponent: source.exponent ?? null,
				width: source.width ?? source.metadata?.babylonEditorAreaLight?.width ?? null,
				height: source.height ?? source.metadata?.babylonEditorAreaLight?.height ?? null,
			};
		});
	const source = JSON.stringify({
		ambient: scene.ambientColor.asArray(),
		environmentIntensity: scene.environmentIntensity,
		environmentTexture: scene.environmentTexture?.name ?? null,
		lights,
	});
	return signature(hashString(0x811c9dc5, source));
}

function meshUsesMaterial(mesh: Mesh, material: PBRMaterial): boolean {
	if (mesh.material === material) {
		return true;
	}
	const subMaterials = (mesh.material as { subMaterials?: Array<unknown> } | null)?.subMaterials;
	return Boolean(subMaterials?.includes(material));
}

function cacheStaleReasons(scene: Scene, candidate: ISubsurfaceTransportCandidate, cache: ISubsurfaceTransportCache): string[] {
	const staleReasons: string[] = [];
	const mesh = scene.getMeshById(cache.meshId);
	if (!mesh || typeof (mesh as any).getVerticesData !== "function" || typeof (mesh as any).computeWorldMatrix !== "function") {
		staleReasons.push("mesh is missing");
	} else if (!meshUsesMaterial(mesh as Mesh, candidate.material)) {
		staleReasons.push("mesh no longer uses this material");
	} else {
		try {
			if (subsurfaceTransportMeshSignature(mesh as Mesh, cache.uvChannel) !== cache.geometrySignature) {
				staleReasons.push("mesh geometry, transform, or UVs changed");
			}
		} catch (error) {
			staleReasons.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (cache.profileId !== candidate.profileId || cache.profileRevision !== candidate.profileRevision || cache.profileContentRevision !== candidate.profileContentRevision) {
		staleReasons.push("diffusion profile changed");
	}
	if (subsurfaceTransportLightingSignature(scene) !== cache.lightingSignature) {
		staleReasons.push("static scene lighting changed");
	}
	return staleReasons;
}

class SubsurfaceTransportMaterialPlugin extends MaterialPluginBase {
	private _entries = new Map<string, ISubsurfaceTransportPluginEntry>();

	public constructor(material: PBRMaterial) {
		super(material, "BabylonEditorSubsurfaceTransport", 210, { BABYLON_EDITOR_SSS_TRANSPORT: false, BABYLON_EDITOR_SSS_TRANSPORT_UV2: false }, true, true);
		this.doNotSerialize = true;
	}

	public getClassName(): string {
		return "BabylonEditorSubsurfaceTransportMaterialPlugin";
	}

	public isCompatible(shaderLanguage: ShaderLanguage): boolean {
		return shaderLanguage === ShaderLanguage.GLSL || shaderLanguage === ShaderLanguage.WGSL;
	}

	public update(entries: ISubsurfaceTransportPluginEntry[]): void {
		this._entries = new Map(entries.map((entry) => [entry.meshId, entry]));
		this.markAllDefinesAsDirty();
	}

	public prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
		const entry = this._entries.get(mesh.id);
		(defines as any).BABYLON_EDITOR_SSS_TRANSPORT = Boolean(entry);
		(defines as any).BABYLON_EDITOR_SSS_TRANSPORT_UV2 = entry?.uvChannel === "uv2";
	}

	public isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): boolean {
		return this._entries.get(subMesh.getMesh().id)?.texture.isReadyOrNotBlocking() ?? true;
	}

	public getActiveTextures(activeTextures: BaseTexture[]): void {
		for (const entry of this._entries.values()) {
			if (!activeTextures.includes(entry.texture)) {
				activeTextures.push(entry.texture);
			}
		}
	}

	public hasTexture(texture: BaseTexture): boolean {
		return [...this._entries.values()].some((entry) => entry.texture === texture);
	}

	public getSamplers(samplers: string[]): void {
		samplers.push("babylonEditorSssTransportSampler");
	}

	public getUniforms(): { externalUniforms: string[] } {
		return { externalUniforms: ["babylonEditorSssTransportIntensity"] };
	}

	public bindForSubMesh(_uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
		const entry = this._entries.get(subMesh.getMesh().id);
		const effect = subMesh.effect;
		if (!entry || !effect) {
			return;
		}
		effect.setTexture("babylonEditorSssTransportSampler", entry.texture);
		effect.setFloat("babylonEditorSssTransportIntensity", entry.intensity);
	}

	public getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): { [pointName: string]: string } | null {
		if (shaderLanguage === ShaderLanguage.WGSL) {
			if (shaderType === "vertex") {
				return {
					CUSTOM_VERTEX_DEFINITIONS: "#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nvarying babylonEditorSssTransportUV: vec2f;\n#endif",
					CUSTOM_VERTEX_MAIN_END:
						"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\n#ifdef BABYLON_EDITOR_SSS_TRANSPORT_UV2\nvertexOutputs.babylonEditorSssTransportUV=uv2Updated;\n#else\nvertexOutputs.babylonEditorSssTransportUV=uvUpdated;\n#endif\n#endif",
				};
			}
			if (shaderType === "fragment") {
				return {
					CUSTOM_FRAGMENT_DEFINITIONS:
						"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nvarying babylonEditorSssTransportUV: vec2f;\nvar babylonEditorSssTransportSamplerSampler: sampler;\nvar babylonEditorSssTransportSampler: texture_2d<f32>;\nuniform babylonEditorSssTransportIntensity: f32;\n#endif",
					CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
						"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nlet babylonEditorSssTransportSample=textureSampleLevel(babylonEditorSssTransportSampler,babylonEditorSssTransportSamplerSampler,fragmentInputs.babylonEditorSssTransportUV,0.0);\nlet babylonEditorSssTransportRadiance=babylonEditorSssTransportSample.rgb*babylonEditorSssTransportSample.a*16.0;\nfinalColor=vec4f(finalColor.rgb+babylonEditorSssTransportRadiance*uniforms.babylonEditorSssTransportIntensity,finalColor.a);\n#endif",
				};
			}
			return null;
		}
		if (shaderType === "vertex") {
			return {
				CUSTOM_VERTEX_DEFINITIONS: "#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nvarying vec2 babylonEditorSssTransportUV;\n#endif",
				CUSTOM_VERTEX_MAIN_END:
					"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\n#ifdef BABYLON_EDITOR_SSS_TRANSPORT_UV2\nbabylonEditorSssTransportUV=uv2Updated;\n#else\nbabylonEditorSssTransportUV=uvUpdated;\n#endif\n#endif",
			};
		}
		if (shaderType === "fragment") {
			return {
				CUSTOM_FRAGMENT_DEFINITIONS:
					"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nvarying vec2 babylonEditorSssTransportUV;\nuniform sampler2D babylonEditorSssTransportSampler;\nuniform float babylonEditorSssTransportIntensity;\n#endif",
				CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR:
					"#ifdef BABYLON_EDITOR_SSS_TRANSPORT\nvec4 babylonEditorSssTransportSample=texture2D(babylonEditorSssTransportSampler,babylonEditorSssTransportUV);\nvec3 babylonEditorSssTransportRadiance=babylonEditorSssTransportSample.rgb*babylonEditorSssTransportSample.a*16.0;\nfinalColor=vec4(finalColor.rgb+babylonEditorSssTransportRadiance*babylonEditorSssTransportIntensity,finalColor.a);\n#endif",
			};
		}
		return null;
	}

	public dispose(): void {
		this._entries.clear();
	}
}

function plugin(material: PBRMaterial): SubsurfaceTransportMaterialPlugin {
	let value = transportPlugins.get(material);
	if (!value) {
		value = new SubsurfaceTransportMaterialPlugin(material);
		transportPlugins.set(material, value);
	}
	return value;
}

function disposeTextureEntry(entry: ISubsurfaceTransportTextureEntry): void {
	if (entry.owned) {
		entry.texture.dispose();
	}
}

function clearMaterialRuntime(material: PBRMaterial): void {
	plugin(material).update([]);
	const entries = transportTextures.get(material);
	if (entries) {
		for (const entry of entries.values()) {
			disposeTextureEntry(entry);
		}
		transportTextures.delete(material);
	}
}

/** Installs an already loaded texture for the next exact runtime rebuild. */
export function setSubsurfaceTransportTexture(material: PBRMaterial, meshId: string, cacheRevision: number, contentRevision: string, texture: BaseTexture): void {
	if (texture.isCube) {
		throw new Error("Subsurface transport texture must be two-dimensional.");
	}
	texture.gammaSpace = false;
	const entries = transportTextures.get(material) ?? new Map<string, ISubsurfaceTransportTextureEntry>();
	const previous = entries.get(meshId);
	if (previous && previous.texture !== texture) {
		disposeTextureEntry(previous);
	}
	entries.set(meshId, { cacheRevision, contentRevision, texture, owned: true });
	transportTextures.set(material, entries);
}

/** Removes and disposes one installed cache texture before metadata cleanup. */
export function clearSubsurfaceTransportTexture(material: PBRMaterial, meshId: string): void {
	const entries = transportTextures.get(material);
	const previous = entries?.get(meshId);
	if (previous) {
		disposeTextureEntry(previous);
		entries!.delete(meshId);
	}
	if (entries && entries.size === 0) {
		transportTextures.delete(material);
	}
}

function textureForCache(scene: Scene, material: PBRMaterial, cache: ISubsurfaceTransportCache, rootUrl: string): BaseTexture {
	const entries = transportTextures.get(material) ?? new Map<string, ISubsurfaceTransportTextureEntry>();
	const current = entries.get(cache.meshId);
	if (current && current.cacheRevision === cache.revision && current.contentRevision === cache.contentRevision) {
		return current.texture;
	}
	if (current) {
		disposeTextureEntry(current);
	}
	const texture = Texture.Parse(structuredClone(cache.texture), scene, rootUrl);
	if (!texture || texture.isCube) {
		texture?.dispose();
		throw new Error(`Subsurface transport texture for mesh "${cache.meshName}" could not be parsed as a 2D texture.`);
	}
	texture.gammaSpace = false;
	entries.set(cache.meshId, { cacheRevision: cache.revision, contentRevision: cache.contentRevision, texture, owned: true });
	transportTextures.set(material, entries);
	return texture;
}

/** Rebuilds portable off-screen transport plugins and returns exact stale/readiness evidence. */
export function configureSubsurfaceTransport(
	scene: Scene,
	candidates: ISubsurfaceTransportCandidate[],
	enabled: boolean,
	globalIntensity: number,
	rootUrl = ""
): ISubsurfaceTransportRuntimeEvidence {
	const effectiveRootUrl = rootUrl || transportConfigurations.get(scene)?.rootUrl || "";
	transportConfigurations.set(scene, { candidates, enabled, globalIntensity, rootUrl: effectiveRootUrl });
	const previousMaterials = activeMaterialsByScene.get(scene) ?? new Set<PBRMaterial>();
	const nextMaterials = new Set(candidates.map((candidate) => candidate.material));
	for (const material of previousMaterials) {
		if (!nextMaterials.has(material) || !enabled) {
			clearMaterialRuntime(material);
		}
	}
	const caches: ISubsurfaceTransportRuntimeCacheEvidence[] = [];
	const warnings: string[] = [];
	let textureCount = 0;
	for (const candidate of candidates) {
		const entries: ISubsurfaceTransportPluginEntry[] = [];
		const retainedTextureIds = new Set<string>();
		for (const cache of candidate.caches) {
			const staleReasons = cacheStaleReasons(scene, candidate, cache);
			let texture: BaseTexture | null = null;
			if (enabled && staleReasons.length === 0) {
				try {
					texture = textureForCache(scene, candidate.material, cache, effectiveRootUrl);
					retainedTextureIds.add(cache.meshId);
					entries.push({ meshId: cache.meshId, texture, uvChannel: cache.uvChannel, intensity: cache.intensity * globalIntensity });
				} catch (error) {
					staleReasons.push(error instanceof Error ? error.message : String(error));
				}
			}
			if (staleReasons.length) {
				warnings.push(`Subsurface transport cache for "${cache.meshName}" is stale: ${staleReasons.join("; ")}. Re-bake it before use.`);
			}
			const textureValue = texture as (BaseTexture & { url?: string }) | null;
			caches.push({
				materialId: candidate.material.id,
				materialName: candidate.material.name,
				meshId: cache.meshId,
				meshName: cache.meshName,
				revision: cache.revision,
				texturePath: cache.texturePath,
				contentRevision: cache.contentRevision,
				uvChannel: cache.uvChannel,
				resolution: cache.resolution,
				sampleCount: cache.sampleCount,
				intensity: cache.intensity,
				active: Boolean(texture && staleReasons.length === 0),
				stale: staleReasons.length > 0,
				staleReasons,
				textureName: texture?.name ?? null,
				textureUrl: typeof textureValue?.url === "string" ? textureValue.url : null,
				textureReady: texture?.isReadyOrNotBlocking() ?? false,
				coveredTexels: cache.coveredTexels,
				hitTexels: cache.hitTexels,
				rayCount: cache.rayCount,
				minimumThickness: cache.minimumThickness,
				maximumThickness: cache.maximumThickness,
				averageThickness: cache.averageThickness,
			});
		}
		const textures = transportTextures.get(candidate.material);
		if (textures) {
			for (const [meshId, entry] of textures) {
				if (!retainedTextureIds.has(meshId)) {
					disposeTextureEntry(entry);
					textures.delete(meshId);
				}
			}
			if (textures.size === 0) {
				transportTextures.delete(candidate.material);
			}
		}
		plugin(candidate.material).update(enabled ? entries : []);
		textureCount += entries.length;
	}
	activeMaterialsByScene.set(scene, enabled ? nextMaterials : new Set());
	const activeCacheCount = caches.filter((cache) => cache.active).length;
	const staleCacheCount = caches.filter((cache) => cache.stale).length;
	if (enabled && caches.length === 0) {
		warnings.push("Baked ray-traced subsurface transport is enabled, but no material has a transport cache.");
	}
	const report: ISubsurfaceTransportRuntimeEvidence = {
		enabled,
		ready: !enabled || (caches.length > 0 && activeCacheCount === caches.length && caches.every((cache) => cache.textureReady)),
		backend: subsurfaceTransportBackend,
		shaderLanguage: scene.getEngine().isWebGPU ? "WGSL" : "GLSL",
		cacheCount: caches.length,
		activeCacheCount,
		staleCacheCount,
		textureCount,
		globalIntensity,
		totalRayCount: candidates.flatMap((candidate) => candidate.caches).reduce((sum, cache) => sum + cache.rayCount, 0),
		caches,
		warnings: [...new Set(warnings)],
	};
	transportReports.set(scene, report);
	return report;
}

/** Revalidates exact geometry/profile/light signatures and rebuilds only when stale state changed. */
export function refreshSubsurfaceTransportRuntime(scene: Scene): ISubsurfaceTransportRuntimeEvidence {
	const configuration = transportConfigurations.get(scene);
	const report = transportReports.get(scene);
	if (!configuration || !report) {
		return getSubsurfaceTransportRuntime(scene);
	}
	const previousByKey = new Map(report.caches.map((cache) => [`${cache.materialId}\u0000${cache.meshId}`, cache]));
	let changed = report.cacheCount !== configuration.candidates.reduce((sum, candidate) => sum + candidate.caches.length, 0);
	for (const candidate of configuration.candidates) {
		for (const cache of candidate.caches) {
			const previous = previousByKey.get(`${candidate.material.id}\u0000${cache.meshId}`);
			const staleReasons = cacheStaleReasons(scene, candidate, cache);
			if (!previous || previous.stale !== Boolean(staleReasons.length) || previous.staleReasons.join("\u0000") !== staleReasons.join("\u0000")) {
				changed = true;
				break;
			}
		}
		if (changed) {
			break;
		}
	}
	return changed
		? configureSubsurfaceTransport(scene, configuration.candidates, configuration.enabled, configuration.globalIntensity, configuration.rootUrl)
		: getSubsurfaceTransportRuntime(scene);
}

/** Refreshes asynchronous texture readiness without rebuilding signatures or shader variants. */
export function getSubsurfaceTransportRuntime(scene: Scene): ISubsurfaceTransportRuntimeEvidence {
	const report = transportReports.get(scene) ?? {
		enabled: false,
		ready: true,
		backend: subsurfaceTransportBackend,
		shaderLanguage: scene.getEngine().isWebGPU ? "WGSL" : "GLSL",
		cacheCount: 0,
		activeCacheCount: 0,
		staleCacheCount: 0,
		textureCount: 0,
		globalIntensity: 1,
		totalRayCount: 0,
		caches: [],
		warnings: [],
	};
	const texturesByMaterialAndMesh = new Map<string, BaseTexture>();
	for (const material of activeMaterialsByScene.get(scene) ?? []) {
		for (const [meshId, entry] of transportTextures.get(material) ?? []) {
			texturesByMaterialAndMesh.set(`${material.id}\u0000${meshId}`, entry.texture);
		}
	}
	const caches = report.caches.map((cache) => {
		const texture = texturesByMaterialAndMesh.get(`${cache.materialId}\u0000${cache.meshId}`);
		return cache.active ? { ...cache, textureReady: texture?.isReadyOrNotBlocking() ?? false } : { ...cache };
	});
	return {
		...report,
		ready: !report.enabled || (caches.length > 0 && caches.every((cache) => cache.active && cache.textureReady)),
		caches,
	};
}

/** Disposes all tool-owned transport textures and disables material plugins for a scene. */
export function clearSubsurfaceTransportRuntime(scene: Scene): void {
	for (const material of activeMaterialsByScene.get(scene) ?? []) {
		clearMaterialRuntime(material);
	}
	activeMaterialsByScene.delete(scene);
	transportReports.delete(scene);
	transportConfigurations.delete(scene);
}
