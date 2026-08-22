import "@babylonjs/core/Engines/AbstractEngine/abstractEngine.query";

import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Material } from "@babylonjs/core/Materials/material";
import { Ray } from "@babylonjs/core/Culling/ray";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export const occlusionCullingMetadataKey = "babylonEditorOcclusionCulling";
export const occlusionCullingSetsMetadataKey = "babylonEditorOcclusionCullingSets";
export const occlusionCullingObjectMetadataKey = "babylonEditorOcclusionCulling";
export const occlusionCullingVersion = 1 as const;

export const maximumOcclusionAreas = 256;
export const maximumOcclusionCells = 4_096;
export const maximumOcclusionMeshes = 4_096;
export const maximumOcclusionRayTests = 2_000_000;
export const maximumOcclusionRelationships = 2_000_000;

export type OcclusionCullingQueryMode = "optimistic" | "strict";

export interface IOcclusionCullingSettings {
	smallestOccluder: number;
	smallestHole: number;
	backfaceThreshold: number;
	cellSize: number;
	viewSamples: number;
	targetSamples: number;
	maximumCells: number;
	maximumRayTests: number;
	maximumRelationships: number;
}

export interface IOcclusionCullingArea {
	version: 1;
	revision: number;
	id: string;
	name: string;
	center: [number, number, number];
	size: [number, number, number];
	isViewVolume: boolean;
	enabled: boolean;
}

export interface IOcclusionCullingMeshSettings {
	version: 1;
	revision: number;
	staticOccluder: boolean;
	staticOccludee: boolean;
	dynamicOcclusion: boolean;
	queryMode: OcclusionCullingQueryMode;
	queryRetryCount: number;
	forceRenderingWhenOccluded: boolean;
}

export interface IOcclusionCullingCameraSettings {
	version: 1;
	revision: number;
	enabled: boolean;
}

export interface IOcclusionCullingSourceMesh {
	id: string;
	name: string;
	signature: string;
	staticOccluder: boolean;
	staticOccludee: boolean;
	occluderEligible: boolean;
	occluderReason: string | null;
	minimum: [number, number, number];
	maximum: [number, number, number];
}

export interface IOcclusionCullingCell {
	id: string;
	areaId: string;
	minimum: [number, number, number];
	maximum: [number, number, number];
	center: [number, number, number];
	valid: boolean;
	backfacePercent: number;
	visibleMeshIds: string[];
	occludedMeshIds: string[];
	rayTests: number;
}

export interface IOcclusionCullingBakeStatistics {
	areaCount: number;
	cellCount: number;
	validCellCount: number;
	invalidCellCount: number;
	sourceMeshCount: number;
	occluderCount: number;
	occludeeCount: number;
	visibleRelationships: number;
	occludedRelationships: number;
	rayTests: number;
	durationMilliseconds: number;
}

export interface IOcclusionCullingBake {
	version: 1;
	model: "bounded-static-pvs-ray-bake-v1";
	configurationBakeRevision: number;
	sourceFingerprint: string;
	bakeFingerprint: string;
	createdAt: string;
	sources: IOcclusionCullingSourceMesh[];
	cells: IOcclusionCullingCell[];
	warnings: string[];
	statistics: IOcclusionCullingBakeStatistics;
}

export interface IOcclusionCullingConfiguration {
	version: 1;
	revision: number;
	bakeRevision: number;
	enabled: boolean;
	settings: IOcclusionCullingSettings;
	areas: IOcclusionCullingArea[];
	bake?: IOcclusionCullingBake;
}

export interface IOcclusionCullingBakePlan {
	version: 1;
	model: "bounded-static-pvs-ray-bake-v1";
	configurationRevision: number;
	configurationBakeRevision: number;
	sourceFingerprint: string;
	sources: IOcclusionCullingSourceMesh[];
	occluderMeshIds: string[];
	occludeeMeshIds: string[];
	areas: IOcclusionCullingArea[];
	cells: Array<Pick<IOcclusionCullingCell, "id" | "areaId" | "minimum" | "maximum" | "center">>;
	estimatedRayTests: number;
	estimatedRelationships: number;
	warnings: string[];
}

export interface IOcclusionCullingBakeProgress {
	phase: "planning" | "baking" | "fingerprinting";
	completedCells: number;
	totalCells: number;
	rayTests: number;
	message: string;
}

export interface IOcclusionCullingBakeOptions {
	signal?: AbortSignal;
	now?: () => number;
	onProgress?: (progress: IOcclusionCullingBakeProgress) => void;
}

export interface IOcclusionCullingCameraRuntimeState {
	cameraId: string;
	cameraName: string;
	enabled: boolean;
	activeCellId: string | null;
	activeBakeFingerprint: string | null;
	bakedCulledMeshIds: string[];
	bakedVisibleMeshIds: string[];
	hardwareOccludedMeshIds: string[];
	staleReason: string | null;
	frameId: number;
	durationMilliseconds: number;
}

export interface IOcclusionCullingRuntimeState {
	configured: boolean;
	configurationCount: number;
	hardwareQueriesSupported: boolean;
	dynamicQueryMeshIds: string[];
	cameras: IOcclusionCullingCameraRuntimeState[];
	errors: string[];
}

interface IOcclusionCullingRuntimeConfiguration {
	configuration: IOcclusionCullingConfiguration;
	bake: IOcclusionCullingBake;
	staleReason: string | null;
}

interface IVisibilitySnapshot {
	mesh: AbstractMesh;
	isVisible: boolean;
	visibility: number;
}

interface IQuerySnapshot {
	mesh: AbstractMesh;
	occlusionType: number;
	occlusionRetryCount: number;
	forceRenderingWhenOccluded: boolean;
}

const configurationKeys = new Set(["version", "revision", "bakeRevision", "enabled", "settings", "areas", "bake"]);
const settingsKeys = new Set([
	"smallestOccluder",
	"smallestHole",
	"backfaceThreshold",
	"cellSize",
	"viewSamples",
	"targetSamples",
	"maximumCells",
	"maximumRayTests",
	"maximumRelationships",
]);
const areaKeys = new Set(["version", "revision", "id", "name", "center", "size", "isViewVolume", "enabled"]);
const meshSettingsKeys = new Set(["version", "revision", "staticOccluder", "staticOccludee", "dynamicOcclusion", "queryMode", "queryRetryCount", "forceRenderingWhenOccluded"]);
const cameraSettingsKeys = new Set(["version", "revision", "enabled"]);

