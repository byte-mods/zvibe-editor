import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import type { Light } from "@babylonjs/core/Lights/light";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { PBRSpecularGlossinessMaterial } from "@babylonjs/core/Materials/PBR/pbrSpecularGlossinessMaterial";
import { OpenPBRMaterial } from "@babylonjs/core/Materials/PBR/openpbrMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import type { RenderingManager } from "@babylonjs/core/Rendering/renderingManager";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/Shaders/ShadersInclude/ltcHelperFunctions";
import "@babylonjs/core/Shaders/ShadersInclude/shadowsFragmentFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/ltcHelperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowsFragmentFunctions";

import { acquireGeometryBufferLease, getGeometryBufferLeaseEvidence, releaseGeometryBufferLease } from "./geometry-buffer-lease";
import { getLightCookieEvidence, getLightCookieMetadata, getLightCookieTexture, ILightCookieEvidence, lightCookieMaximumSources } from "../loading/light-cookies";
import { getAreaLightBasis, getAreaLightEvidence, getAreaLightMetadata, IAreaLightEvidence, isAreaLight } from "../loading/area-lights";
import { reflectionProbeBlendModel } from "../loading/reflection-probes";

export const deferredLightingRuntimeBackend = "bounded-babylon-deferred-lighting-v1" as const;
export const deferredLightingMaximumLights = 16;
export const deferredLightingMaximumShadowSources = 8;
export const deferredLightingMaximumIblSources = 8;
export const deferredLightingMaximumEmissiveSources = 256;
export const deferredLightingMaximumDecalSources = 256;
export const deferredLightingMaximumProjectorDecalSources = 8;
const deferredLightingMaximumCascades = 4;

type DeferredShadowFilter = "hard" | "poisson" | "esm" | "blur-esm" | "close-esm" | "blur-close-esm" | "pcf" | "pcss";
type DeferredShadowMode =
	| "none"
	| `classic-${DeferredShadowFilter}`
	| `point-cube-${Exclude<DeferredShadowFilter, "blur-esm" | "blur-close-esm" | "pcf" | "pcss">}`
	| `cascaded-${Extract<DeferredShadowFilter, "hard" | "pcf" | "pcss">}`;

export interface IDeferredShadowSourceEvidence {
	index: number;
	lightId: string;
	lightName: string;
	lightIndex: number;
	generatorType: "classic" | "cascaded";
	mapType: "2d" | "cube" | "2d-array";
	filter: DeferredShadowFilter;
	filteringQuality: "low" | "medium" | "high" | null;
	blurScale: number;
	depthScale: number;
	contactHardeningLightSizeUVRatio: number;
	cascadeCount: number;
	mapCount: number;
	mapReady: boolean;
	mapWidth: number;
	mapHeight: number;
	casterCount: number;
	receiverCount: number;
	samplerCount: number;
}

export interface IDeferredIblSourceEvidence {
	index: number;
	kind: "environment" | "reflection-probe" | "material-cubemap";
	name: string;
	textureName: string;
	ready: boolean;
	width: number;
	height: number;
	maximumLod: number;
	gammaSpace: boolean;
	rgbd: boolean;
	intensity: number;
	meshCount: number;
	materialCount: number;
	boxProjection: boolean;
	boxPosition: [number, number, number] | null;
	boxSize: [number, number, number] | null;
	diffuseMode: "spherical-polynomial" | "roughest-mip";
	probeSlot: number | null;
	importance: number | null;
	blendDistance: number | null;
	blendModel: typeof reflectionProbeBlendModel | null;
}

export interface IDeferredEmissiveSourceEvidence {
	materialId: string;
	materialName: string;
	materialClassName: string;
	meshCount: number;
	color: [number, number, number];
	intensity: number;
	textureName: string | null;
	textureReady: boolean;
	textureGammaSpace: boolean | null;
}

export interface IDeferredDecalChannels {
	albedo: boolean;
	normal: boolean;
	metallic: boolean;
	ambientOcclusion: boolean;
	emissive: boolean;
}

export interface IDeferredDecalSourceEvidence {
	backend: "projected-geometry-gbuffer-v1" | "screen-space-volume-projector-v1" | "screen-space-volume-projector-v2";
	projectionMode: "geometry" | "screen-space-volume";
	nodeId: string;
	nodeName: string;
	version: number;
	revision: number;
	sourceMeshId: string | null;
	sourceMeshName: string | null;
	materialId: string;
	materialName: string;
	materialClassName: string;
	position: [number, number, number] | null;
	normal: [number, number, number] | null;
	rotation: [number, number, number] | null;
	size: [number, number, number] | null;
	angle: number;
	edgeFade: number;
	uvScale: [number, number];
	uvOffset: [number, number];
	alphaMode: "opaque" | "alpha-test" | "alpha-blend";
	opacity: number;
	renderingGroupId: number;
	alphaIndex: number;
	zOffset: number;
	zOffsetUnits: number;
	affectsAlbedo: boolean;
	affectsNormal: boolean;
	affectsReflectivity: boolean;
	affectsAmbientOcclusion: boolean;
	affectsEmissive: boolean;
	channels: IDeferredDecalChannels;
	normalStrength: number;
	metallic: number;
	smoothness: number;
	ambientOcclusion: number;
	emissiveIntensity: number;
	decalLayerMask: number;
	textureNames: string[];
	projectorTextureNames: {
		albedo: string | null;
		normal: string | null;
		reflectivity: string | null;
		ambientOcclusion: string | null;
		emissive: string | null;
	};
	projectorTexturesReady: boolean;
	/** @deprecated Use projectorTextureNames.albedo. */
	projectorTextureName: string | null;
	/** @deprecated Use projectorTexturesReady. */
	projectorTextureReady: boolean;
	affectedMeshCount: number;
	texturesReady: boolean;
	vertexCount: number;
	indexCount: number;
	geometryReady: boolean;
}

export interface IDeferredLightingRuntimeEvidence {
	backend: typeof deferredLightingRuntimeBackend;
	configured: boolean;
	active: boolean;
	ready: boolean;
	cameraId: string | null;
	cameraName: string | null;
	configuredCameraCount: number;
	sharedGeometryBufferHolderCount: number;
	cameraViewport: [number, number, number, number];
	outputRenderTargetName: string | null;
	outputRenderTargetWidth: number;
	outputRenderTargetHeight: number;
	shaderLanguage: "GLSL" | "WGSL" | null;
	geometryBufferReady: boolean;
	geometryBufferWidth: number;
	geometryBufferHeight: number;
	geometryBufferTextureCount: number;
	albedoReady: boolean;
	albedoWidth: number;
	albedoHeight: number;
	emissiveActive: boolean;
	emissiveReady: boolean;
	emissiveWidth: number;
	emissiveHeight: number;
	emissiveMeshCount: number;
	emissiveMaterialCount: number;
	emissiveTextureCount: number;
	emissiveMaximumSources: number;
	emissiveEvidenceTruncated: boolean;
	emissiveFrameCount: number;
	emissiveSources: IDeferredEmissiveSourceEvidence[];
	decalActive: boolean;
	decalReady: boolean;
	decalCount: number;
	decalGeometryCount: number;
	decalProjectorCount: number;
	decalProjectorMaximumSources: number;
	decalProjectorSamplerCount: number;
	decalLayerFilteredProjectorCount: number;
	decalLayerTargetReady: boolean;
	decalLayerTargetWidth: number;
	decalLayerTargetHeight: number;
	decalSourceMeshCount: number;
	decalMaterialCount: number;
	decalTextureCount: number;
	decalMaximumSources: number;
	decalEvidenceTruncated: boolean;
	decalFrameCount: number;
	decalForwardSubMeshSuppressedCount: number;
	decalForwardSuppressionFrameCount: number;
	decalSources: IDeferredDecalSourceEvidence[];
	iblActive: boolean;
	iblReady: boolean;
	iblSelectorReady: boolean;
	iblSelectorWidth: number;
	iblSelectorHeight: number;
	iblSourceCount: number;
	iblMaximumSources: number;
	iblEnvironmentTextureName: string | null;
	iblReflectionProbeCount: number;
	iblReflectionProbeNames: string[];
	iblProbeBlendingActive: boolean;
	iblProbeBlendModel: typeof reflectionProbeBlendModel;
	iblProbeBlendMeshCount: number;
	iblProbeMaximumBlendSources: number;
	iblFrameCount: number;
	iblSources: IDeferredIblSourceEvidence[];
	meshCount: number;
	materialCount: number;
	lightCount: number;
	maximumLights: number;
	cookieActive: boolean;
	cookieReady: boolean;
	cookieCount: number;
	cookieMaximumSources: number;
	cookieFrameCount: number;
	cookieSources: ILightCookieEvidence[];
	areaLightActive: boolean;
	areaLightReady: boolean;
	areaLightCount: number;
	areaLightFrameCount: number;
	areaLightSources: IAreaLightEvidence[];
	frameCount: number;
	shadowLightCount: number;
	shadowMaximumSources: number;
	shadowMapCount: number;
	shadowSamplerCount: number;
	shadowSamplerBudget: number;
	shadowSources: IDeferredShadowSourceEvidence[];
	shadowLightId: string | null;
	shadowLightName: string | null;
	shadowGeneratorType: "classic" | "cascaded" | null;
	shadowMapType: "2d" | "cube" | "2d-array" | null;
	shadowFilter: DeferredShadowFilter | null;
	shadowFilteringQuality: "low" | "medium" | "high" | null;
	shadowBlurScale: number;
	shadowDepthScale: number;
	shadowContactHardeningLightSizeUVRatio: number;
	shadowCascadeCount: number;
	shadowMapReady: boolean;
	shadowMapWidth: number;
	shadowMapHeight: number;
	shadowCasterCount: number;
	shadowReceiverCount: number;
	shadowFrameCount: number;
	compositionMode: "deferred-only" | "hybrid-forward";
	forwardCompositionReady: boolean;
	forwardCompositionFrameCount: number;
	forwardMeshCount: number;
	transparentMeshCount: number;
	backgroundMeshCount: number;
	laterRenderingGroupMeshCount: number;
	particleSystemCount: number;
	spriteManagerCount: number;
	layerCount: number;
	limitations: string[];
	warnings: string[];
	errors: string[];
}

interface IDeferredLightingState {
	scene: Scene;
	camera: Camera;
	manager: IDeferredLightingSceneManager;
	runtime: IDeferredLightingRuntimeEvidence;
	geometryBuffer: GeometryBufferRenderer;
	geometryBufferLeaseHolder: string;
	geometryBufferTargetAddedToCamera: boolean;
	albedoTarget: RenderTargetTexture;
	albedoMaterials: Material[];
	emissiveTarget: RenderTargetTexture | null;
	emissiveMaterials: Material[];
	emissiveSources: IDeferredEmissiveSource[];
	emissiveSignature: string;
	decalSources: IDeferredDecalSource[];
	decalSignature: string;
	decalLayerTarget: RenderTargetTexture | null;
	decalLayerMaterials: Material[];
	iblSelectorTarget: RenderTargetTexture | null;
	iblSelectorMaterials: Material[];
	iblSources: IDeferredIblSource[];
	iblSignature: string;
	cookieSources: IDeferredCookieSource[];
	cookieSignature: string;
	areaLightSignature: string;
	iblEffectWrapper: EffectWrapper | null;
	activeIblSource: IDeferredIblSource | null;
	shadowSources: IDeferredShadowSource[];
	shadowReceiverTarget: RenderTargetTexture | null;
	shadowReceiverMaterial: StandardMaterial | null;
	effectRenderer: EffectRenderer;
	effectWrapper: EffectWrapper;
	meshIds: string[];
}

interface IDeferredRenderingGroup {
	onBeforeTransparentRendering: (() => void) | undefined;
	_transparentSubMeshes: {
		data: Array<{ getMesh: () => AbstractMesh }>;
		length: number;
	};
	_renderSprites: () => void;
	_renderParticles: (activeMeshes: unknown) => void;
}

interface IDeferredLightingSceneManager {
	scene: Scene;
	states: Map<Camera, IDeferredLightingState>;
	renderingGroup: IDeferredRenderingGroup;
	previousBeforeTransparentRendering: (() => void) | undefined;
	beforeTransparentRendering: () => void;
	previousRenderSprites: () => void;
	previousRenderParticles: (activeMeshes: unknown) => void;
	suppressedRenderSprites: () => void;
	suppressedRenderParticles: (activeMeshes: unknown) => void;
	hadOwnRenderSprites: boolean;
	hadOwnRenderParticles: boolean;
	cameraRemovedObserver: Observer<Camera> | null;
	disposeObserver: Observer<Scene> | null;
}

interface IDeferredSceneCompatibility {
	meshes: AbstractMesh[];
	forwardMeshes: AbstractMesh[];
	materials: Material[];
	lights: Light[];
	shadowSources: IDeferredShadowSource[];
	/** @deprecated Use shadowSources. Retained as first-source compatibility evidence. */
	shadowGenerator: ShadowGenerator | null;
	/** @deprecated Use shadowSources. Retained as first-source compatibility evidence. */
	shadowLight: Light | null;
	/** @deprecated Use shadowSources. Retained as first-source compatibility evidence. */
	shadowMode: DeferredShadowMode;
	shadowReceiverMeshes: AbstractMesh[];
	emissiveSources: IDeferredEmissiveSource[];
	decalSources: IDeferredDecalSource[];
	iblSources: IDeferredIblSource[];
	cookieSources: IDeferredCookieSource[];
	areaLightSources: IAreaLightEvidence[];
	transparentMeshCount: number;
	backgroundMeshCount: number;
	laterRenderingGroupMeshCount: number;
	particleSystemCount: number;
	spriteManagerCount: number;
	layerCount: number;
	warnings: string[];
	errors: string[];
}

interface IDeferredIblSource {
	index: number;
	kind: IDeferredIblSourceEvidence["kind"];
	name: string;
	texture: BaseTexture;
	probe: ReflectionProbe | null;
	probeSlot: number | null;
	intensity: number;
	meshes: Array<{ mesh: AbstractMesh; materialIntensity: number }>;
}

interface IDeferredEmissiveSource {
	material: Material;
	color: Color3;
	texture: BaseTexture | null;
	intensity: number;
	meshes: AbstractMesh[];
}

interface IDeferredDecalSource {
	mesh: AbstractMesh;
	sourceMesh: AbstractMesh | null;
	material: Material;
	projectionMode: IDeferredDecalSourceEvidence["projectionMode"];
	version: number;
	revision: number;
	position: [number, number, number] | null;
	normal: [number, number, number] | null;
	rotation: [number, number, number] | null;
	size: [number, number, number] | null;
	angle: number;
	edgeFade: number;
	uvScale: [number, number];
	uvOffset: [number, number];
	alphaMode: IDeferredDecalSourceEvidence["alphaMode"];
	opacity: number;
	albedoColor: Color3;
	albedoTexture: BaseTexture | null;
	normalTexture: BaseTexture | null;
	reflectivityTexture: BaseTexture | null;
	ambientOcclusionTexture: BaseTexture | null;
	emissiveColor: Color3;
	emissiveTexture: BaseTexture | null;
	worldToLocal: Matrix | null;
	normalToWorld: Matrix | null;
	affectedMeshCount: number;
	affectedMeshIds: number[];
	targetLayerSignature: string;
	textures: BaseTexture[];
	channels: IDeferredDecalChannels;
	normalStrength: number;
	metallic: number;
	smoothness: number;
	ambientOcclusion: number;
	emissiveIntensity: number;
	decalLayerMask: number;
	affectsNormal: boolean;
	affectsReflectivity: boolean;
	affectsAmbientOcclusion: boolean;
	affectsEmissive: boolean;
}

interface IDeferredCookieSource {
	light: Light;
	lightIndex: number;
	texture: BaseTexture;
	evidence: ILightCookieEvidence;
}

interface IDeferredShadowSource {
	light: Light;
	generator: ShadowGenerator;
	mode: DeferredShadowMode;
}

const managers = new WeakMap<Scene, IDeferredLightingSceneManager>();
const reports = new WeakMap<Scene, Map<string, IDeferredLightingRuntimeEvidence>>();

const babylonCsmLowQualityWgslDefect = "vDepthMetric{X}[index{X}],,shadowTexture{X}Sampler";
const babylonCsmLowQualityWgslCorrection = "vDepthMetric{X}[index{X}],shadowTexture{X},shadowTexture{X}Sampler";

function correctBabylonCsmLowQualityWgsl(): void {
	const source = ShaderStore.IncludesShadersStoreWGSL.lightFragment;
	if (source?.includes(babylonCsmLowQualityWgslDefect)) {
		ShaderStore.IncludesShadersStoreWGSL.lightFragment = source.replace(babylonCsmLowQualityWgslDefect, babylonCsmLowQualityWgslCorrection);
	}
}

correctBabylonCsmLowQualityWgsl();

const limitations = [
	"Deferred cameras share Babylon's one scene-wide geometry buffer and execute camera-specific resolves in scene camera render order.",
	"Opaque meshes, alpha-tested meshes, and projected decal meshes in rendering group 0 are deferred; other transparent meshes, particles, sprites, layers, skyboxes, and later rendering groups compose through Babylon's native forward stages.",
	"The bounded resolve supports Standard, PBR, PBR metallic-roughness, PBR specular-glossiness, and OpenPBR materials with point, directional, spot, hemispheric, rectangle-area, and bounded 16-gon disc-area lights.",
	`Up to ${deferredLightingMaximumShadowSources} Babylon-owned heterogeneous shadow generators are sampled simultaneously by the deferred resolve: classic directional/spot hard, Poisson, ESM/blurred ESM, close ESM/blurred close ESM, PCF, or PCSS 2D; point hard, Poisson, ESM, or close-ESM cube; or directional 2–4 cascade hard, PCF, or PCSS array.`,
	"Shadow maps remain Babylon-owned independent textures rather than a Unity-style packed shadow atlas; the runtime rejects a source combination that exceeds the active backend's fragment-texture sampler budget. Babylon normalizes point-light PCF/PCSS requests to Poisson and blurred cube ESM requests to their unblurred native variants.",
	`Up to ${deferredLightingMaximumIblSources} unique scene-environment, material-cubemap, or assigned realtime reflection-probe sources execute per camera. The shared deferred path blends equal-importance overlapping probe boxes per pixel, gives higher importance precedence, and fades remaining weight to the material cubemap or scene environment; Babylon's native forward slot preserves an authored material cubemap and otherwise selects one highest-importance assigned probe per material.`,
	`Up to ${lightCookieMaximumSources} spot 2D, directional tiled 2D, or point cubemap cookies execute per deferred camera; Babylon-native forward cookie projection remains spot-only.`,
	`Projected-geometry decals execute through the shared G-buffer and up to ${deferredLightingMaximumProjectorDecalSources} ordered screen-space volume projectors blend independently enabled albedo, projector-space normal, metallic/smoothness, ambient-occlusion, and emissive channels from reconstructed world position. A native 32-bit rendering-layer mask provides Unity-style Decal Layer filtering. Subsurface scattering and per-object light lists are not evaluated by this deferred resolve. Area lights are one-sided and do not cast realtime shadows.`,
];

function getDeferredShadowFilter(generator: ShadowGenerator): DeferredShadowFilter | null {
	switch (generator.filter) {
		case ShadowGenerator.FILTER_NONE:
			return "hard";
		case ShadowGenerator.FILTER_POISSONSAMPLING:
			return "poisson";
		case ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP:
			return "esm";
		case ShadowGenerator.FILTER_BLUREXPONENTIALSHADOWMAP:
			return "blur-esm";
		case ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP:
			return "close-esm";
		case ShadowGenerator.FILTER_BLURCLOSEEXPONENTIALSHADOWMAP:
			return "blur-close-esm";
		case ShadowGenerator.FILTER_PCF:
			return "pcf";
		case ShadowGenerator.FILTER_PCSS:
			return "pcss";
		default:
			return null;
	}
}

function isClassicShadowMode(mode: DeferredShadowMode): mode is `classic-${DeferredShadowFilter}` {
	return mode.startsWith("classic-");
}

function isPointShadowMode(mode: DeferredShadowMode): mode is Exclude<DeferredShadowMode, "none" | `classic-${DeferredShadowFilter}` | `cascaded-${"hard" | "pcf" | "pcss"}`> {
	return mode.startsWith("point-cube-");
}

function isCascadedShadowMode(mode: DeferredShadowMode): mode is `cascaded-${"hard" | "pcf" | "pcss"}` {
	return mode.startsWith("cascaded-");
}

function isDepthComparisonShadowMode(mode: DeferredShadowMode): boolean {
	return mode.endsWith("-pcf") || mode.endsWith("-pcss");
}

function isPcssShadowMode(mode: DeferredShadowMode): boolean {
	return mode.endsWith("-pcss");
}

function deferredShadowDeclarationGLSL(mode: DeferredShadowMode): string {
	if (mode === "none") {
		return "";
	}
	const common = `#define SHADOWS
#define SHADOWFLOAT
#include<helperFunctions>
#include<shadowsFragmentFunctions>
uniform sampler2D shadowReceiverSampler;
uniform float shadowLightIndex;
uniform float shadowDarkness;
`;
	if (isClassicShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		const samplers = isDepthComparisonShadowMode(mode)
			? `uniform highp sampler2DShadow shadowSampler;
${isPcssShadowMode(mode) ? "uniform sampler2D shadowDepthSampler;" : ""}`
			: "uniform sampler2D shadowColorSampler;";
		return `${common}${samplers}
uniform mat4 shadowMatrix;
uniform vec2 shadowDepthValues;
uniform float shadowMapSize;
uniform float shadowMapSizeInverse;
uniform float shadowBlurScale;
uniform float shadowDepthScale;
uniform float shadowLightSizeUV;
uniform float shadowFilteringQuality;
uniform float shadowFrustumEdgeFalloff;

float deferredShadow(vec3 worldPosition, vec3 viewPosition) {
	vec4 positionFromLight = shadowMatrix * vec4(worldPosition, 1.0);
	float depthMetric = (positionFromLight.z + shadowDepthValues.x) / shadowDepthValues.y;
	${
		filter === "pcf"
			? `if (shadowFilteringQuality < 0.5) { return computeShadowWithPCF1(positionFromLight, depthMetric, shadowSampler, shadowDarkness, shadowFrustumEdgeFalloff); }
	if (shadowFilteringQuality < 1.5) { return computeShadowWithPCF3(positionFromLight, depthMetric, shadowSampler, vec2(shadowMapSize, shadowMapSizeInverse), shadowDarkness, shadowFrustumEdgeFalloff); }
	return computeShadowWithPCF5(positionFromLight, depthMetric, shadowSampler, vec2(shadowMapSize, shadowMapSizeInverse), shadowDarkness, shadowFrustumEdgeFalloff);`
			: filter === "pcss"
				? `if (shadowFilteringQuality < 0.5) { return computeShadowWithPCSS16(positionFromLight, depthMetric, shadowDepthSampler, shadowSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff); }
	if (shadowFilteringQuality < 1.5) { return computeShadowWithPCSS32(positionFromLight, depthMetric, shadowDepthSampler, shadowSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff); }
	return computeShadowWithPCSS64(positionFromLight, depthMetric, shadowDepthSampler, shadowSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff);`
				: filter === "poisson"
					? "return computeShadowWithPoissonSampling(positionFromLight, depthMetric, shadowColorSampler, shadowBlurScale * shadowMapSizeInverse, shadowDarkness, shadowFrustumEdgeFalloff);"
					: filter === "esm" || filter === "blur-esm"
						? "return computeShadowWithESM(positionFromLight, depthMetric, shadowColorSampler, shadowDarkness, shadowDepthScale, shadowFrustumEdgeFalloff);"
						: filter === "close-esm" || filter === "blur-close-esm"
							? "return computeShadowWithCloseESM(positionFromLight, depthMetric, shadowColorSampler, shadowDarkness, shadowDepthScale, shadowFrustumEdgeFalloff);"
							: "return computeShadow(positionFromLight, depthMetric, shadowColorSampler, shadowDarkness, shadowFrustumEdgeFalloff);"
	}
}`;
	}
	if (isPointShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		return `${common}uniform samplerCube shadowCubeSampler;
uniform vec3 shadowLightPosition;
uniform vec2 shadowDepthValues;
uniform float shadowMapSizeInverse;
uniform float shadowBlurScale;
uniform float shadowDepthScale;

float deferredShadow(vec3 worldPosition, vec3 viewPosition) {
	${
		filter === "poisson"
			? "return computeShadowWithPoissonSamplingCube(worldPosition, shadowLightPosition, shadowCubeSampler, shadowBlurScale * shadowMapSizeInverse, shadowDarkness, shadowDepthValues);"
			: filter === "esm"
				? "return computeShadowWithESMCube(worldPosition, shadowLightPosition, shadowCubeSampler, shadowDarkness, shadowDepthScale, shadowDepthValues);"
				: filter === "close-esm"
					? "return computeShadowWithCloseESMCube(worldPosition, shadowLightPosition, shadowCubeSampler, shadowDarkness, shadowDepthScale, shadowDepthValues);"
					: "return computeShadowCube(worldPosition, shadowLightPosition, shadowCubeSampler, shadowDarkness, shadowDepthValues);"
	}
}`;
	}
	if (isCascadedShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		const samplers = isDepthComparisonShadowMode(mode)
			? `uniform highp sampler2DArrayShadow shadowCascadeSampler;
${isPcssShadowMode(mode) ? "uniform highp sampler2DArray shadowCascadeDepthSampler;" : ""}`
			: "uniform highp sampler2DArray shadowCascadeColorSampler;";
		return `${common}${samplers}
uniform mat4 shadowCascadeMatrices[${deferredLightingMaximumCascades}];
uniform float shadowCascadeFrustumZ[${deferredLightingMaximumCascades}];
uniform float shadowCascadeFrustumLength[${deferredLightingMaximumCascades}];
uniform vec2 shadowCascadeLightSizeUVCorrection[${deferredLightingMaximumCascades}];
uniform float shadowCascadeDepthCorrection[${deferredLightingMaximumCascades}];
uniform float shadowCascadeCount;
uniform float shadowCascadeBlendFactor;
uniform vec2 shadowDepthValues;
uniform float shadowMapSize;
uniform float shadowMapSizeInverse;
uniform float shadowLightSizeUV;
uniform float shadowFilteringQuality;
uniform float shadowPenumbraDarkness;
uniform float shadowFrustumEdgeFalloff;

float deferredCascadeSample(vec3 worldPosition, int cascadeIndex) {
	vec4 positionFromLight = shadowCascadeMatrices[cascadeIndex] * vec4(worldPosition, 1.0);
	float depthMetric = (positionFromLight.z + shadowDepthValues.x) / shadowDepthValues.y;
	${
		filter === "pcf"
			? `if (shadowFilteringQuality < 0.5) { return computeShadowWithCSMPCF1(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeSampler, shadowDarkness, shadowFrustumEdgeFalloff); }
	if (shadowFilteringQuality < 1.5) { return computeShadowWithCSMPCF3(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeSampler, vec2(shadowMapSize, shadowMapSizeInverse), shadowDarkness, shadowFrustumEdgeFalloff); }
	return computeShadowWithCSMPCF5(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeSampler, vec2(shadowMapSize, shadowMapSizeInverse), shadowDarkness, shadowFrustumEdgeFalloff);`
			: filter === "pcss"
				? `if (shadowFilteringQuality < 0.5) { return computeShadowWithCSMPCSS16(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff, shadowCascadeLightSizeUVCorrection[cascadeIndex], shadowCascadeDepthCorrection[cascadeIndex], shadowPenumbraDarkness); }
	if (shadowFilteringQuality < 1.5) { return computeShadowWithCSMPCSS32(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff, shadowCascadeLightSizeUVCorrection[cascadeIndex], shadowCascadeDepthCorrection[cascadeIndex], shadowPenumbraDarkness); }
	return computeShadowWithCSMPCSS64(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeSampler, shadowMapSizeInverse, shadowLightSizeUV, shadowDarkness, shadowFrustumEdgeFalloff, shadowCascadeLightSizeUVCorrection[cascadeIndex], shadowCascadeDepthCorrection[cascadeIndex], shadowPenumbraDarkness);`
				: "return computeShadowCSM(float(cascadeIndex), positionFromLight, depthMetric, shadowCascadeColorSampler, shadowDarkness, shadowFrustumEdgeFalloff);"
	}
}

float deferredShadow(vec3 worldPosition, vec3 viewPosition) {
	int cascadeIndex = max(int(shadowCascadeCount) - 1, 0);
	float cascadeDifference = 0.0;
	for (int cascade = 0; cascade < ${deferredLightingMaximumCascades}; ++cascade) {
		if (float(cascade) >= shadowCascadeCount) { break; }
		cascadeDifference = shadowCascadeFrustumZ[cascade] - viewPosition.z;
		if (cascadeDifference >= 0.0) { cascadeIndex = cascade; break; }
	}
	float visibility = deferredCascadeSample(worldPosition, cascadeIndex);
	float blendRatio = clamp(cascadeDifference / max(shadowCascadeFrustumLength[cascadeIndex], 0.00001), 0.0, 1.0) * shadowCascadeBlendFactor;
	if (cascadeIndex + 1 < int(shadowCascadeCount) && blendRatio < 1.0) {
		visibility = mix(deferredCascadeSample(worldPosition, cascadeIndex + 1), visibility, blendRatio);
	}
	return visibility;
}`;
	}
	return "";
}

function deferredShadowDeclarationsGLSL(sources: IDeferredShadowSource[]): string {
	if (!sources.length) {
		return "";
	}
	const common = `#define SHADOWS
#define SHADOWFLOAT
#include<helperFunctions>
#include<shadowsFragmentFunctions>
uniform sampler2D shadowReceiverSampler;
`;
	const declarations = sources.map(({ mode }, index) => {
		const source = deferredShadowDeclarationGLSL(mode)
			.replace(
				/^#define SHADOWS\n#define SHADOWFLOAT\n#include<helperFunctions>\n#include<shadowsFragmentFunctions>\nuniform sampler2D shadowReceiverSampler;\nuniform float shadowLightIndex;\nuniform float shadowDarkness;\n/,
				""
			)
			.replace(/\bdeferredCascadeSample\b/g, `deferredCascadeSample${index}`)
			.replace(/\bdeferredShadow\b/g, `deferredShadow${index}`)
			.replace(/\bshadow([A-Z][A-Za-z0-9_]*)\b/g, (_match, name: string) => `shadow${name}${index}`);
		return `uniform float shadowLightIndex${index};\nuniform float shadowDarkness${index};\n${source}`;
	});
	return `${common}${declarations.join("\n")}`;
}

function deferredShadowApplicationGLSL(sources: IDeferredShadowSource[]): string {
	if (!sources.length) {
		return "";
	}
	const samples = sources
		.map((_source, index) => `if (abs(float(i) - shadowLightIndex${index}) < 0.25) { shadow = deferredShadow${index}(positionSample.xyz, positionV); }`)
		.join(" else ");
	return `if (texture2D(shadowReceiverSampler, deferredUV).r > 0.5) { ${samples} }`;
}