export const defaultOcclusionCullingSettings: Readonly<IOcclusionCullingSettings> = Object.freeze({
	smallestOccluder: 100,
	smallestHole: 25,
	backfaceThreshold: 100,
	cellSize: 500,
	viewSamples: 9,
	targetSamples: 9,
	maximumCells: 512,
	maximumRayTests: 500_000,
	maximumRelationships: 250_000,
});

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: Set<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !keys.has(key));
	if (unknown.length) {
		throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
	}
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isFinite(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return Number(value);
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function text(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1 through ${maximum} characters.`);
	}
	return value.trim();
}

function vector3Tuple(value: unknown, label: string, positive = false): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3) {
		throw new Error(`${label} must contain exactly three numbers.`);
	}
	const result = value.map((component, index) => finite(component, `${label}[${index}]`, positive ? 0.001 : -1_000_000_000, 1_000_000_000)) as [number, number, number];
	return result;
}

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`;
	}
	const source = value as Record<string, unknown>;
	return `{${Object.keys(source)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(source[key])}`)
		.join(",")}}`;
}

async function sha256(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Occlusion baking requires Web Crypto SHA-256 support.");
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function precise(value: number): string {
	return Number.isFinite(value) ? value.toPrecision(15) : "non-finite";
}

function uniqueId(value: string, label: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must use 1 through 128 letters, numbers, dots, underscores, colons, or hyphens.`);
	}
	return value;
}

/** Returns a detached default configuration without mutating a scene. */
export function createDefaultOcclusionCullingConfiguration(): IOcclusionCullingConfiguration {
	return {
		version: 1,
		revision: 0,
		bakeRevision: 0,
		enabled: true,
		settings: { ...defaultOcclusionCullingSettings },
		areas: [],
	};
}

/** Strictly normalizes the Unity-facing bake settings. */
export function normalizeOcclusionCullingSettings(value: unknown): IOcclusionCullingSettings {
	const source = record(value, "Occlusion Culling settings");
	closed(source, settingsKeys, "Occlusion Culling settings");
	const viewSamples = integer(source.viewSamples, "viewSamples", 1, 9);
	const targetSamples = integer(source.targetSamples, "targetSamples", 1, 9);
	return {
		smallestOccluder: finite(source.smallestOccluder, "smallestOccluder", 0, 1_000_000_000),
		smallestHole: finite(source.smallestHole, "smallestHole", 0, 1_000_000_000),
		backfaceThreshold: finite(source.backfaceThreshold, "backfaceThreshold", 0, 100),
		cellSize: finite(source.cellSize, "cellSize", 0.001, 1_000_000_000),
		viewSamples,
		targetSamples,
		maximumCells: integer(source.maximumCells, "maximumCells", 1, maximumOcclusionCells),
		maximumRayTests: integer(source.maximumRayTests, "maximumRayTests", 1, maximumOcclusionRayTests),
		maximumRelationships: integer(source.maximumRelationships, "maximumRelationships", 1, maximumOcclusionRelationships),
	};
}

/** Strictly normalizes one Occlusion Area/View Volume. */
export function normalizeOcclusionCullingArea(value: unknown): IOcclusionCullingArea {
	const source = record(value, "Occlusion Area");
	closed(source, areaKeys, "Occlusion Area");
	return {
		version: integer(source.version, "Occlusion Area version", 1, 1) as 1,
		revision: integer(source.revision, "Occlusion Area revision", 1, Number.MAX_SAFE_INTEGER),
		id: uniqueId(text(source.id, "Occlusion Area id", 128), "Occlusion Area id"),
		name: text(source.name, "Occlusion Area name", 128),
		center: vector3Tuple(source.center, "Occlusion Area center"),
		size: vector3Tuple(source.size, "Occlusion Area size", true),
		isViewVolume: boolean(source.isViewVolume, "Occlusion Area isViewVolume"),
		enabled: boolean(source.enabled, "Occlusion Area enabled"),
	};
}

/** Strictly normalizes persisted per-mesh occlusion flags. */
export function normalizeOcclusionCullingMeshSettings(value: unknown): IOcclusionCullingMeshSettings {
	const source = record(value, "Mesh Occlusion Culling settings");
	closed(source, meshSettingsKeys, "Mesh Occlusion Culling settings");
	if (source.queryMode !== "optimistic" && source.queryMode !== "strict") {
		throw new Error("Mesh Occlusion Culling queryMode must be optimistic or strict.");
	}
	return {
		version: integer(source.version, "Mesh Occlusion Culling version", 1, 1) as 1,
		revision: integer(source.revision, "Mesh Occlusion Culling revision", 1, Number.MAX_SAFE_INTEGER),
		staticOccluder: boolean(source.staticOccluder, "staticOccluder"),
		staticOccludee: boolean(source.staticOccludee, "staticOccludee"),
		dynamicOcclusion: boolean(source.dynamicOcclusion, "dynamicOcclusion"),
		queryMode: source.queryMode,
		queryRetryCount: integer(source.queryRetryCount, "queryRetryCount", 0, 1_000),
		forceRenderingWhenOccluded: boolean(source.forceRenderingWhenOccluded, "forceRenderingWhenOccluded"),
	};
}

/** Strictly normalizes persisted per-camera occlusion enablement. */
export function normalizeOcclusionCullingCameraSettings(value: unknown): IOcclusionCullingCameraSettings {
	const source = record(value, "Camera Occlusion Culling settings");
	closed(source, cameraSettingsKeys, "Camera Occlusion Culling settings");
	return {
		version: integer(source.version, "Camera Occlusion Culling version", 1, 1) as 1,
		revision: integer(source.revision, "Camera Occlusion Culling revision", 1, Number.MAX_SAFE_INTEGER),
		enabled: boolean(source.enabled, "Camera Occlusion Culling enabled"),
	};
}

function normalizeSource(value: unknown): IOcclusionCullingSourceMesh {
	const source = record(value, "Occlusion bake source");
	const allowed = new Set(["id", "name", "signature", "staticOccluder", "staticOccludee", "occluderEligible", "occluderReason", "minimum", "maximum"]);
	closed(source, allowed, "Occlusion bake source");
	const signature = text(source.signature, "Occlusion bake source signature", 4096);
	return {
		id: text(source.id, "Occlusion bake source id", 256),
		name: text(source.name, "Occlusion bake source name", 256),
		signature,
		staticOccluder: boolean(source.staticOccluder, "Occlusion bake source staticOccluder"),
		staticOccludee: boolean(source.staticOccludee, "Occlusion bake source staticOccludee"),
		occluderEligible: boolean(source.occluderEligible, "Occlusion bake source occluderEligible"),
		occluderReason: source.occluderReason === null ? null : text(source.occluderReason, "Occlusion bake source occluderReason", 512),
		minimum: vector3Tuple(source.minimum, "Occlusion bake source minimum"),
		maximum: vector3Tuple(source.maximum, "Occlusion bake source maximum"),
	};
}