function deferredCookieDeclarationGLSL(sources: IDeferredCookieSource[]): string {
	if (!sources.length) {
		return "vec3 deferredLightCookie(int lightIndex, vec3 worldPosition) { return vec3(1.0); }";
	}
	const declarations = sources
		.map((source, index) => {
			const common = `uniform float lightCookieIntensity${index};`;
			if (source.evidence.kind === "point-cube") {
				return `${common}\nuniform samplerCube lightCookieCube${index};\nuniform vec3 lightCookiePosition${index};`;
			}
			if (source.evidence.kind === "directional-2d") {
				return `${common}\nuniform sampler2D lightCookie2D${index};\nuniform vec3 lightCookieRight${index};\nuniform vec3 lightCookieUp${index};\nuniform vec4 lightCookieScaleOffset${index};`;
			}
			return `${common}\nuniform sampler2D lightCookie2D${index};\nuniform mat4 lightCookieMatrix${index};`;
		})
		.join("\n");
	const branches = sources
		.map((source, index) => {
			const blend = `return mix(vec3(1.0), cookieColor, lightCookieIntensity${index});`;
			if (source.evidence.kind === "point-cube") {
				return `if (lightIndex == ${source.lightIndex}) { vec3 cookieColor = textureCube(lightCookieCube${index}, normalize(worldPosition - lightCookiePosition${index})).rgb; ${blend} }`;
			}
			if (source.evidence.kind === "directional-2d") {
				return `if (lightIndex == ${source.lightIndex}) { vec2 cookieUV = vec2(dot(worldPosition, lightCookieRight${index}) * lightCookieScaleOffset${index}.x, dot(worldPosition, lightCookieUp${index}) * lightCookieScaleOffset${index}.y) + lightCookieScaleOffset${index}.zw; vec3 cookieColor = texture2D(lightCookie2D${index}, cookieUV).rgb; ${blend} }`;
			}
			return `if (lightIndex == ${source.lightIndex}) { vec4 cookieProjection = lightCookieMatrix${index} * vec4(worldPosition, 1.0); if (cookieProjection.w <= 0.0) { return vec3(1.0 - lightCookieIntensity${index}); } vec2 cookieUV = cookieProjection.xy / cookieProjection.w; if (any(lessThan(cookieUV, vec2(0.0))) || any(greaterThan(cookieUV, vec2(1.0)))) { return vec3(1.0 - lightCookieIntensity${index}); } vec3 cookieColor = texture2D(lightCookie2D${index}, cookieUV).rgb; ${blend} }`;
		})
		.join("\n");
	return `${declarations}\nvec3 deferredLightCookie(int lightIndex, vec3 worldPosition) {\n${branches}\nreturn vec3(1.0);\n}`;
}

function deferredAreaDeclarationGLSL(active: boolean, helperFunctionsAlreadyIncluded: boolean): string {
	if (!active) {
		return "";
	}
	return `${helperFunctionsAlreadyIncluded ? "" : "#include<helperFunctions>\n"}#define SPECULARTERM
#include<ltcHelperFunctions>
uniform sampler2D areaLightsLTC1Sampler;
uniform sampler2D areaLightsLTC2Sampler;

vec3 deferredLTCEvaluateDisc(vec3 N, vec3 V, vec3 P, mat3 mInv, vec3 lightPosition, vec3 halfWidth, vec3 halfHeight) {
	vec3 lightNormal = -cross(halfWidth, halfHeight);
	if (dot(lightNormal, P - lightPosition) < 0.0) { return vec3(0.0); }
	vec3 T1 = normalize(V - N * dot(V, N));
	vec3 T2 = -cross(N, T1);
	mat3 basis = mInv * transposeMat3(mat3(T1, T2, N));
	vec3 first = normalize(basis * (lightPosition + halfWidth - P));
	vec3 previous = first;
	vec3 vectorFormFactor = vec3(0.0);
	for (int edge = 1; edge <= 16; ++edge) {
		float angle = -6.28318530718 * float(edge) / 16.0;
		vec3 current = normalize(basis * (lightPosition + cos(angle) * halfWidth + sin(angle) * halfHeight - P));
		vectorFormFactor += LTCEdgeVectorFormFactor(previous, current);
		previous = current;
	}
	return vec3(LTCClippedSphereFormFactor(vectorFormFactor));
}

areaLightData deferredDiscAreaLight(vec3 V, vec3 N, vec3 P, vec3 lightPosition, vec3 halfWidth, vec3 halfHeight, float roughness) {
	areaLightData result;
	result.Diffuse = vec3(0.0);
	result.Specular = vec3(0.0);
	result.Fresnel = vec4(0.0);
	vec2 uv = LTCUv(N, V, roughness);
	vec4 t1 = texture2D(areaLightsLTC1Sampler, uv);
	vec4 t2 = texture2D(areaLightsLTC2Sampler, uv);
	mat3 mInv = mat3(vec3(t1.x, 0.0, t1.y), vec3(0.0, 1.0, 0.0), vec3(t1.z, 0.0, t1.w));
	result.Specular = deferredLTCEvaluateDisc(N, V, P, mInv, lightPosition, halfWidth, halfHeight);
	result.Fresnel = t2;
	result.Diffuse = deferredLTCEvaluateDisc(N, V, P, mat3(1.0), lightPosition, halfWidth, halfHeight);
	return result;
}`;
}

function decalProjectorDeclarationsGLSL(sources: IDeferredDecalSource[]): string {
	const filtered = sources.some((source) => source.decalLayerMask !== 0xffffffff);
	return (
		sources
			.map(
				(source, index) => `uniform mat4 decalProjectorWorldToLocal${index};
uniform mat4 decalProjectorNormalToWorld${index};
uniform vec4 decalProjectorColor${index};
uniform vec4 decalProjectorUv${index};
uniform vec4 decalProjectorMaterial${index};
uniform vec4 decalProjectorEmissive${index};
uniform vec4 decalProjectorLayerMask${index};
uniform float decalProjectorEdgeFade${index};
${source.albedoTexture ? `uniform sampler2D decalProjectorAlbedoSampler${index};` : ""}
${source.channels.normal && source.normalTexture ? `uniform sampler2D decalProjectorNormalSampler${index};` : ""}
${source.channels.metallic && source.reflectivityTexture ? `uniform sampler2D decalProjectorReflectivitySampler${index};` : ""}
${source.channels.ambientOcclusion && source.ambientOcclusionTexture ? `uniform sampler2D decalProjectorAmbientOcclusionSampler${index};` : ""}
${source.channels.emissive && source.emissiveTexture ? `uniform sampler2D decalProjectorEmissiveSampler${index};` : ""}`
			)
			.join("\n") +
		(filtered
			? `
uniform sampler2D decalLayerMaskSampler;

float decalLayerByteOverlap(float encodedByte, float maskByte) {
	float overlap = 0.0;
	overlap += mod(floor(encodedByte / 1.0), 2.0) * mod(floor(maskByte / 1.0), 2.0);
	overlap += mod(floor(encodedByte / 2.0), 2.0) * mod(floor(maskByte / 2.0), 2.0);
	overlap += mod(floor(encodedByte / 4.0), 2.0) * mod(floor(maskByte / 4.0), 2.0);
	overlap += mod(floor(encodedByte / 8.0), 2.0) * mod(floor(maskByte / 8.0), 2.0);
	overlap += mod(floor(encodedByte / 16.0), 2.0) * mod(floor(maskByte / 16.0), 2.0);
	overlap += mod(floor(encodedByte / 32.0), 2.0) * mod(floor(maskByte / 32.0), 2.0);
	overlap += mod(floor(encodedByte / 64.0), 2.0) * mod(floor(maskByte / 64.0), 2.0);
	overlap += mod(floor(encodedByte / 128.0), 2.0) * mod(floor(maskByte / 128.0), 2.0);
	return overlap;
}

bool decalLayerMatches(vec4 encodedMask, vec4 projectorMask) {
	vec4 encodedBytes = floor(encodedMask * 255.0 + 0.5);
	return decalLayerByteOverlap(encodedBytes.r, projectorMask.r) + decalLayerByteOverlap(encodedBytes.g, projectorMask.g) + decalLayerByteOverlap(encodedBytes.b, projectorMask.b) + decalLayerByteOverlap(encodedBytes.a, projectorMask.a) > 0.5;
}`
			: "")
	);
}

function decalProjectorApplicationGLSL(sources: IDeferredDecalSource[], normalSpace: "view" | "world", includeEmissive: boolean): string {
	return sources
		.map(
			(source, index) => `{
	vec3 projectorLocal = (decalProjectorWorldToLocal${index} * vec4(positionSample.xyz, 1.0)).xyz;
	vec3 projectorBoundary = vec3(0.5) - abs(projectorLocal);
	bool projectorLayerAllowed = ${source.decalLayerMask === 0xffffffff ? "true" : `decalLayerMatches(texture2D(decalLayerMaskSampler, deferredUV), decalProjectorLayerMask${index})`};
	if (projectorLayerAllowed && min(min(projectorBoundary.x, projectorBoundary.y), projectorBoundary.z) >= 0.0) {
		vec2 projectorUV = (projectorLocal.xy + vec2(0.5)) * decalProjectorUv${index}.xy + decalProjectorUv${index}.zw;
		vec4 projectorSample = decalProjectorColor${index};
		${source.albedoTexture ? `projectorSample *= texture2D(decalProjectorAlbedoSampler${index}, projectorUV);` : ""}
		float projectorFadeWidth = max(decalProjectorEdgeFade${index} * 0.5, 0.00001);
		float projectorFade = decalProjectorEdgeFade${index} <= 0.0 ? 1.0 : smoothstep(0.0, projectorFadeWidth, min(min(projectorBoundary.x, projectorBoundary.y), projectorBoundary.z));
		float projectorWeight = clamp(projectorSample.a * projectorFade, 0.0, 1.0);
		${source.channels.albedo ? "albedo = mix(albedo, projectorSample.rgb, projectorWeight);" : ""}
		${
			source.channels.normal
				? `vec3 projectorNormalSample = ${source.normalTexture ? `texture2D(decalProjectorNormalSampler${index}, projectorUV).xyz` : "vec3(0.5, 0.5, 1.0)"} * 2.0 - 1.0;
		projectorNormalSample.xy *= vec2(abs(decalProjectorMaterial${index}.x), sign(decalProjectorMaterial${index}.x) * abs(decalProjectorMaterial${index}.x));
		vec3 projectorNormalW = normalize((decalProjectorNormalToWorld${index} * vec4(normalize(projectorNormalSample), 0.0)).xyz);
		${normalSpace === "view" ? `vec3 projectorNormal = normalize((view * vec4(projectorNormalW, 0.0)).xyz);` : "vec3 projectorNormal = projectorNormalW;"}
		${normalSpace === "view" ? "normalV" : "normalW"} = normalize(mix(${normalSpace === "view" ? "normalV" : "normalW"}, projectorNormal, projectorWeight));`
				: ""
		}
		${
			source.channels.metallic
				? `vec2 projectorReflectivity = decalProjectorMaterial${index}.yz;
		${source.reflectivityTexture ? `vec4 projectorReflectivitySample = texture2D(decalProjectorReflectivitySampler${index}, projectorUV); projectorReflectivity *= vec2(projectorReflectivitySample.r, projectorReflectivitySample.a);` : ""}
		vec3 projectorF0 = mix(vec3(0.04), projectorSample.rgb, clamp(projectorReflectivity.x, 0.0, 1.0));
		reflectivity = mix(reflectivity, vec4(projectorF0, clamp(projectorReflectivity.y, 0.0, 1.0)), projectorWeight);`
				: ""
		}
		${
			source.channels.ambientOcclusion
				? `float projectorAo = decalProjectorMaterial${index}.w;
		${source.ambientOcclusionTexture ? `projectorAo *= texture2D(decalProjectorAmbientOcclusionSampler${index}, projectorUV).r;` : ""}
		ambientOcclusion *= mix(1.0, clamp(projectorAo, 0.0, 1.0), projectorWeight);`
				: ""
		}
		${
			includeEmissive && source.channels.emissive
				? `vec3 projectorEmission = decalProjectorEmissive${index}.rgb * decalProjectorEmissive${index}.a;
		${source.emissiveTexture ? `projectorEmission *= texture2D(decalProjectorEmissiveSampler${index}, projectorUV).rgb;` : ""}
		emissive += max(projectorEmission, vec3(0.0)) * projectorWeight;`
				: ""
		}
	}
}`
		)
		.join("\n");
}

function deferredFragmentShaderGLSL(
	shadowSources: IDeferredShadowSource[],
	emissiveActive: boolean,
	cookieSources: IDeferredCookieSource[],
	areaLightActive: boolean,
	projectorSources: IDeferredDecalSource[]
): string {
	return `
precision highp float;
varying vec2 vUV;
uniform sampler2D positionSampler;
uniform sampler2D normalSampler;
uniform sampler2D reflectivitySampler;
uniform sampler2D albedoSampler;
${emissiveActive ? "uniform sampler2D emissiveSampler;" : ""}
uniform mat4 view;
uniform vec4 cameraViewport;
uniform vec3 ambientColor;
uniform float normalUnsigned;
uniform float lightCount;
uniform vec4 lightData0[${deferredLightingMaximumLights}];
uniform vec4 lightData1[${deferredLightingMaximumLights}];
uniform vec4 lightData2[${deferredLightingMaximumLights}];
uniform vec4 lightData3[${deferredLightingMaximumLights}];
uniform vec4 lightData4[${deferredLightingMaximumLights}];
${deferredShadowDeclarationsGLSL(shadowSources)}
${deferredCookieDeclarationGLSL(cookieSources)}
${deferredAreaDeclarationGLSL(areaLightActive, shadowSources.length > 0)}
${decalProjectorDeclarationsGLSL(projectorSources)}

void main(void) {
	vec2 deferredUV = cameraViewport.xy + vUV * cameraViewport.zw;
	vec4 positionSample = texture2D(positionSampler, deferredUV);
	vec4 albedoSample = texture2D(albedoSampler, deferredUV);
	if (albedoSample.a < 0.0001) {
		gl_FragColor = vec4(0.0);
		return;
	}
	vec3 normalV = normalize(texture2D(normalSampler, deferredUV).xyz);
	if (normalUnsigned > 0.5) {
		normalV = normalize(normalV * 2.0 - 1.0);
	}
	vec3 positionV = (view * vec4(positionSample.xyz, 1.0)).xyz;
	vec3 viewDirection = normalize(-positionV);
	vec3 albedo = max(albedoSample.rgb, vec3(0.0));
	vec4 reflectivity = texture2D(reflectivitySampler, deferredUV);
	float ambientOcclusion = 1.0;
	vec3 emissive = ${emissiveActive ? "max(texture2D(emissiveSampler, deferredUV).rgb, vec3(0.0))" : "vec3(0.0)"};
	${decalProjectorApplicationGLSL(projectorSources, "view", true)}
	float smoothness = clamp(reflectivity.a, 0.0, 1.0);
	vec3 result = albedo * ambientColor * ambientOcclusion;
	for (int i = 0; i < ${deferredLightingMaximumLights}; ++i) {
		if (float(i) >= lightCount) {
			break;
		}
		vec4 data0 = lightData0[i];
		vec3 lightColor = lightData3[i].rgb * data0.y;
		${
			areaLightActive
				? `if (data0.x > 3.5) {
			vec3 lightPositionV = (view * vec4(lightData1[i].xyz, 1.0)).xyz;
			vec3 halfWidthV = (view * vec4(lightData2[i].xyz, 0.0)).xyz;
			vec3 halfHeightV = (view * vec4(lightData4[i].xyz, 0.0)).xyz;
			areaLightData areaData;
			if (data0.w > 0.5) {
				areaData = deferredDiscAreaLight(viewDirection, normalV, positionV, lightPositionV, halfWidthV, halfHeightV, 1.0 - smoothness);
			} else {
				areaData = computeAreaLightSpecularDiffuseFresnel(areaLightsLTC1Sampler, areaLightsLTC2Sampler, viewDirection, normalV, positionV, lightPositionV, halfWidthV, halfHeightV, 1.0 - smoothness);
			}
			vec3 fresnel = reflectivity.rgb * areaData.Fresnel.x + (vec3(1.0) - reflectivity.rgb) * areaData.Fresnel.y;
			float distanceToLight = length(lightPositionV - positionV);
			float rangeFactor = clamp(1.0 - distanceToLight / max(data0.z, 0.00001), 0.0, 1.0);
			float attenuation = rangeFactor * rangeFactor;
			result += (albedo * areaData.Diffuse + reflectivity.rgb * fresnel * areaData.Specular) * lightColor * attenuation;
			continue;
		}`
				: ""
		}
		if (data0.x > 2.5) {
			vec3 upV = normalize((view * vec4(lightData2[i].xyz, 0.0)).xyz);
			float sky = dot(normalV, upV) * 0.5 + 0.5;
			result += albedo * mix(lightData4[i].rgb, lightColor, sky);
			continue;
		}
		vec3 lightDirectionV;
		float attenuation = 1.0;
		if (data0.x > 0.5 && data0.x < 1.5) {
			lightDirectionV = normalize(-(view * vec4(lightData2[i].xyz, 0.0)).xyz);
		} else {
			vec3 lightPositionV = (view * vec4(lightData1[i].xyz, 1.0)).xyz;
			vec3 toLight = lightPositionV - positionV;
			float distanceToLight = length(toLight);
			lightDirectionV = toLight / max(distanceToLight, 0.00001);
			float rangeFactor = clamp(1.0 - distanceToLight / max(data0.z, 0.00001), 0.0, 1.0);
			attenuation = rangeFactor * rangeFactor;
			if (data0.x > 1.5) {
				vec3 spotDirectionV = normalize((view * vec4(lightData2[i].xyz, 0.0)).xyz);
				float cone = dot(-lightDirectionV, spotDirectionV);
				attenuation *= pow(smoothstep(data0.w, 1.0, cone), max(lightData1[i].w, 1.0));
			}
		}
		float diffuse = max(dot(normalV, lightDirectionV), 0.0);
		vec3 halfDirection = normalize(lightDirectionV + viewDirection);
		float specular = pow(max(dot(normalV, halfDirection), 0.0), mix(8.0, 256.0, smoothness)) * step(0.0001, diffuse);
		float shadow = 1.0;
		${deferredShadowApplicationGLSL(shadowSources)}
		vec3 cookie = deferredLightCookie(i, positionSample.xyz);
		result += (albedo * diffuse + reflectivity.rgb * specular) * lightColor * cookie * attenuation * shadow;
	}
	result += emissive;
	gl_FragColor = vec4(max(result, vec3(0.0)), 1.0);
}`;
}

function deferredShadowDeclarationWGSL(mode: DeferredShadowMode): string {
	if (mode === "none") {
		return "";
	}
	const common = `#define SHADOWS
#define SHADOWFLOAT
#include<helperFunctions>
#include<shadowsFragmentFunctions>
var shadowReceiverSamplerSampler: sampler;
var shadowReceiverSampler: texture_2d<f32>;
uniform shadowLightIndex: f32;
uniform shadowDarkness: f32;
`;
	if (isClassicShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		const samplers = isDepthComparisonShadowMode(mode)
			? `var shadowSamplerSampler: sampler_comparison;
var shadowSampler: texture_depth_2d;
${isPcssShadowMode(mode) ? "var shadowDepthSamplerSampler: sampler;\nvar shadowDepthSampler: texture_2d<f32>;" : ""}`
			: "var shadowColorSamplerSampler: sampler;\nvar shadowColorSampler: texture_2d<f32>;";
		return `${common}${samplers}
uniform shadowMatrix: mat4x4f;
uniform shadowDepthValues: vec2f;
uniform shadowMapSize: f32;
uniform shadowMapSizeInverse: f32;
uniform shadowBlurScale: f32;
uniform shadowDepthScale: f32;
uniform shadowLightSizeUV: f32;
uniform shadowFilteringQuality: f32;
uniform shadowFrustumEdgeFalloff: f32;

fn deferredShadow(worldPosition: vec3f, viewPosition: vec3f) -> f32 {
	let positionFromLight = uniforms.shadowMatrix * vec4f(worldPosition, 1.0);
	let depthMetric = (positionFromLight.z + uniforms.shadowDepthValues.x) / uniforms.shadowDepthValues.y;
	${
		filter === "pcf"
			? `if (uniforms.shadowFilteringQuality < 0.5) { return computeShadowWithPCF1(positionFromLight, depthMetric, shadowSampler, shadowSamplerSampler, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	if (uniforms.shadowFilteringQuality < 1.5) { return computeShadowWithPCF3(positionFromLight, depthMetric, shadowSampler, shadowSamplerSampler, vec2f(uniforms.shadowMapSize, uniforms.shadowMapSizeInverse), uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	return computeShadowWithPCF5(positionFromLight, depthMetric, shadowSampler, shadowSamplerSampler, vec2f(uniforms.shadowMapSize, uniforms.shadowMapSizeInverse), uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);`
			: filter === "pcss"
				? `if (uniforms.shadowFilteringQuality < 0.5) { return computeShadowWithPCSS16(positionFromLight, depthMetric, shadowDepthSampler, shadowDepthSamplerSampler, shadowSampler, shadowSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	if (uniforms.shadowFilteringQuality < 1.5) { return computeShadowWithPCSS32(positionFromLight, depthMetric, shadowDepthSampler, shadowDepthSamplerSampler, shadowSampler, shadowSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	return computeShadowWithPCSS64(positionFromLight, depthMetric, shadowDepthSampler, shadowDepthSamplerSampler, shadowSampler, shadowSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);`
				: filter === "poisson"
					? "return computeShadowWithPoissonSampling(positionFromLight, depthMetric, shadowColorSampler, shadowColorSamplerSampler, uniforms.shadowBlurScale * uniforms.shadowMapSizeInverse, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);"
					: filter === "esm" || filter === "blur-esm"
						? "return computeShadowWithESM(positionFromLight, depthMetric, shadowColorSampler, shadowColorSamplerSampler, uniforms.shadowDarkness, uniforms.shadowDepthScale, uniforms.shadowFrustumEdgeFalloff);"
						: filter === "close-esm" || filter === "blur-close-esm"
							? "return computeShadowWithCloseESM(positionFromLight, depthMetric, shadowColorSampler, shadowColorSamplerSampler, uniforms.shadowDarkness, uniforms.shadowDepthScale, uniforms.shadowFrustumEdgeFalloff);"
							: "return computeShadow(positionFromLight, depthMetric, shadowColorSampler, shadowColorSamplerSampler, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);"
	}
}`;
	}
	if (isPointShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		return `${common}var shadowCubeSamplerSampler: sampler;
var shadowCubeSampler: texture_cube<f32>;
uniform shadowLightPosition: vec3f;
uniform shadowDepthValues: vec2f;
uniform shadowMapSizeInverse: f32;
uniform shadowBlurScale: f32;
uniform shadowDepthScale: f32;

fn deferredShadow(worldPosition: vec3f, viewPosition: vec3f) -> f32 {
	${
		filter === "poisson"
			? "return computeShadowWithPoissonSamplingCube(worldPosition, uniforms.shadowLightPosition, shadowCubeSampler, shadowCubeSamplerSampler, uniforms.shadowBlurScale * uniforms.shadowMapSizeInverse, uniforms.shadowDarkness, uniforms.shadowDepthValues);"
			: filter === "esm"
				? "return computeShadowWithESMCube(worldPosition, uniforms.shadowLightPosition, shadowCubeSampler, shadowCubeSamplerSampler, uniforms.shadowDarkness, uniforms.shadowDepthScale, uniforms.shadowDepthValues);"
				: filter === "close-esm"
					? "return computeShadowWithCloseESMCube(worldPosition, uniforms.shadowLightPosition, shadowCubeSampler, shadowCubeSamplerSampler, uniforms.shadowDarkness, uniforms.shadowDepthScale, uniforms.shadowDepthValues);"
					: "return computeShadowCube(worldPosition, uniforms.shadowLightPosition, shadowCubeSampler, shadowCubeSamplerSampler, uniforms.shadowDarkness, uniforms.shadowDepthValues);"
	}
}`;
	}
	if (isCascadedShadowMode(mode)) {
		const filter = shadowFilter(mode)!;
		const samplers = isDepthComparisonShadowMode(mode)
			? `var shadowCascadeSamplerSampler: sampler_comparison;
var shadowCascadeSampler: texture_depth_2d_array;
${isPcssShadowMode(mode) ? "var shadowCascadeDepthSamplerSampler: sampler;\nvar shadowCascadeDepthSampler: texture_2d_array<f32>;" : ""}`
			: "var shadowCascadeColorSamplerSampler: sampler;\nvar shadowCascadeColorSampler: texture_2d_array<f32>;";
		return `${common}${samplers}
uniform shadowCascadeMatrices: array<mat4x4f, ${deferredLightingMaximumCascades}>;
uniform shadowCascadeFrustumZ: array<f32, ${deferredLightingMaximumCascades}>;
uniform shadowCascadeFrustumLength: array<f32, ${deferredLightingMaximumCascades}>;
uniform shadowCascadeLightSizeUVCorrection: array<vec2f, ${deferredLightingMaximumCascades}>;
uniform shadowCascadeDepthCorrection: array<f32, ${deferredLightingMaximumCascades}>;
uniform shadowCascadeCount: f32;
uniform shadowCascadeBlendFactor: f32;
uniform shadowDepthValues: vec2f;
uniform shadowMapSize: f32;
uniform shadowMapSizeInverse: f32;
uniform shadowLightSizeUV: f32;
uniform shadowFilteringQuality: f32;
uniform shadowPenumbraDarkness: f32;
uniform shadowFrustumEdgeFalloff: f32;

fn deferredCascadeSample(worldPosition: vec3f, cascadeIndex: i32) -> f32 {
	let positionFromLight = uniforms.shadowCascadeMatrices[cascadeIndex] * vec4f(worldPosition, 1.0);
	let depthMetric = (positionFromLight.z + uniforms.shadowDepthValues.x) / uniforms.shadowDepthValues.y;
	${
		filter === "pcf"
			? `if (uniforms.shadowFilteringQuality < 0.5) { return computeShadowWithCSMPCF1(cascadeIndex, positionFromLight, depthMetric, shadowCascadeSampler, shadowCascadeSamplerSampler, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	if (uniforms.shadowFilteringQuality < 1.5) { return computeShadowWithCSMPCF3(cascadeIndex, positionFromLight, depthMetric, shadowCascadeSampler, shadowCascadeSamplerSampler, vec2f(uniforms.shadowMapSize, uniforms.shadowMapSizeInverse), uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff); }
	return computeShadowWithCSMPCF5(cascadeIndex, positionFromLight, depthMetric, shadowCascadeSampler, shadowCascadeSamplerSampler, vec2f(uniforms.shadowMapSize, uniforms.shadowMapSizeInverse), uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);`
			: filter === "pcss"
				? `if (uniforms.shadowFilteringQuality < 0.5) { return computeShadowWithCSMPCSS16(cascadeIndex, positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeDepthSamplerSampler, shadowCascadeSampler, shadowCascadeSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff, uniforms.shadowCascadeLightSizeUVCorrection[cascadeIndex], uniforms.shadowCascadeDepthCorrection[cascadeIndex], uniforms.shadowPenumbraDarkness); }
	if (uniforms.shadowFilteringQuality < 1.5) { return computeShadowWithCSMPCSS32(cascadeIndex, positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeDepthSamplerSampler, shadowCascadeSampler, shadowCascadeSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff, uniforms.shadowCascadeLightSizeUVCorrection[cascadeIndex], uniforms.shadowCascadeDepthCorrection[cascadeIndex], uniforms.shadowPenumbraDarkness); }
	return computeShadowWithCSMPCSS64(cascadeIndex, positionFromLight, depthMetric, shadowCascadeDepthSampler, shadowCascadeDepthSamplerSampler, shadowCascadeSampler, shadowCascadeSamplerSampler, uniforms.shadowMapSizeInverse, uniforms.shadowLightSizeUV, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff, uniforms.shadowCascadeLightSizeUVCorrection[cascadeIndex], uniforms.shadowCascadeDepthCorrection[cascadeIndex], uniforms.shadowPenumbraDarkness);`
				: "return computeShadowCSM(cascadeIndex, positionFromLight, depthMetric, shadowCascadeColorSampler, shadowCascadeColorSamplerSampler, uniforms.shadowDarkness, uniforms.shadowFrustumEdgeFalloff);"
	}
}

fn deferredShadow(worldPosition: vec3f, viewPosition: vec3f) -> f32 {
	var cascadeIndex = max(i32(uniforms.shadowCascadeCount) - 1, 0);
	var cascadeDifference = 0.0;
	for (var cascade = 0; cascade < ${deferredLightingMaximumCascades}; cascade += 1) {
		if (f32(cascade) >= uniforms.shadowCascadeCount) { break; }
		cascadeDifference = uniforms.shadowCascadeFrustumZ[cascade] - viewPosition.z;
		if (cascadeDifference >= 0.0) { cascadeIndex = cascade; break; }
	}
	var visibility = deferredCascadeSample(worldPosition, cascadeIndex);
	let blendRatio = clamp(cascadeDifference / max(uniforms.shadowCascadeFrustumLength[cascadeIndex], 0.00001), 0.0, 1.0) * uniforms.shadowCascadeBlendFactor;
	if (cascadeIndex + 1 < i32(uniforms.shadowCascadeCount) && blendRatio < 1.0) {
		visibility = mix(deferredCascadeSample(worldPosition, cascadeIndex + 1), visibility, blendRatio);
	}
	return visibility;
}`;
	}
	return "";
}

function deferredShadowDeclarationsWGSL(sources: IDeferredShadowSource[]): string {
	if (!sources.length) {
		return "";
	}
	const common = `#define SHADOWS
#define SHADOWFLOAT
#include<helperFunctions>
#include<shadowsFragmentFunctions>
var shadowReceiverSamplerSampler: sampler;
var shadowReceiverSampler: texture_2d<f32>;
`;
	const declarations = sources.map(({ mode }, index) => {
		const source = deferredShadowDeclarationWGSL(mode)
			.replace(
				/^#define SHADOWS\n#define SHADOWFLOAT\n#include<helperFunctions>\n#include<shadowsFragmentFunctions>\nvar shadowReceiverSamplerSampler: sampler;\nvar shadowReceiverSampler: texture_2d<f32>;\nuniform shadowLightIndex: f32;\nuniform shadowDarkness: f32;\n/,
				""
			)
			.replace(/\bdeferredCascadeSample\b/g, `deferredCascadeSample${index}`)
			.replace(/\bdeferredShadow\b/g, `deferredShadow${index}`)
			.replace(/\bshadow([A-Z][A-Za-z0-9_]*)\b/g, (_match, name: string) => `shadow${name}${index}`)
			.replace(/\b(shadow[A-Z][A-Za-z0-9_]*?)Sampler(\d+)\b/g, (match, prefix: string, sourceIndex: string) =>
				prefix.endsWith("Sampler") ? `${prefix}${sourceIndex}Sampler` : match
			);
		return `uniform shadowLightIndex${index}: f32;\nuniform shadowDarkness${index}: f32;\n${source}`;
	});
	return `${common}${declarations.join("\n")}`;
}

function deferredShadowApplicationWGSL(sources: IDeferredShadowSource[]): string {
	if (!sources.length) {
		return "";
	}
	const samples = sources
		.map((_source, index) => `if (abs(f32(i) - uniforms.shadowLightIndex${index}) < 0.25) { shadow = deferredShadow${index}(positionSample.xyz, positionV); }`)
		.join(" else ");
	return `if (textureSampleLevel(shadowReceiverSampler, shadowReceiverSamplerSampler, deferredUV, 0.0).r > 0.5) { ${samples} }`;
}

function deferredCookieDeclarationWGSL(sources: IDeferredCookieSource[]): string {
	if (!sources.length) {
		return "fn deferredLightCookie(lightIndex: i32, worldPosition: vec3f) -> vec3f { return vec3f(1.0); }";
	}
	const declarations = sources
		.map((source, index) => {
			const common = `uniform lightCookieIntensity${index}: f32;`;
			if (source.evidence.kind === "point-cube") {
				return `${common}\nvar lightCookieCube${index}Sampler: sampler;\nvar lightCookieCube${index}: texture_cube<f32>;\nuniform lightCookiePosition${index}: vec3f;`;
			}
			if (source.evidence.kind === "directional-2d") {
				return `${common}\nvar lightCookie2D${index}Sampler: sampler;\nvar lightCookie2D${index}: texture_2d<f32>;\nuniform lightCookieRight${index}: vec3f;\nuniform lightCookieUp${index}: vec3f;\nuniform lightCookieScaleOffset${index}: vec4f;`;
			}
			return `${common}\nvar lightCookie2D${index}Sampler: sampler;\nvar lightCookie2D${index}: texture_2d<f32>;\nuniform lightCookieMatrix${index}: mat4x4f;`;
		})
		.join("\n");
	const branches = sources
		.map((source, index) => {
			const blend = `return mix(vec3f(1.0), cookieColor, uniforms.lightCookieIntensity${index});`;
			if (source.evidence.kind === "point-cube") {
				return `if (lightIndex == ${source.lightIndex}) { let cookieColor = textureSampleLevel(lightCookieCube${index}, lightCookieCube${index}Sampler, normalize(worldPosition - uniforms.lightCookiePosition${index}), 0.0).rgb; ${blend} }`;
			}
			if (source.evidence.kind === "directional-2d") {
				return `if (lightIndex == ${source.lightIndex}) { let cookieUV = vec2f(dot(worldPosition, uniforms.lightCookieRight${index}) * uniforms.lightCookieScaleOffset${index}.x, dot(worldPosition, uniforms.lightCookieUp${index}) * uniforms.lightCookieScaleOffset${index}.y) + uniforms.lightCookieScaleOffset${index}.zw; let cookieColor = textureSampleLevel(lightCookie2D${index}, lightCookie2D${index}Sampler, cookieUV, 0.0).rgb; ${blend} }`;
			}
			return `if (lightIndex == ${source.lightIndex}) { let cookieProjection = uniforms.lightCookieMatrix${index} * vec4f(worldPosition, 1.0); if (cookieProjection.w <= 0.0) { return vec3f(1.0 - uniforms.lightCookieIntensity${index}); } let cookieUV = cookieProjection.xy / cookieProjection.w; if (any(cookieUV < vec2f(0.0)) || any(cookieUV > vec2f(1.0))) { return vec3f(1.0 - uniforms.lightCookieIntensity${index}); } let cookieColor = textureSampleLevel(lightCookie2D${index}, lightCookie2D${index}Sampler, cookieUV, 0.0).rgb; ${blend} }`;
		})
		.join("\n");
	return `${declarations}\nfn deferredLightCookie(lightIndex: i32, worldPosition: vec3f) -> vec3f {\n${branches}\nreturn vec3f(1.0);\n}`;
}

function deferredAreaDeclarationWGSL(active: boolean, helperFunctionsAlreadyIncluded: boolean): string {
	if (!active) {
		return "";
	}
	return `${helperFunctionsAlreadyIncluded ? "" : "#include<helperFunctions>\n"}#define SPECULARTERM
#include<ltcHelperFunctions>
var areaLightsLTC1SamplerSampler: sampler;
var areaLightsLTC1Sampler: texture_2d<f32>;
var areaLightsLTC2SamplerSampler: sampler;
var areaLightsLTC2Sampler: texture_2d<f32>;

fn deferredLTCEvaluateDisc(N: vec3f, V: vec3f, P: vec3f, mInv: mat3x3f, lightPosition: vec3f, halfWidth: vec3f, halfHeight: vec3f) -> vec3f {
	let lightNormal = -cross(halfWidth, halfHeight);
	if (dot(lightNormal, P - lightPosition) < 0.0) { return vec3f(0.0); }
	let T1 = normalize(V - N * dot(V, N));
	let T2 = -cross(N, T1);
	let basis = mInv * transposeMat3(mat3x3f(T1, T2, N));
	let first = normalize(basis * (lightPosition + halfWidth - P));
	var previous = first;
	var vectorFormFactor = vec3f(0.0);
	for (var edge = 1; edge <= 16; edge += 1) {
		let angle = -6.28318530718 * f32(edge) / 16.0;
		let current = normalize(basis * (lightPosition + cos(angle) * halfWidth + sin(angle) * halfHeight - P));
		vectorFormFactor += LTCEdgeVectorFormFactor(previous, current);
		previous = current;
	}
	return vec3f(LTCClippedSphereFormFactor(vectorFormFactor));
}

fn deferredDiscAreaLight(V: vec3f, N: vec3f, P: vec3f, lightPosition: vec3f, halfWidth: vec3f, halfHeight: vec3f, roughness: f32) -> areaLightData {
	var result = areaLightData(vec3f(0.0), vec3f(0.0), vec4f(0.0));
	let uv = LTCUv(N, V, roughness);
	let t1 = textureSampleLevel(areaLightsLTC1Sampler, areaLightsLTC1SamplerSampler, uv, 0.0);
	let t2 = textureSampleLevel(areaLightsLTC2Sampler, areaLightsLTC2SamplerSampler, uv, 0.0);
	let mInv = mat3x3f(vec3f(t1.x, 0.0, t1.y), vec3f(0.0, 1.0, 0.0), vec3f(t1.z, 0.0, t1.w));
	result.Specular = deferredLTCEvaluateDisc(N, V, P, mInv, lightPosition, halfWidth, halfHeight);
	result.Fresnel = t2;
	result.Diffuse = deferredLTCEvaluateDisc(N, V, P, mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0)), lightPosition, halfWidth, halfHeight);
	return result;
}

fn deferredRectangleAreaLight(V: vec3f, N: vec3f, P: vec3f, lightPosition: vec3f, halfWidth: vec3f, halfHeight: vec3f, roughness: f32) -> areaLightData {
	var result = areaLightData(vec3f(0.0), vec3f(0.0), vec4f(0.0));
	let uv = LTCUv(N, V, roughness);
	let t1 = textureSampleLevel(areaLightsLTC1Sampler, areaLightsLTC1SamplerSampler, uv, 0.0);
	let t2 = textureSampleLevel(areaLightsLTC2Sampler, areaLightsLTC2SamplerSampler, uv, 0.0);
	let mInv = mat3x3f(vec3f(t1.x, 0.0, t1.y), vec3f(0.0, 1.0, 0.0), vec3f(t1.z, 0.0, t1.w));
	let rectCoords0 = lightPosition + halfWidth - halfHeight;
	let rectCoords1 = lightPosition - halfWidth - halfHeight;
	let rectCoords2 = lightPosition - halfWidth + halfHeight;
	let rectCoords3 = lightPosition + halfWidth + halfHeight;
	result.Specular = LTCEvaluate(N, V, P, mInv, rectCoords0, rectCoords1, rectCoords2, rectCoords3);
	result.Fresnel = t2;
	result.Diffuse = LTCEvaluate(N, V, P, mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0)), rectCoords0, rectCoords1, rectCoords2, rectCoords3);
	return result;
}`;
}

function decalProjectorDeclarationsWGSL(sources: IDeferredDecalSource[]): string {
	const filtered = sources.some((source) => source.decalLayerMask !== 0xffffffff);
	return (
		sources
			.map(
				(source, index) => `uniform decalProjectorWorldToLocal${index}: mat4x4f;
uniform decalProjectorNormalToWorld${index}: mat4x4f;
uniform decalProjectorColor${index}: vec4f;
uniform decalProjectorUv${index}: vec4f;
uniform decalProjectorMaterial${index}: vec4f;
uniform decalProjectorEmissive${index}: vec4f;
uniform decalProjectorLayerMask${index}: vec4f;
uniform decalProjectorEdgeFade${index}: f32;
${source.albedoTexture ? `var decalProjectorAlbedoSampler${index}Sampler: sampler;\nvar decalProjectorAlbedoSampler${index}: texture_2d<f32>;` : ""}
${source.channels.normal && source.normalTexture ? `var decalProjectorNormalSampler${index}Sampler: sampler;\nvar decalProjectorNormalSampler${index}: texture_2d<f32>;` : ""}
${source.channels.metallic && source.reflectivityTexture ? `var decalProjectorReflectivitySampler${index}Sampler: sampler;\nvar decalProjectorReflectivitySampler${index}: texture_2d<f32>;` : ""}
${source.channels.ambientOcclusion && source.ambientOcclusionTexture ? `var decalProjectorAmbientOcclusionSampler${index}Sampler: sampler;\nvar decalProjectorAmbientOcclusionSampler${index}: texture_2d<f32>;` : ""}
${source.channels.emissive && source.emissiveTexture ? `var decalProjectorEmissiveSampler${index}Sampler: sampler;\nvar decalProjectorEmissiveSampler${index}: texture_2d<f32>;` : ""}`
			)
			.join("\n") +
		(filtered
			? `
var decalLayerMaskSamplerSampler: sampler;
var decalLayerMaskSampler: texture_2d<f32>;

fn decalLayerByteOverlap(encodedByte: f32, maskByte: f32) -> f32 {
	var overlap = 0.0;
	overlap += floor(encodedByte / 1.0) % 2.0 * (floor(maskByte / 1.0) % 2.0);
	overlap += floor(encodedByte / 2.0) % 2.0 * (floor(maskByte / 2.0) % 2.0);
	overlap += floor(encodedByte / 4.0) % 2.0 * (floor(maskByte / 4.0) % 2.0);
	overlap += floor(encodedByte / 8.0) % 2.0 * (floor(maskByte / 8.0) % 2.0);
	overlap += floor(encodedByte / 16.0) % 2.0 * (floor(maskByte / 16.0) % 2.0);
	overlap += floor(encodedByte / 32.0) % 2.0 * (floor(maskByte / 32.0) % 2.0);
	overlap += floor(encodedByte / 64.0) % 2.0 * (floor(maskByte / 64.0) % 2.0);
	overlap += floor(encodedByte / 128.0) % 2.0 * (floor(maskByte / 128.0) % 2.0);
	return overlap;
}

fn decalLayerMatches(encodedMask: vec4f, projectorMask: vec4f) -> bool {
	let encodedBytes = floor(encodedMask * 255.0 + vec4f(0.5));
	return decalLayerByteOverlap(encodedBytes.r, projectorMask.r) + decalLayerByteOverlap(encodedBytes.g, projectorMask.g) + decalLayerByteOverlap(encodedBytes.b, projectorMask.b) + decalLayerByteOverlap(encodedBytes.a, projectorMask.a) > 0.5;
}`
			: "")
	);
}

function decalProjectorApplicationWGSL(sources: IDeferredDecalSource[], normalSpace: "view" | "world", includeEmissive: boolean): string {
	return sources
		.map(
			(source, index) => `{
	let projectorLocal = (uniforms.decalProjectorWorldToLocal${index} * vec4f(positionSample.xyz, 1.0)).xyz;
	let projectorBoundary = vec3f(0.5) - abs(projectorLocal);
	let projectorLayerAllowed = ${source.decalLayerMask === 0xffffffff ? "true" : `decalLayerMatches(textureSampleLevel(decalLayerMaskSampler, decalLayerMaskSamplerSampler, deferredUV, 0.0), uniforms.decalProjectorLayerMask${index})`};
	if (projectorLayerAllowed && min(min(projectorBoundary.x, projectorBoundary.y), projectorBoundary.z) >= 0.0) {
		let projectorUV = (projectorLocal.xy + vec2f(0.5)) * uniforms.decalProjectorUv${index}.xy + uniforms.decalProjectorUv${index}.zw;
		var projectorSample = uniforms.decalProjectorColor${index};
		${source.albedoTexture ? `projectorSample *= textureSampleLevel(decalProjectorAlbedoSampler${index}, decalProjectorAlbedoSampler${index}Sampler, projectorUV, 0.0);` : ""}
		let projectorFadeWidth = max(uniforms.decalProjectorEdgeFade${index} * 0.5, 0.00001);
		let projectorFade = select(smoothstep(0.0, projectorFadeWidth, min(min(projectorBoundary.x, projectorBoundary.y), projectorBoundary.z)), 1.0, uniforms.decalProjectorEdgeFade${index} <= 0.0);
		let projectorWeight = clamp(projectorSample.a * projectorFade, 0.0, 1.0);
		${source.channels.albedo ? "albedo = mix(albedo, projectorSample.rgb, projectorWeight);" : ""}
		${
			source.channels.normal
				? `var projectorNormalSample = ${source.normalTexture ? `textureSampleLevel(decalProjectorNormalSampler${index}, decalProjectorNormalSampler${index}Sampler, projectorUV, 0.0).xyz` : "vec3f(0.5, 0.5, 1.0)"} * 2.0 - vec3f(1.0);
		projectorNormalSample = vec3f(projectorNormalSample.xy * vec2f(abs(uniforms.decalProjectorMaterial${index}.x), sign(uniforms.decalProjectorMaterial${index}.x) * abs(uniforms.decalProjectorMaterial${index}.x)), projectorNormalSample.z);
		let projectorNormalW = normalize((uniforms.decalProjectorNormalToWorld${index} * vec4f(normalize(projectorNormalSample), 0.0)).xyz);
		${normalSpace === "view" ? "let projectorNormal = normalize((uniforms.view * vec4f(projectorNormalW, 0.0)).xyz);" : "let projectorNormal = projectorNormalW;"}
		${normalSpace === "view" ? "normalV" : "normalW"} = normalize(mix(${normalSpace === "view" ? "normalV" : "normalW"}, projectorNormal, projectorWeight));`
				: ""
		}
		${
			source.channels.metallic
				? `var projectorReflectivity = uniforms.decalProjectorMaterial${index}.yz;
		${source.reflectivityTexture ? `let projectorReflectivitySample = textureSampleLevel(decalProjectorReflectivitySampler${index}, decalProjectorReflectivitySampler${index}Sampler, projectorUV, 0.0); projectorReflectivity *= vec2f(projectorReflectivitySample.r, projectorReflectivitySample.a);` : ""}
		let projectorF0 = mix(vec3f(0.04), projectorSample.rgb, clamp(projectorReflectivity.x, 0.0, 1.0));
		reflectivity = mix(reflectivity, vec4f(projectorF0, clamp(projectorReflectivity.y, 0.0, 1.0)), projectorWeight);`
				: ""
		}
		${
			source.channels.ambientOcclusion
				? `var projectorAo = uniforms.decalProjectorMaterial${index}.w;
		${source.ambientOcclusionTexture ? `projectorAo *= textureSampleLevel(decalProjectorAmbientOcclusionSampler${index}, decalProjectorAmbientOcclusionSampler${index}Sampler, projectorUV, 0.0).r;` : ""}
		ambientOcclusion *= mix(1.0, clamp(projectorAo, 0.0, 1.0), projectorWeight);`
				: ""
		}
		${
			includeEmissive && source.channels.emissive
				? `var projectorEmission = uniforms.decalProjectorEmissive${index}.rgb * uniforms.decalProjectorEmissive${index}.a;
		${source.emissiveTexture ? `projectorEmission *= textureSampleLevel(decalProjectorEmissiveSampler${index}, decalProjectorEmissiveSampler${index}Sampler, projectorUV, 0.0).rgb;` : ""}
		emissive += max(projectorEmission, vec3f(0.0)) * projectorWeight;`
				: ""
		}
	}
}`
		)
		.join("\n");
}

function deferredFragmentShaderWGSL(
	shadowSources: IDeferredShadowSource[],
	emissiveActive: boolean,
	cookieSources: IDeferredCookieSource[],
	areaLightActive: boolean,
	projectorSources: IDeferredDecalSource[]
): string {
	return `
varying vUV: vec2f;
var positionSamplerSampler: sampler;
var positionSampler: texture_2d<f32>;
var normalSamplerSampler: sampler;
var normalSampler: texture_2d<f32>;
var reflectivitySamplerSampler: sampler;
var reflectivitySampler: texture_2d<f32>;
var albedoSamplerSampler: sampler;
var albedoSampler: texture_2d<f32>;
${emissiveActive ? "var emissiveSamplerSampler: sampler;\nvar emissiveSampler: texture_2d<f32>;" : ""}
uniform view: mat4x4f;
uniform cameraViewport: vec4f;
uniform ambientColor: vec3f;
uniform normalUnsigned: f32;
uniform lightCount: f32;
uniform lightData0: array<vec4f, ${deferredLightingMaximumLights}>;
uniform lightData1: array<vec4f, ${deferredLightingMaximumLights}>;
uniform lightData2: array<vec4f, ${deferredLightingMaximumLights}>;
uniform lightData3: array<vec4f, ${deferredLightingMaximumLights}>;
uniform lightData4: array<vec4f, ${deferredLightingMaximumLights}>;
${deferredShadowDeclarationsWGSL(shadowSources)}
${deferredCookieDeclarationWGSL(cookieSources)}
${deferredAreaDeclarationWGSL(areaLightActive, shadowSources.length > 0)}
${decalProjectorDeclarationsWGSL(projectorSources)}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
	let deferredUV = uniforms.cameraViewport.xy + input.vUV * uniforms.cameraViewport.zw;
	let positionSample = textureSample(positionSampler, positionSamplerSampler, deferredUV);
	let normalSample = textureSample(normalSampler, normalSamplerSampler, deferredUV);
	let albedoSample = textureSample(albedoSampler, albedoSamplerSampler, deferredUV);
	var reflectivity = textureSample(reflectivitySampler, reflectivitySamplerSampler, deferredUV);
	if (albedoSample.a < 0.0001) {
		fragmentOutputs.color = vec4f(0.0);
		return fragmentOutputs;
	}
	var normalV = normalize(normalSample.xyz);
	if (uniforms.normalUnsigned > 0.5) {
		normalV = normalize(normalV * 2.0 - vec3f(1.0));
	}
	let positionV = (uniforms.view * vec4f(positionSample.xyz, 1.0)).xyz;
	let viewDirection = normalize(-positionV);
	var albedo = max(albedoSample.rgb, vec3f(0.0));
	var ambientOcclusion = 1.0;
	var emissive = ${emissiveActive ? "max(textureSampleLevel(emissiveSampler, emissiveSamplerSampler, deferredUV, 0.0).rgb, vec3f(0.0))" : "vec3f(0.0)"};
	${decalProjectorApplicationWGSL(projectorSources, "view", true)}
	let smoothness = clamp(reflectivity.a, 0.0, 1.0);
	var result = albedo * uniforms.ambientColor * ambientOcclusion;
	for (var i = 0; i < ${deferredLightingMaximumLights}; i += 1) {
		if (f32(i) >= uniforms.lightCount) {
			break;
		}
		let data0 = uniforms.lightData0[i];
		let lightColor = uniforms.lightData3[i].rgb * data0.y;
		${
			areaLightActive
				? `if (data0.x > 3.5) {
			let lightPositionV = (uniforms.view * vec4f(uniforms.lightData1[i].xyz, 1.0)).xyz;
			let halfWidthV = (uniforms.view * vec4f(uniforms.lightData2[i].xyz, 0.0)).xyz;
			let halfHeightV = (uniforms.view * vec4f(uniforms.lightData4[i].xyz, 0.0)).xyz;
			var areaData = areaLightData(vec3f(0.0), vec3f(0.0), vec4f(0.0));
			if (data0.w > 0.5) {
				areaData = deferredDiscAreaLight(viewDirection, normalV, positionV, lightPositionV, halfWidthV, halfHeightV, 1.0 - smoothness);
			} else {
				areaData = deferredRectangleAreaLight(viewDirection, normalV, positionV, lightPositionV, halfWidthV, halfHeightV, 1.0 - smoothness);
			}
			let fresnel = reflectivity.rgb * areaData.Fresnel.x + (vec3f(1.0) - reflectivity.rgb) * areaData.Fresnel.y;
			let distanceToLight = length(lightPositionV - positionV);
			let rangeFactor = clamp(1.0 - distanceToLight / max(data0.z, 0.00001), 0.0, 1.0);
			let areaAttenuation = rangeFactor * rangeFactor;
			result += (albedo * areaData.Diffuse + reflectivity.rgb * fresnel * areaData.Specular) * lightColor * areaAttenuation;
			continue;
		}`
				: ""
		}
		if (data0.x > 2.5) {
			let upV = normalize((uniforms.view * vec4f(uniforms.lightData2[i].xyz, 0.0)).xyz);
			let sky = dot(normalV, upV) * 0.5 + 0.5;
			result += albedo * mix(uniforms.lightData4[i].rgb, lightColor, sky);
			continue;
		}
		var lightDirectionV: vec3f;
		var attenuation = 1.0;
		if (data0.x > 0.5 && data0.x < 1.5) {
			lightDirectionV = normalize(-(uniforms.view * vec4f(uniforms.lightData2[i].xyz, 0.0)).xyz);
		} else {
			let lightPositionV = (uniforms.view * vec4f(uniforms.lightData1[i].xyz, 1.0)).xyz;
			let toLight = lightPositionV - positionV;
			let distanceToLight = length(toLight);
			lightDirectionV = toLight / max(distanceToLight, 0.00001);
			let rangeFactor = clamp(1.0 - distanceToLight / max(data0.z, 0.00001), 0.0, 1.0);
			attenuation = rangeFactor * rangeFactor;
			if (data0.x > 1.5) {
				let spotDirectionV = normalize((uniforms.view * vec4f(uniforms.lightData2[i].xyz, 0.0)).xyz);
				let cone = dot(-lightDirectionV, spotDirectionV);
				attenuation *= pow(smoothstep(data0.w, 1.0, cone), max(uniforms.lightData1[i].w, 1.0));
			}
		}
		let diffuse = max(dot(normalV, lightDirectionV), 0.0);
		let halfDirection = normalize(lightDirectionV + viewDirection);
		let specular = pow(max(dot(normalV, halfDirection), 0.0), mix(8.0, 256.0, smoothness)) * select(0.0, 1.0, diffuse >= 0.0001);
		var shadow = 1.0;
		${deferredShadowApplicationWGSL(shadowSources)}
		let cookie = deferredLightCookie(i, positionSample.xyz);
		result += (albedo * diffuse + reflectivity.rgb * specular) * lightColor * cookie * attenuation * shadow;
	}
	result += emissive;
	fragmentOutputs.color = vec4f(max(result, vec3f(0.0)), 1.0);
	return fragmentOutputs;
}`;
}

function deferredIblFragmentShaderGLSL(projectorSources: IDeferredDecalSource[]): string {
	return `
precision highp float;
#include<helperFunctions>
varying vec2 vUV;
uniform sampler2D positionSampler;
uniform sampler2D normalSampler;
uniform sampler2D reflectivitySampler;
uniform sampler2D albedoSampler;
uniform sampler2D iblSelectorSampler;
uniform samplerCube iblSampler;
uniform vec4 cameraViewport;
uniform mat4 inverseView;
uniform mat4 iblReflectionMatrix;
uniform vec3 cameraPosition;
uniform vec3 iblBoxPosition;
uniform vec3 iblBoxSize;
uniform float normalUnsigned;
uniform float iblSourceCode;
uniform float iblSourceKind;
uniform float iblProbeSlot;
uniform float iblProbeCount;
uniform vec4 iblProbeData0[${deferredLightingMaximumIblSources}];
uniform vec4 iblProbeData1[${deferredLightingMaximumIblSources}];
uniform float iblSourceIntensity;
uniform float iblMaximumLod;
uniform float iblLodScale;
uniform float iblLodOffset;
uniform float iblGammaSpace;
uniform float iblRgbd;
uniform float iblOppositeZ;
uniform float iblInvertY;
uniform float iblBoxProjection;
uniform float iblHasSphericalPolynomial;
uniform vec3 iblSphericalX;
uniform vec3 iblSphericalY;
uniform vec3 iblSphericalZ;
uniform vec3 iblSphericalXX_ZZ;
uniform vec3 iblSphericalYY_ZZ;
uniform vec3 iblSphericalZZ;
uniform vec3 iblSphericalXY;
uniform vec3 iblSphericalYZ;
uniform vec3 iblSphericalZX;
${decalProjectorDeclarationsGLSL(projectorSources)}

vec3 decodeIbl(vec4 sampleValue) {
	if (iblRgbd > 0.5) { return fromRGBD(sampleValue); }
	return iblGammaSpace > 0.5 ? toLinearSpace(sampleValue.rgb) : sampleValue.rgb;
}

vec3 environmentIrradiance(vec3 normalW) {
	if (iblHasSphericalPolynomial < 0.5) {
		return decodeIbl(textureCubeLodEXT(iblSampler, normalW, iblMaximumLod));
	}
	float Nx = normalW.x; float Ny = normalW.y; float Nz = normalW.z;
	vec3 a = (iblSphericalYY_ZZ * Ny + iblSphericalY + iblSphericalYZ * Nz) * Ny;
	vec3 b = ((iblSphericalXX_ZZ * Nx + iblSphericalX + iblSphericalXY * Ny + iblSphericalZX * Nz) * Nx);
	return max(iblSphericalZZ + iblSphericalZ * Nz + a + b, vec3(0.0));
}

vec3 boxProject(vec3 worldPosition, vec3 direction) {
	vec3 halfSize = max(iblBoxSize * 0.5, vec3(0.0001));
	vec3 minimum = iblBoxPosition - halfSize;
	vec3 maximum = iblBoxPosition + halfSize;
	vec3 safeDirection = vec3(abs(direction.x) < 0.00001 ? 0.00001 : direction.x, abs(direction.y) < 0.00001 ? 0.00001 : direction.y, abs(direction.z) < 0.00001 ? 0.00001 : direction.z);
	vec3 positive = (maximum - worldPosition) / safeDirection;
	vec3 negative = (minimum - worldPosition) / safeDirection;
	vec3 distanceToPlane = vec3(direction.x > 0.0 ? positive.x : negative.x, direction.y > 0.0 ? positive.y : negative.y, direction.z > 0.0 ? positive.z : negative.z);
	float distanceToIntersection = min(distanceToPlane.x, min(distanceToPlane.y, distanceToPlane.z));
	return worldPosition + direction * max(distanceToIntersection, 0.0) - iblBoxPosition;
}

float probeMaskContains(float encodedMask, float slot) {
	float mask = floor(encodedMask * 255.0 + 0.5);
	return mod(floor(mask / exp2(slot)), 2.0);
}

float probeRawWeight(int slot, vec3 worldPosition) {
	vec4 data0 = iblProbeData0[slot];
	vec4 data1 = iblProbeData1[slot];
	vec3 edge = data1.xyz * 0.5 - abs(worldPosition - data0.xyz);
	float edgeDistance = min(edge.x, min(edge.y, edge.z));
	if (edgeDistance < 0.0) { return 0.0; }
	return data0.w <= 0.0 ? 1.0 : clamp(edgeDistance / data0.w, 0.0, 1.0);
}

vec2 probeWeightSummary(vec3 worldPosition, float encodedMask) {
	float maximumImportance = -1.0;
	for (int index = 0; index < ${deferredLightingMaximumIblSources}; index++) {
		if (float(index) >= iblProbeCount || probeMaskContains(encodedMask, float(index)) < 0.5) { continue; }
		float rawWeight = probeRawWeight(index, worldPosition);
		if (rawWeight > 0.0) { maximumImportance = max(maximumImportance, iblProbeData1[index].w); }
	}
	float totalWeight = 0.0;
	for (int index = 0; index < ${deferredLightingMaximumIblSources}; index++) {
		if (float(index) >= iblProbeCount || probeMaskContains(encodedMask, float(index)) < 0.5) { continue; }
		float rawWeight = probeRawWeight(index, worldPosition);
		if (rawWeight > 0.0 && abs(iblProbeData1[index].w - maximumImportance) < 0.5) { totalWeight += rawWeight; }
	}
	return vec2(maximumImportance, totalWeight);
}

float sourceBlendWeight(vec3 worldPosition, vec3 selectorData) {
	vec2 summary = probeWeightSummary(worldPosition, selectorData.b);
	if (iblSourceKind < 0.5) { return max(0.0, 1.0 - min(summary.y, 1.0)); }
	int slot = int(iblProbeSlot + 0.5);
	if (slot < 0 || slot >= ${deferredLightingMaximumIblSources} || probeMaskContains(selectorData.b, iblProbeSlot) < 0.5) { return 0.0; }
	float rawWeight = probeRawWeight(slot, worldPosition);
	if (rawWeight <= 0.0 || abs(iblProbeData1[slot].w - summary.x) >= 0.5) { return 0.0; }
	float hasBase = selectorData.r > 0.5 / 255.0 ? 1.0 : 0.0;
	return rawWeight / max(hasBase > 0.5 ? max(1.0, summary.y) : summary.y, 0.00001);
}

void main(void) {
	vec2 deferredUV = cameraViewport.xy + vUV * cameraViewport.zw;
	vec4 selector = texture2D(iblSelectorSampler, deferredUV);
	vec3 selectorData = toLinearSpace(selector.rgb);
	if (iblSourceKind < 0.5 && abs(selectorData.r - iblSourceCode) > 0.5 / 255.0) { discard; }
	if (iblSourceKind > 0.5 && probeMaskContains(selectorData.b, iblProbeSlot) < 0.5) { discard; }
	vec4 albedoSample = texture2D(albedoSampler, deferredUV);
	if (albedoSample.a < 0.0001) { discard; }
	vec3 normalV = normalize(texture2D(normalSampler, deferredUV).xyz);
	if (normalUnsigned > 0.5) { normalV = normalize(normalV * 2.0 - 1.0); }
	vec3 normalW = normalize((inverseView * vec4(normalV, 0.0)).xyz);
	vec4 positionSample = texture2D(positionSampler, deferredUV);
	vec3 worldPosition = positionSample.xyz;
	float blendWeight = sourceBlendWeight(worldPosition, selectorData);
	if (blendWeight <= 0.00001) { discard; }
	vec3 viewDirectionW = normalize(cameraPosition - worldPosition);
	vec4 reflectivity = texture2D(reflectivitySampler, deferredUV);
	vec3 albedo = max(albedoSample.rgb, vec3(0.0));
	float ambientOcclusion = 1.0;
	${decalProjectorApplicationGLSL(projectorSources, "world", false)}
	vec3 reflectionDirection = reflect(-viewDirectionW, normalW);
	if (iblBoxProjection > 0.5) { reflectionDirection = boxProject(worldPosition, reflectionDirection); }
	reflectionDirection = normalize((iblReflectionMatrix * vec4(reflectionDirection, 0.0)).xyz);
	if (iblOppositeZ > 0.5) { reflectionDirection.z *= -1.0; }
	if (iblInvertY > 0.5) { reflectionDirection.y *= -1.0; }
	float smoothness = clamp(reflectivity.a, 0.0, 1.0);
	float roughness = 1.0 - smoothness;
	float lod = clamp(roughness * roughness * iblMaximumLod * iblLodScale + iblLodOffset, 0.0, iblMaximumLod);
	vec3 radiance = decodeIbl(textureCubeLodEXT(iblSampler, reflectionDirection, lod));
	vec3 irradiance = environmentIrradiance(normalW);
	vec3 f0 = clamp(reflectivity.rgb, vec3(0.0), vec3(1.0));
	float albedoMaximum = max(albedo.r, max(albedo.g, albedo.b));
	float f0Maximum = max(f0.r, max(f0.g, f0.b));
	float metallic = clamp((f0Maximum - 0.04) / max(albedoMaximum - 0.04, 0.0001), 0.0, 1.0);
	float NdotV = max(dot(normalW, viewDirectionW), 0.0001);
	vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
	vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
	vec4 r = roughness * c0 + c1;
	float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
	vec2 brdf = vec2(-1.04, 1.04) * a004 + r.zw;
	vec3 diffuse = irradiance * albedo * (1.0 - metallic);
	vec3 specular = radiance * max(f0 * brdf.x + vec3(brdf.y), vec3(0.0));
	float intensity = iblSourceIntensity * selectorData.g * 16.0 * blendWeight;
	gl_FragColor = vec4(max((diffuse + specular) * intensity * ambientOcclusion, vec3(0.0)), 1.0);
}`;
}

function deferredIblFragmentShaderWGSL(projectorSources: IDeferredDecalSource[]): string {
	return `
#include<helperFunctions>
varying vUV: vec2f;
var positionSamplerSampler: sampler;
var positionSampler: texture_2d<f32>;
var normalSamplerSampler: sampler;
var normalSampler: texture_2d<f32>;
var reflectivitySamplerSampler: sampler;
var reflectivitySampler: texture_2d<f32>;
var albedoSamplerSampler: sampler;
var albedoSampler: texture_2d<f32>;
var iblSelectorSamplerSampler: sampler;
var iblSelectorSampler: texture_2d<f32>;
var iblSamplerSampler: sampler;
var iblSampler: texture_cube<f32>;
uniform cameraViewport: vec4f;
uniform inverseView: mat4x4f;
uniform iblReflectionMatrix: mat4x4f;
uniform cameraPosition: vec3f;
uniform iblBoxPosition: vec3f;
uniform iblBoxSize: vec3f;
uniform normalUnsigned: f32;
uniform iblSourceCode: f32;
uniform iblSourceKind: f32;
uniform iblProbeSlot: f32;
uniform iblProbeCount: f32;
uniform iblProbeData0: array<vec4f, ${deferredLightingMaximumIblSources}>;
uniform iblProbeData1: array<vec4f, ${deferredLightingMaximumIblSources}>;
uniform iblSourceIntensity: f32;
uniform iblMaximumLod: f32;
uniform iblLodScale: f32;
uniform iblLodOffset: f32;
uniform iblGammaSpace: f32;
uniform iblRgbd: f32;
uniform iblOppositeZ: f32;
uniform iblInvertY: f32;
uniform iblBoxProjection: f32;
uniform iblHasSphericalPolynomial: f32;
uniform iblSphericalX: vec3f;
uniform iblSphericalY: vec3f;
uniform iblSphericalZ: vec3f;
uniform iblSphericalXX_ZZ: vec3f;
uniform iblSphericalYY_ZZ: vec3f;
uniform iblSphericalZZ: vec3f;
uniform iblSphericalXY: vec3f;
uniform iblSphericalYZ: vec3f;
uniform iblSphericalZX: vec3f;
${decalProjectorDeclarationsWGSL(projectorSources)}

fn decodeIbl(sampleValue: vec4f) -> vec3f {
	if (uniforms.iblRgbd > 0.5) { return fromRGBD(sampleValue); }
	return select(sampleValue.rgb, toLinearSpaceVec3(sampleValue.rgb), uniforms.iblGammaSpace > 0.5);
}

fn environmentIrradiance(normalW: vec3f) -> vec3f {
	if (uniforms.iblHasSphericalPolynomial < 0.5) {
		return decodeIbl(textureSampleLevel(iblSampler, iblSamplerSampler, normalW, uniforms.iblMaximumLod));
	}
	let Nx = normalW.x; let Ny = normalW.y; let Nz = normalW.z;
	let a = (uniforms.iblSphericalYY_ZZ * Ny + uniforms.iblSphericalY + uniforms.iblSphericalYZ * Nz) * Ny;
	let b = (uniforms.iblSphericalXX_ZZ * Nx + uniforms.iblSphericalX + uniforms.iblSphericalXY * Ny + uniforms.iblSphericalZX * Nz) * Nx;
	return max(uniforms.iblSphericalZZ + uniforms.iblSphericalZ * Nz + a + b, vec3f(0.0));
}

fn boxProject(worldPosition: vec3f, direction: vec3f) -> vec3f {
	let halfSize = max(uniforms.iblBoxSize * 0.5, vec3f(0.0001));
	let minimum = uniforms.iblBoxPosition - halfSize;
	let maximum = uniforms.iblBoxPosition + halfSize;
	var safeDirection = direction;
	if (abs(safeDirection.x) < 0.00001) { safeDirection.x = 0.00001; }
	if (abs(safeDirection.y) < 0.00001) { safeDirection.y = 0.00001; }
	if (abs(safeDirection.z) < 0.00001) { safeDirection.z = 0.00001; }
	let positive = (maximum - worldPosition) / safeDirection;
	let negative = (minimum - worldPosition) / safeDirection;
	let distanceToPlane = vec3f(select(negative.x, positive.x, direction.x > 0.0), select(negative.y, positive.y, direction.y > 0.0), select(negative.z, positive.z, direction.z > 0.0));
	let distanceToIntersection = min(distanceToPlane.x, min(distanceToPlane.y, distanceToPlane.z));
	return worldPosition + direction * max(distanceToIntersection, 0.0) - uniforms.iblBoxPosition;
}

fn probeMaskContains(encodedMask: f32, slot: f32) -> f32 {
	let mask = floor(encodedMask * 255.0 + 0.5);
	let shifted = floor(mask / exp2(slot));
	return shifted - floor(shifted * 0.5) * 2.0;
}

fn probeRawWeight(slot: i32, worldPosition: vec3f) -> f32 {
	let data0 = uniforms.iblProbeData0[u32(slot)];
	let data1 = uniforms.iblProbeData1[u32(slot)];
	let edge = data1.xyz * 0.5 - abs(worldPosition - data0.xyz);
	let edgeDistance = min(edge.x, min(edge.y, edge.z));
	if (edgeDistance < 0.0) { return 0.0; }
	return select(clamp(edgeDistance / data0.w, 0.0, 1.0), 1.0, data0.w <= 0.0);
}

fn probeWeightSummary(worldPosition: vec3f, encodedMask: f32) -> vec2f {
	var maximumImportance = -1.0;
	for (var index: i32 = 0; index < ${deferredLightingMaximumIblSources}; index = index + 1) {
		if (f32(index) >= uniforms.iblProbeCount || probeMaskContains(encodedMask, f32(index)) < 0.5) { continue; }
		let rawWeight = probeRawWeight(index, worldPosition);
		if (rawWeight > 0.0) { maximumImportance = max(maximumImportance, uniforms.iblProbeData1[u32(index)].w); }
	}
	var totalWeight = 0.0;
	for (var index: i32 = 0; index < ${deferredLightingMaximumIblSources}; index = index + 1) {
		if (f32(index) >= uniforms.iblProbeCount || probeMaskContains(encodedMask, f32(index)) < 0.5) { continue; }
		let rawWeight = probeRawWeight(index, worldPosition);
		if (rawWeight > 0.0 && abs(uniforms.iblProbeData1[u32(index)].w - maximumImportance) < 0.5) { totalWeight += rawWeight; }
	}
	return vec2f(maximumImportance, totalWeight);
}

fn sourceBlendWeight(worldPosition: vec3f, selectorData: vec3f) -> f32 {
	let summary = probeWeightSummary(worldPosition, selectorData.b);
	if (uniforms.iblSourceKind < 0.5) { return max(0.0, 1.0 - min(summary.y, 1.0)); }
	let slot = i32(uniforms.iblProbeSlot + 0.5);
	if (slot < 0 || slot >= ${deferredLightingMaximumIblSources} || probeMaskContains(selectorData.b, uniforms.iblProbeSlot) < 0.5) { return 0.0; }
	let rawWeight = probeRawWeight(slot, worldPosition);
	if (rawWeight <= 0.0 || abs(uniforms.iblProbeData1[u32(slot)].w - summary.x) >= 0.5) { return 0.0; }
	var denominator = summary.y;
	if (selectorData.r > 0.5 / 255.0) { denominator = max(1.0, denominator); }
	return rawWeight / max(denominator, 0.00001);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
	let deferredUV = uniforms.cameraViewport.xy + input.vUV * uniforms.cameraViewport.zw;
	let selector = textureSampleLevel(iblSelectorSampler, iblSelectorSamplerSampler, deferredUV, 0.0);
	let selectorData = toLinearSpaceVec3(selector.rgb);
	if (uniforms.iblSourceKind < 0.5 && abs(selectorData.r - uniforms.iblSourceCode) > 0.5 / 255.0) { discard; }
	if (uniforms.iblSourceKind > 0.5 && probeMaskContains(selectorData.b, uniforms.iblProbeSlot) < 0.5) { discard; }
	let albedoSample = textureSample(albedoSampler, albedoSamplerSampler, deferredUV);
	if (albedoSample.a < 0.0001) { discard; }
	var normalV = normalize(textureSample(normalSampler, normalSamplerSampler, deferredUV).xyz);
	if (uniforms.normalUnsigned > 0.5) { normalV = normalize(normalV * 2.0 - vec3f(1.0)); }
	var normalW = normalize((uniforms.inverseView * vec4f(normalV, 0.0)).xyz);
	let positionSample = textureSample(positionSampler, positionSamplerSampler, deferredUV);
	let worldPosition = positionSample.xyz;
	let blendWeight = sourceBlendWeight(worldPosition, selectorData);
	if (blendWeight <= 0.00001) { discard; }
	let viewDirectionW = normalize(uniforms.cameraPosition - worldPosition);
	var reflectivity = textureSample(reflectivitySampler, reflectivitySamplerSampler, deferredUV);
	var albedo = max(albedoSample.rgb, vec3f(0.0));
	var ambientOcclusion = 1.0;
	${decalProjectorApplicationWGSL(projectorSources, "world", false)}
	var reflectionDirection = reflect(-viewDirectionW, normalW);
	if (uniforms.iblBoxProjection > 0.5) { reflectionDirection = boxProject(worldPosition, reflectionDirection); }
	reflectionDirection = normalize((uniforms.iblReflectionMatrix * vec4f(reflectionDirection, 0.0)).xyz);
	if (uniforms.iblOppositeZ > 0.5) { reflectionDirection.z *= -1.0; }
	if (uniforms.iblInvertY > 0.5) { reflectionDirection.y *= -1.0; }
	let smoothness = clamp(reflectivity.a, 0.0, 1.0);
	let roughness = 1.0 - smoothness;
	let lod = clamp(roughness * roughness * uniforms.iblMaximumLod * uniforms.iblLodScale + uniforms.iblLodOffset, 0.0, uniforms.iblMaximumLod);
	let radiance = decodeIbl(textureSampleLevel(iblSampler, iblSamplerSampler, reflectionDirection, lod));
	let irradiance = environmentIrradiance(normalW);
	let f0 = clamp(reflectivity.rgb, vec3f(0.0), vec3f(1.0));
	let albedoMaximum = max(albedo.r, max(albedo.g, albedo.b));
	let f0Maximum = max(f0.r, max(f0.g, f0.b));
	let metallic = clamp((f0Maximum - 0.04) / max(albedoMaximum - 0.04, 0.0001), 0.0, 1.0);
	let NdotV = max(dot(normalW, viewDirectionW), 0.0001);
	let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
	let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
	let r = roughness * c0 + c1;
	let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
	let brdf = vec2f(-1.04, 1.04) * a004 + r.zw;
	let diffuse = irradiance * albedo * (1.0 - metallic);
	let specular = radiance * max(f0 * brdf.x + vec3f(brdf.y), vec3f(0.0));
	let intensity = uniforms.iblSourceIntensity * selectorData.g * 16.0 * blendWeight;
	fragmentOutputs.color = vec4f(max((diffuse + specular) * intensity * ambientOcclusion, vec3f(0.0)), 1.0);
	return fragmentOutputs;
}`;
}

function inactive(error?: string): IDeferredLightingRuntimeEvidence {
	return {
		backend: deferredLightingRuntimeBackend,
		configured: false,
		active: false,
		ready: false,
		cameraId: null,
		cameraName: null,
		configuredCameraCount: 0,
		sharedGeometryBufferHolderCount: 0,
		cameraViewport: [0, 0, 1, 1],
		outputRenderTargetName: null,
		outputRenderTargetWidth: 0,
		outputRenderTargetHeight: 0,
		shaderLanguage: null,
		geometryBufferReady: false,
		geometryBufferWidth: 0,
		geometryBufferHeight: 0,
		geometryBufferTextureCount: 0,
		albedoReady: false,
		albedoWidth: 0,
		albedoHeight: 0,
		emissiveActive: false,
		emissiveReady: false,
		emissiveWidth: 0,
		emissiveHeight: 0,
		emissiveMeshCount: 0,
		emissiveMaterialCount: 0,
		emissiveTextureCount: 0,
		emissiveMaximumSources: deferredLightingMaximumEmissiveSources,
		emissiveEvidenceTruncated: false,
		emissiveFrameCount: 0,
		emissiveSources: [],
		decalActive: false,
		decalReady: false,
		decalCount: 0,
		decalGeometryCount: 0,
		decalProjectorCount: 0,
		decalProjectorMaximumSources: deferredLightingMaximumProjectorDecalSources,
		decalProjectorSamplerCount: 0,
		decalLayerFilteredProjectorCount: 0,
		decalLayerTargetReady: false,
		decalLayerTargetWidth: 0,
		decalLayerTargetHeight: 0,
		decalSourceMeshCount: 0,
		decalMaterialCount: 0,
		decalTextureCount: 0,
		decalMaximumSources: deferredLightingMaximumDecalSources,
		decalEvidenceTruncated: false,
		decalFrameCount: 0,
		decalForwardSubMeshSuppressedCount: 0,
		decalForwardSuppressionFrameCount: 0,
		decalSources: [],
		iblActive: false,
		iblReady: false,
		iblSelectorReady: false,
		iblSelectorWidth: 0,
		iblSelectorHeight: 0,
		iblSourceCount: 0,
		iblMaximumSources: deferredLightingMaximumIblSources,
		iblEnvironmentTextureName: null,
		iblReflectionProbeCount: 0,
		iblReflectionProbeNames: [],
		iblProbeBlendingActive: false,
		iblProbeBlendModel: reflectionProbeBlendModel,
		iblProbeBlendMeshCount: 0,
		iblProbeMaximumBlendSources: deferredLightingMaximumIblSources,
		iblFrameCount: 0,
		iblSources: [],
		meshCount: 0,
		materialCount: 0,
		lightCount: 0,
		maximumLights: deferredLightingMaximumLights,
		cookieActive: false,
		cookieReady: false,
		cookieCount: 0,
		cookieMaximumSources: lightCookieMaximumSources,
		cookieFrameCount: 0,
		cookieSources: [],
		areaLightActive: false,
		areaLightReady: false,
		areaLightCount: 0,
		areaLightFrameCount: 0,
		areaLightSources: [],
		frameCount: 0,
		shadowLightCount: 0,
		shadowMaximumSources: deferredLightingMaximumShadowSources,
		shadowMapCount: 0,
		shadowSamplerCount: 0,
		shadowSamplerBudget: 0,
		shadowSources: [],
		shadowLightId: null,
		shadowLightName: null,
		shadowGeneratorType: null,
		shadowMapType: null,
		shadowFilter: null,
		shadowFilteringQuality: null,
		shadowBlurScale: 0,
		shadowDepthScale: 0,
		shadowContactHardeningLightSizeUVRatio: 0,
		shadowCascadeCount: 0,
		shadowMapReady: false,
		shadowMapWidth: 0,
		shadowMapHeight: 0,
		shadowCasterCount: 0,
		shadowReceiverCount: 0,
		shadowFrameCount: 0,
		compositionMode: "deferred-only",
		forwardCompositionReady: false,
		forwardCompositionFrameCount: 0,
		forwardMeshCount: 0,
		transparentMeshCount: 0,
		backgroundMeshCount: 0,
		laterRenderingGroupMeshCount: 0,
		particleSystemCount: 0,
		spriteManagerCount: 0,
		layerCount: 0,
		limitations: [...limitations],
		warnings: [],
		errors: error ? [error] : [],
	};
}

function setReport(scene: Scene, camera: Camera, report: IDeferredLightingRuntimeEvidence): void {
	report.configuredCameraCount = managers.get(scene)?.states.size ?? 0;
	report.sharedGeometryBufferHolderCount = getGeometryBufferLeaseEvidence(scene).holderCount;
	let sceneReports = reports.get(scene);
	if (!sceneReports) {
		sceneReports = new Map();
		reports.set(scene, sceneReports);
	}
	sceneReports.set(camera.id, report);
}

function deleteReport(scene: Scene, camera: Camera): void {
	const sceneReports = reports.get(scene);
	sceneReports?.delete(camera.id);
	if (sceneReports?.size === 0) {
		reports.delete(scene);
	}
}

function applyCameraEvidence(report: IDeferredLightingRuntimeEvidence, camera: Camera): void {
	const output = camera.outputRenderTarget;
	const outputSize = output?.getSize();
	report.cameraId = camera.id;
	report.cameraName = camera.name;
	report.cameraViewport = [camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height];
	report.outputRenderTargetName = output?.name ?? null;
	report.outputRenderTargetWidth = outputSize?.width ?? 0;
	report.outputRenderTargetHeight = outputSize?.height ?? 0;
}

function nonBlack(color: Color3 | undefined): boolean {
	return Boolean(color && (Math.abs(color.r) > 0.0001 || Math.abs(color.g) > 0.0001 || Math.abs(color.b) > 0.0001));
}

function supportedMaterial(material: Material): boolean {
	return (
		material instanceof StandardMaterial ||
		material instanceof PBRMaterial ||
		material instanceof PBRMetallicRoughnessMaterial ||
		material instanceof PBRSpecularGlossinessMaterial ||
		material instanceof OpenPBRMaterial
	);
}

function usesNativeSubsurface(material: Material): boolean {
	const value = material as Material & { subSurface?: { isScatteringEnabled?: boolean; isTranslucencyEnabled?: boolean } };
	return material.getClassName() === "PBRMaterial" && Boolean(value.subSurface?.isScatteringEnabled || value.subSurface?.isTranslucencyEnabled);
}

function materialEmissive(material: Material): { color: Color3; texture: BaseTexture | null; intensity: number } {
	const value = material as Material & {
		emissiveColor?: Color3;
		emissiveTexture?: BaseTexture | null;
		emissiveIntensity?: number;
		emissionColor?: Color3;
		emissionColorTexture?: BaseTexture | null;
		emissionLuminance?: number;
	};
	const rawIntensity = value.emissiveIntensity ?? value.emissionLuminance ?? 1;
	return {
		color: (value.emissiveColor ?? value.emissionColor ?? Color3.Black()).clone(),
		texture: value.emissiveTexture ?? value.emissionColorTexture ?? null,
		intensity: Number.isFinite(rawIntensity) ? Math.max(0, rawIntensity) : 1,
	};
}

function collectEmissiveSources(meshes: AbstractMesh[], warnings: string[]): IDeferredEmissiveSource[] {
	const sources = new Map<Material, IDeferredEmissiveSource>();
	for (const mesh of meshes) {
		const material = mesh.material!;
		const emissive = materialEmissive(material);
		if (emissive.intensity <= 0 || (!nonBlack(emissive.color) && !emissive.texture)) {
			continue;
		}
		let source = sources.get(material);
		if (!source) {
			source = { material, ...emissive, meshes: [] };
			sources.set(material, source);
		}
		source.meshes.push(mesh);
	}
	const result = [...sources.values()].sort((left, right) => left.material.name.localeCompare(right.material.name) || left.material.uniqueId - right.material.uniqueId);
	if (result.length > deferredLightingMaximumEmissiveSources) {
		warnings.push(
			`Deferred emissive execution includes all ${result.length} authored materials; runtime evidence is bounded to the first ${deferredLightingMaximumEmissiveSources}.`
		);
	}
	return result;
}

function emissiveTextureSignature(texture: BaseTexture | null): string {
	if (!texture) {
		return "none";
	}
	const value = texture as BaseTexture & {
		coordinatesIndex?: number;
		uOffset?: number;
		vOffset?: number;
		uScale?: number;
		vScale?: number;
		uAng?: number;
		vAng?: number;
		wAng?: number;
	};
	return [
		texture.uniqueId,
		texture.name,
		texture.level,
		texture.gammaSpace,
		texture.hasAlpha,
		value.coordinatesIndex ?? 0,
		value.uOffset ?? 0,
		value.vOffset ?? 0,
		value.uScale ?? 1,
		value.vScale ?? 1,
		value.uAng ?? 0,
		value.vAng ?? 0,
		value.wAng ?? 0,
	].join(":");
}

function emissiveSignature(sources: IDeferredEmissiveSource[]): string {
	return sources
		.map((source) =>
			[
				source.material.uniqueId,
				source.material.getClassName(),
				source.color.r,
				source.color.g,
				source.color.b,
				source.intensity,
				emissiveTextureSignature(source.texture),
				...source.meshes.map((mesh) => mesh.uniqueId).sort((left, right) => left - right),
			].join("|")
		)
		.join(";");
}

function emissiveSourceEvidence(source: IDeferredEmissiveSource): IDeferredEmissiveSourceEvidence {
	return {
		materialId: source.material.id,
		materialName: source.material.name,
		materialClassName: source.material.getClassName(),
		meshCount: source.meshes.length,
		color: source.color.asArray() as [number, number, number],
		intensity: source.intensity,
		textureName: source.texture?.name ?? null,
		textureReady: source.texture?.isReadyOrNotBlocking() ?? true,
		textureGammaSpace: source.texture?.gammaSpace ?? null,
	};
}

function finiteTuple(value: unknown): [number, number, number] | null {
	return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? [value[0], value[1], value[2]] : null;
}

function finiteTuple2(value: unknown, fallback: [number, number]): [number, number] {
	return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? [value[0], value[1]] : fallback;
}

function materialDecalAlbedo(material: Material): { color: Color3; texture: BaseTexture | null } {
	if (material instanceof StandardMaterial) {
		return { color: material.diffuseColor.clone(), texture: material.diffuseTexture };
	}
	if (material instanceof PBRMaterial) {
		return { color: material.albedoColor.clone(), texture: material.albedoTexture };
	}
	if (material instanceof PBRMetallicRoughnessMaterial) {
		return { color: material.baseColor.clone(), texture: material.baseTexture };
	}
	if (material instanceof PBRSpecularGlossinessMaterial) {
		return { color: material.diffuseColor.clone(), texture: material.diffuseTexture };
	}
	if (material instanceof OpenPBRMaterial) {
		return { color: material.baseColor.clone(), texture: material.baseColorTexture };
	}
	return { color: Color3.White(), texture: null };
}

function materialDecalTextures(material: Material): BaseTexture[] {
	const value = material as Material & {
		diffuseTexture?: BaseTexture | null;
		bumpTexture?: BaseTexture | null;
		specularTexture?: BaseTexture | null;
		opacityTexture?: BaseTexture | null;
		albedoTexture?: BaseTexture | null;
		metallicTexture?: BaseTexture | null;
		reflectivityTexture?: BaseTexture | null;
		baseTexture?: BaseTexture | null;
		normalTexture?: BaseTexture | null;
		metallicRoughnessTexture?: BaseTexture | null;
		specularGlossinessTexture?: BaseTexture | null;
		baseColorTexture?: BaseTexture | null;
		geometryNormalTexture?: BaseTexture | null;
		geometryOpacityTexture?: BaseTexture | null;
		ambientTexture?: BaseTexture | null;
		ambientOcclusionTexture?: BaseTexture | null;
		geometryAmbientOcclusionTexture?: BaseTexture | null;
		specularColorTexture?: BaseTexture | null;
		specularRoughnessTexture?: BaseTexture | null;
		emissiveTexture?: BaseTexture | null;
		emissionColorTexture?: BaseTexture | null;
	};
	return [
		value.diffuseTexture,
		value.bumpTexture,
		value.specularTexture,
		value.opacityTexture,
		value.albedoTexture,
		value.metallicTexture,
		value.reflectivityTexture,
		value.baseTexture,
		value.normalTexture,
		value.metallicRoughnessTexture,
		value.specularGlossinessTexture,
		value.baseColorTexture,
		value.geometryNormalTexture,
		value.geometryOpacityTexture,
		value.ambientTexture,
		value.ambientOcclusionTexture,
		value.geometryAmbientOcclusionTexture,
		value.specularColorTexture,
		value.specularRoughnessTexture,
		value.emissiveTexture,
		value.emissionColorTexture,
	].filter((texture, index, textures): texture is BaseTexture => Boolean(texture) && textures.indexOf(texture) === index);
}

function materialNormalTexture(material: Material): BaseTexture | null {
	const value = material as Material & { bumpTexture?: BaseTexture | null; normalTexture?: BaseTexture | null; geometryNormalTexture?: BaseTexture | null };
	return value.bumpTexture ?? value.normalTexture ?? value.geometryNormalTexture ?? null;
}

function materialReflectivityTexture(material: Material): BaseTexture | null {
	const value = material as Material & {
		specularTexture?: BaseTexture | null;
		metallicTexture?: BaseTexture | null;
		reflectivityTexture?: BaseTexture | null;
		metallicRoughnessTexture?: BaseTexture | null;
		specularGlossinessTexture?: BaseTexture | null;
		specularColorTexture?: BaseTexture | null;
		specularRoughnessTexture?: BaseTexture | null;
	};
	return (
		value.specularTexture ??
		value.metallicTexture ??
		value.reflectivityTexture ??
		value.metallicRoughnessTexture ??
		value.specularGlossinessTexture ??
		value.specularColorTexture ??
		value.specularRoughnessTexture ??
		null
	);
}

function materialAmbientOcclusionTexture(material: Material): BaseTexture | null {
	const value = material as Material & {
		ambientTexture?: BaseTexture | null;
		ambientOcclusionTexture?: BaseTexture | null;
		geometryAmbientOcclusionTexture?: BaseTexture | null;
	};
	return value.ambientTexture ?? value.ambientOcclusionTexture ?? value.geometryAmbientOcclusionTexture ?? null;
}

function finiteUnit(value: unknown, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value as number)) : fallback;
}

function finiteRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}

function decalChannels(value: unknown, fallback: IDeferredDecalChannels): IDeferredDecalChannels {
	if (!value || typeof value !== "object") {
		return { ...fallback };
	}
	const channels = value as Partial<IDeferredDecalChannels>;
	return {
		albedo: typeof channels.albedo === "boolean" ? channels.albedo : fallback.albedo,
		normal: typeof channels.normal === "boolean" ? channels.normal : fallback.normal,
		metallic: typeof channels.metallic === "boolean" ? channels.metallic : fallback.metallic,
		ambientOcclusion: typeof channels.ambientOcclusion === "boolean" ? channels.ambientOcclusion : fallback.ambientOcclusion,
		emissive: typeof channels.emissive === "boolean" ? channels.emissive : fallback.emissive,
	};
}

function projectorNormalToWorld(mesh: AbstractMesh): Matrix {
	const scale = Vector3.One();
	const rotation = Quaternion.Identity();
	const translation = Vector3.Zero();
	mesh.computeWorldMatrix(true).decompose(scale, rotation, translation);
	return Matrix.Compose(Vector3.One(), rotation, Vector3.Zero());
}

function decalAlphaMode(material: Material, mesh: AbstractMesh): IDeferredDecalSourceEvidence["alphaMode"] {
	return material.needAlphaBlendingForMesh(mesh) ? "alpha-blend" : material.needAlphaTesting() ? "alpha-test" : "opaque";
}

function collectDecalSources(scene: Scene, meshes: AbstractMesh[], warnings: string[], errors: string[]): IDeferredDecalSource[] {
	const result: IDeferredDecalSource[] = [];
	const deferredMeshIds = new Set(meshes.map((mesh) => mesh.uniqueId));
	for (const mesh of scene.meshes) {
		const metadata = mesh.metadata?.decal as
			| {
					version?: number;
					revision?: number;
					projectionMode?: "geometry" | "screen-space-volume";
					meshId?: string;
					position?: unknown;
					normal?: unknown;
					rotation?: unknown;
					sizeX?: number;
					sizeY?: number;
					sizeZ?: number;
					angle?: number;
					edgeFade?: number;
					uvScale?: unknown;
					uvOffset?: unknown;
					channels?: unknown;
					normalStrength?: number;
					metallic?: number;
					smoothness?: number;
					ambientOcclusion?: number;
					emissiveIntensity?: number;
					decalLayerMask?: number;
			  }
			| undefined;
		if (!metadata || !mesh.material) {
			continue;
		}
		const projectionMode = metadata.projectionMode === "screen-space-volume" ? "screen-space-volume" : "geometry";
		if (projectionMode === "geometry" && !deferredMeshIds.has(mesh.uniqueId)) {
			continue;
		}
		const sourceMesh = typeof metadata.meshId === "string" ? scene.getMeshById(metadata.meshId) : null;
		if (projectionMode === "geometry" && metadata.meshId && !sourceMesh) {
			errors.push(`Deferred decal "${mesh.name}" references missing source mesh "${metadata.meshId}".`);
		}
		if (projectionMode === "geometry" && sourceMesh?.metadata?.decal) {
			errors.push(`Deferred decal "${mesh.name}" cannot use another decal as its projection source.`);
		}
		if (projectionMode === "geometry" && (!mesh.geometry || mesh.getTotalVertices() === 0 || mesh.getTotalIndices() === 0)) {
			errors.push(`Deferred decal "${mesh.name}" has no projected geometry; regenerate it with a projection volume that intersects its source mesh.`);
		}
		const size =
			Number.isFinite(metadata.sizeX) && Number.isFinite(metadata.sizeY) && Number.isFinite(metadata.sizeZ)
				? ([metadata.sizeX!, metadata.sizeY!, metadata.sizeZ!] as [number, number, number])
				: projectionMode === "screen-space-volume"
					? (mesh.scaling.asArray() as [number, number, number])
					: null;
		if (projectionMode === "screen-space-volume" && (!size || size.some((value) => !Number.isFinite(value) || value <= 0))) {
			errors.push(`Screen-space decal projector "${mesh.name}" requires positive finite width, height, and depth.`);
			continue;
		}
		if (!supportedMaterial(mesh.material)) {
			errors.push(`Screen-space decal projector "${mesh.name}" uses unsupported material "${mesh.material.name}" (${mesh.material.getClassName()}).`);
		}
		const emissive = materialEmissive(mesh.material);
		const albedo = materialDecalAlbedo(mesh.material);
		const normalTexture = materialNormalTexture(mesh.material);
		const reflectivityTexture = materialReflectivityTexture(mesh.material);
		const ambientOcclusionTexture = materialAmbientOcclusionTexture(mesh.material);
		const geometryChannels: IDeferredDecalChannels = {
			albedo: true,
			normal: Boolean(normalTexture),
			metallic: !(mesh.material instanceof StandardMaterial) || Boolean(reflectivityTexture) || nonBlack(mesh.material.specularColor),
			ambientOcclusion: Boolean(ambientOcclusionTexture),
			emissive: emissive.intensity > 0 && (nonBlack(emissive.color) || Boolean(emissive.texture)),
		};
		const channels = decalChannels(
			metadata.channels,
			projectionMode === "screen-space-volume" ? { albedo: true, normal: false, metallic: false, ambientOcclusion: false, emissive: false } : geometryChannels
		);
		if (projectionMode === "screen-space-volume" && !Object.values(channels).some(Boolean)) {
			errors.push(`Screen-space decal projector "${mesh.name}" requires at least one enabled material channel.`);
			continue;
		}
		if (projectionMode === "screen-space-volume" && albedo.texture?.isCube) {
			errors.push(`Screen-space decal projector "${mesh.name}" requires a 2D albedo texture, not a cubemap.`);
		}
		for (const [channel, enabled, texture] of [
			["normal", channels.normal, normalTexture],
			["metallic/smoothness", channels.metallic, reflectivityTexture],
			["ambient-occlusion", channels.ambientOcclusion, ambientOcclusionTexture],
			["emissive", channels.emissive, emissive.texture],
		] as const) {
			if (projectionMode === "screen-space-volume" && enabled && texture?.isCube) {
				errors.push(`Screen-space decal projector "${mesh.name}" requires a 2D ${channel} texture, not a cubemap.`);
			}
		}
		const edgeFade = Number.isFinite(metadata.edgeFade) ? Math.max(0, Math.min(1, metadata.edgeFade!)) : 0;
		const decalLayerMask = Number.isInteger(metadata.decalLayerMask) ? metadata.decalLayerMask! >>> 0 : 0xffffffff;
		const affectedMeshes =
			projectionMode === "screen-space-volume"
				? meshes.filter((target) => target !== mesh && ((target.layerMask >>> 0) & decalLayerMask) !== 0)
				: sourceMesh
					? [sourceMesh]
					: [];
		result.push({
			mesh,
			sourceMesh: projectionMode === "geometry" ? sourceMesh : null,
			material: mesh.material,
			projectionMode,
			version: Number.isInteger(metadata.version) && metadata.version! > 0 ? metadata.version! : 1,
			revision: Number.isInteger(metadata.revision) && metadata.revision! > 0 ? metadata.revision! : 1,
			position: projectionMode === "screen-space-volume" ? (mesh.getAbsolutePosition().asArray() as [number, number, number]) : finiteTuple(metadata.position),
			normal: projectionMode === "geometry" ? finiteTuple(metadata.normal) : null,
			rotation: projectionMode === "screen-space-volume" ? (mesh.rotation.asArray() as [number, number, number]) : finiteTuple(metadata.rotation),
			size,
			angle: Number.isFinite(metadata.angle) ? metadata.angle! : 0,
			edgeFade,
			uvScale: finiteTuple2(metadata.uvScale, [1, 1]),
			uvOffset: finiteTuple2(metadata.uvOffset, [0, 0]),
			alphaMode: decalAlphaMode(mesh.material, mesh),
			opacity: Number.isFinite(mesh.material.alpha) ? Math.max(0, Math.min(1, mesh.material.alpha)) : 1,
			albedoColor: albedo.color,
			albedoTexture: projectionMode === "screen-space-volume" ? albedo.texture : null,
			normalTexture: projectionMode === "screen-space-volume" && channels.normal ? normalTexture : null,
			reflectivityTexture: projectionMode === "screen-space-volume" && channels.metallic ? reflectivityTexture : null,
			ambientOcclusionTexture: projectionMode === "screen-space-volume" && channels.ambientOcclusion ? ambientOcclusionTexture : null,
			emissiveColor: emissive.color,
			emissiveTexture: projectionMode === "screen-space-volume" && channels.emissive ? emissive.texture : null,
			worldToLocal: projectionMode === "screen-space-volume" ? Matrix.Invert(mesh.computeWorldMatrix(true)) : null,
			normalToWorld: projectionMode === "screen-space-volume" ? projectorNormalToWorld(mesh) : null,
			affectedMeshCount: affectedMeshes.length,
			affectedMeshIds: affectedMeshes.map((target) => target.uniqueId).sort((left, right) => left - right),
			targetLayerSignature: meshes
				.map((target) => `${target.uniqueId}:${target.layerMask >>> 0}`)
				.sort()
				.join(","),
			textures:
				projectionMode === "screen-space-volume"
					? [
							albedo.texture,
							channels.normal ? normalTexture : null,
							channels.metallic ? reflectivityTexture : null,
							channels.ambientOcclusion ? ambientOcclusionTexture : null,
							channels.emissive ? emissive.texture : null,
						].filter((texture, index, textures): texture is BaseTexture => Boolean(texture) && textures.indexOf(texture) === index)
					: materialDecalTextures(mesh.material),
			channels,
			normalStrength: finiteRange(metadata.normalStrength, 1, 0, 2),
			metallic: finiteUnit(metadata.metallic, 0),
			smoothness: finiteUnit(metadata.smoothness, 0.5),
			ambientOcclusion: finiteUnit(metadata.ambientOcclusion, 1),
			emissiveIntensity: finiteRange(metadata.emissiveIntensity, 1, 0, 16),
			decalLayerMask,
			affectsNormal: channels.normal,
			affectsReflectivity: channels.metallic,
			affectsAmbientOcclusion: channels.ambientOcclusion,
			affectsEmissive: channels.emissive,
		});
	}
	result.sort(
		(left, right) => left.mesh.renderingGroupId - right.mesh.renderingGroupId || left.mesh.alphaIndex - right.mesh.alphaIndex || left.mesh.name.localeCompare(right.mesh.name)
	);
	const projectorCount = result.filter((source) => source.projectionMode === "screen-space-volume").length;
	if (projectorCount > deferredLightingMaximumProjectorDecalSources) {
		errors.push(
			`Deferred lighting supports at most ${deferredLightingMaximumProjectorDecalSources} active screen-space decal projectors per camera; this scene has ${projectorCount}.`
		);
	}
	if (result.length > deferredLightingMaximumDecalSources) {
		warnings.push(`Deferred decal execution includes all ${result.length} projected meshes; runtime evidence is bounded to the first ${deferredLightingMaximumDecalSources}.`);
	}
	let retainedProjectors = 0;
	return result.filter((source) => source.projectionMode === "geometry" || retainedProjectors++ < deferredLightingMaximumProjectorDecalSources);
}

function decalMaterialSignature(material: Material): string {
	let serialized = "";
	try {
		serialized = JSON.stringify(material.serialize());
	} catch {
		serialized = `${material.id}:${material.name}:${material.alpha}`;
	}
	return `${serialized}|${materialDecalTextures(material).map(emissiveTextureSignature).join("|")}`;
}

function decalSignature(sources: IDeferredDecalSource[]): string {
	return sources
		.map((source) =>
			[
				source.mesh.uniqueId,
				source.projectionMode,
				source.mesh.geometry?.uniqueId ?? "no-geometry",
				source.mesh.getTotalVertices(),
				source.mesh.getTotalIndices(),
				source.sourceMesh?.uniqueId ?? "merged",
				source.version,
				source.revision,
				source.position?.join(",") ?? "none",
				source.normal?.join(",") ?? "none",
				source.rotation?.join(",") ?? "none",
				source.size?.join(",") ?? "none",
				source.angle,
				source.edgeFade,
				source.uvScale.join(","),
				source.uvOffset.join(","),
				source.worldToLocal?.m.join(",") ?? "no-projector-matrix",
				source.normalToWorld?.m.join(",") ?? "no-projector-normal-matrix",
				source.albedoColor.asArray().join(","),
				emissiveTextureSignature(source.albedoTexture),
				emissiveTextureSignature(source.normalTexture),
				emissiveTextureSignature(source.reflectivityTexture),
				emissiveTextureSignature(source.ambientOcclusionTexture),
				source.emissiveColor.asArray().join(","),
				emissiveTextureSignature(source.emissiveTexture),
				Object.values(source.channels).join(","),
				source.normalStrength,
				source.metallic,
				source.smoothness,
				source.ambientOcclusion,
				source.emissiveIntensity,
				source.decalLayerMask,
				source.affectedMeshIds.join(","),
				source.targetLayerSignature,
				source.mesh.renderingGroupId,
				source.mesh.alphaIndex,
				source.material.zOffset,
				source.material.zOffsetUnits,
				decalMaterialSignature(source.material),
			].join("|")
		)
		.join(";");
}

function decalSourceEvidence(source: IDeferredDecalSource): IDeferredDecalSourceEvidence {
	return {
		backend: source.projectionMode === "screen-space-volume" ? "screen-space-volume-projector-v2" : "projected-geometry-gbuffer-v1",
		projectionMode: source.projectionMode,
		nodeId: source.mesh.id,
		nodeName: source.mesh.name,
		version: source.version,
		revision: source.revision,
		sourceMeshId: source.sourceMesh?.id ?? null,
		sourceMeshName: source.sourceMesh?.name ?? null,
		materialId: source.material.id,
		materialName: source.material.name,
		materialClassName: source.material.getClassName(),
		position: source.position,
		normal: source.normal,
		rotation: source.rotation,
		size: source.size,
		angle: source.angle,
		edgeFade: source.edgeFade,
		uvScale: source.uvScale,
		uvOffset: source.uvOffset,
		alphaMode: source.alphaMode,
		opacity: source.opacity,
		renderingGroupId: source.mesh.renderingGroupId,
		alphaIndex: source.mesh.alphaIndex,
		zOffset: source.material.zOffset,
		zOffsetUnits: source.material.zOffsetUnits,
		affectsAlbedo: source.projectionMode === "geometry" || source.channels.albedo,
		affectsNormal: source.affectsNormal,
		affectsReflectivity: source.affectsReflectivity,
		affectsAmbientOcclusion: source.affectsAmbientOcclusion,
		affectsEmissive: source.affectsEmissive,
		channels: { ...source.channels },
		normalStrength: source.normalStrength,
		metallic: source.metallic,
		smoothness: source.smoothness,
		ambientOcclusion: source.ambientOcclusion,
		emissiveIntensity: source.emissiveIntensity,
		decalLayerMask: source.decalLayerMask,
		textureNames: source.textures.map((texture) => texture.name),
		projectorTextureNames: {
			albedo: source.albedoTexture?.name ?? null,
			normal: source.normalTexture?.name ?? null,
			reflectivity: source.reflectivityTexture?.name ?? null,
			ambientOcclusion: source.ambientOcclusionTexture?.name ?? null,
			emissive: source.emissiveTexture?.name ?? null,
		},
		projectorTexturesReady: [source.albedoTexture, source.normalTexture, source.reflectivityTexture, source.ambientOcclusionTexture, source.emissiveTexture].every(
			(texture) => texture?.isReadyOrNotBlocking() ?? true
		),
		projectorTextureName: source.albedoTexture?.name ?? null,
		projectorTextureReady: source.albedoTexture?.isReadyOrNotBlocking() ?? true,
		affectedMeshCount: source.affectedMeshCount,
		texturesReady: source.textures.every((texture) => texture.isReadyOrNotBlocking()),
		vertexCount: source.projectionMode === "geometry" ? source.mesh.getTotalVertices() : 0,
		indexCount: source.projectionMode === "geometry" ? source.mesh.getTotalIndices() : 0,
		geometryReady:
			source.projectionMode === "screen-space-volume" || (Boolean(source.mesh.geometry) && source.mesh.getTotalVertices() > 0 && source.mesh.getTotalIndices() > 0),
	};
}

function projectorSamplerCount(projectors: IDeferredDecalSource[]): number {
	return (
		projectors.reduce(
			(count, source) =>
				count +
				Number(Boolean(source.albedoTexture)) +
				Number(Boolean(source.channels.normal && source.normalTexture)) +
				Number(Boolean(source.channels.metallic && source.reflectivityTexture)) +
				Number(Boolean(source.channels.ambientOcclusion && source.ambientOcclusionTexture)) +
				Number(Boolean(source.channels.emissive && source.emissiveTexture)),
			0
		) + Number(projectors.some((source) => source.decalLayerMask !== 0xffffffff))
	);
}

function applyDecalEvidence(report: IDeferredLightingRuntimeEvidence, sources: IDeferredDecalSource[]): void {
	report.decalActive = sources.length > 0;
	report.decalCount = sources.length;
	report.decalGeometryCount = sources.filter((source) => source.projectionMode === "geometry").length;
	report.decalProjectorCount = sources.filter((source) => source.projectionMode === "screen-space-volume").length;
	const projectors = sources.filter((source) => source.projectionMode === "screen-space-volume");
	report.decalLayerFilteredProjectorCount = projectors.filter((source) => source.decalLayerMask !== 0xffffffff).length;
	report.decalProjectorSamplerCount = projectorSamplerCount(projectors);
	report.decalSourceMeshCount = new Set(sources.map((source) => source.sourceMesh?.uniqueId).filter((id): id is number => id !== undefined)).size;
	report.decalMaterialCount = new Set(sources.map((source) => source.material.uniqueId)).size;
	report.decalTextureCount = new Set(sources.flatMap((source) => source.textures.map((texture) => texture.uniqueId))).size;
	report.decalEvidenceTruncated = sources.length > deferredLightingMaximumDecalSources;
	report.decalSources = sources.slice(0, deferredLightingMaximumDecalSources).map(decalSourceEvidence);
}

function materialIblTexture(material: Material, scene: Scene): BaseTexture | null {
	const value = material as Material & {
		reflectionTexture?: BaseTexture | null;
		environmentTexture?: BaseTexture | null;
		radianceTexture?: BaseTexture | null;
		_radianceTexture?: BaseTexture | null;
	};
	return value.reflectionTexture ?? value.environmentTexture ?? value.radianceTexture ?? value._radianceTexture ?? scene.environmentTexture ?? null;
}

function materialIblIntensity(material: Material): number {
	const value = (material as Material & { environmentIntensity?: number }).environmentIntensity;
	return Number.isFinite(value) ? Math.max(0, Math.min(16, value!)) : 1;
}

function isCubeIblTexture(texture: BaseTexture): boolean {
	const value = texture as BaseTexture & { renderTarget?: { isCube?: boolean } | null };
	return texture.isCube || Boolean(value.renderTarget?.isCube);
}

function iblMaximumLod(texture: BaseTexture): number {
	const size = texture.getSize();
	return (texture as BaseTexture & { noMipmap?: boolean }).noMipmap ? 0 : Math.max(0, Math.floor(Math.log2(Math.max(1, size.width))));
}

function probeMetadata(probe: ReflectionProbe | null): {
	intensity: number;
	boxProjection: boolean;
	revision: number;
	boxPosition: Vector3;
	boxSize: Vector3;
	importance: number;
	blendDistance: number;
	assignedMaterialIds: string[];
	explicitAssignments: boolean;
} {
	const metadata = probe?.metadata?.babylonEditorReflectionProbe as
		| {
				version?: number;
				intensity?: number;
				boxProjection?: boolean;
				revision?: number;
				influencePosition?: [number, number, number];
				influenceSize?: [number, number, number];
				importance?: number;
				blendDistance?: number;
				assignedMaterialIds?: string[];
		  }
		| undefined;
	const validPosition = metadata?.influencePosition?.length === 3 && metadata.influencePosition.every(Number.isFinite);
	const validSize = metadata?.influenceSize?.length === 3 && metadata.influenceSize.every((value) => Number.isFinite(value) && value > 0);
	const boxSize = validSize ? Vector3.FromArray(metadata!.influenceSize!) : (probe?.cubeTexture.boundingBoxSize?.clone() ?? new Vector3(1000, 1000, 1000));
	const maximumBlendDistance = Math.min(boxSize.x, boxSize.y, boxSize.z) * 0.5;
	return {
		intensity: Number.isFinite(metadata?.intensity) ? Math.max(0, Math.min(16, metadata!.intensity!)) : 1,
		boxProjection: metadata?.boxProjection ?? Boolean(probe?.cubeTexture.boundingBoxSize),
		revision: Number.isInteger(metadata?.revision) ? metadata!.revision! : 0,
		boxPosition: validPosition
			? Vector3.FromArray(metadata!.influencePosition!)
			: (probe?.cubeTexture.boundingBoxPosition?.clone() ?? probe?.position.clone() ?? Vector3.Zero()),
		boxSize,
		importance: Number.isInteger(metadata?.importance) ? Math.max(0, Math.min(1000, metadata!.importance!)) : 1,
		blendDistance: Number.isFinite(metadata?.blendDistance) ? Math.max(0, Math.min(maximumBlendDistance, metadata!.blendDistance!)) : Math.min(100, maximumBlendDistance),
		assignedMaterialIds:
			metadata?.version === 2 && Array.isArray(metadata.assignedMaterialIds)
				? [...new Set(metadata.assignedMaterialIds.filter((id): id is string => typeof id === "string" && !!id))]
				: [],
		explicitAssignments: metadata?.version === 2 && Array.isArray(metadata.assignedMaterialIds),
	};
}

function collectIblSources(scene: Scene, meshes: AbstractMesh[], warnings: string[], errors: string[]): IDeferredIblSource[] {
	const probes = ((scene as Scene & { reflectionProbes?: ReflectionProbe[] }).reflectionProbes ?? []).filter((probe) => Boolean(probe?.cubeTexture));
	const probeByTexture = new Map<BaseTexture, ReflectionProbe>(probes.map((probe) => [probe.cubeTexture, probe]));
	const sources = new Map<number, IDeferredIblSource>();
	const addSource = (texture: BaseTexture, probe: ReflectionProbe | null, mesh: AbstractMesh, materialIntensity: number): void => {
		const metadata = probeMetadata(probe);
		let source = sources.get(texture.uniqueId);
		if (!source) {
			source = {
				index: 0,
				kind: probe ? "reflection-probe" : texture === scene.environmentTexture ? "environment" : "material-cubemap",
				name: probe?.name ?? (texture.name || `IBL source ${texture.uniqueId}`),
				texture,
				probe,
				probeSlot: null,
				intensity: Math.max(0, texture.level * (scene.iblIntensity ?? 1) * metadata.intensity),
				meshes: [],
			};
			sources.set(texture.uniqueId, source);
		}
		if (!source.meshes.some((entry) => entry.mesh === mesh)) {
			source.meshes.push({ mesh, materialIntensity });
		}
	};
	for (const mesh of meshes) {
		const material = mesh.material!;
		const materialIntensity = materialIblIntensity(material);
		const authoredTexture = materialIblTexture(material, scene);
		const nativeProbe = authoredTexture ? (probeByTexture.get(authoredTexture) ?? null) : null;
		const assignedProbes = probes.filter((probe) => {
			const metadata = probeMetadata(probe);
			return metadata.explicitAssignments ? metadata.assignedMaterialIds.includes(material.id) : probe === nativeProbe;
		});
		let baseTexture = authoredTexture;
		if (nativeProbe) {
			baseTexture = scene.environmentTexture && scene.environmentTexture !== nativeProbe.cubeTexture ? scene.environmentTexture : null;
		}
		if (baseTexture) {
			if (isCubeIblTexture(baseTexture)) {
				addSource(baseTexture, null, mesh, materialIntensity);
			} else {
				warnings.push(`Material "${material.name}" uses non-cube reflection texture "${baseTexture.name}"; the bounded deferred IBL path supports cube textures only.`);
			}
		}
		for (const probe of assignedProbes) {
			addSource(probe.cubeTexture, probe, mesh, materialIntensity);
		}
	}
	const result = [...sources.values()].sort(
		(left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name) || left.texture.uniqueId - right.texture.uniqueId
	);
	if (result.length > deferredLightingMaximumIblSources) {
		errors.push(`Deferred IBL supports at most ${deferredLightingMaximumIblSources} unique cube sources per camera; this camera resolves ${result.length}.`);
	}
	for (let index = 0; index < result.length; index++) {
		result[index].index = index + 1;
	}
	let probeSlot = 0;
	for (const source of result) {
		if (source.kind === "reflection-probe") {
			source.probeSlot = probeSlot++;
		}
	}
	return result.slice(0, deferredLightingMaximumIblSources);
}

function iblSignature(sources: IDeferredIblSource[]): string {
	return sources
		.map((source) => {
			const metadata = probeMetadata(source.probe);
			return [
				source.index,
				source.kind,
				source.texture.uniqueId,
				source.intensity,
				metadata.revision,
				metadata.boxProjection,
				metadata.boxPosition.asArray().join(","),
				metadata.boxSize.asArray().join(","),
				metadata.importance,
				metadata.blendDistance,
				metadata.assignedMaterialIds.join(","),
				source.probeSlot ?? -1,
				...source.meshes.map(({ mesh, materialIntensity }) => `${mesh.uniqueId}:${mesh.material?.uniqueId ?? -1}:${materialIntensity}`).sort(),
			].join("|");
		})
		.join(";");
}

function iblSourceEvidence(source: IDeferredIblSource): IDeferredIblSourceEvidence {
	const texture = source.texture as BaseTexture & { boundingBoxPosition?: Vector3; boundingBoxSize?: Vector3; sphericalPolynomial?: unknown };
	const size = texture.getSize();
	const metadata = probeMetadata(source.probe);
	const boxProjection = metadata.boxProjection;
	return {
		index: source.index,
		kind: source.kind,
		name: source.name,
		textureName: source.texture.name,
		ready: source.texture.isReadyOrNotBlocking(),
		width: size.width,
		height: size.height,
		maximumLod: iblMaximumLod(texture),
		gammaSpace: source.texture.gammaSpace,
		rgbd: source.texture.isRGBD,
		intensity: source.intensity,
		meshCount: source.meshes.length,
		materialCount: new Set(source.meshes.map(({ mesh }) => mesh.material?.uniqueId)).size,
		boxProjection,
		boxPosition: boxProjection ? (metadata.boxPosition.asArray() as [number, number, number]) : null,
		boxSize: boxProjection ? (metadata.boxSize.asArray() as [number, number, number]) : null,
		diffuseMode: texture.sphericalPolynomial ? "spherical-polynomial" : "roughest-mip",
		probeSlot: source.probeSlot,
		importance: source.probe ? metadata.importance : null,
		blendDistance: source.probe ? metadata.blendDistance : null,
		blendModel: source.probe ? reflectionProbeBlendModel : null,
	};
}

interface IDeferredIblSelectorAssignment {
	mesh: AbstractMesh;
	baseSourceIndex: number;
	materialIntensity: number;
	probeMask: number;
}

function iblSelectorAssignments(sources: IDeferredIblSource[]): IDeferredIblSelectorAssignment[] {
	const assignments = new Map<number, IDeferredIblSelectorAssignment>();
	for (const source of sources) {
		for (const { mesh, materialIntensity } of source.meshes) {
			let assignment = assignments.get(mesh.uniqueId);
			if (!assignment) {
				assignment = { mesh, baseSourceIndex: 0, materialIntensity, probeMask: 0 };
				assignments.set(mesh.uniqueId, assignment);
			}
			if (source.kind === "reflection-probe" && source.probeSlot !== null) {
				assignment.probeMask |= 1 << source.probeSlot;
			} else {
				assignment.baseSourceIndex = source.index;
			}
		}
	}
	return [...assignments.values()].sort((left, right) => left.mesh.uniqueId - right.mesh.uniqueId);
}

function iblProbeBlendMeshCount(sources: IDeferredIblSource[]): number {
	return iblSelectorAssignments(sources).filter((assignment) => {
		let mask = assignment.probeMask;
		let count = 0;
		while (mask) {
			count += mask & 1;
			mask >>>= 1;
		}
		return count > 1;
	}).length;
}

function enabledLights(scene: Scene): Light[] {
	return scene.lights.filter((light) => light.isEnabled() && light.getTypeID() !== 5);
}

function collectAreaLightSources(lights: Light[]): IAreaLightEvidence[] {
	return lights.filter(isAreaLight).map(getAreaLightEvidence);
}

function areaLightSignature(lights: Light[]): string {
	return lights
		.filter(isAreaLight)
		.map((light) => {
			const basis = getAreaLightBasis(light);
			return [
				light.uniqueId,
				light.isEnabled(),
				light.intensity,
				light.range,
				light.diffuse.asArray().join(","),
				JSON.stringify(getAreaLightMetadata(light)),
				basis.position.asArray().join(","),
				basis.halfWidth.asArray().join(","),
				basis.halfHeight.asArray().join(","),
			].join("|");
		})
		.join(";");
}

function areaLightLtcReady(scene: Scene): boolean {
	const textures = (scene as Scene & { _ltcTextures?: { LTC1: BaseTexture; LTC2: BaseTexture } })._ltcTextures;
	return Boolean(textures?.LTC1.isReadyOrNotBlocking() && textures.LTC2.isReadyOrNotBlocking());
}

function collectCookieSources(lights: Light[], errors: string[]): IDeferredCookieSource[] {
	const sources: IDeferredCookieSource[] = [];
	for (let lightIndex = 0; lightIndex < lights.length; lightIndex++) {
		const light = lights[lightIndex];
		const metadata = getLightCookieMetadata(light);
		const texture = getLightCookieTexture(light);
		const evidence = getLightCookieEvidence(light);
		if (!metadata?.enabled || !texture || !evidence) {
			continue;
		}
		if (evidence.kind === "point-cube" && !texture.isCube) {
			errors.push(`Point-light cookie "${texture.name}" on "${light.name}" must be a cubemap.`);
			continue;
		}
		if (evidence.kind !== "point-cube" && texture.isCube) {
			errors.push(`${evidence.lightType} cookie "${texture.name}" on "${light.name}" must be a 2D texture.`);
			continue;
		}
		sources.push({ light, lightIndex, texture, evidence });
	}
	if (sources.length > lightCookieMaximumSources) {
		errors.push(`Deferred lighting supports at most ${lightCookieMaximumSources} active light cookies per camera; this camera resolves ${sources.length}.`);
	}
	return sources.slice(0, lightCookieMaximumSources);
}

function cookieSignature(sources: IDeferredCookieSource[]): string {
	return sources.map((source) => [source.lightIndex, source.light.uniqueId, source.texture.uniqueId, JSON.stringify(getLightCookieMetadata(source.light))].join("|")).join(";");
}

function applyCookieEvidence(report: IDeferredLightingRuntimeEvidence, sources: IDeferredCookieSource[]): void {
	report.cookieActive = sources.length > 0;
	report.cookieCount = sources.length;
	report.cookieReady = !sources.length || sources.every((source) => source.texture.isReadyOrNotBlocking());
	report.cookieSources = sources.map((source) => getLightCookieEvidence(source.light) ?? source.evidence);
}

function applyAreaLightEvidence(report: IDeferredLightingRuntimeEvidence, scene: Scene, lights: Light[]): void {
	const sources = lights.filter(isAreaLight).map(getAreaLightEvidence);
	report.areaLightActive = sources.length > 0;
	report.areaLightReady = !sources.length || areaLightLtcReady(scene);
	report.areaLightCount = sources.length;
	report.areaLightSources = sources;
}

/** Returns deterministic compatibility evidence without allocating render targets or changing scene state. */
export function inspectDeferredLightingCompatibility(scene: Scene, camera: Camera): IDeferredSceneCompatibility {
	const errors: string[] = [];
	const warnings: string[] = [];
	const engine = scene.getEngine();
	const capabilities = engine.getCaps();
	if (!capabilities.drawBuffersExtension || (capabilities.maxDrawBuffers ?? 0) < 4) {
		errors.push("Deferred lighting requires a rendering backend with at least four simultaneous draw buffers.");
	}
	const visibleMeshes = scene.meshes.filter(
		(mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0 && (mesh.layerMask & camera.layerMask) !== 0 && Boolean(mesh.material)
	);
	const meshes: AbstractMesh[] = [];
	const forwardMeshes: AbstractMesh[] = [];
	let transparentMeshCount = 0;
	let backgroundMeshCount = 0;
	let laterRenderingGroupMeshCount = 0;
	for (const mesh of visibleMeshes) {
		const material = mesh.material!;
		const decal = Boolean(mesh.metadata?.decal);
		if (mesh.renderingGroupId !== 0) {
			forwardMeshes.push(mesh);
			laterRenderingGroupMeshCount++;
			if (decal) {
				warnings.push(
					`Decal "${mesh.name}" uses rendering group ${mesh.renderingGroupId} and remains in the native forward stage; use rendering group 0 for deferred execution.`
				);
			}
			continue;
		}
		if (material.needAlphaBlendingForMesh(mesh) && !decal) {
			forwardMeshes.push(mesh);
			transparentMeshCount++;
			continue;
		}
		if (mesh.infiniteDistance) {
			forwardMeshes.push(mesh);
			backgroundMeshCount++;
			if (decal) {
				warnings.push(`Decal "${mesh.name}" is marked infiniteDistance and remains in the native forward background stage.`);
			}
			continue;
		}
		if (usesNativeSubsurface(material)) {
			forwardMeshes.push(mesh);
			warnings.push(`Subsurface material "${material.name}" on mesh "${mesh.name}" is composed through Babylon's native forward/pre-pass SSS path.`);
			continue;
		}
		meshes.push(mesh);
	}
	const materials = [...new Set(meshes.map((mesh) => mesh.material).filter((material): material is Material => Boolean(material)))];
	for (const mesh of meshes) {
		const material = mesh.material!;
		if (material.disableDepthWrite) {
			errors.push(
				`Opaque mesh "${mesh.name}" disables depth writes and cannot be composed safely before the deferred resolve; use transparency, infiniteDistance, or a later rendering group.`
			);
		}
		if (!supportedMaterial(material)) {
			errors.push(`Material "${material.name}" (${material.getClassName()}) is not supported by the bounded deferred albedo pass.`);
		}
		if (material.wireframe || material.pointsCloud) {
			errors.push(`Material "${material.name}" uses wireframe or point rendering and must remain on a forward renderer.`);
		}
	}
	const decalSources = collectDecalSources(scene, meshes, warnings, errors);
	const projectorSources = decalSources.filter((source) => source.projectionMode === "screen-space-volume");
	const emissiveSources = collectEmissiveSources(meshes, warnings);
	const particleSystemCount = scene.particleSystems.filter((particleSystem) => particleSystem.isStarted()).length;
	const spriteManagerCount = scene.spriteManagers?.length ?? 0;
	const layerCount = scene.layers?.length ?? 0;
	const lights = enabledLights(scene);
	const cookieSources = collectCookieSources(lights, errors);
	const areaLightSources = collectAreaLightSources(lights);
	const supportedShadows: IDeferredShadowSource[] = [];
	if (lights.length > deferredLightingMaximumLights) {
		errors.push(`Deferred lighting supports at most ${deferredLightingMaximumLights} enabled lights; this scene has ${lights.length}.`);
	}
	for (const light of lights) {
		if (![0, 1, 2, 3, 4].includes(light.getTypeID())) {
			errors.push(`Light "${light.name}" (${light.getClassName()}) is not supported by the bounded deferred resolve.`);
		}
		if (light.includedOnlyMeshes.length || light.excludedMeshes.length || light.includeOnlyWithLayerMask || light.excludeWithLayerMask) {
			errors.push(`Light "${light.name}" uses per-object mesh or layer filtering, which the bounded deferred resolve cannot reproduce.`);
		}
		const shadow = light.getShadowGenerator(camera) ?? light.getShadowGenerator();
		if (shadow && scene.shadowsEnabled && light.shadowEnabled) {
			const generator = shadow as ShadowGenerator;
			const className = generator.getClassName();
			const cube = Boolean((light as Light & { needCube?: () => boolean }).needCube?.());
			const filter = getDeferredShadowFilter(generator);
			let mode: DeferredShadowMode = "none";
			if (className === "CascadedShadowGenerator") {
				const cascaded = generator as CascadedShadowGenerator;
				if (light.getTypeID() !== 1) {
					errors.push(`Light "${light.name}" uses cascaded shadows but is not directional.`);
				} else if (!filter || !["hard", "pcf", "pcss"].includes(filter)) {
					errors.push(`Light "${light.name}" uses unsupported cascaded shadow filter ${generator.filter}; native cascades support hard, PCF, or PCSS.`);
				} else if (cascaded.numCascades < 2 || cascaded.numCascades > deferredLightingMaximumCascades) {
					errors.push(`Light "${light.name}" uses ${cascaded.numCascades} cascades; bounded deferred cascades require 2 through ${deferredLightingMaximumCascades}.`);
				} else {
					mode = `cascaded-${filter as "hard" | "pcf" | "pcss"}`;
				}
			} else if (className !== "ShadowGenerator") {
				errors.push(`Light "${light.name}" uses unsupported shadow generator ${className}.`);
			} else if (cube) {
				if (light.getTypeID() !== 0) {
					errors.push(`Light "${light.name}" exposes a cube shadow map but is not a point light.`);
				} else if (!filter || !["hard", "poisson", "esm", "close-esm"].includes(filter)) {
					errors.push(
						`Point light "${light.name}" uses unsupported cube shadow filter ${generator.filter}; Babylon cube shadows support hard, Poisson, ESM, or close ESM.`
					);
				} else {
					mode = `point-cube-${filter as "hard" | "poisson" | "esm" | "close-esm"}`;
				}
			} else if (light.getTypeID() !== 1 && light.getTypeID() !== 2) {
				errors.push(`Light "${light.name}" must be directional or spot to use the bounded deferred 2D shadow path.`);
			} else if (!filter) {
				errors.push(`Light "${light.name}" uses unknown classic shadow filter ${generator.filter}.`);
			} else {
				mode = `classic-${filter}`;
			}
			if (!generator.getShadowMap() || !generator.getShadowMapForRendering()) {
				errors.push(`Light "${light.name}" did not allocate a native shadow map.`);
			} else if (mode !== "none") {
				supportedShadows.push({ light, generator, mode });
			}
		}
	}
	if (supportedShadows.length > deferredLightingMaximumShadowSources) {
		errors.push(
			`Deferred lighting supports at most ${deferredLightingMaximumShadowSources} simultaneous shadowed lights per camera; this scene has ${supportedShadows.length}.`
		);
	}
	const shadowSources = supportedShadows.slice(0, deferredLightingMaximumShadowSources);
	const firstShadow = shadowSources[0] ?? null;
	const requiredTextureSamplers =
		4 +
		(emissiveSources.length ? 1 : 0) +
		(areaLightSources.length ? 2 : 0) +
		projectorSamplerCount(projectorSources) +
		cookieSources.length +
		(shadowSources.length ? 1 : 0) +
		shadowSources.reduce((count, source) => count + (isPcssShadowMode(source.mode) ? 2 : 1), 0);
	const textureSamplerBudget = capabilities.maxTexturesImageUnits ?? 0;
	if (requiredTextureSamplers > textureSamplerBudget) {
		errors.push(
			`Deferred lighting requires ${requiredTextureSamplers} fragment texture samplers for this camera's materials, projector decals, cookies, area lights, and ${shadowSources.length} shadowed lights, but the active backend exposes ${textureSamplerBudget}.`
		);
	}
	const iblSources = collectIblSources(scene, meshes, warnings, errors);
	const requiredIblTextureSamplers = iblSources.length ? 6 + projectorSamplerCount(projectorSources) : 0;
	if (requiredIblTextureSamplers > textureSamplerBudget) {
		errors.push(
			`Deferred IBL requires ${requiredIblTextureSamplers} fragment texture samplers for its G-buffer, source, selector, projector channels, and Decal Layers, but the active backend exposes ${textureSamplerBudget}.`
		);
	}
	if (scene.fogEnabled && scene.fogMode !== 0) {
		warnings.push("Scene fog is not evaluated by the bounded deferred resolve.");
	}
	return {
		meshes,
		forwardMeshes,
		materials,
		lights: lights.slice(0, deferredLightingMaximumLights),
		shadowSources,
		shadowGenerator: firstShadow?.generator ?? null,
		shadowLight: firstShadow?.light ?? null,
		shadowMode: firstShadow?.mode ?? "none",
		shadowReceiverMeshes: shadowSources.length ? meshes.filter((mesh) => mesh.receiveShadows) : [],
		emissiveSources,
		decalSources,
		iblSources,
		cookieSources,
		areaLightSources,
		transparentMeshCount,
		backgroundMeshCount,
		laterRenderingGroupMeshCount,
		particleSystemCount,
		spriteManagerCount,
		layerCount,
		warnings: [...new Set(warnings)],
		errors: [...new Set(errors)],
	};
}

function shadowGeneratorType(mode: DeferredShadowMode): IDeferredLightingRuntimeEvidence["shadowGeneratorType"] {
	return isCascadedShadowMode(mode) ? "cascaded" : mode === "none" ? null : "classic";
}

function shadowMapType(mode: DeferredShadowMode): IDeferredLightingRuntimeEvidence["shadowMapType"] {
	return isClassicShadowMode(mode) ? "2d" : isPointShadowMode(mode) ? "cube" : isCascadedShadowMode(mode) ? "2d-array" : null;
}

function shadowFilter(mode: DeferredShadowMode): IDeferredLightingRuntimeEvidence["shadowFilter"] {
	if (mode === "none") {
		return null;
	}
	if (mode.includes("blur-close-esm")) {
		return "blur-close-esm";
	}
	if (mode.includes("close-esm")) {
		return "close-esm";
	}
	if (mode.includes("blur-esm")) {
		return "blur-esm";
	}
	return mode.slice(mode.lastIndexOf("-") + 1) as DeferredShadowFilter;
}

function shadowCascadeCount(source: IDeferredShadowSource | null): number {
	return source && isCascadedShadowMode(source.mode) ? (source.generator as CascadedShadowGenerator).numCascades : 0;
}

function shadowFilteringQuality(generator: ShadowGenerator | null): IDeferredLightingRuntimeEvidence["shadowFilteringQuality"] {
	if (!generator || (generator.filter !== ShadowGenerator.FILTER_PCF && generator.filter !== ShadowGenerator.FILTER_PCSS)) {
		return null;
	}
	return generator.filteringQuality === ShadowGenerator.QUALITY_LOW ? "low" : generator.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? "medium" : "high";
}

function shadowFilteringQualityIndex(generator: ShadowGenerator): number {
	return generator.filteringQuality === ShadowGenerator.QUALITY_LOW ? 0 : generator.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? 1 : 2;
}

function shadowSourceEvidence(source: IDeferredShadowSource, index: number, lights: Light[], receiverCount: number): IDeferredShadowSourceEvidence {
	const map = source.generator.getShadowMapForRendering();
	const size = map?.getSize();
	const cascades = shadowCascadeCount(source);
	return {
		index,
		lightId: source.light.id,
		lightName: source.light.name,
		lightIndex: lights.indexOf(source.light),
		generatorType: shadowGeneratorType(source.mode)!,
		mapType: shadowMapType(source.mode)!,
		filter: shadowFilter(source.mode)!,
		filteringQuality: shadowFilteringQuality(source.generator),
		blurScale: source.generator.blurScale,
		depthScale: source.generator.depthScale,
		contactHardeningLightSizeUVRatio: source.generator.contactHardeningLightSizeUVRatio,
		cascadeCount: cascades,
		mapCount: isPointShadowMode(source.mode) ? 6 : Math.max(1, cascades),
		mapReady: Boolean(map?.isReadyForRendering()),
		mapWidth: size?.width ?? 0,
		mapHeight: size?.height ?? 0,
		casterCount: source.generator.getShadowMap()?.renderList?.length ?? 0,
		receiverCount,
		samplerCount: isPcssShadowMode(source.mode) ? 2 : 1,
	};
}

function applyShadowEvidence(report: IDeferredLightingRuntimeEvidence, compatibility: IDeferredSceneCompatibility, scene: Scene): void {
	const sources = compatibility.shadowSources.map((source, index) => shadowSourceEvidence(source, index, compatibility.lights, compatibility.shadowReceiverMeshes.length));
	const first = sources[0] ?? null;
	report.shadowLightCount = sources.length;
	report.shadowMaximumSources = deferredLightingMaximumShadowSources;
	report.shadowMapCount = sources.reduce((count, source) => count + source.mapCount, 0);
	report.shadowSamplerCount = sources.length ? 1 + sources.reduce((count, source) => count + source.samplerCount, 0) : 0;
	report.shadowSamplerBudget = scene.getEngine().getCaps().maxTexturesImageUnits ?? 0;
	report.shadowSources = sources;
	report.shadowLightId = first?.lightId ?? null;
	report.shadowLightName = first?.lightName ?? null;
	report.shadowGeneratorType = first?.generatorType ?? null;
	report.shadowMapType = first?.mapType ?? null;
	report.shadowFilter = first?.filter ?? null;
	report.shadowFilteringQuality = first?.filteringQuality ?? null;
	report.shadowBlurScale = first?.blurScale ?? 0;
	report.shadowDepthScale = first?.depthScale ?? 0;
	report.shadowContactHardeningLightSizeUVRatio = first?.contactHardeningLightSizeUVRatio ?? 0;
	report.shadowCascadeCount = first?.cascadeCount ?? 0;
	report.shadowMapReady = sources.length > 0 && sources.every((source) => source.mapReady);
	report.shadowMapWidth = first?.mapWidth ?? 0;
	report.shadowMapHeight = first?.mapHeight ?? 0;
	report.shadowCasterCount = sources.reduce((count, source) => count + source.casterCount, 0);
	report.shadowReceiverCount = compatibility.shadowReceiverMeshes.length;
}

function createAlbedoMaterial(source: Material): Material {
	const clone = source.clone(`Deferred Albedo · ${source.name}`);
	if (!clone) {
		throw new Error(`Material "${source.name}" could not be cloned for the deferred albedo pass.`);
	}
	clone.doNotSerialize = true;
	clone.disableColorWrite = false;
	if (clone instanceof StandardMaterial && source instanceof StandardMaterial) {
		clone.disableLighting = true;
		clone.ambientColor = Color3.Black();
		clone.diffuseColor = Color3.Black();
		clone.specularColor = Color3.Black();
		clone.emissiveColor = source.diffuseColor.clone();
		clone.emissiveTexture = source.diffuseTexture;
	} else if (clone instanceof PBRMaterial) {
		clone.unlit = true;
		clone.emissiveColor = Color3.Black();
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRMetallicRoughnessMaterial && source instanceof PBRMetallicRoughnessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.baseColor = Color3.Black();
		clone.emissiveColor = source.baseColor.clone();
		clone.emissiveTexture = source.baseTexture;
	} else if (clone instanceof PBRSpecularGlossinessMaterial && source instanceof PBRSpecularGlossinessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.diffuseColor = Color3.Black();
		clone.emissiveColor = source.diffuseColor.clone();
		clone.emissiveTexture = source.diffuseTexture;
	} else if (clone instanceof OpenPBRMaterial) {
		clone.unlit = true;
		clone.emissionColor = Color3.Black();
		clone.emissionColorTexture = null;
	} else {
		clone.dispose(false, false);
		throw new Error(`Material "${source.name}" (${source.getClassName()}) has no deferred albedo adapter.`);
	}
	return clone;
}

function createEmissiveMaterial(source: Material): Material {
	if (source instanceof OpenPBRMaterial) {
		const emissive = new PBRMaterial(`Deferred Emissive · ${source.name}`, source.getScene());
		emissive.doNotSerialize = true;
		emissive.disableColorWrite = false;
		emissive.disableDepthWrite = false;
		emissive.alpha = 1;
		emissive.backFaceCulling = source.backFaceCulling;
		emissive.sideOrientation = source.sideOrientation;
		emissive.zOffset = source.zOffset;
		emissive.zOffsetUnits = source.zOffsetUnits;
		emissive.unlit = true;
		emissive.albedoColor = Color3.Black();
		emissive.albedoTexture = null;
		emissive.reflectionTexture = null;
		emissive.environmentIntensity = 0;
		emissive.emissiveColor = source.emissionColor.clone();
		emissive.emissiveTexture = source.emissionColorTexture;
		emissive.emissiveIntensity = Math.max(0, source.emissionLuminance);
		return emissive;
	}
	const clone = source.clone(`Deferred Emissive · ${source.name}`);
	if (!clone) {
		throw new Error(`Material "${source.name}" could not be cloned for the deferred emissive pass.`);
	}
	clone.doNotSerialize = true;
	clone.disableColorWrite = false;
	clone.disableDepthWrite = false;
	clone.alpha = 1;
	if (clone instanceof StandardMaterial && source instanceof StandardMaterial) {
		clone.disableLighting = true;
		clone.ambientColor = Color3.Black();
		clone.diffuseColor = Color3.Black();
		clone.diffuseTexture = null;
		clone.specularColor = Color3.Black();
		clone.specularTexture = null;
		clone.reflectionTexture = null;
		clone.opacityTexture = null;
	} else if (clone instanceof PBRMaterial) {
		clone.unlit = true;
		clone.albedoColor = Color3.Black();
		clone.albedoTexture = null;
		clone.reflectionTexture = null;
		clone.environmentIntensity = 0;
		clone.opacityTexture = null;
	} else if (clone instanceof PBRMetallicRoughnessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.baseColor = Color3.Black();
		clone.baseTexture = null;
	} else if (clone instanceof PBRSpecularGlossinessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.diffuseColor = Color3.Black();
		clone.diffuseTexture = null;
	} else {
		clone.dispose(false, false);
		throw new Error(`Material "${source.name}" (${source.getClassName()}) has no deferred emissive adapter.`);
	}
	return clone;
}

function createIblSelectorMaterial(source: Material, baseSourceIndex: number, materialIntensity: number, probeMask: number): Material {
	const clone = source.clone(`Deferred IBL Selector · ${source.name}`);
	if (!clone) {
		throw new Error(`Material "${source.name}" could not be cloned for the deferred IBL selector pass.`);
	}
	const selector = new Color3(baseSourceIndex / 255, Math.max(0, Math.min(16, materialIntensity)) / 16, Math.max(0, Math.min(255, probeMask)) / 255);
	clone.doNotSerialize = true;
	clone.disableColorWrite = false;
	if (clone instanceof StandardMaterial) {
		clone.disableLighting = true;
		clone.ambientColor = Color3.Black();
		clone.diffuseColor = Color3.Black();
		clone.specularColor = Color3.Black();
		clone.emissiveColor = selector;
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRMaterial) {
		clone.unlit = true;
		clone.albedoColor = selector;
		clone.albedoTexture = null;
		clone.emissiveColor = Color3.Black();
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRMetallicRoughnessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.baseColor = selector;
		clone.baseTexture = null;
		clone.emissiveColor = Color3.Black();
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRSpecularGlossinessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.diffuseColor = selector;
		clone.diffuseTexture = null;
		clone.emissiveColor = Color3.Black();
		clone.emissiveTexture = null;
	} else if (clone instanceof OpenPBRMaterial) {
		clone.unlit = true;
		clone.baseColor = selector;
		clone.baseWeight = 1;
		clone.baseColorTexture = null;
		clone.emissionColor = Color3.Black();
		clone.emissionColorTexture = null;
	} else {
		clone.dispose(false, false);
		throw new Error(`Material "${source.name}" (${source.getClassName()}) has no deferred IBL selector adapter.`);
	}
	return clone;
}

function createDecalLayerMaterial(source: Material, layerMask: number): Material {
	const clone = source.clone(`Deferred Decal Layers · ${source.name}`);
	if (!clone) {
		throw new Error(`Material "${source.name}" could not be cloned for the deferred Decal Layer pass.`);
	}
	const bytes = maskBytes(layerMask);
	const encoded = new Color3(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255);
	clone.doNotSerialize = true;
	clone.disableColorWrite = false;
	clone.disableDepthWrite = false;
	clone.alpha = bytes[3] / 255;
	clone.transparencyMode = Material.MATERIAL_OPAQUE;
	if (clone instanceof StandardMaterial) {
		clone.disableLighting = true;
		clone.ambientColor = Color3.Black();
		clone.diffuseColor = Color3.Black();
		clone.specularColor = Color3.Black();
		clone.specularTexture = null;
		clone.opacityTexture = null;
		clone.reflectionTexture = null;
		clone.emissiveColor = encoded;
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRMaterial) {
		clone.unlit = true;
		clone.albedoColor = Color3.Black();
		clone.reflectivityTexture = null;
		clone.metallicTexture = null;
		clone.opacityTexture = null;
		clone.reflectionTexture = null;
		clone.environmentIntensity = 0;
		clone.emissiveColor = encoded;
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRMetallicRoughnessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.baseColor = Color3.Black();
		clone.emissiveColor = encoded;
		clone.emissiveTexture = null;
	} else if (clone instanceof PBRSpecularGlossinessMaterial) {
		clone.disableLighting = true;
		clone.environmentTexture = null;
		clone.diffuseColor = Color3.Black();
		clone.emissiveColor = encoded;
		clone.emissiveTexture = null;
	} else if (clone instanceof OpenPBRMaterial) {
		clone.unlit = true;
		clone.baseColor = Color3.Black();
		clone.baseWeight = 0;
		clone.emissionColor = encoded;
		clone.emissionLuminance = 1;
		clone.emissionColorTexture = null;
	} else {
		clone.dispose(false, false);
		throw new Error(`Material "${source.name}" (${source.getClassName()}) has no deferred Decal Layer adapter.`);
	}
	return clone;
}

function shadowLightData(light: Light): { position: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } {
	const value = light as Light & {
		getAbsolutePosition?: () => { x: number; y: number; z: number };
		getShadowDirection?: () => { x: number; y: number; z: number };
		direction?: { x: number; y: number; z: number };
		position?: { x: number; y: number; z: number };
	};
	return {
		position: value.getAbsolutePosition?.() ?? value.position ?? { x: 0, y: 0, z: 0 },
		direction: value.getShadowDirection?.() ?? value.direction ?? { x: 0, y: 1, z: 0 },
	};
}

function lightArrays(lights: Light[]): [number[], number[], number[], number[], number[]] {
	const arrays: [number[], number[], number[], number[], number[]] = [[], [], [], [], []];
	for (let index = 0; index < deferredLightingMaximumLights; index++) {
		const light = lights[index];
		if (!light) {
			for (const array of arrays) {
				array.push(0, 0, 0, 0);
			}
			continue;
		}
		const type = light.getTypeID();
		const shadow = shadowLightData(light);
		const spot = light as Light & { angle?: number; exponent?: number };
		const hemi = light as Light & { direction?: { x: number; y: number; z: number }; groundColor?: Color3 };
		const range = Number.isFinite(light.range) && light.range > 0 ? light.range : 1_000_000;
		if (isAreaLight(light)) {
			const metadata = getAreaLightMetadata(light);
			const basis = getAreaLightBasis(light);
			arrays[0].push(type, light.intensity, range, metadata.shape === "disc" ? 1 : 0);
			arrays[1].push(basis.position.x, basis.position.y, basis.position.z, 0);
			arrays[2].push(basis.halfWidth.x, basis.halfWidth.y, basis.halfWidth.z, 0);
			arrays[3].push(light.diffuse.r, light.diffuse.g, light.diffuse.b, 0);
			arrays[4].push(basis.halfHeight.x, basis.halfHeight.y, basis.halfHeight.z, 0);
			continue;
		}
		arrays[0].push(type, light.intensity, range, type === 2 ? Math.cos((spot.angle ?? Math.PI / 2) * 0.5) : 0);
		arrays[1].push(shadow.position.x, shadow.position.y, shadow.position.z, spot.exponent ?? 1);
		const direction = type === 3 ? (hemi.direction ?? shadow.direction) : shadow.direction;
		arrays[2].push(direction.x, direction.y, direction.z, 0);
		arrays[3].push(light.diffuse.r, light.diffuse.g, light.diffuse.b, 0);
		arrays[4].push(hemi.groundColor?.r ?? 0, hemi.groundColor?.g ?? 0, hemi.groundColor?.b ?? 0, 0);
	}
	return arrays;
}

function projectorUniformNames(sources: IDeferredDecalSource[]): string[] {
	return sources.flatMap((_source, index) => [
		`decalProjectorWorldToLocal${index}`,
		`decalProjectorNormalToWorld${index}`,
		`decalProjectorColor${index}`,
		`decalProjectorUv${index}`,
		`decalProjectorMaterial${index}`,
		`decalProjectorEmissive${index}`,
		`decalProjectorLayerMask${index}`,
		`decalProjectorEdgeFade${index}`,
	]);
}

function projectorSamplerNames(sources: IDeferredDecalSource[]): string[] {
	return [
		...sources.flatMap((source, index) => [
			...(source.albedoTexture ? [`decalProjectorAlbedoSampler${index}`] : []),
			...(source.channels.normal && source.normalTexture ? [`decalProjectorNormalSampler${index}`] : []),
			...(source.channels.metallic && source.reflectivityTexture ? [`decalProjectorReflectivitySampler${index}`] : []),
			...(source.channels.ambientOcclusion && source.ambientOcclusionTexture ? [`decalProjectorAmbientOcclusionSampler${index}`] : []),
			...(source.channels.emissive && source.emissiveTexture ? [`decalProjectorEmissiveSampler${index}`] : []),
		]),
		...(sources.some((source) => source.decalLayerMask !== 0xffffffff) ? ["decalLayerMaskSampler"] : []),
	];
}

function maskBytes(mask: number): [number, number, number, number] {
	const value = mask >>> 0;
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function applyProjectorUniforms(effect: Effect, sources: IDeferredDecalSource[], decalLayerTarget: RenderTargetTexture | null): void {
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index];
		effect.setMatrix(`decalProjectorWorldToLocal${index}`, source.worldToLocal!);
		effect.setMatrix(`decalProjectorNormalToWorld${index}`, source.normalToWorld!);
		effect.setFloat4(`decalProjectorColor${index}`, source.albedoColor.r, source.albedoColor.g, source.albedoColor.b, source.opacity);
		effect.setFloat4(`decalProjectorUv${index}`, source.uvScale[0], source.uvScale[1], source.uvOffset[0], source.uvOffset[1]);
		const normalTexture = source.normalTexture as (BaseTexture & { invertY?: boolean }) | null;
		effect.setFloat4(`decalProjectorMaterial${index}`, source.normalStrength * (normalTexture?.invertY ? -1 : 1), source.metallic, source.smoothness, source.ambientOcclusion);
		effect.setFloat4(`decalProjectorEmissive${index}`, source.emissiveColor.r, source.emissiveColor.g, source.emissiveColor.b, source.emissiveIntensity);
		const bytes = maskBytes(source.decalLayerMask);
		effect.setFloat4(`decalProjectorLayerMask${index}`, bytes[0], bytes[1], bytes[2], bytes[3]);
		effect.setFloat(`decalProjectorEdgeFade${index}`, source.edgeFade);
		if (source.albedoTexture) {
			effect.setTexture(`decalProjectorAlbedoSampler${index}`, source.albedoTexture);
		}
		if (source.channels.normal && source.normalTexture) {
			effect.setTexture(`decalProjectorNormalSampler${index}`, source.normalTexture);
		}
		if (source.channels.metallic && source.reflectivityTexture) {
			effect.setTexture(`decalProjectorReflectivitySampler${index}`, source.reflectivityTexture);
		}
		if (source.channels.ambientOcclusion && source.ambientOcclusionTexture) {
			effect.setTexture(`decalProjectorAmbientOcclusionSampler${index}`, source.ambientOcclusionTexture);
		}
		if (source.channels.emissive && source.emissiveTexture) {
			effect.setTexture(`decalProjectorEmissiveSampler${index}`, source.emissiveTexture);
		}
	}
	if (sources.some((source) => source.decalLayerMask !== 0xffffffff) && decalLayerTarget) {
		effect.setTexture("decalLayerMaskSampler", decalLayerTarget);
	}
}

function cookieUniformNames(sources: IDeferredCookieSource[]): string[] {
	return sources.flatMap((source, index) =>
		source.evidence.kind === "point-cube"
			? [`lightCookieIntensity${index}`, `lightCookiePosition${index}`]
			: source.evidence.kind === "directional-2d"
				? [`lightCookieIntensity${index}`, `lightCookieRight${index}`, `lightCookieUp${index}`, `lightCookieScaleOffset${index}`]
				: [`lightCookieIntensity${index}`, `lightCookieMatrix${index}`]
	);
}

function cookieSamplerNames(sources: IDeferredCookieSource[]): string[] {
	return sources.map((source, index) => (source.evidence.kind === "point-cube" ? `lightCookieCube${index}` : `lightCookie2D${index}`));
}

function applyCookieUniforms(effect: Effect, sources: IDeferredCookieSource[]): void {
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index];
		const metadata = getLightCookieMetadata(source.light)!;
		effect.setFloat(`lightCookieIntensity${index}`, metadata.intensity);
		if (source.evidence.kind === "point-cube") {
			const position = shadowLightData(source.light).position;
			effect.setTexture(`lightCookieCube${index}`, source.texture);
			effect.setFloat3(`lightCookiePosition${index}`, position.x, position.y, position.z);
			continue;
		}
		effect.setTexture(`lightCookie2D${index}`, source.texture);
		if (source.evidence.kind === "spot-2d") {
			const spot = source.light as Light & {
				_projectionTextureViewLightDirty: boolean;
				_projectionTextureProjectionLightDirty: boolean;
				_projectionTextureDirty: boolean;
				_computeProjectionTextureViewLightMatrix: () => void;
				_computeProjectionTextureProjectionLightMatrix: () => void;
				_computeProjectionTextureMatrix: () => void;
				projectionTextureMatrix: Matrix;
			};
			if (spot._projectionTextureViewLightDirty) {
				spot._computeProjectionTextureViewLightMatrix();
			}
			if (spot._projectionTextureProjectionLightDirty) {
				spot._computeProjectionTextureProjectionLightMatrix();
			}
			if (spot._projectionTextureDirty) {
				spot._computeProjectionTextureMatrix();
			}
			effect.setMatrix(`lightCookieMatrix${index}`, spot.projectionTextureMatrix);
			continue;
		}
		const directionData = shadowLightData(source.light).direction;
		const direction = new Vector3(directionData.x, directionData.y, directionData.z).normalize();
		let up = Vector3.FromArray(metadata.upDirection).normalize();
		let right = Vector3.Cross(up, direction);
		if (right.lengthSquared() < 0.000001) {
			up = Math.abs(direction.y) < 0.999 ? Vector3.Up() : Vector3.Right();
			right = Vector3.Cross(up, direction);
		}
		right.normalize();
		up = Vector3.Cross(direction, right).normalize();
		effect.setVector3(`lightCookieRight${index}`, right);
		effect.setVector3(`lightCookieUp${index}`, up);
		effect.setFloat4(`lightCookieScaleOffset${index}`, 1 / metadata.size[0], 1 / metadata.size[1], 0.5 + metadata.offset[0], 0.5 + metadata.offset[1]);
	}
}

function shadowUniformNames(sources: IDeferredShadowSource[]): string[] {
	return sources.flatMap(({ mode }, index) => {
		const suffix = index.toString();
		const common = [`shadowLightIndex${suffix}`, `shadowDarkness${suffix}`];
		if (isClassicShadowMode(mode)) {
			return [
				...common,
				`shadowMatrix${suffix}`,
				`shadowDepthValues${suffix}`,
				`shadowMapSize${suffix}`,
				`shadowMapSizeInverse${suffix}`,
				`shadowBlurScale${suffix}`,
				`shadowDepthScale${suffix}`,
				`shadowLightSizeUV${suffix}`,
				`shadowFilteringQuality${suffix}`,
				`shadowFrustumEdgeFalloff${suffix}`,
			];
		}
		if (isPointShadowMode(mode)) {
			return [
				...common,
				`shadowLightPosition${suffix}`,
				`shadowDepthValues${suffix}`,
				`shadowMapSizeInverse${suffix}`,
				`shadowBlurScale${suffix}`,
				`shadowDepthScale${suffix}`,
			];
		}
		return [
			...common,
			`shadowCascadeMatrices${suffix}`,
			`shadowCascadeFrustumZ${suffix}`,
			`shadowCascadeFrustumLength${suffix}`,
			`shadowCascadeLightSizeUVCorrection${suffix}`,
			`shadowCascadeDepthCorrection${suffix}`,
			`shadowCascadeCount${suffix}`,
			`shadowCascadeBlendFactor${suffix}`,
			`shadowDepthValues${suffix}`,
			`shadowMapSize${suffix}`,
			`shadowMapSizeInverse${suffix}`,
			`shadowLightSizeUV${suffix}`,
			`shadowFilteringQuality${suffix}`,
			`shadowPenumbraDarkness${suffix}`,
			`shadowFrustumEdgeFalloff${suffix}`,
		];
	});
}

function shadowSamplerNames(sources: IDeferredShadowSource[]): string[] {
	if (!sources.length) {
		return [];
	}
	return [
		"shadowReceiverSampler",
		...sources.flatMap(({ mode }, index) => {
			const suffix = index.toString();
			if (isClassicShadowMode(mode)) {
				return [
					isDepthComparisonShadowMode(mode) ? `shadowSampler${suffix}` : `shadowColorSampler${suffix}`,
					...(isPcssShadowMode(mode) ? [`shadowDepthSampler${suffix}`] : []),
				];
			}
			if (isPointShadowMode(mode)) {
				return [`shadowCubeSampler${suffix}`];
			}
			return [
				isDepthComparisonShadowMode(mode) ? `shadowCascadeSampler${suffix}` : `shadowCascadeColorSampler${suffix}`,
				...(isPcssShadowMode(mode) ? [`shadowCascadeDepthSampler${suffix}`] : []),
			];
		}),
	];
}

function applyShadowUniforms(effect: Effect, sources: IDeferredShadowSource[], currentLights: Light[], camera: Camera, shadowReceiverTarget: RenderTargetTexture): void {
	effect.setTexture("shadowReceiverSampler", shadowReceiverTarget);
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index];
		const suffix = index.toString();
		const generator = source.generator;
		const shadowMap = generator.getShadowMapForRendering()!;
		const shadowMapSize = generator.getShadowMap()?.getSize().width ?? shadowMap.getSize().width;
		const shadowLight = source.light as Light & { getDepthMinZ: (camera: Camera) => number; getDepthMaxZ: (camera: Camera) => number };
		const minimumDepth = shadowLight.getDepthMinZ(camera);
		effect.setFloat(`shadowLightIndex${suffix}`, currentLights.indexOf(source.light));
		effect.setFloat(`shadowDarkness${suffix}`, generator.getDarkness());
		if (isClassicShadowMode(source.mode)) {
			if (isDepthComparisonShadowMode(source.mode)) {
				effect.setDepthStencilTexture(`shadowSampler${suffix}`, shadowMap);
				if (isPcssShadowMode(source.mode)) {
					effect.setTexture(`shadowDepthSampler${suffix}`, shadowMap);
				}
			} else {
				effect.setTexture(`shadowColorSampler${suffix}`, shadowMap);
			}
			effect.setMatrix(`shadowMatrix${suffix}`, generator.getTransformMatrix());
			effect.setFloat2(`shadowDepthValues${suffix}`, minimumDepth, minimumDepth + shadowLight.getDepthMaxZ(camera));
			effect.setFloat(`shadowMapSize${suffix}`, shadowMapSize);
			effect.setFloat(`shadowMapSizeInverse${suffix}`, 1 / shadowMapSize);
			effect.setFloat(`shadowBlurScale${suffix}`, generator.blurScale);
			effect.setFloat(`shadowDepthScale${suffix}`, generator.depthScale);
			effect.setFloat(`shadowLightSizeUV${suffix}`, generator.contactHardeningLightSizeUVRatio * shadowMapSize);
			effect.setFloat(`shadowFilteringQuality${suffix}`, shadowFilteringQualityIndex(generator));
			effect.setFloat(`shadowFrustumEdgeFalloff${suffix}`, generator.frustumEdgeFalloff);
			continue;
		}
		if (isPointShadowMode(source.mode)) {
			const lightData = shadowLightData(source.light);
			effect.setTexture(`shadowCubeSampler${suffix}`, shadowMap);
			effect.setFloat3(`shadowLightPosition${suffix}`, lightData.position.x, lightData.position.y, lightData.position.z);
			effect.setFloat2(`shadowDepthValues${suffix}`, minimumDepth, minimumDepth + shadowLight.getDepthMaxZ(camera));
			effect.setFloat(`shadowMapSizeInverse${suffix}`, 1 / shadowMapSize);
			effect.setFloat(`shadowBlurScale${suffix}`, generator.blurScale);
			effect.setFloat(`shadowDepthScale${suffix}`, generator.depthScale);
			continue;
		}
		const cascaded = generator as unknown as {
			getCascadeTransformMatrix: (index: number) => Matrix | null;
			getCascadeMinExtents: (index: number) => { x: number; y: number; z: number } | null;
			getCascadeMaxExtents: (index: number) => { x: number; y: number; z: number } | null;
			numCascades: number;
			cascadeBlendPercentage: number;
			frustumEdgeFalloff: number;
			penumbraDarkness: number;
			_viewSpaceFrustumsZ: number[];
			_frustumLengths: number[];
		};
		const matrices = new Float32Array(deferredLightingMaximumCascades * 16);
		const lightSizeCorrections = new Array<number>(deferredLightingMaximumCascades * 2).fill(1);
		const depthCorrections = new Array<number>(deferredLightingMaximumCascades).fill(1);
		const firstMin = cascaded.getCascadeMinExtents(0);
		const firstMax = cascaded.getCascadeMaxExtents(0);
		for (let cascadeIndex = 0; cascadeIndex < deferredLightingMaximumCascades; cascadeIndex++) {
			(cascaded.getCascadeTransformMatrix(cascadeIndex) ?? Matrix.Identity()).copyToArray(matrices, cascadeIndex * 16);
			const minimum = cascaded.getCascadeMinExtents(cascadeIndex);
			const maximum = cascaded.getCascadeMaxExtents(cascadeIndex);
			if (cascadeIndex > 0 && firstMin && firstMax && minimum && maximum) {
				lightSizeCorrections[cascadeIndex * 2] = (firstMax.x - firstMin.x) / Math.max(maximum.x - minimum.x, 0.00001);
				lightSizeCorrections[cascadeIndex * 2 + 1] = (firstMax.y - firstMin.y) / Math.max(maximum.y - minimum.y, 0.00001);
				depthCorrections[cascadeIndex] = (maximum.z - minimum.z) / Math.max(firstMax.z - firstMin.z, 0.00001);
			}
		}
		if (isDepthComparisonShadowMode(source.mode)) {
			effect.setDepthStencilTexture(`shadowCascadeSampler${suffix}`, shadowMap);
			if (isPcssShadowMode(source.mode)) {
				effect.setTexture(`shadowCascadeDepthSampler${suffix}`, shadowMap);
			}
		} else {
			effect.setTexture(`shadowCascadeColorSampler${suffix}`, shadowMap);
		}
		effect.setMatrices(`shadowCascadeMatrices${suffix}`, matrices);
		effect.setArray(`shadowCascadeFrustumZ${suffix}`, cascaded._viewSpaceFrustumsZ);
		effect.setArray(`shadowCascadeFrustumLength${suffix}`, cascaded._frustumLengths);
		effect.setArray2(`shadowCascadeLightSizeUVCorrection${suffix}`, lightSizeCorrections);
		effect.setArray(`shadowCascadeDepthCorrection${suffix}`, depthCorrections);
		effect.setFloat(`shadowCascadeCount${suffix}`, cascaded.numCascades);
		effect.setFloat(`shadowCascadeBlendFactor${suffix}`, cascaded.cascadeBlendPercentage === 0 ? 10_000 : 1 / cascaded.cascadeBlendPercentage);
		effect.setFloat2(`shadowDepthValues${suffix}`, minimumDepth, minimumDepth + shadowLight.getDepthMaxZ(camera));
		effect.setFloat(`shadowMapSize${suffix}`, shadowMapSize);
		effect.setFloat(`shadowMapSizeInverse${suffix}`, 1 / shadowMapSize);
		effect.setFloat(`shadowLightSizeUV${suffix}`, generator.contactHardeningLightSizeUVRatio * shadowMapSize);
		effect.setFloat(`shadowFilteringQuality${suffix}`, shadowFilteringQualityIndex(generator));
		effect.setFloat(`shadowPenumbraDarkness${suffix}`, cascaded.penumbraDarkness);
		effect.setFloat(`shadowFrustumEdgeFalloff${suffix}`, cascaded.frustumEdgeFalloff);
	}
}

function createIblEffectWrapper(state: IDeferredLightingState): EffectWrapper {
	const engine = state.scene.getEngine();
	const projectorSources = state.decalSources.filter((source) => source.projectionMode === "screen-space-volume");
	const wrapper = new EffectWrapper({
		engine,
		name: "Babylon Editor Deferred IBL",
		fragmentShader: engine.isWebGPU ? deferredIblFragmentShaderWGSL(projectorSources) : deferredIblFragmentShaderGLSL(projectorSources),
		uniformNames: [
			"cameraViewport",
			"inverseView",
			"iblReflectionMatrix",
			"cameraPosition",
			"iblBoxPosition",
			"iblBoxSize",
			"normalUnsigned",
			"iblSourceCode",
			"iblSourceKind",
			"iblProbeSlot",
			"iblProbeCount",
			"iblProbeData0",
			"iblProbeData1",
			"iblSourceIntensity",
			"iblMaximumLod",
			"iblLodScale",
			"iblLodOffset",
			"iblGammaSpace",
			"iblRgbd",
			"iblOppositeZ",
			"iblInvertY",
			"iblBoxProjection",
			"iblHasSphericalPolynomial",
			"iblSphericalX",
			"iblSphericalY",
			"iblSphericalZ",
			"iblSphericalXX_ZZ",
			"iblSphericalYY_ZZ",
			"iblSphericalZZ",
			"iblSphericalXY",
			"iblSphericalYZ",
			"iblSphericalZX",
			...projectorUniformNames(projectorSources),
		],
		samplerNames: ["positionSampler", "normalSampler", "reflectivitySampler", "albedoSampler", "iblSelectorSampler", "iblSampler", ...projectorSamplerNames(projectorSources)],
		shaderLanguage: engine.isWebGPU ? 1 : 0,
	});
	wrapper.onApplyObservable.add(() => {
		const source = state.activeIblSource;
		if (!source || !state.iblSelectorTarget) {
			return;
		}
		const effect = wrapper.effect;
		const gbuffer = state.geometryBuffer.getGBuffer();
		const positionIndex = state.geometryBuffer.getTextureIndex(GeometryBufferRenderer.POSITION_TEXTURE_TYPE);
		const normalIndex = state.geometryBuffer.getTextureIndex(GeometryBufferRenderer.NORMAL_TEXTURE_TYPE);
		const reflectivityIndex = state.geometryBuffer.getTextureIndex(GeometryBufferRenderer.REFLECTIVITY_TEXTURE_TYPE);
		const texture = source.texture as BaseTexture & {
			boundingBoxPosition?: Vector3;
			boundingBoxSize?: Vector3;
			sphericalPolynomial?: {
				x: Vector3;
				y: Vector3;
				z: Vector3;
				xx: Vector3;
				yy: Vector3;
				zz: Vector3;
				xy: Vector3;
				yz: Vector3;
				zx: Vector3;
			} | null;
		};
		const polynomial = texture.sphericalPolynomial;
		const zero = Vector3.Zero();
		const metadata = probeMetadata(source.probe);
		const boxProjection = metadata.boxProjection;
		const probeSources = state.iblSources.filter((candidate) => candidate.probeSlot !== null).sort((left, right) => left.probeSlot! - right.probeSlot!);
		const probeData0 = new Array<number>(deferredLightingMaximumIblSources * 4).fill(0);
		const probeData1 = new Array<number>(deferredLightingMaximumIblSources * 4).fill(0);
		for (const probeSource of probeSources) {
			const slot = probeSource.probeSlot!;
			const probeSourceMetadata = probeMetadata(probeSource.probe);
			probeData0.splice(slot * 4, 4, ...probeSourceMetadata.boxPosition.asArray(), probeSourceMetadata.blendDistance);
			probeData1.splice(slot * 4, 4, ...probeSourceMetadata.boxSize.asArray(), probeSourceMetadata.importance);
		}
		const cameraPosition = state.camera.globalPosition ?? state.camera.position;
		effect.setTexture("positionSampler", gbuffer.textures[positionIndex]);
		effect.setTexture("normalSampler", gbuffer.textures[normalIndex]);
		effect.setTexture("reflectivitySampler", gbuffer.textures[reflectivityIndex]);
		effect.setTexture("albedoSampler", state.albedoTarget);
		effect.setTexture("iblSelectorSampler", state.iblSelectorTarget);
		effect.setTexture("iblSampler", texture);
		effect.setFloat4("cameraViewport", state.camera.viewport.x, state.camera.viewport.y, state.camera.viewport.width, state.camera.viewport.height);
		effect.setMatrix("inverseView", state.camera.getWorldMatrix());
		effect.setMatrix("iblReflectionMatrix", texture.getReflectionTextureMatrix());
		effect.setVector3("cameraPosition", cameraPosition);
		effect.setVector3("iblBoxPosition", boxProjection ? metadata.boxPosition : zero);
		effect.setVector3("iblBoxSize", boxProjection ? metadata.boxSize : Vector3.One());
		effect.setFloat("normalUnsigned", state.geometryBuffer.normalsAreUnsigned ? 1 : 0);
		effect.setFloat("iblSourceCode", source.index / 255);
		effect.setFloat("iblSourceKind", source.kind === "reflection-probe" ? 1 : 0);
		effect.setFloat("iblProbeSlot", source.probeSlot ?? -1);
		effect.setFloat("iblProbeCount", probeSources.length);
		effect.setArray4("iblProbeData0", probeData0);
		effect.setArray4("iblProbeData1", probeData1);
		effect.setFloat("iblSourceIntensity", source.intensity);
		effect.setFloat("iblMaximumLod", iblMaximumLod(texture));
		effect.setFloat("iblLodScale", texture.lodGenerationScale > 0 ? texture.lodGenerationScale : 1);
		effect.setFloat("iblLodOffset", texture.lodGenerationOffset);
		effect.setFloat("iblGammaSpace", texture.gammaSpace ? 1 : 0);
		effect.setFloat("iblRgbd", texture.isRGBD ? 1 : 0);
		effect.setFloat("iblOppositeZ", state.scene.useRightHandedSystem ? (texture.invertZ ? 0 : 1) : texture.invertZ ? 1 : 0);
		effect.setFloat("iblInvertY", texture.coordinatesMode === Texture.INVCUBIC_MODE ? 1 : 0);
		effect.setFloat("iblBoxProjection", boxProjection ? 1 : 0);
		effect.setFloat("iblHasSphericalPolynomial", polynomial ? 1 : 0);
		effect.setVector3("iblSphericalX", polynomial?.x ?? zero);
		effect.setVector3("iblSphericalY", polynomial?.y ?? zero);
		effect.setVector3("iblSphericalZ", polynomial?.z ?? zero);
		effect.setVector3("iblSphericalXX_ZZ", polynomial ? polynomial.xx.subtract(polynomial.zz) : zero);
		effect.setVector3("iblSphericalYY_ZZ", polynomial ? polynomial.yy.subtract(polynomial.zz) : zero);
		effect.setVector3("iblSphericalZZ", polynomial?.zz ?? zero);
		effect.setVector3("iblSphericalXY", polynomial?.xy ?? zero);
		effect.setVector3("iblSphericalYZ", polynomial?.yz ?? zero);
		effect.setVector3("iblSphericalZX", polynomial?.zx ?? zero);
		applyProjectorUniforms(effect, projectorSources, state.decalLayerTarget);
	});
	return wrapper;
}

function updateEvidence(state: IDeferredLightingState): IDeferredLightingRuntimeEvidence {
	const geometry = getGeometryBufferLeaseEvidence(state.scene);
	const albedoSize = state.albedoTarget.getSize();
	const emissiveSize = state.emissiveTarget?.getSize();
	const compilationError = state.effectWrapper.effect.getCompilationError();
	const compatibility = inspectDeferredLightingCompatibility(state.scene, state.camera);
	const currentEmissiveSignature = emissiveSignature(compatibility.emissiveSources);
	const emissiveSourcesChanged = currentEmissiveSignature !== state.emissiveSignature;
	const currentDecalSignature = decalSignature(compatibility.decalSources);
	const decalSourcesChanged = currentDecalSignature !== state.decalSignature;
	const currentIblSignature = iblSignature(compatibility.iblSources);
	const iblSourcesChanged = currentIblSignature !== state.iblSignature;
	const currentCookieSignature = cookieSignature(compatibility.cookieSources);
	const cookieSourcesChanged = currentCookieSignature !== state.cookieSignature;
	const currentAreaLightSignature = areaLightSignature(compatibility.lights);
	const areaLightsChanged = currentAreaLightSignature !== state.areaLightSignature;
	const decalLayerSize = state.decalLayerTarget?.getSize();
	const iblSelectorSize = state.iblSelectorTarget?.getSize();
	const iblCompilationError = state.iblEffectWrapper?.effect.getCompilationError();
	const currentMeshIds = compatibility.meshes.map((mesh) => mesh.uniqueId.toString()).sort();
	const renderListChanged = currentMeshIds.length !== state.meshIds.length || currentMeshIds.some((id, index) => id !== state.meshIds[index]);
	const shadowGeneratorsChanged =
		compatibility.shadowSources.length !== state.shadowSources.length ||
		compatibility.shadowSources.some((source, index) => source.generator !== state.shadowSources[index]?.generator || source.light !== state.shadowSources[index]?.light);
	const shadowModesChanged = !shadowGeneratorsChanged && compatibility.shadowSources.some((source, index) => source.mode !== state.shadowSources[index]?.mode);
	const shadowMapsReady = compatibility.shadowSources.every((source) => Boolean(source.generator.getShadowMapForRendering()?.isReadyForRendering()));
	if (state.shadowReceiverTarget && !shadowGeneratorsChanged) {
		state.shadowReceiverTarget.renderList = compatibility.shadowReceiverMeshes;
		for (const mesh of compatibility.shadowReceiverMeshes) {
			state.shadowReceiverTarget.setMaterialForRendering(mesh, state.shadowReceiverMaterial!);
		}
	}
	state.runtime.geometryBufferReady = geometry.ready;
	state.runtime.configuredCameraCount = state.manager.states.size;
	state.runtime.sharedGeometryBufferHolderCount = geometry.holderCount;
	applyCameraEvidence(state.runtime, state.camera);
	state.runtime.geometryBufferWidth = geometry.width;
	state.runtime.geometryBufferHeight = geometry.height;
	state.runtime.geometryBufferTextureCount = geometry.textureCount;
	state.runtime.albedoReady = state.albedoTarget.isReadyForRendering();
	state.runtime.albedoWidth = albedoSize.width;
	state.runtime.albedoHeight = albedoSize.height;
	state.runtime.emissiveActive = state.emissiveSources.length > 0;
	state.runtime.emissiveReady =
		!state.runtime.emissiveActive ||
		(Boolean(state.emissiveTarget?.isReadyForRendering()) && state.emissiveSources.every((source) => source.texture?.isReadyOrNotBlocking() ?? true));
	state.runtime.emissiveWidth = emissiveSize?.width ?? 0;
	state.runtime.emissiveHeight = emissiveSize?.height ?? 0;
	state.runtime.emissiveMeshCount = state.emissiveSources.reduce((count, source) => count + source.meshes.length, 0);
	state.runtime.emissiveMaterialCount = state.emissiveSources.length;
	state.runtime.emissiveTextureCount = new Set(state.emissiveSources.map((source) => source.texture?.uniqueId).filter((id): id is number => id !== undefined)).size;
	state.runtime.emissiveEvidenceTruncated = state.emissiveSources.length > deferredLightingMaximumEmissiveSources;
	state.runtime.emissiveSources = state.emissiveSources.slice(0, deferredLightingMaximumEmissiveSources).map(emissiveSourceEvidence);
	applyDecalEvidence(state.runtime, state.decalSources);
	state.runtime.decalLayerTargetReady = Boolean(state.decalLayerTarget?.isReadyForRendering());
	state.runtime.decalLayerTargetWidth = decalLayerSize?.width ?? 0;
	state.runtime.decalLayerTargetHeight = decalLayerSize?.height ?? 0;
	state.runtime.decalReady =
		!state.runtime.decalActive ||
		(state.decalSources.every(
			(source) =>
				(source.projectionMode === "screen-space-volume" || (Boolean(source.mesh.geometry) && source.mesh.getTotalVertices() > 0 && source.mesh.getTotalIndices() > 0)) &&
				source.textures.every((texture) => texture.isReadyOrNotBlocking())
		) &&
			(!state.runtime.decalLayerFilteredProjectorCount || state.runtime.decalLayerTargetReady));
	state.runtime.iblActive = state.iblSources.length > 0;
	state.runtime.iblSelectorReady = Boolean(state.iblSelectorTarget?.isReadyForRendering());
	state.runtime.iblSelectorWidth = iblSelectorSize?.width ?? 0;
	state.runtime.iblSelectorHeight = iblSelectorSize?.height ?? 0;
	state.runtime.iblSourceCount = state.iblSources.length;
	state.runtime.iblEnvironmentTextureName = state.iblSources.find((source) => source.kind === "environment")?.texture.name ?? null;
	state.runtime.iblReflectionProbeNames = state.iblSources.filter((source) => source.kind === "reflection-probe").map((source) => source.name);
	state.runtime.iblReflectionProbeCount = state.runtime.iblReflectionProbeNames.length;
	state.runtime.iblProbeBlendingActive = state.runtime.iblReflectionProbeCount > 0;
	state.runtime.iblProbeBlendMeshCount = iblProbeBlendMeshCount(state.iblSources);
	state.runtime.iblSources = state.iblSources.map(iblSourceEvidence);
	state.runtime.iblReady =
		!state.runtime.iblActive ||
		(Boolean(state.iblSelectorTarget?.isReadyForRendering()) &&
			Boolean(state.iblEffectWrapper?.isReady()) &&
			state.iblSources.every((source) => source.texture.isReadyOrNotBlocking()));
	state.runtime.lightCount = compatibility.lights.length;
	state.runtime.cookieActive = state.cookieSources.length > 0;
	state.runtime.cookieCount = state.cookieSources.length;
	state.runtime.cookieSources = state.cookieSources.map((source) => getLightCookieEvidence(source.light) ?? source.evidence);
	state.runtime.cookieReady = !state.runtime.cookieActive || state.cookieSources.every((source) => source.texture.isReadyOrNotBlocking());
	state.runtime.areaLightActive = compatibility.areaLightSources.length > 0;
	state.runtime.areaLightCount = compatibility.areaLightSources.length;
	state.runtime.areaLightSources = compatibility.lights.filter(isAreaLight).map(getAreaLightEvidence);
	state.runtime.areaLightReady = !state.runtime.areaLightActive || areaLightLtcReady(state.scene);
	applyShadowEvidence(state.runtime, compatibility, state.scene);
	state.runtime.forwardMeshCount = compatibility.forwardMeshes.length;
	state.runtime.transparentMeshCount = compatibility.transparentMeshCount;
	state.runtime.backgroundMeshCount = compatibility.backgroundMeshCount;
	state.runtime.laterRenderingGroupMeshCount = compatibility.laterRenderingGroupMeshCount;
	state.runtime.particleSystemCount = compatibility.particleSystemCount;
	state.runtime.spriteManagerCount = compatibility.spriteManagerCount;
	state.runtime.layerCount = compatibility.layerCount;
	state.runtime.compositionMode =
		compatibility.forwardMeshes.length || compatibility.particleSystemCount || compatibility.spriteManagerCount || compatibility.layerCount
			? "hybrid-forward"
			: "deferred-only";
	state.runtime.warnings = compatibility.warnings;
	state.runtime.errors = [
		...compatibility.errors,
		...(!state.camera.customRenderTargets.includes(state.geometryBuffer.getGBuffer())
			? ["The camera-specific shared G-buffer render target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(!state.scene.customRenderTargets.includes(state.albedoTarget)
			? ["The camera-specific deferred albedo target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(state.emissiveTarget && !state.scene.customRenderTargets.includes(state.emissiveTarget)
			? ["The camera-specific deferred emissive target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(state.decalLayerTarget && !state.scene.customRenderTargets.includes(state.decalLayerTarget)
			? ["The camera-specific deferred Decal Layer target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(state.runtime.decalLayerFilteredProjectorCount && !state.decalLayerTarget
			? ["A filtered screen-space decal projector requires the camera-specific 32-bit Decal Layer target; rebuild the deferred runtime."]
			: []),
		...(state.shadowReceiverTarget && !state.scene.customRenderTargets.includes(state.shadowReceiverTarget)
			? ["The camera-specific deferred shadow receiver target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(state.iblSelectorTarget && !state.scene.customRenderTargets.includes(state.iblSelectorTarget)
			? ["The camera-specific deferred IBL selector target was removed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(renderListChanged ? ["The set of deferred meshes changed; rebuild the deferred runtime before resolving another frame."] : []),
		...(emissiveSourcesChanged
			? ["The deferred emissive material color, texture, intensity, or mesh assignment changed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(decalSourcesChanged
			? [
					"A deferred decal projection, geometry, material channel, texture, opacity, or draw-order setting changed; rebuild the deferred runtime before resolving another frame.",
				]
			: []),
		...(iblSourcesChanged
			? ["The deferred IBL environment, probe assignment, probe settings, or intensity changed; rebuild the deferred runtime before resolving another frame."]
			: []),
		...(cookieSourcesChanged
			? [
					"A deferred light cookie texture, type, revision, intensity, projection size, offset, clip range, or up direction changed; rebuild the deferred runtime before resolving another frame.",
				]
			: []),
		...(areaLightsChanged
			? [
					"A deferred area-light shape, size, orientation, transform, intensity, range, color, or revision changed; rebuild the deferred runtime before resolving another frame.",
				]
			: []),
		...(shadowGeneratorsChanged
			? ["The active deferred shadow generator changed (source set or light assignment); rebuild the deferred runtime before resolving another frame."]
			: []),
		...(shadowModesChanged ? ["An active deferred shadow map type or filter changed; rebuild the deferred runtime before resolving another frame."] : []),
		...(state.manager.renderingGroup.onBeforeTransparentRendering !== state.manager.beforeTransparentRendering
			? ["The rendering-group deferred resolve callback was replaced; rebuild the deferred runtime to restore execution order."]
			: []),
		...(state.manager.renderingGroup._renderSprites !== state.manager.suppressedRenderSprites ||
		state.manager.renderingGroup._renderParticles !== state.manager.suppressedRenderParticles
			? ["The rendering-group sprite or particle stage was replaced; rebuild the deferred runtime to restore hybrid forward ordering."]
			: []),
		...(compilationError ? [`Deferred lighting shader compilation failed: ${compilationError}`] : []),
		...(iblCompilationError ? [`Deferred IBL shader compilation failed: ${iblCompilationError}`] : []),
	];
	state.runtime.ready =
		state.runtime.geometryBufferReady &&
		state.runtime.albedoReady &&
		state.runtime.emissiveReady &&
		state.runtime.decalReady &&
		state.runtime.iblReady &&
		state.runtime.cookieReady &&
		state.runtime.areaLightReady &&
		state.effectWrapper.isReady() &&
		(!state.shadowSources.length || (shadowMapsReady && Boolean(state.shadowReceiverTarget?.isReadyForRendering()))) &&
		!state.runtime.errors.length;
	state.runtime.active = state.runtime.configured && !state.runtime.errors.length;
	state.runtime.forwardCompositionReady = state.runtime.compositionMode === "hybrid-forward" && state.runtime.ready;
	setReport(state.scene, state.camera, state.runtime);
	return state.runtime;
}

function renderDeferredLighting(state: IDeferredLightingState): boolean {
	if (state.scene.activeCamera !== state.camera) {
		return false;
	}
	updateEvidence(state);
	if (!state.runtime.ready) {
		return false;
	}
	const engine = state.scene.getEngine();
	const alphaMode = engine.getAlphaMode();
	engine.setAlphaMode(Constants.ALPHA_COMBINE);
	try {
		state.effectRenderer.saveStates();
		state.effectRenderer.setViewport(state.camera.viewport);
		state.effectRenderer.applyEffectWrapper(state.effectWrapper);
		state.effectRenderer.draw();
		if (state.iblEffectWrapper && state.iblSources.length) {
			engine.setAlphaMode(Constants.ALPHA_ADD);
			for (const source of state.iblSources) {
				state.activeIblSource = source;
				state.effectRenderer.applyEffectWrapper(state.iblEffectWrapper);
				state.effectRenderer.draw();
			}
		}
	} finally {
		state.activeIblSource = null;
		state.effectRenderer.restoreStates();
		engine.setAlphaMode(alphaMode);
	}
	state.runtime.frameCount++;
	if (state.emissiveSources.length) {
		state.runtime.emissiveFrameCount++;
	}
	if (state.decalSources.length) {
		state.runtime.decalFrameCount++;
	}
	if (state.iblSources.length) {
		state.runtime.iblFrameCount++;
	}
	if (state.cookieSources.length) {
		state.runtime.cookieFrameCount++;
	}
	if (state.runtime.areaLightActive) {
		state.runtime.areaLightFrameCount++;
	}
	if (state.shadowSources.length && state.runtime.shadowMapReady) {
		state.runtime.shadowFrameCount++;
	}
	return true;
}

function suppressDeferredDecalForwardSubMeshes(state: IDeferredLightingState): number {
	const decalMeshes = new Set(state.decalSources.filter((source) => source.projectionMode === "geometry" && source.alphaMode === "alpha-blend").map((source) => source.mesh));
	if (!decalMeshes.size) {
		return 0;
	}
	const transparentSubMeshes = state.manager.renderingGroup._transparentSubMeshes;
	let writeIndex = 0;
	let suppressedCount = 0;
	for (let readIndex = 0; readIndex < transparentSubMeshes.length; readIndex++) {
		const subMesh = transparentSubMeshes.data[readIndex];
		if (decalMeshes.has(subMesh.getMesh())) {
			suppressedCount++;
			continue;
		}
		transparentSubMeshes.data[writeIndex++] = subMesh;
	}
	transparentSubMeshes.length = writeIndex;
	return suppressedCount;
}

function createSceneManager(scene: Scene): IDeferredLightingSceneManager {
	const existing = managers.get(scene);
	if (existing) {
		return existing;
	}
	const renderingManager = (scene as unknown as { _renderingManager: RenderingManager })._renderingManager;
	const renderingGroup = renderingManager.getRenderingGroup(0) as unknown as IDeferredRenderingGroup;
	const previousBeforeTransparentRendering = renderingGroup.onBeforeTransparentRendering;
	const previousRenderSprites = renderingGroup._renderSprites;
	const previousRenderParticles = renderingGroup._renderParticles;
	const hadOwnRenderSprites = Object.prototype.hasOwnProperty.call(renderingGroup, "_renderSprites");
	const hadOwnRenderParticles = Object.prototype.hasOwnProperty.call(renderingGroup, "_renderParticles");
	let manager: IDeferredLightingSceneManager;
	const suppressedRenderSprites = (): void => {
		if (!scene.activeCamera || !manager.states.has(scene.activeCamera)) {
			manager.previousRenderSprites.call(manager.renderingGroup);
		}
	};
	const suppressedRenderParticles = (activeMeshes: unknown): void => {
		if (!scene.activeCamera || !manager.states.has(scene.activeCamera)) {
			manager.previousRenderParticles.call(manager.renderingGroup, activeMeshes);
		}
	};
	const beforeTransparentRendering = (): void => {
		const state = scene.activeCamera ? manager.states.get(scene.activeCamera) : undefined;
		const resolved = state ? renderDeferredLighting(state) : false;
		if (state) {
			manager.previousRenderSprites.call(manager.renderingGroup);
			manager.previousRenderParticles.call(manager.renderingGroup, (scene as unknown as { _activeMeshes: unknown })._activeMeshes);
		}
		manager.previousBeforeTransparentRendering?.();
		if (state && resolved) {
			state.runtime.decalForwardSubMeshSuppressedCount = suppressDeferredDecalForwardSubMeshes(state);
			if (state.runtime.decalForwardSubMeshSuppressedCount) {
				state.runtime.decalForwardSuppressionFrameCount++;
			}
			if (state.runtime.compositionMode === "hybrid-forward") {
				state.runtime.forwardCompositionFrameCount++;
			}
			setReport(scene, state.camera, state.runtime);
		}
	};
	manager = {
		scene,
		states: new Map(),
		renderingGroup,
		previousBeforeTransparentRendering,
		beforeTransparentRendering,
		previousRenderSprites,
		previousRenderParticles,
		suppressedRenderSprites,
		suppressedRenderParticles,
		hadOwnRenderSprites,
		hadOwnRenderParticles,
		cameraRemovedObserver: null,
		disposeObserver: null,
	};
	renderingGroup._renderSprites = suppressedRenderSprites;
	renderingGroup._renderParticles = suppressedRenderParticles;
	renderingGroup.onBeforeTransparentRendering = beforeTransparentRendering;
	managers.set(scene, manager);
	manager.cameraRemovedObserver = scene.onCameraRemovedObservable.add((camera) => stopDeferredLighting(scene, camera));
	manager.disposeObserver = scene.onDisposeObservable.add(() => stopDeferredLighting(scene));
	return manager;
}

function disposeState(state: IDeferredLightingState): void {
	if (state.geometryBufferTargetAddedToCamera) {
		const geometryTarget = state.geometryBuffer.getGBuffer();
		const cameraTargetIndex = state.camera.customRenderTargets.indexOf(geometryTarget);
		if (cameraTargetIndex !== -1) {
			state.camera.customRenderTargets.splice(cameraTargetIndex, 1);
		}
	}
	const targetIndex = state.scene.customRenderTargets.indexOf(state.albedoTarget);
	if (targetIndex !== -1) {
		state.scene.customRenderTargets.splice(targetIndex, 1);
	}
	state.albedoTarget.dispose();
	for (const material of state.albedoMaterials) {
		material.dispose(false, false);
	}
	if (state.emissiveTarget) {
		const emissiveIndex = state.scene.customRenderTargets.indexOf(state.emissiveTarget);
		if (emissiveIndex !== -1) {
			state.scene.customRenderTargets.splice(emissiveIndex, 1);
		}
		state.emissiveTarget.dispose();
	}
	for (const material of state.emissiveMaterials) {
		material.dispose(false, false);
	}
	if (state.decalLayerTarget) {
		const decalLayerIndex = state.scene.customRenderTargets.indexOf(state.decalLayerTarget);
		if (decalLayerIndex !== -1) {
			state.scene.customRenderTargets.splice(decalLayerIndex, 1);
		}
		state.decalLayerTarget.dispose();
	}
	for (const material of state.decalLayerMaterials) {
		material.dispose(false, false);
	}
	if (state.iblSelectorTarget) {
		const iblSelectorIndex = state.scene.customRenderTargets.indexOf(state.iblSelectorTarget);
		if (iblSelectorIndex !== -1) {
			state.scene.customRenderTargets.splice(iblSelectorIndex, 1);
		}
		state.iblSelectorTarget.dispose();
	}
	for (const material of state.iblSelectorMaterials) {
		material.dispose(false, false);
	}
	if (state.shadowReceiverTarget) {
		const shadowReceiverIndex = state.scene.customRenderTargets.indexOf(state.shadowReceiverTarget);
		if (shadowReceiverIndex !== -1) {
			state.scene.customRenderTargets.splice(shadowReceiverIndex, 1);
		}
		state.shadowReceiverTarget.dispose();
	}
	state.shadowReceiverMaterial?.dispose(false, false);
	state.iblEffectWrapper?.dispose();
	state.effectWrapper.dispose();
	state.effectRenderer.dispose();
	releaseGeometryBufferLease(state.scene, state.geometryBufferLeaseHolder);
}

function restoreSceneManager(manager: IDeferredLightingSceneManager): void {
	if (manager.cameraRemovedObserver) {
		manager.scene.onCameraRemovedObservable.remove(manager.cameraRemovedObserver);
		manager.cameraRemovedObserver = null;
	}
	if (manager.disposeObserver) {
		manager.scene.onDisposeObservable.remove(manager.disposeObserver);
		manager.disposeObserver = null;
	}
	if (manager.renderingGroup.onBeforeTransparentRendering === manager.beforeTransparentRendering) {
		manager.renderingGroup.onBeforeTransparentRendering = manager.previousBeforeTransparentRendering;
	}
	if (manager.renderingGroup._renderSprites === manager.suppressedRenderSprites) {
		if (manager.hadOwnRenderSprites) {
			manager.renderingGroup._renderSprites = manager.previousRenderSprites;
		} else {
			delete (manager.renderingGroup as unknown as Record<string, unknown>)._renderSprites;
		}
	}
	if (manager.renderingGroup._renderParticles === manager.suppressedRenderParticles) {
		if (manager.hadOwnRenderParticles) {
			manager.renderingGroup._renderParticles = manager.previousRenderParticles;
		} else {
			delete (manager.renderingGroup as unknown as Record<string, unknown>)._renderParticles;
		}
	}
	managers.delete(manager.scene);
}

/** Restores one camera or every deferred camera while releasing shared scene resources only after the final camera. */
export function stopDeferredLighting(scene: Scene, camera?: Camera): IDeferredLightingRuntimeEvidence {
	const manager = managers.get(scene);
	if (!manager) {
		const report = inactive();
		if (camera) {
			applyCameraEvidence(report, camera);
			deleteReport(scene, camera);
		} else {
			reports.delete(scene);
		}
		return report;
	}
	const selectedStates = camera ? [manager.states.get(camera)].filter((state): state is IDeferredLightingState => Boolean(state)) : [...manager.states.values()];
	for (const state of selectedStates) {
		manager.states.delete(state.camera);
		disposeState(state);
		deleteReport(scene, state.camera);
	}
	if (!manager.states.size) {
		restoreSceneManager(manager);
	}
	const report = inactive();
	if (camera) {
		applyCameraEvidence(report, camera);
	}
	return report;
}

/** Configures the bounded native deferred direct-lighting path for one camera. */
export function configureDeferredLighting(scene: Scene, camera: Camera): IDeferredLightingRuntimeEvidence {
	stopDeferredLighting(scene, camera);
	const compatibility = inspectDeferredLightingCompatibility(scene, camera);
	if (compatibility.errors.length) {
		const report = inactive();
		applyCameraEvidence(report, camera);
		report.meshCount = compatibility.meshes.length;
		report.materialCount = compatibility.materials.length;
		report.lightCount = compatibility.lights.length;
		applyShadowEvidence(report, compatibility, scene);
		report.emissiveActive = compatibility.emissiveSources.length > 0;
		report.emissiveMeshCount = compatibility.emissiveSources.reduce((count, source) => count + source.meshes.length, 0);
		report.emissiveMaterialCount = compatibility.emissiveSources.length;
		report.emissiveTextureCount = new Set(compatibility.emissiveSources.map((source) => source.texture?.uniqueId).filter((id): id is number => id !== undefined)).size;
		report.emissiveEvidenceTruncated = compatibility.emissiveSources.length > deferredLightingMaximumEmissiveSources;
		report.emissiveSources = compatibility.emissiveSources.slice(0, deferredLightingMaximumEmissiveSources).map(emissiveSourceEvidence);
		applyDecalEvidence(report, compatibility.decalSources);
		applyCookieEvidence(report, compatibility.cookieSources);
		applyAreaLightEvidence(report, scene, compatibility.lights);
		report.forwardMeshCount = compatibility.forwardMeshes.length;
		report.transparentMeshCount = compatibility.transparentMeshCount;
		report.backgroundMeshCount = compatibility.backgroundMeshCount;
		report.laterRenderingGroupMeshCount = compatibility.laterRenderingGroupMeshCount;
		report.particleSystemCount = compatibility.particleSystemCount;
		report.spriteManagerCount = compatibility.spriteManagerCount;
		report.layerCount = compatibility.layerCount;
		report.compositionMode =
			compatibility.forwardMeshes.length || compatibility.particleSystemCount || compatibility.spriteManagerCount || compatibility.layerCount
				? "hybrid-forward"
				: "deferred-only";
		report.warnings = compatibility.warnings;
		report.errors = compatibility.errors;
		setReport(scene, camera, report);
		return structuredClone(report);
	}
	const holder = `deferred-lighting:${camera.uniqueId}`;
	let geometryBuffer: GeometryBufferRenderer | null = null;
	let albedoTarget: RenderTargetTexture | null = null;
	let emissiveTarget: RenderTargetTexture | null = null;
	let decalLayerTarget: RenderTargetTexture | null = null;
	let iblSelectorTarget: RenderTargetTexture | null = null;
	let shadowReceiverTarget: RenderTargetTexture | null = null;
	let shadowReceiverMaterial: StandardMaterial | null = null;
	let effectRenderer: EffectRenderer | null = null;
	let effectWrapper: EffectWrapper | null = null;
	let iblEffectWrapper: EffectWrapper | null = null;
	let manager: IDeferredLightingSceneManager | null = null;
	let geometryBufferTargetAddedToCamera = false;
	const albedoMaterials: Material[] = [];
	const emissiveMaterials: Material[] = [];
	const decalLayerMaterials: Material[] = [];
	const iblSelectorMaterials: Material[] = [];
	try {
		const projectorSources = compatibility.decalSources.filter((source) => source.projectionMode === "screen-space-volume");
		geometryBuffer = acquireGeometryBufferLease(scene, holder, {
			transparent: compatibility.decalSources.some((source) => source.projectionMode === "geometry" && source.alphaMode === "alpha-blend"),
			normal: true,
			position: true,
			reflectivity: true,
		});
		const geometryBufferTarget = geometryBuffer.getGBuffer();
		if (!camera.customRenderTargets.includes(geometryBufferTarget)) {
			camera.customRenderTargets.push(geometryBufferTarget);
			geometryBufferTargetAddedToCamera = true;
		}
		const positionIndex = geometryBuffer.getTextureIndex(GeometryBufferRenderer.POSITION_TEXTURE_TYPE);
		const normalIndex = geometryBuffer.getTextureIndex(GeometryBufferRenderer.NORMAL_TEXTURE_TYPE);
		const reflectivityIndex = geometryBuffer.getTextureIndex(GeometryBufferRenderer.REFLECTIVITY_TEXTURE_TYPE);
		if (positionIndex < 0 || normalIndex < 0 || reflectivityIndex < 0) {
			throw new Error("Babylon did not allocate the required position, normal, and reflectivity geometry-buffer attachments.");
		}
		const engine = scene.getEngine();
		albedoTarget = new RenderTargetTexture(
			"Babylon Editor Deferred Albedo",
			{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
			scene,
			false,
			true,
			engine.getCaps().textureHalfFloat && engine.getCaps().textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE
		);
		albedoTarget.activeCamera = camera;
		albedoTarget.renderParticles = false;
		albedoTarget.renderSprites = false;
		albedoTarget.ignoreCameraViewport = false;
		albedoTarget.clearColor = new Color4(0, 0, 0, 0);
		albedoTarget.gammaSpace = false;
		albedoTarget.renderList = compatibility.meshes;
		const materialMap = new Map<Material, Material>();
		for (const mesh of compatibility.meshes) {
			const source = mesh.material!;
			let albedo = materialMap.get(source);
			if (!albedo) {
				albedo = createAlbedoMaterial(source);
				materialMap.set(source, albedo);
				albedoMaterials.push(albedo);
			}
			albedoTarget.setMaterialForRendering(mesh, albedo);
		}
		albedoTarget.onBeforeRenderObservable.add(() => {
			const width = Math.max(1, engine.getRenderWidth());
			const height = Math.max(1, engine.getRenderHeight());
			const size = albedoTarget!.getSize();
			if (size.width !== width || size.height !== height) {
				albedoTarget!.resize({ width, height });
			}
		});
		scene.customRenderTargets.push(albedoTarget);
		if (projectorSources.some((source) => source.decalLayerMask !== 0xffffffff)) {
			decalLayerTarget = new RenderTargetTexture(
				"Babylon Editor Deferred Decal Layers",
				{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
				scene,
				false,
				true,
				Constants.TEXTURETYPE_UNSIGNED_BYTE
			);
			decalLayerTarget.activeCamera = camera;
			decalLayerTarget.renderParticles = false;
			decalLayerTarget.renderSprites = false;
			decalLayerTarget.ignoreCameraViewport = false;
			decalLayerTarget.clearColor = new Color4(0, 0, 0, 0);
			decalLayerTarget.gammaSpace = false;
			decalLayerTarget.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
			decalLayerTarget.renderList = compatibility.meshes;
			for (const mesh of compatibility.meshes) {
				const material = createDecalLayerMaterial(mesh.material!, mesh.layerMask);
				decalLayerMaterials.push(material);
				decalLayerTarget.setMaterialForRendering(mesh, material);
			}
			decalLayerTarget.onBeforeRenderObservable.add(() => {
				const width = Math.max(1, engine.getRenderWidth());
				const height = Math.max(1, engine.getRenderHeight());
				const size = decalLayerTarget!.getSize();
				if (size.width !== width || size.height !== height) {
					decalLayerTarget!.resize({ width, height });
				}
			});
			scene.customRenderTargets.push(decalLayerTarget);
		}
		if (compatibility.emissiveSources.length) {
			emissiveTarget = new RenderTargetTexture(
				"Babylon Editor Deferred Emissive",
				{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
				scene,
				false,
				true,
				engine.getCaps().textureHalfFloat && engine.getCaps().textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE
			);
			emissiveTarget.activeCamera = camera;
			emissiveTarget.renderParticles = false;
			emissiveTarget.renderSprites = false;
			emissiveTarget.ignoreCameraViewport = false;
			emissiveTarget.clearColor = new Color4(0, 0, 0, 0);
			emissiveTarget.gammaSpace = false;
			emissiveTarget.renderList = compatibility.emissiveSources.flatMap((source) => source.meshes);
			for (const source of compatibility.emissiveSources) {
				const emissive = createEmissiveMaterial(source.material);
				emissiveMaterials.push(emissive);
				for (const mesh of source.meshes) {
					emissiveTarget.setMaterialForRendering(mesh, emissive);
				}
			}
			emissiveTarget.onBeforeRenderObservable.add(() => {
				const width = Math.max(1, engine.getRenderWidth());
				const height = Math.max(1, engine.getRenderHeight());
				const size = emissiveTarget!.getSize();
				if (size.width !== width || size.height !== height) {
					emissiveTarget!.resize({ width, height });
				}
			});
			scene.customRenderTargets.push(emissiveTarget);
		}
		if (compatibility.iblSources.length) {
			const selectorAssignments = iblSelectorAssignments(compatibility.iblSources);
			iblSelectorTarget = new RenderTargetTexture(
				"Babylon Editor Deferred IBL Selector",
				{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
				scene,
				false,
				true,
				Constants.TEXTURETYPE_UNSIGNED_BYTE
			);
			iblSelectorTarget.activeCamera = camera;
			iblSelectorTarget.renderParticles = false;
			iblSelectorTarget.renderSprites = false;
			iblSelectorTarget.ignoreCameraViewport = false;
			iblSelectorTarget.clearColor = new Color4(0, 0, 0, 0);
			iblSelectorTarget.gammaSpace = false;
			iblSelectorTarget.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
			iblSelectorTarget.renderList = selectorAssignments.map((assignment) => assignment.mesh);
			for (const assignment of selectorAssignments) {
				const selector = createIblSelectorMaterial(assignment.mesh.material!, assignment.baseSourceIndex, assignment.materialIntensity, assignment.probeMask);
				iblSelectorMaterials.push(selector);
				iblSelectorTarget.setMaterialForRendering(assignment.mesh, selector);
			}
			iblSelectorTarget.onBeforeRenderObservable.add(() => {
				const width = Math.max(1, engine.getRenderWidth());
				const height = Math.max(1, engine.getRenderHeight());
				const size = iblSelectorTarget!.getSize();
				if (size.width !== width || size.height !== height) {
					iblSelectorTarget!.resize({ width, height });
				}
			});
			scene.customRenderTargets.push(iblSelectorTarget);
		}
		if (compatibility.shadowSources.length) {
			shadowReceiverMaterial = new StandardMaterial("Babylon Editor Deferred Shadow Receivers", scene);
			shadowReceiverMaterial.doNotSerialize = true;
			shadowReceiverMaterial.disableLighting = true;
			shadowReceiverMaterial.ambientColor = Color3.Black();
			shadowReceiverMaterial.diffuseColor = Color3.Black();
			shadowReceiverMaterial.specularColor = Color3.Black();
			shadowReceiverMaterial.emissiveColor = Color3.White();
			shadowReceiverMaterial.backFaceCulling = false;
			shadowReceiverTarget = new RenderTargetTexture(
				"Babylon Editor Deferred Shadow Receivers",
				{ width: Math.max(1, engine.getRenderWidth()), height: Math.max(1, engine.getRenderHeight()) },
				scene,
				false,
				true,
				Constants.TEXTURETYPE_UNSIGNED_BYTE
			);
			shadowReceiverTarget.activeCamera = camera;
			shadowReceiverTarget.renderParticles = false;
			shadowReceiverTarget.renderSprites = false;
			shadowReceiverTarget.ignoreCameraViewport = false;
			shadowReceiverTarget.clearColor = new Color4(0, 0, 0, 0);
			shadowReceiverTarget.gammaSpace = false;
			shadowReceiverTarget.renderList = compatibility.shadowReceiverMeshes;
			for (const mesh of compatibility.shadowReceiverMeshes) {
				shadowReceiverTarget.setMaterialForRendering(mesh, shadowReceiverMaterial);
			}
			shadowReceiverTarget.onBeforeRenderObservable.add(() => {
				const width = Math.max(1, engine.getRenderWidth());
				const height = Math.max(1, engine.getRenderHeight());
				const size = shadowReceiverTarget!.getSize();
				if (size.width !== width || size.height !== height) {
					shadowReceiverTarget!.resize({ width, height });
				}
			});
			scene.customRenderTargets.push(shadowReceiverTarget);
		}
		effectRenderer = new EffectRenderer(engine);
		const deferredEffectVariant = [
			engine.isWebGPU ? "wgsl" : "glsl",
			compatibility.shadowSources.map((source) => source.mode).join(",") || "no-shadows",
			compatibility.emissiveSources.length ? "emissive" : "no-emissive",
			compatibility.cookieSources.map((source) => source.evidence.kind).join(",") || "no-cookies",
			compatibility.areaLightSources.length ? "area-lights" : "no-area-lights",
			projectorSources
				.map(
					(source) =>
						`${source.channels.albedo ? "a" : ""}${source.channels.normal ? "n" : ""}${source.channels.metallic ? "m" : ""}${source.channels.ambientOcclusion ? "o" : ""}${source.channels.emissive ? "e" : ""}:${source.albedoTexture ? "at" : "ac"}:${source.normalTexture ? "nt" : "nc"}:${source.reflectivityTexture ? "rt" : "rc"}:${source.ambientOcclusionTexture ? "ot" : "oc"}:${source.emissiveTexture ? "et" : "ec"}:${source.decalLayerMask === 0xffffffff ? "all" : "layers"}`
				)
				.join(",") || "no-projectors",
		].join(":");
		effectWrapper = new EffectWrapper({
			engine,
			name: `Babylon Editor Deferred Lighting:${deferredEffectVariant}`,
			fragmentShader: engine.isWebGPU
				? deferredFragmentShaderWGSL(
						compatibility.shadowSources,
						compatibility.emissiveSources.length > 0,
						compatibility.cookieSources,
						compatibility.areaLightSources.length > 0,
						projectorSources
					)
				: deferredFragmentShaderGLSL(
						compatibility.shadowSources,
						compatibility.emissiveSources.length > 0,
						compatibility.cookieSources,
						compatibility.areaLightSources.length > 0,
						projectorSources
					),
			uniformNames: [
				"view",
				"cameraViewport",
				"ambientColor",
				"normalUnsigned",
				"lightCount",
				"lightData0",
				"lightData1",
				"lightData2",
				"lightData3",
				"lightData4",
				...projectorUniformNames(projectorSources),
				...cookieUniformNames(compatibility.cookieSources),
				...shadowUniformNames(compatibility.shadowSources),
			],
			samplerNames: [
				"positionSampler",
				"normalSampler",
				"reflectivitySampler",
				"albedoSampler",
				...(emissiveTarget ? ["emissiveSampler"] : []),
				...(compatibility.areaLightSources.length ? ["areaLightsLTC1Sampler", "areaLightsLTC2Sampler"] : []),
				...projectorSamplerNames(projectorSources),
				...cookieSamplerNames(compatibility.cookieSources),
				...shadowSamplerNames(compatibility.shadowSources),
			],
			shaderLanguage: engine.isWebGPU ? 1 : 0,
		});
		effectWrapper.onApplyObservable.add(() => {
			const effect = effectWrapper!.effect;
			const gbuffer = geometryBuffer!.getGBuffer();
			const currentLights = enabledLights(scene).slice(0, deferredLightingMaximumLights);
			const arrays = lightArrays(currentLights);
			effect.setTexture("positionSampler", gbuffer.textures[positionIndex]);
			effect.setTexture("normalSampler", gbuffer.textures[normalIndex]);
			effect.setTexture("reflectivitySampler", gbuffer.textures[reflectivityIndex]);
			effect.setTexture("albedoSampler", albedoTarget!);
			if (emissiveTarget) {
				effect.setTexture("emissiveSampler", emissiveTarget);
			}
			if (compatibility.areaLightSources.length) {
				const textures = (scene as Scene & { _ltcTextures?: { LTC1: BaseTexture; LTC2: BaseTexture } })._ltcTextures;
				if (textures) {
					effect.setTexture("areaLightsLTC1Sampler", textures.LTC1);
					effect.setTexture("areaLightsLTC2Sampler", textures.LTC2);
				}
			}
			effect.setMatrix("view", camera.getViewMatrix());
			effect.setFloat4("cameraViewport", camera.viewport.x, camera.viewport.y, camera.viewport.width, camera.viewport.height);
			effect.setColor3("ambientColor", scene.ambientColor);
			effect.setFloat("normalUnsigned", geometryBuffer!.normalsAreUnsigned ? 1 : 0);
			effect.setFloat("lightCount", currentLights.length);
			effect.setArray4("lightData0", arrays[0]);
			effect.setArray4("lightData1", arrays[1]);
			effect.setArray4("lightData2", arrays[2]);
			effect.setArray4("lightData3", arrays[3]);
			effect.setArray4("lightData4", arrays[4]);
			applyProjectorUniforms(effect, projectorSources, decalLayerTarget);
			applyCookieUniforms(effect, compatibility.cookieSources);
			if (compatibility.shadowSources.length && shadowReceiverTarget) {
				applyShadowUniforms(effect, compatibility.shadowSources, currentLights, camera, shadowReceiverTarget);
			}
		});
		const runtime: IDeferredLightingRuntimeEvidence = {
			...inactive(),
			configured: true,
			active: true,
			cameraId: camera.id,
			cameraName: camera.name,
			shaderLanguage: engine.isWebGPU ? "WGSL" : "GLSL",
			meshCount: compatibility.meshes.length,
			materialCount: compatibility.materials.length,
			lightCount: compatibility.lights.length,
			emissiveActive: compatibility.emissiveSources.length > 0,
			emissiveMeshCount: compatibility.emissiveSources.reduce((count, source) => count + source.meshes.length, 0),
			emissiveMaterialCount: compatibility.emissiveSources.length,
			emissiveTextureCount: new Set(compatibility.emissiveSources.map((source) => source.texture?.uniqueId).filter((id): id is number => id !== undefined)).size,
			emissiveEvidenceTruncated: compatibility.emissiveSources.length > deferredLightingMaximumEmissiveSources,
			emissiveSources: compatibility.emissiveSources.slice(0, deferredLightingMaximumEmissiveSources).map(emissiveSourceEvidence),
			iblActive: compatibility.iblSources.length > 0,
			iblSourceCount: compatibility.iblSources.length,
			iblEnvironmentTextureName: compatibility.iblSources.find((source) => source.kind === "environment")?.texture.name ?? null,
			iblReflectionProbeCount: compatibility.iblSources.filter((source) => source.kind === "reflection-probe").length,
			iblReflectionProbeNames: compatibility.iblSources.filter((source) => source.kind === "reflection-probe").map((source) => source.name),
			iblProbeBlendingActive: compatibility.iblSources.some((source) => source.kind === "reflection-probe"),
			iblProbeBlendMeshCount: iblProbeBlendMeshCount(compatibility.iblSources),
			iblSources: compatibility.iblSources.map(iblSourceEvidence),
			compositionMode:
				compatibility.forwardMeshes.length || compatibility.particleSystemCount || compatibility.spriteManagerCount || compatibility.layerCount
					? "hybrid-forward"
					: "deferred-only",
			forwardMeshCount: compatibility.forwardMeshes.length,
			transparentMeshCount: compatibility.transparentMeshCount,
			backgroundMeshCount: compatibility.backgroundMeshCount,
			laterRenderingGroupMeshCount: compatibility.laterRenderingGroupMeshCount,
			particleSystemCount: compatibility.particleSystemCount,
			spriteManagerCount: compatibility.spriteManagerCount,
			layerCount: compatibility.layerCount,
			warnings: compatibility.warnings,
		};
		applyDecalEvidence(runtime, compatibility.decalSources);
		applyCookieEvidence(runtime, compatibility.cookieSources);
		applyAreaLightEvidence(runtime, scene, compatibility.lights);
		applyShadowEvidence(runtime, compatibility, scene);
		manager = createSceneManager(scene);
		const state: IDeferredLightingState = {
			scene,
			camera,
			manager,
			runtime,
			geometryBuffer,
			geometryBufferLeaseHolder: holder,
			geometryBufferTargetAddedToCamera,
			albedoTarget,
			albedoMaterials,
			emissiveTarget,
			emissiveMaterials,
			emissiveSources: compatibility.emissiveSources,
			emissiveSignature: emissiveSignature(compatibility.emissiveSources),
			decalSources: compatibility.decalSources,
			decalSignature: decalSignature(compatibility.decalSources),
			decalLayerTarget,
			decalLayerMaterials,
			iblSelectorTarget,
			iblSelectorMaterials,
			iblSources: compatibility.iblSources,
			iblSignature: iblSignature(compatibility.iblSources),
			cookieSources: compatibility.cookieSources,
			cookieSignature: cookieSignature(compatibility.cookieSources),
			areaLightSignature: areaLightSignature(compatibility.lights),
			iblEffectWrapper: null,
			activeIblSource: null,
			shadowSources: compatibility.shadowSources,
			shadowReceiverTarget,
			shadowReceiverMaterial,
			effectRenderer,
			effectWrapper,
			meshIds: compatibility.meshes.map((mesh) => mesh.uniqueId.toString()).sort(),
		};
		if (compatibility.iblSources.length) {
			iblEffectWrapper = createIblEffectWrapper(state);
			state.iblEffectWrapper = iblEffectWrapper;
		}
		manager.states.set(camera, state);
		setReport(scene, camera, runtime);
		return structuredClone(updateEvidence(state));
	} catch (error) {
		if (manager) {
			manager.states.delete(camera);
			if (!manager.states.size) {
				restoreSceneManager(manager);
			}
		}
		if (albedoTarget) {
			const targetIndex = scene.customRenderTargets.indexOf(albedoTarget);
			if (targetIndex !== -1) {
				scene.customRenderTargets.splice(targetIndex, 1);
			}
			albedoTarget.dispose();
		}
		if (geometryBuffer && geometryBufferTargetAddedToCamera) {
			const geometryTarget = geometryBuffer.getGBuffer();
			const cameraTargetIndex = camera.customRenderTargets.indexOf(geometryTarget);
			if (cameraTargetIndex !== -1) {
				camera.customRenderTargets.splice(cameraTargetIndex, 1);
			}
		}
		for (const material of albedoMaterials) {
			material.dispose(false, false);
		}
		if (emissiveTarget) {
			const targetIndex = scene.customRenderTargets.indexOf(emissiveTarget);
			if (targetIndex !== -1) {
				scene.customRenderTargets.splice(targetIndex, 1);
			}
			emissiveTarget.dispose();
		}
		for (const material of emissiveMaterials) {
			material.dispose(false, false);
		}
		if (decalLayerTarget) {
			const targetIndex = scene.customRenderTargets.indexOf(decalLayerTarget);
			if (targetIndex !== -1) {
				scene.customRenderTargets.splice(targetIndex, 1);
			}
			decalLayerTarget.dispose();
		}
		for (const material of decalLayerMaterials) {
			material.dispose(false, false);
		}
		if (iblSelectorTarget) {
			const targetIndex = scene.customRenderTargets.indexOf(iblSelectorTarget);
			if (targetIndex !== -1) {
				scene.customRenderTargets.splice(targetIndex, 1);
			}
			iblSelectorTarget.dispose();
		}
		for (const material of iblSelectorMaterials) {
			material.dispose(false, false);
		}
		if (shadowReceiverTarget) {
			const targetIndex = scene.customRenderTargets.indexOf(shadowReceiverTarget);
			if (targetIndex !== -1) {
				scene.customRenderTargets.splice(targetIndex, 1);
			}
			shadowReceiverTarget.dispose();
		}
		shadowReceiverMaterial?.dispose(false, false);
		iblEffectWrapper?.dispose();
		effectWrapper?.dispose();
		effectRenderer?.dispose();
		if (geometryBuffer) {
			releaseGeometryBufferLease(scene, holder);
		}
		const report = inactive(error instanceof Error ? error.message : String(error));
		applyCameraEvidence(report, camera);
		report.meshCount = compatibility.meshes.length;
		report.materialCount = compatibility.materials.length;
		report.lightCount = compatibility.lights.length;
		applyShadowEvidence(report, compatibility, scene);
		report.emissiveActive = compatibility.emissiveSources.length > 0;
		report.emissiveMeshCount = compatibility.emissiveSources.reduce((count, source) => count + source.meshes.length, 0);
		report.emissiveMaterialCount = compatibility.emissiveSources.length;
		report.emissiveTextureCount = new Set(compatibility.emissiveSources.map((source) => source.texture?.uniqueId).filter((id): id is number => id !== undefined)).size;
		report.emissiveEvidenceTruncated = compatibility.emissiveSources.length > deferredLightingMaximumEmissiveSources;
		report.emissiveSources = compatibility.emissiveSources.slice(0, deferredLightingMaximumEmissiveSources).map(emissiveSourceEvidence);
		applyDecalEvidence(report, compatibility.decalSources);
		applyCookieEvidence(report, compatibility.cookieSources);
		report.forwardMeshCount = compatibility.forwardMeshes.length;
		report.transparentMeshCount = compatibility.transparentMeshCount;
		report.backgroundMeshCount = compatibility.backgroundMeshCount;
		report.laterRenderingGroupMeshCount = compatibility.laterRenderingGroupMeshCount;
		report.particleSystemCount = compatibility.particleSystemCount;
		report.spriteManagerCount = compatibility.spriteManagerCount;
		report.layerCount = compatibility.layerCount;
		report.compositionMode =
			compatibility.forwardMeshes.length || compatibility.particleSystemCount || compatibility.spriteManagerCount || compatibility.layerCount
				? "hybrid-forward"
				: "deferred-only";
		report.warnings = compatibility.warnings;
		setReport(scene, camera, report);
		return structuredClone(report);
	}
}

/** Returns immutable live readiness, allocation, light, material, and limitation evidence. */
export function getDeferredLightingRuntime(scene: Scene, camera?: Camera | string): IDeferredLightingRuntimeEvidence {
	const manager = managers.get(scene);
	const selectedCamera = typeof camera === "string" ? scene.getCameraById(camera) : camera;
	const state = selectedCamera ? manager?.states.get(selectedCamera) : scene.activeCamera ? manager?.states.get(scene.activeCamera) : manager?.states.values().next().value;
	if (state) {
		return structuredClone(updateEvidence(state));
	}
	const sceneReports = reports.get(scene);
	const report = selectedCamera
		? sceneReports?.get(selectedCamera.id)
		: camera && typeof camera === "string"
			? sceneReports?.get(camera)
			: scene.activeCamera
				? sceneReports?.get(scene.activeCamera.id)
				: sceneReports?.values().next().value;
	if (report) {
		return structuredClone(report);
	}
	const empty = inactive();
	if (selectedCamera) {
		applyCameraEvidence(empty, selectedCamera);
	} else if (typeof camera === "string") {
		empty.cameraId = camera;
	}
	return structuredClone(empty);
}

/** Returns immutable runtime evidence for every configured or failed deferred camera in scene camera order. */
export function getDeferredLightingRuntimes(scene: Scene): IDeferredLightingRuntimeEvidence[] {
	const manager = managers.get(scene);
	const sceneReports = reports.get(scene);
	const cameraIds = new Set<string>([...(manager?.states.keys() ?? [])].map((camera) => camera.id));
	for (const cameraId of sceneReports?.keys() ?? []) {
		cameraIds.add(cameraId);
	}
	return scene.cameras.filter((camera) => cameraIds.has(camera.id)).map((camera) => getDeferredLightingRuntime(scene, camera));
}