function normalizeCell(value: unknown): IOcclusionCullingCell {
	const source = record(value, "Occlusion bake cell");
	const allowed = new Set(["id", "areaId", "minimum", "maximum", "center", "valid", "backfacePercent", "visibleMeshIds", "occludedMeshIds", "rayTests"]);
	closed(source, allowed, "Occlusion bake cell");
	const identifiers = (candidate: unknown, label: string): string[] => {
		if (!Array.isArray(candidate) || candidate.length > maximumOcclusionMeshes || candidate.some((id) => typeof id !== "string" || !id || id.length > 256)) {
			throw new Error(`${label} must contain at most ${maximumOcclusionMeshes} non-empty mesh ids.`);
		}
		if (new Set(candidate).size !== candidate.length) {
			throw new Error(`${label} must not contain duplicate mesh ids.`);
		}
		return [...candidate].sort();
	};
	return {
		id: text(source.id, "Occlusion bake cell id", 256),
		areaId: text(source.areaId, "Occlusion bake cell areaId", 128),
		minimum: vector3Tuple(source.minimum, "Occlusion bake cell minimum"),
		maximum: vector3Tuple(source.maximum, "Occlusion bake cell maximum"),
		center: vector3Tuple(source.center, "Occlusion bake cell center"),
		valid: boolean(source.valid, "Occlusion bake cell valid"),
		backfacePercent: finite(source.backfacePercent, "Occlusion bake cell backfacePercent", 0, 100),
		visibleMeshIds: identifiers(source.visibleMeshIds, "Occlusion bake visibleMeshIds"),
		occludedMeshIds: identifiers(source.occludedMeshIds, "Occlusion bake occludedMeshIds"),
		rayTests: integer(source.rayTests, "Occlusion bake cell rayTests", 0, maximumOcclusionRayTests),
	};
}

function normalizeBake(value: unknown): IOcclusionCullingBake {
	const source = record(value, "Occlusion Culling bake");
	const allowed = new Set(["version", "model", "configurationBakeRevision", "sourceFingerprint", "bakeFingerprint", "createdAt", "sources", "cells", "warnings", "statistics"]);
	closed(source, allowed, "Occlusion Culling bake");
	if (source.model !== "bounded-static-pvs-ray-bake-v1") {
		throw new Error("Occlusion Culling bake model must be bounded-static-pvs-ray-bake-v1.");
	}
	if (typeof source.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.sourceFingerprint)) {
		throw new Error("Occlusion Culling sourceFingerprint must be a lowercase SHA-256 value.");
	}
	if (typeof source.bakeFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.bakeFingerprint)) {
		throw new Error("Occlusion Culling bakeFingerprint must be a lowercase SHA-256 value.");
	}
	if (!Array.isArray(source.sources) || source.sources.length > maximumOcclusionMeshes) {
		throw new Error(`Occlusion Culling bake supports at most ${maximumOcclusionMeshes} source meshes.`);
	}
	if (!Array.isArray(source.cells) || source.cells.length > maximumOcclusionCells) {
		throw new Error(`Occlusion Culling bake supports at most ${maximumOcclusionCells} cells.`);
	}
	if (
		!Array.isArray(source.warnings) ||
		source.warnings.length > maximumOcclusionMeshes ||
		source.warnings.some((warning) => typeof warning !== "string" || warning.length > 512)
	) {
		throw new Error("Occlusion Culling bake warnings are invalid or excessive.");
	}
	const statistics = record(source.statistics, "Occlusion Culling bake statistics");
	const statisticKeys = new Set([
		"areaCount",
		"cellCount",
		"validCellCount",
		"invalidCellCount",
		"sourceMeshCount",
		"occluderCount",
		"occludeeCount",
		"visibleRelationships",
		"occludedRelationships",
		"rayTests",
		"durationMilliseconds",
	]);
	closed(statistics, statisticKeys, "Occlusion Culling bake statistics");
	const cells = source.cells.map(normalizeCell);
	const relationships = cells.reduce((sum, cell) => sum + cell.visibleMeshIds.length + cell.occludedMeshIds.length, 0);
	if (relationships > maximumOcclusionRelationships) {
		throw new Error(`Occlusion Culling bake exceeds ${maximumOcclusionRelationships} cell-to-mesh relationships.`);
	}
	return {
		version: integer(source.version, "Occlusion Culling bake version", 1, 1) as 1,
		model: source.model,
		configurationBakeRevision: integer(source.configurationBakeRevision, "Occlusion Culling bake configurationBakeRevision", 0, Number.MAX_SAFE_INTEGER),
		sourceFingerprint: source.sourceFingerprint,
		bakeFingerprint: source.bakeFingerprint,
		createdAt: text(source.createdAt, "Occlusion Culling bake createdAt", 64),
		sources: source.sources.map(normalizeSource),
		cells,
		warnings: [...source.warnings],
		statistics: {
			areaCount: integer(statistics.areaCount, "statistics.areaCount", 0, maximumOcclusionAreas),
			cellCount: integer(statistics.cellCount, "statistics.cellCount", 0, maximumOcclusionCells),
			validCellCount: integer(statistics.validCellCount, "statistics.validCellCount", 0, maximumOcclusionCells),
			invalidCellCount: integer(statistics.invalidCellCount, "statistics.invalidCellCount", 0, maximumOcclusionCells),
			sourceMeshCount: integer(statistics.sourceMeshCount, "statistics.sourceMeshCount", 0, maximumOcclusionMeshes),
			occluderCount: integer(statistics.occluderCount, "statistics.occluderCount", 0, maximumOcclusionMeshes),
			occludeeCount: integer(statistics.occludeeCount, "statistics.occludeeCount", 0, maximumOcclusionMeshes),
			visibleRelationships: integer(statistics.visibleRelationships, "statistics.visibleRelationships", 0, maximumOcclusionRelationships),
			occludedRelationships: integer(statistics.occludedRelationships, "statistics.occludedRelationships", 0, maximumOcclusionRelationships),
			rayTests: integer(statistics.rayTests, "statistics.rayTests", 0, maximumOcclusionRayTests),
			durationMilliseconds: finite(statistics.durationMilliseconds, "statistics.durationMilliseconds", 0, 86_400_000),
		},
	};
}

/** Strictly normalizes a complete persisted configuration and bake. */
export function normalizeOcclusionCullingConfiguration(value: unknown): IOcclusionCullingConfiguration {
	const source = record(value, "Occlusion Culling configuration");
	closed(source, configurationKeys, "Occlusion Culling configuration");
	if (!Array.isArray(source.areas) || source.areas.length > maximumOcclusionAreas) {
		throw new Error(`Occlusion Culling supports at most ${maximumOcclusionAreas} areas.`);
	}
	const areas = source.areas.map(normalizeOcclusionCullingArea);
	if (new Set(areas.map((area) => area.id)).size !== areas.length) {
		throw new Error("Occlusion Culling area ids must be unique.");
	}
	return {
		version: integer(source.version, "Occlusion Culling version", 1, 1) as 1,
		revision: integer(source.revision, "Occlusion Culling revision", 0, Number.MAX_SAFE_INTEGER),
		bakeRevision: integer(source.bakeRevision, "Occlusion Culling bakeRevision", 0, Number.MAX_SAFE_INTEGER),
		enabled: boolean(source.enabled, "Occlusion Culling enabled"),
		settings: normalizeOcclusionCullingSettings(source.settings),
		areas,
		...(source.bake === undefined ? {} : { bake: normalizeBake(source.bake) }),
	};
}

/** Reads a strict detached configuration, or null when the scene has not authored one. */
export function getOcclusionCullingConfiguration(scene: Scene): IOcclusionCullingConfiguration | null {
	const value = scene.metadata?.[occlusionCullingMetadataKey];
	return value === undefined ? null : normalizeOcclusionCullingConfiguration(value);
}

/** Returns detached per-mesh settings, defaulting to an unauthored revision-zero record. */
export function getOcclusionCullingMeshSettings(mesh: AbstractMesh): IOcclusionCullingMeshSettings {
	const value = mesh.metadata?.[occlusionCullingObjectMetadataKey];
	return value === undefined
		? {
				version: 1,
				revision: 0,
				staticOccluder: false,
				staticOccludee: false,
				dynamicOcclusion: false,
				queryMode: "optimistic",
				queryRetryCount: 2,
				forceRenderingWhenOccluded: false,
			}
		: normalizeOcclusionCullingMeshSettings(value);
}

/** Returns detached per-camera settings; Unity-compatible default is enabled. */
export function getOcclusionCullingCameraSettings(camera: Camera): IOcclusionCullingCameraSettings {
	const value = camera.metadata?.[occlusionCullingObjectMetadataKey];
	return value === undefined ? { version: 1, revision: 0, enabled: true } : normalizeOcclusionCullingCameraSettings(value);
}

function materialOccluderReason(mesh: AbstractMesh): string | null {
	if (!mesh.material) {
		return null;
	}
	const materials: Material[] =
		"subMaterials" in mesh.material ? (((mesh.material as any).subMaterials as Array<Material | null>).filter(Boolean) as Material[]) : [mesh.material];
	if (!materials.length) {
		return "its MultiMaterial has no concrete submaterials";
	}
	for (const material of materials) {
		try {
			if (material.alpha < 1 || material.needAlphaBlendingForMesh(mesh) || material.needAlphaTesting()) {
				return `material "${material.name}" is transparent or alpha-tested`;
			}
		} catch {
			return `material "${material.name}" could not prove opaque rendering`;
		}
	}
	return null;
}

function worldBounds(mesh: AbstractMesh): { minimum: Vector3; maximum: Vector3 } {
	mesh.computeWorldMatrix(true);
	mesh.refreshBoundingInfo({ applySkeleton: false, applyMorph: false });
	const box = mesh.getBoundingInfo().boundingBox;
	return { minimum: box.minimumWorld.clone(), maximum: box.maximumWorld.clone() };
}

function meshSignature(mesh: AbstractMesh): string {
	const bounds = worldBounds(mesh);
	const material = mesh.material;
	const materialState = material ? [material.id, precise(material.alpha), String(material.transparencyMode), String(material.needAlphaTesting())].join(":") : "default-opaque";
	return [
		mesh.id,
		mesh.getClassName(),
		String(mesh.getTotalVertices()),
		String(mesh.getTotalIndices()),
		...mesh.getWorldMatrix().asArray().map(precise),
		...bounds.minimum.asArray().map(precise),
		...bounds.maximum.asArray().map(precise),
		String(mesh.isEnabled()),
		String(mesh.isVisible),
		precise(mesh.visibility),
		materialState,
	].join("|");
}

/** Returns the exact deterministic geometry/material/transform signature used to detect stale baked sources. */
export function getOcclusionCullingMeshSignature(mesh: AbstractMesh): string {
	return meshSignature(mesh);
}

function sourceMesh(scene: Scene, settings: IOcclusionCullingSettings): IOcclusionCullingSourceMesh[] {
	const result: IOcclusionCullingSourceMesh[] = [];
	for (const mesh of [...scene.meshes].sort((left, right) => left.id.localeCompare(right.id))) {
		const authored = getOcclusionCullingMeshSettings(mesh);
		if (!authored.staticOccluder && !authored.staticOccludee) {
			continue;
		}
		if (result.length >= maximumOcclusionMeshes) {
			throw new Error(`Occlusion Culling supports at most ${maximumOcclusionMeshes} participating meshes.`);
		}
		const bounds = worldBounds(mesh);
		const extent = bounds.maximum.subtract(bounds.minimum);
		let occluderReason: string | null = null;
		if (authored.staticOccluder) {
			if (mesh.getTotalVertices() < 3 || mesh.getTotalIndices() < 3) {
				occluderReason = "it has no triangle geometry";
			} else if (!mesh.isEnabled() || !mesh.isVisible || mesh.visibility <= 0) {
				occluderReason = "it is disabled or invisible";
			} else if (Math.max(extent.x, extent.y, extent.z) < settings.smallestOccluder) {
				occluderReason = `its largest world extent is below Smallest Occluder ${settings.smallestOccluder}`;
			} else {
				occluderReason = materialOccluderReason(mesh);
			}
		}
		result.push({
			id: mesh.id,
			name: mesh.name,
			signature: meshSignature(mesh),
			staticOccluder: authored.staticOccluder,
			staticOccludee: authored.staticOccludee,
			occluderEligible: authored.staticOccluder && !occluderReason,
			occluderReason,
			minimum: bounds.minimum.asArray() as [number, number, number],
			maximum: bounds.maximum.asArray() as [number, number, number],
		});
	}
	return result;
}

function automaticArea(sources: IOcclusionCullingSourceMesh[], cellSize: number): IOcclusionCullingArea {
	const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
	for (const source of sources) {
		minimum.minimizeInPlaceFromFloats(source.minimum[0], source.minimum[1], source.minimum[2]);
		maximum.maximizeInPlaceFromFloats(source.maximum[0], source.maximum[1], source.maximum[2]);
	}
	if (![...minimum.asArray(), ...maximum.asArray()].every(Number.isFinite)) {
		throw new Error("Occlusion Culling could not derive finite automatic scene bounds.");
	}
	const padding = Math.max(0.001, cellSize * 0.5);
	minimum.subtractInPlace(new Vector3(padding, padding, padding));
	maximum.addInPlaceFromFloats(padding, padding, padding);
	const size = maximum.subtract(minimum);
	return {
		version: 1,
		revision: 1,
		id: "automatic-scene-bounds",
		name: "Automatic Scene Bounds",
		center: minimum.add(maximum).scale(0.5).asArray() as [number, number, number],
		size: size.asArray() as [number, number, number],
		isViewVolume: true,
		enabled: true,
	};
}

function buildCells(areas: IOcclusionCullingArea[], cellSize: number, maximumCells: number): IOcclusionCullingBakePlan["cells"] {
	const cells: IOcclusionCullingBakePlan["cells"] = [];
	for (const area of areas.filter((candidate) => candidate.enabled).sort((left, right) => left.id.localeCompare(right.id))) {
		const center = Vector3.FromArray(area.center);
		const size = Vector3.FromArray(area.size);
		const minimum = center.subtract(size.scale(0.5));
		const maximum = center.add(size.scale(0.5));
		const countX = Math.max(1, Math.ceil(size.x / cellSize));
		const countY = Math.max(1, Math.ceil(size.y / cellSize));
		const countZ = Math.max(1, Math.ceil(size.z / cellSize));
		if (countX * countY * countZ > maximumCells - cells.length) {
			throw new Error(`Occlusion Area "${area.name}" would exceed the authored ${maximumCells}-cell bake limit. Increase Portable Cell Size or reduce its volume.`);
		}
		for (let x = 0; x < countX; x++) {
			for (let y = 0; y < countY; y++) {
				for (let z = 0; z < countZ; z++) {
					const cellMinimum = new Vector3(minimum.x + x * cellSize, minimum.y + y * cellSize, minimum.z + z * cellSize);
					const cellMaximum = new Vector3(
						Math.min(maximum.x, cellMinimum.x + cellSize),
						Math.min(maximum.y, cellMinimum.y + cellSize),
						Math.min(maximum.z, cellMinimum.z + cellSize)
					);
					cells.push({
						id: `${area.id}:${x}:${y}:${z}`,
						areaId: area.id,
						minimum: cellMinimum.asArray() as [number, number, number],
						maximum: cellMaximum.asArray() as [number, number, number],
						center: cellMinimum.add(cellMaximum).scale(0.5).asArray() as [number, number, number],
					});
				}
			}
		}
	}
	if (!cells.length) {
		throw new Error("Occlusion Culling requires at least one enabled Occlusion Area or automatic scene bounds.");
	}
	return cells;
}

function planPayload(
	configuration: IOcclusionCullingConfiguration,
	sources: IOcclusionCullingSourceMesh[],
	areas: IOcclusionCullingArea[],
	cells: IOcclusionCullingBakePlan["cells"]
): unknown {
	return {
		version: 1,
		model: "bounded-static-pvs-ray-bake-v1",
		configurationBakeRevision: configuration.bakeRevision,
		settings: configuration.settings,
		areas,
		cells,
		sources,
	};
}

/** Produces a non-mutating exact bake plan and source fingerprint. */
export async function inspectOcclusionCullingBake(scene: Scene, value?: IOcclusionCullingConfiguration): Promise<IOcclusionCullingBakePlan> {
	const configuration = normalizeOcclusionCullingConfiguration(value ?? getOcclusionCullingConfiguration(scene) ?? createDefaultOcclusionCullingConfiguration());
	const sources = sourceMesh(scene, configuration.settings);
	const occluders = sources.filter((source) => source.occluderEligible);
	const occludees = sources.filter((source) => source.staticOccludee);
	if (!occluders.length) {
		throw new Error("Occlusion Culling bake requires at least one enabled opaque Static Occluder at or above Smallest Occluder.");
	}
	if (!occludees.length) {
		throw new Error("Occlusion Culling bake requires at least one Static Occludee.");
	}
	const authoredAreas = configuration.areas.filter((area) => area.enabled);
	const areas = authoredAreas.length ? authoredAreas : [automaticArea(sources, configuration.settings.cellSize)];
	const cells = buildCells(areas, configuration.settings.cellSize, configuration.settings.maximumCells);
	const bundleCount = configuration.settings.smallestHole > 0 ? 5 : 1;
	const estimatedRelationships = cells.length * occludees.length;
	const estimatedRayTests = cells.length * 6 + estimatedRelationships * configuration.settings.viewSamples * configuration.settings.targetSamples * bundleCount;
	if (estimatedRelationships > configuration.settings.maximumRelationships) {
		throw new Error(
			`Occlusion Culling plan requires ${estimatedRelationships} cell-to-mesh relationships, above the authored ${configuration.settings.maximumRelationships} limit. Increase Portable Cell Size, reduce Areas, or reduce Static Occludees.`
		);
	}
	if (estimatedRayTests > configuration.settings.maximumRayTests) {
		throw new Error(
			`Occlusion Culling plan may require ${estimatedRayTests} ray tests, above the authored ${configuration.settings.maximumRayTests} limit. Increase Portable Cell Size, reduce samples/Areas, or reduce Static Occludees.`
		);
	}
	const warnings = sources
		.filter((source) => source.staticOccluder && !source.occluderEligible)
		.map((source) => `Static Occluder "${source.name}" is excluded because ${source.occluderReason}.`);
	const sourceFingerprint = await sha256(stable(planPayload(configuration, sources, areas, cells)));
	return {
		version: 1,
		model: "bounded-static-pvs-ray-bake-v1",
		configurationRevision: configuration.revision,
		configurationBakeRevision: configuration.bakeRevision,
		sourceFingerprint,
		sources,
		occluderMeshIds: occluders.map((source) => source.id),
		occludeeMeshIds: occludees.map((source) => source.id),
		areas,
		cells,
		estimatedRayTests,
		estimatedRelationships,
		warnings,
	};
}

function samples(minimum: readonly number[], maximum: readonly number[], count: number): Vector3[] {
	const min = Vector3.FromArray(minimum);
	const max = Vector3.FromArray(maximum);
	const center = min.add(max).scale(0.5);
	const points = [
		center,
		new Vector3(min.x, min.y, min.z),
		new Vector3(max.x, min.y, min.z),
		new Vector3(min.x, max.y, min.z),
		new Vector3(max.x, max.y, min.z),
		new Vector3(min.x, min.y, max.z),
		new Vector3(max.x, min.y, max.z),
		new Vector3(min.x, max.y, max.z),
		new Vector3(max.x, max.y, max.z),
	];
	return points.slice(0, count);
}

function intersects(leftMinimum: readonly number[], leftMaximum: readonly number[], rightMinimum: readonly number[], rightMaximum: readonly number[]): boolean {
	return !(
		leftMaximum[0] < rightMinimum[0] ||
		leftMinimum[0] > rightMaximum[0] ||
		leftMaximum[1] < rightMinimum[1] ||
		leftMinimum[1] > rightMaximum[1] ||
		leftMaximum[2] < rightMinimum[2] ||
		leftMinimum[2] > rightMaximum[2]
	);
}

function perpendiculars(direction: Vector3): [Vector3, Vector3] {
	const helper = Math.abs(direction.y) < 0.9 ? Vector3.Up() : Vector3.Right();
	const first = Vector3.Cross(direction, helper).normalize();
	return [first, Vector3.Cross(direction, first).normalize()];
}

function rayBlocked(scene: Scene, source: Vector3, target: Vector3, occluders: Set<string>, excludedMeshId: string): boolean {
	const displacement = target.subtract(source);
	const distance = displacement.length();
	if (distance <= 0.002) {
		return false;
	}
	const direction = displacement.scale(1 / distance);
	const bias = Math.min(1, Math.max(0.001, distance * 0.00001));
	const ray = new Ray(source.add(direction.scale(bias)), direction, Math.max(0.001, distance - bias * 2));
	const hit = scene.pickWithRay(ray, (mesh) => mesh.id !== excludedMeshId && occluders.has(mesh.id) && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0, false);
	return Boolean(hit?.hit && hit.distance <= ray.length);
}

interface IPathVisibilityContext {
	occluders: Set<string>;
	excludedMeshId: string;
	countRay: () => void;
}

function pathVisible(scene: Scene, source: Vector3, target: Vector3, smallestHole: number, context: IPathVisibilityContext): boolean {
	const direction = target.subtract(source).normalize();
	const offsets = [Vector3.Zero()];
	if (smallestHole > 0 && direction.lengthSquared() > 0) {
		const [first, second] = perpendiculars(direction);
		const radius = smallestHole * 0.5;
		offsets.push(first.scale(radius), first.scale(-radius), second.scale(radius), second.scale(-radius));
	}
	for (const offset of offsets) {
		context.countRay();
		if (rayBlocked(scene, source.add(offset), target.add(offset), context.occluders, context.excludedMeshId)) {
			return false;
		}
	}
	return true;
}

function backfacePercent(scene: Scene, center: Vector3, maximumDistance: number, occluders: Set<string>, countRay: () => void): number {
	const directions = [Vector3.Right(), Vector3.Left(), Vector3.Up(), Vector3.Down(), Vector3.Forward(), Vector3.Backward()];
	let hits = 0;
	let backfaces = 0;
	for (const direction of directions) {
		countRay();
		const ray = new Ray(center, direction, maximumDistance);
		const hit = scene.pickWithRay(ray, (mesh) => occluders.has(mesh.id) && mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0, false);
		if (!hit?.hit) {
			continue;
		}
		hits++;
		const pickedMesh = hit.pickedMesh;
		const positions = pickedMesh?.getVerticesData(VertexBuffer.PositionKind);
		const indices = pickedMesh?.getIndices();
		const index = hit.faceId * 3;
		let normal: Vector3 | null = null;
		if (pickedMesh && positions && indices && hit.faceId >= 0 && index + 2 < indices.length) {
			const first = Vector3.FromArray(positions, indices[index] * 3);
			const second = Vector3.FromArray(positions, indices[index + 1] * 3);
			const third = Vector3.FromArray(positions, indices[index + 2] * 3);
			normal = Vector3.TransformNormal(Vector3.Cross(third.subtract(first), second.subtract(first)).normalize(), pickedMesh.getWorldMatrix()).normalize();
		}
		if (normal && Vector3.Dot(normal, direction) > 0) {
			backfaces++;
		}
	}
	return hits ? (backfaces / hits) * 100 : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Occlusion Culling bake was cancelled before publication.");
	}
}

/** Executes the bounded conservative static PVS bake without mutating scene metadata. */
export async function bakeOcclusionCulling(scene: Scene, value?: IOcclusionCullingConfiguration, options?: IOcclusionCullingBakeOptions): Promise<IOcclusionCullingBake> {
	const configuration = normalizeOcclusionCullingConfiguration(value ?? getOcclusionCullingConfiguration(scene) ?? createDefaultOcclusionCullingConfiguration());
	const now = options?.now ?? (() => performance.now());
	const started = now();
	options?.onProgress?.({ phase: "planning", completedCells: 0, totalCells: 0, rayTests: 0, message: "Inspecting static occluders, occludees, Areas, and source signatures." });
	const plan = await inspectOcclusionCullingBake(scene, configuration);
	throwIfAborted(options?.signal);
	const occluders = new Set(plan.occluderMeshIds);
	const occludees = plan.sources.filter((source) => source.staticOccludee);
	const sourceMinimum = new Vector3(
		Math.min(...plan.sources.map((source) => source.minimum[0])),
		Math.min(...plan.sources.map((source) => source.minimum[1])),
		Math.min(...plan.sources.map((source) => source.minimum[2]))
	);
	const sourceMaximum = new Vector3(
		Math.max(...plan.sources.map((source) => source.maximum[0])),
		Math.max(...plan.sources.map((source) => source.maximum[1])),
		Math.max(...plan.sources.map((source) => source.maximum[2]))
	);
	const maximumDistance = Math.max(1, sourceMaximum.subtract(sourceMinimum).length() * 2);
	let rayTests = 0;
	const countRay = (): void => {
		rayTests++;
		if (rayTests > configuration.settings.maximumRayTests) {
			throw new Error(`Occlusion Culling exceeded the exact ${configuration.settings.maximumRayTests}-ray limit before publication.`);
		}
	};
	const cells: IOcclusionCullingCell[] = [];
	for (let index = 0; index < plan.cells.length; index++) {
		throwIfAborted(options?.signal);
		const planned = plan.cells[index];
		const cellStartedRays = rayTests;
		const percent = backfacePercent(scene, Vector3.FromArray(planned.center), maximumDistance, occluders, countRay);
		const valid = percent <= configuration.settings.backfaceThreshold;
		const visibleMeshIds: string[] = [];
		const occludedMeshIds: string[] = [];
		if (!valid) {
			visibleMeshIds.push(...occludees.map((source) => source.id));
		} else {
			const viewPoints = samples(planned.minimum, planned.maximum, configuration.settings.viewSamples);
			for (const target of occludees) {
				if (intersects(planned.minimum, planned.maximum, target.minimum, target.maximum)) {
					visibleMeshIds.push(target.id);
					continue;
				}
				const targetPoints = samples(target.minimum, target.maximum, configuration.settings.targetSamples);
				let visible = false;
				for (const viewPoint of viewPoints) {
					for (const targetPoint of targetPoints) {
						if (
							pathVisible(scene, viewPoint, targetPoint, configuration.settings.smallestHole, {
								occluders,
								excludedMeshId: target.id,
								countRay,
							})
						) {
							visible = true;
							break;
						}
					}
					if (visible) {
						break;
					}
				}
				(visible ? visibleMeshIds : occludedMeshIds).push(target.id);
			}
		}
		cells.push({
			...planned,
			valid,
			backfacePercent: percent,
			visibleMeshIds: visibleMeshIds.sort(),
			occludedMeshIds: occludedMeshIds.sort(),
			rayTests: rayTests - cellStartedRays,
		});
		options?.onProgress?.({
			phase: "baking",
			completedCells: index + 1,
			totalCells: plan.cells.length,
			rayTests,
			message: `Baked cell ${index + 1} of ${plan.cells.length}.`,
		});
		if ((index + 1) % 4 === 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}
	throwIfAborted(options?.signal);
	options?.onProgress?.({ phase: "fingerprinting", completedCells: cells.length, totalCells: cells.length, rayTests, message: "Hashing exact bake output." });
	const bakeFingerprint = await sha256(stable({ sourceFingerprint: plan.sourceFingerprint, cells }));
	const validCells = cells.filter((cell) => cell.valid).length;
	const visibleRelationships = cells.reduce((sum, cell) => sum + cell.visibleMeshIds.length, 0);
	const occludedRelationships = cells.reduce((sum, cell) => sum + cell.occludedMeshIds.length, 0);
	return {
		version: 1,
		model: "bounded-static-pvs-ray-bake-v1",
		configurationBakeRevision: configuration.bakeRevision,
		sourceFingerprint: plan.sourceFingerprint,
		bakeFingerprint,
		createdAt: new Date().toISOString(),
		sources: plan.sources,
		cells,
		warnings: plan.warnings,
		statistics: {
			areaCount: plan.areas.length,
			cellCount: cells.length,
			validCellCount: validCells,
			invalidCellCount: cells.length - validCells,
			sourceMeshCount: plan.sources.length,
			occluderCount: plan.occluderMeshIds.length,
			occludeeCount: plan.occludeeMeshIds.length,
			visibleRelationships,
			occludedRelationships,
			rayTests,
			durationMilliseconds: Math.max(0, now() - started),
		},
	};
}

function sceneConfigurations(scene: Scene): IOcclusionCullingConfiguration[] {
	const sets = scene.metadata?.[occlusionCullingSetsMetadataKey];
	if (sets !== undefined) {
		if (!Array.isArray(sets) || sets.length > 64) {
			throw new Error("Additive Occlusion Culling configuration sets must contain at most 64 entries.");
		}
		return sets.map(normalizeOcclusionCullingConfiguration);
	}
	const value = scene.metadata?.[occlusionCullingMetadataKey];
	return value === undefined ? [] : [normalizeOcclusionCullingConfiguration(value)];
}

function cellVolume(cell: IOcclusionCullingCell): number {
	return Math.max(0, cell.maximum[0] - cell.minimum[0]) * Math.max(0, cell.maximum[1] - cell.minimum[1]) * Math.max(0, cell.maximum[2] - cell.minimum[2]);
}

function contains(cell: IOcclusionCullingCell, point: Vector3): boolean {
	const epsilon = 0.000001;
	return (
		point.x >= cell.minimum[0] - epsilon &&
		point.x <= cell.maximum[0] + epsilon &&
		point.y >= cell.minimum[1] - epsilon &&
		point.y <= cell.maximum[1] + epsilon &&
		point.z >= cell.minimum[2] - epsilon &&
		point.z <= cell.maximum[2] + epsilon
	);
}

/** Owns per-camera baked PVS application, exact restoration, stale evidence, and supplementary native dynamic queries. */
export class OcclusionCullingRuntime {
	private _beforeCameraObserver: any;
	private _afterCameraObserver: any;
	private _afterRenderObserver: any;
	private _disposeObserver: any;
	private _visibilitySnapshots: IVisibilitySnapshot[] = [];
	private readonly _querySnapshots = new Map<AbstractMesh, IQuerySnapshot>();
	private _configurations: IOcclusionCullingRuntimeConfiguration[] = [];
	private _errors: string[] = [];
	private _dynamicQueryMeshIds: string[] = [];
	private readonly _cameraStates = new Map<string, IOcclusionCullingCameraRuntimeState>();
	private _disposed = false;

	public constructor(private readonly _scene: Scene) {
		this._beforeCameraObserver = _scene.onBeforeCameraRenderObservable.add((camera) => this._beforeCamera(camera));
		this._afterCameraObserver = _scene.onAfterCameraRenderObservable.add(() => this._restoreVisibility());
		this._afterRenderObserver = _scene.onAfterRenderObservable.add(() => this._restoreVisibility());
		this._disposeObserver = _scene.onDisposeObservable.addOnce(() => this.dispose());
		this.refresh();
	}

	public refresh(): void {
		if (this._disposed) {
			return;
		}
		this._restoreVisibility();
		this._restoreQueries();
		this._errors = [];
		this._configurations = [];
		try {
			for (const configuration of sceneConfigurations(this._scene)) {
				if (!configuration.enabled || !configuration.bake) {
					continue;
				}
				this._configurations.push({
					configuration,
					bake: configuration.bake,
					staleReason:
						configuration.bake.configurationBakeRevision === configuration.bakeRevision
							? null
							: `bake revision ${configuration.bake.configurationBakeRevision} does not match authoring revision ${configuration.bakeRevision}`,
				});
			}
		} catch (error) {
			this._errors.push(error instanceof Error ? error.message : String(error));
		}
		this._applyQueries();
	}

	public getState(): IOcclusionCullingRuntimeState {
		return {
			configured: this._configurations.length > 0,
			configurationCount: this._configurations.length,
			hardwareQueriesSupported: Boolean(this._scene.getEngine().getCaps().supportOcclusionQuery),
			dynamicQueryMeshIds: [...this._dynamicQueryMeshIds],
			cameras: [...this._cameraStates.values()].map((state) => structuredClone(state)),
			errors: [...this._errors],
		};
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._restoreVisibility();
		this._restoreQueries();
		this._scene.onBeforeCameraRenderObservable.remove(this._beforeCameraObserver);
		this._scene.onAfterCameraRenderObservable.remove(this._afterCameraObserver);
		this._scene.onAfterRenderObservable.remove(this._afterRenderObserver);
		this._scene.onDisposeObservable.remove(this._disposeObserver);
		if (this._scene.occlusionCulling === this) {
			this._scene.occlusionCulling = undefined;
		}
	}

	private _applyQueries(): void {
		const supported = Boolean(this._scene.getEngine().getCaps().supportOcclusionQuery);
		this._dynamicQueryMeshIds = [];
		for (const mesh of this._scene.meshes) {
			let settings: IOcclusionCullingMeshSettings;
			try {
				settings = getOcclusionCullingMeshSettings(mesh);
			} catch (error) {
				this._errors.push(`Mesh "${mesh.name}": ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (!settings.dynamicOcclusion || !supported) {
				continue;
			}
			this._querySnapshots.set(mesh, {
				mesh,
				occlusionType: mesh.occlusionType,
				occlusionRetryCount: mesh.occlusionRetryCount,
				forceRenderingWhenOccluded: mesh.forceRenderingWhenOccluded,
			});
			mesh.occlusionType = settings.queryMode === "strict" ? AbstractMesh.OCCLUSION_TYPE_STRICT : AbstractMesh.OCCLUSION_TYPE_OPTIMISTIC;
			mesh.occlusionRetryCount = settings.queryRetryCount;
			mesh.forceRenderingWhenOccluded = settings.forceRenderingWhenOccluded;
			this._dynamicQueryMeshIds.push(mesh.id);
		}
		this._dynamicQueryMeshIds.sort();
	}

	private _restoreQueries(): void {
		this._querySnapshots.forEach((snapshot) => {
			if (!snapshot.mesh.isDisposed()) {
				snapshot.mesh.occlusionType = snapshot.occlusionType;
				snapshot.mesh.occlusionRetryCount = snapshot.occlusionRetryCount;
				snapshot.mesh.forceRenderingWhenOccluded = snapshot.forceRenderingWhenOccluded;
			}
		});
		this._querySnapshots.clear();
		this._dynamicQueryMeshIds = [];
	}

	private _configurationStaleReason(runtime: IOcclusionCullingRuntimeConfiguration): string | null {
		if (runtime.staleReason) {
			return runtime.staleReason;
		}
		for (const source of runtime.bake.sources) {
			const matches = this._scene.meshes.filter((mesh) => mesh.id === source.id);
			if (matches.length !== 1) {
				return matches.length ? `source mesh id "${source.id}" is duplicated` : `source mesh "${source.name}" is missing`;
			}
			try {
				if (meshSignature(matches[0]) !== source.signature) {
					return `source mesh "${source.name}" changed after baking`;
				}
			} catch (error) {
				return `source mesh "${source.name}" could not be verified: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		return null;
	}

	private _beforeCamera(camera: Camera): void {
		this._restoreVisibility();
		const started = typeof performance === "undefined" ? Date.now() : performance.now();
		let enabled = true;
		try {
			enabled = getOcclusionCullingCameraSettings(camera).enabled;
		} catch (error) {
			this._errors.push(`Camera "${camera.name}": ${error instanceof Error ? error.message : String(error)}`);
			enabled = false;
		}
		const state: IOcclusionCullingCameraRuntimeState = {
			cameraId: camera.id,
			cameraName: camera.name,
			enabled,
			activeCellId: null,
			activeBakeFingerprint: null,
			bakedCulledMeshIds: [],
			bakedVisibleMeshIds: [],
			hardwareOccludedMeshIds: this._dynamicQueryMeshIds.filter((id) => this._scene.getMeshById(id)?.isOccluded),
			staleReason: null,
			frameId: this._scene.getFrameId(),
			durationMilliseconds: 0,
		};
		if (!enabled) {
			state.staleReason = "Occlusion Culling is disabled on this camera.";
			state.durationMilliseconds = Math.max(0, (typeof performance === "undefined" ? Date.now() : performance.now()) - started);
			this._cameraStates.set(camera.id, state);
			return;
		}
		camera.getWorldMatrix();
		const point = camera.globalPosition ?? camera.position;
		const candidates = this._configurations
			.flatMap((runtime) => runtime.bake.cells.filter((cell) => contains(cell, point)).map((cell) => ({ runtime, cell })))
			.sort((left, right) => cellVolume(left.cell) - cellVolume(right.cell) || left.cell.id.localeCompare(right.cell.id));
		if (!candidates.length) {
			state.staleReason = this._configurations.length ? "Camera is outside every baked Occlusion Area/View Volume." : "No enabled Occlusion Culling bake is configured.";
		} else {
			const { runtime, cell } = candidates[0];
			state.activeCellId = cell.id;
			state.activeBakeFingerprint = runtime.bake.bakeFingerprint;
			state.staleReason = this._configurationStaleReason(runtime);
			if (!state.staleReason && !cell.valid) {
				state.staleReason = `Cell "${cell.id}" exceeded Backface Threshold during baking.`;
			}
			if (!state.staleReason) {
				const visible = new Set(cell.visibleMeshIds);
				for (const source of runtime.bake.sources.filter((candidate) => candidate.staticOccludee)) {
					const mesh = this._scene.getMeshById(source.id);
					if (!mesh) {
						continue;
					}
					if (visible.has(source.id)) {
						state.bakedVisibleMeshIds.push(source.id);
						continue;
					}
					this._visibilitySnapshots.push({ mesh, isVisible: mesh.isVisible, visibility: mesh.visibility });
					mesh.isVisible = false;
					state.bakedCulledMeshIds.push(source.id);
				}
				state.bakedVisibleMeshIds.sort();
				state.bakedCulledMeshIds.sort();
			}
		}
		state.durationMilliseconds = Math.max(0, (typeof performance === "undefined" ? Date.now() : performance.now()) - started);
		this._cameraStates.set(camera.id, state);
	}

	private _restoreVisibility(): void {
		for (const snapshot of this._visibilitySnapshots) {
			if (!snapshot.mesh.isDisposed()) {
				snapshot.mesh.isVisible = snapshot.isVisible;
				snapshot.mesh.visibility = snapshot.visibility;
			}
		}
		this._visibilitySnapshots = [];
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		/** Shared baked/static and hardware/dynamic Occlusion Culling runtime. */
		occlusionCulling?: OcclusionCullingRuntime;
	}
}

/** Creates or refreshes the one shared full/additive scene runtime. */
export function configureOcclusionCulling(scene: Scene): OcclusionCullingRuntime | null {
	const hasConfiguration = scene.metadata?.[occlusionCullingMetadataKey] !== undefined || scene.metadata?.[occlusionCullingSetsMetadataKey] !== undefined;
	if (!hasConfiguration) {
		scene.occlusionCulling?.dispose();
		return null;
	}
	if (scene.occlusionCulling) {
		scene.occlusionCulling.refresh();
		return scene.occlusionCulling;
	}
	scene.occlusionCulling = new OcclusionCullingRuntime(scene);
	return scene.occlusionCulling;
}
