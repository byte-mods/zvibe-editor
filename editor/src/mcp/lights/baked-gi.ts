import { dirname, join, relative } from "path/posix";
import { lstat, realpath } from "fs/promises";
import { ensureDir, move, pathExists, remove, writeFile } from "fs-extra";

import sharp from "sharp";

import {
	Color3,
	DirectionalLight,
	HemisphericLight,
	Light,
	Material,
	Mesh,
	MultiMaterial,
	PBRMaterial,
	PointLight,
	Ray,
	Scene,
	SpotLight,
	StandardMaterial,
	Texture,
	Vector3,
	VertexBuffer,
	VertexData,
} from "babylonjs";
import { areaLightDiscSegments, getAreaLightBasis, getAreaLightSamplePoints } from "babylonjs-editor-tools";

import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { projectConfiguration } from "../../project/configuration";
import { isMultiMaterial, isPBRMaterial, isStandardMaterial } from "../../tools/guards/material";
import { isRectAreaLight } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";

const BAKED_GI_METADATA_KEY = "babylonEditorBakedGi";
const BAKED_GI_BACKEND = "bounded-cpu-one-bounce-v1";
const MAX_BAKE_MESHES = 128;
const MAX_LIGHTMAP_TEXELS = 128 * 256 * 256;

type TBakedGiUvSource = "uv0" | "uv2";

interface IBakedGiMaterialSnapshotNone {
	kind: "none";
}

interface IBakedGiMaterialSnapshotSingle {
	kind: "single";
	material: Record<string, unknown>;
}

interface IBakedGiMaterialSnapshotMulti {
	kind: "multi";
	material: Record<string, unknown>;
	subMaterials: (Record<string, unknown> | null)[];
}

type TBakedGiMaterialSnapshot = IBakedGiMaterialSnapshotNone | IBakedGiMaterialSnapshotSingle | IBakedGiMaterialSnapshotMulti;

export interface IBakedGiMeshEntry {
	meshId: string;
	meshName: string;
	originalMaterialId: string | null;
	originalMaterial: TBakedGiMaterialSnapshot;
	bakedMaterialId: string;
	bakedSubMaterialIds: string[];
	lightmapPath: string;
	coordinatesIndex: number;
	uvSource: TBakedGiUvSource;
	coveredTexels: number;
	overlapTexels: number;
	saturatedTexels: number;
	rayCount: number;
}

export interface IBakedGiManifest {
	version: 1;
	backend: typeof BAKED_GI_BACKEND;
	bakeId: string;
	createdAt: string;
	outputDirectory: string;
	resolution: number;
	samples: number;
	bounces: 0 | 1;
	directIntensity: number;
	indirectIntensity: number;
	shadowing: boolean;
	shadowBias: number;
	maxDistance: number;
	dilation: number;
	encoding: "linear-rgba8-clamped";
	limitations: string[];
	meshEntries: IBakedGiMeshEntry[];
}

interface IValidatedBakedGiOptions {
	resolution: number;
	samples: number;
	bounces: 0 | 1;
	directIntensity: number;
	indirectIntensity: number;
	shadowing: boolean;
	shadowBias: number;
	maxDistance: number;
	dilation: number;
	uvChannel: "auto" | TBakedGiUvSource;
	outputDirectory: string;
}

interface IPreparedBakeMesh {
	mesh: Mesh;
	material: Material;
	originalMaterial: TBakedGiMaterialSnapshot;
	positions: number[];
	normals: number[];
	uvs: number[];
	indices: number[];
	uvSource: TBakedGiUvSource;
	coordinatesIndex: number;
}

export interface IBakedGiRasterResult {
	rgba: Uint8Array;
	coveredTexels: number;
	overlapTexels: number;
	saturatedTexels: number;
	rayCount: number;
}

interface ILightSample {
	color: Color3;
	rayCount: number;
}

interface IClosestPick {
	mesh: Mesh;
	point: Vector3;
	normal: Vector3;
	subMeshId: number;
}

interface ICreatedBakedMaterial {
	root: Material;
	leaves: (PBRMaterial | StandardMaterial)[];
}

/** Returns the active project's absolute root directory. */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open. Open a project before baking global illumination.");
	}
	return dirname(projectConfiguration.path);
}

/** Resolves a project-relative generated directory and rejects traversal or absolute paths. */
function resolveGeneratedDirectory(projectDirectory: string, projectRelativePath: string): string {
	if (!projectRelativePath || projectRelativePath.startsWith("/") || /^[A-Za-z]:/.test(projectRelativePath)) {
		throw new Error("Baked-GI outputDirectory must be a non-empty project-relative directory.");
	}
	const absolutePath = join(projectDirectory, projectRelativePath);
	const containment = relative(projectDirectory, absolutePath);
	if (containment === ".." || containment.startsWith("../") || containment === "") {
		throw new Error("Baked-GI outputDirectory must stay inside the open project directory.");
	}
	return absolutePath;
}

/** Rejects existing symlink components and canonical paths that escape the project root. */
async function assertGeneratedDirectorySafe(projectDirectory: string, absolutePath: string): Promise<void> {
	const canonicalProject = await realpath(projectDirectory);
	const pathFromProject = relative(projectDirectory, absolutePath);
	let currentPath = projectDirectory;
	for (const component of pathFromProject.split("/").filter(Boolean)) {
		currentPath = join(currentPath, component);
		if (!(await pathExists(currentPath))) {
			continue;
		}
		if ((await lstat(currentPath)).isSymbolicLink()) {
			throw new Error(`Baked-GI generated paths must not traverse symbolic links: ${relative(projectDirectory, currentPath)}.`);
		}
		const canonicalCurrent = await realpath(currentPath);
		const containment = relative(canonicalProject, canonicalCurrent);
		if (containment === ".." || containment.startsWith("../")) {
			throw new Error("Baked-GI generated paths must remain inside the canonical project directory.");
		}
	}
}

/** Reads the persisted bake manifest without creating metadata as a side effect. */
export function readBakedGlobalIlluminationManifest(scene: Scene): IBakedGiManifest | null {
	return (scene.metadata?.[BAKED_GI_METADATA_KEY] as IBakedGiManifest | undefined) ?? null;
}

/** Returns the currently configured baked-GI manifest and aggregate evidence. */
export function getBakedGlobalIllumination(scene: Scene): Record<string, unknown> {
	const manifest = readBakedGlobalIlluminationManifest(scene);
	if (!manifest) {
		return { configured: false, backend: BAKED_GI_BACKEND };
	}
	return {
		configured: true,
		...structuredClone(manifest),
		meshCount: manifest.meshEntries.length,
		totalCoveredTexels: manifest.meshEntries.reduce((sum, entry) => sum + entry.coveredTexels, 0),
		totalOverlapTexels: manifest.meshEntries.reduce((sum, entry) => sum + entry.overlapTexels, 0),
		totalSaturatedTexels: manifest.meshEntries.reduce((sum, entry) => sum + entry.saturatedTexels, 0),
		totalRayCount: manifest.meshEntries.reduce((sum, entry) => sum + entry.rayCount, 0),
	};
}

/** Validates bounded bake options before any ray tracing or file mutation occurs. */
function validateOptions(data: Record<string, unknown>): IValidatedBakedGiOptions {
	const resolution = data.resolution ?? 64;
	const samples = data.samples ?? 4;
	const bounces = data.bounces ?? 1;
	const directIntensity = data.directIntensity ?? 1;
	const indirectIntensity = data.indirectIntensity ?? 0.5;
	const shadowing = data.shadowing ?? true;
	const shadowBias = data.shadowBias ?? 0.05;
	const maxDistance = data.maxDistance ?? 10000;
	const dilation = data.dilation ?? 2;
	const uvChannel = data.uvChannel ?? "auto";
	const outputDirectory = data.outputDirectory ?? "assets/Lighting/BakedGI";

	if (!Number.isInteger(resolution) || (resolution as number) < 16 || (resolution as number) > 256) {
		throw new Error("Baked-GI resolution must be an integer from 16 through 256 pixels per mesh.");
	}
	if (!Number.isInteger(samples) || (samples as number) < 1 || (samples as number) > 32) {
		throw new Error("Baked-GI samples must be an integer from 1 through 32.");
	}
	if (bounces !== 0 && bounces !== 1) {
		throw new Error("Baked-GI bounces must be 0 or 1 for the bounded CPU backend.");
	}
	for (const [name, value, maximum] of [
		["directIntensity", directIntensity, 8],
		["indirectIntensity", indirectIntensity, 8],
		["shadowBias", shadowBias, 100],
		["maxDistance", maxDistance, 1000000],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
			throw new Error(`Baked-GI ${name} must be a finite value from 0 through ${maximum}.`);
		}
	}
	if (maxDistance === 0) {
		throw new Error("Baked-GI maxDistance must be greater than zero.");
	}
	if (!Number.isInteger(dilation) || (dilation as number) < 0 || (dilation as number) > 16) {
		throw new Error("Baked-GI dilation must be an integer from 0 through 16 pixels.");
	}
	if (typeof shadowing !== "boolean") {
		throw new Error("Baked-GI shadowing must be a boolean.");
	}
	if (uvChannel !== "auto" && uvChannel !== "uv0" && uvChannel !== "uv2") {
		throw new Error('Baked-GI uvChannel must be "auto", "uv0", or "uv2".');
	}
	if (typeof outputDirectory !== "string") {
		throw new Error("Baked-GI outputDirectory must be a project-relative string.");
	}

	return {
		resolution: resolution as number,
		samples: samples as number,
		bounces: bounces as 0 | 1,
		directIntensity: directIntensity as number,
		indirectIntensity: indirectIntensity as number,
		shadowing,
		shadowBias: shadowBias as number,
		maxDistance: maxDistance as number,
		dilation: dilation as number,
		uvChannel,
		outputDirectory: outputDirectory.replace(/\\/g, "/").replace(/\/$/, ""),
	};
}

/** Captures a serializable original material, including every MultiMaterial child. */
function snapshotMaterial(material: Material | null): TBakedGiMaterialSnapshot {
	if (!material) {
		return { kind: "none" };
	}
	if (isMultiMaterial(material)) {
		return {
			kind: "multi",
			material: structuredClone(material.serialize()),
			subMaterials: material.subMaterials.map((subMaterial) => (subMaterial ? structuredClone(subMaterial.serialize()) : null)),
		};
	}
	return { kind: "single", material: structuredClone(material.serialize()) };
}

/** Validates that a material can consume a Babylon lightmap. */
function validateSupportedMaterial(material: Material, meshName: string): void {
	const leaves = isMultiMaterial(material) ? material.subMaterials.filter((candidate): candidate is Material => candidate !== null) : [material];
	if (!leaves.length) {
		throw new Error(`Mesh "${meshName}" has an empty MultiMaterial and cannot receive a baked lightmap.`);
	}
	const unsupported = leaves.find((candidate) => !isPBRMaterial(candidate) && !isStandardMaterial(candidate));
	if (unsupported) {
		throw new Error(
			`Mesh "${meshName}" uses ${unsupported.getClassName()} material "${unsupported.name}". Automatic baked GI currently supports PBR and Standard material leaves.`
		);
	}
}

/** Selects and fully validates bake targets before the operation can mutate the scene or disk. */
function prepareMeshes(scene: Scene, data: Record<string, unknown>, options: IValidatedBakedGiOptions): IPreparedBakeMesh[] {
	const requestedIds = data.meshIds;
	if (requestedIds !== undefined && (!Array.isArray(requestedIds) || requestedIds.some((id) => typeof id !== "string" || !id))) {
		throw new Error("Baked-GI meshIds must be an array of non-empty stable mesh IDs.");
	}
	const uniqueIds = requestedIds ? [...new Set(requestedIds as string[])] : null;
	if (uniqueIds && uniqueIds.length !== (requestedIds as string[]).length) {
		throw new Error("Baked-GI meshIds must not contain duplicates.");
	}
	if (uniqueIds?.length) {
		const missing = uniqueIds.filter((id) => !scene.getMeshById(id));
		if (missing.length) {
			throw new Error(`Baked-GI meshIds were not found in the active scene: ${missing.join(", ")}.`);
		}
	}

	const selected = scene.meshes
		.filter((candidate): candidate is Mesh => candidate instanceof Mesh)
		.filter((mesh) => (uniqueIds ? uniqueIds.includes(mesh.id) : mesh.geometry !== null && mesh.getTotalVertices() > 0 && mesh.isEnabled() && mesh.isVisible))
		.sort((left, right) => left.id.localeCompare(right.id));
	if (!selected.length) {
		throw new Error("No eligible authored meshes were selected for baked GI.");
	}
	if (selected.length > MAX_BAKE_MESHES) {
		throw new Error(`Baked GI is bounded to ${MAX_BAKE_MESHES} meshes per bake; select a smaller set.`);
	}
	if (selected.length * options.resolution * options.resolution > MAX_LIGHTMAP_TEXELS) {
		throw new Error(`The requested bake exceeds the ${MAX_LIGHTMAP_TEXELS.toLocaleString()}-texel safety budget; lower resolution or select fewer meshes.`);
	}

	return selected.map((mesh) => {
		if (!mesh.geometry || mesh.getTotalVertices() === 0) {
			throw new Error(`Mesh "${mesh.name}" has no bakeable vertex geometry.`);
		}
		const material = mesh.material ?? scene.defaultMaterial;
		validateSupportedMaterial(material, mesh.name);
		const rawPositions = mesh.getVerticesData(VertexBuffer.PositionKind);
		const rawNormals = mesh.getVerticesData(VertexBuffer.NormalKind);
		const rawIndices = mesh.getIndices();
		if (!rawPositions || rawPositions.length < 9 || !rawIndices || rawIndices.length < 3 || rawIndices.length % 3 !== 0) {
			throw new Error(`Mesh "${mesh.name}" must contain indexed triangle geometry for baked GI.`);
		}
		const vertexCount = rawPositions.length / 3;
		const uv2 = mesh.getVerticesData(VertexBuffer.UV2Kind);
		const uv0 = mesh.getVerticesData(VertexBuffer.UVKind);
		let uvSource: TBakedGiUvSource;
		let rawUvs: ArrayLike<number> | null;
		if (options.uvChannel === "uv2") {
			uvSource = "uv2";
			rawUvs = uv2;
		} else if (options.uvChannel === "uv0") {
			uvSource = "uv0";
			rawUvs = uv0;
		} else if (uv2?.length === vertexCount * 2) {
			uvSource = "uv2";
			rawUvs = uv2;
		} else {
			uvSource = "uv0";
			rawUvs = uv0;
		}
		if (!rawUvs || rawUvs.length !== vertexCount * 2) {
			throw new Error(
				`Mesh "${mesh.name}" has no valid ${uvSource.toUpperCase()} coordinates. Generate non-overlapping lightmap UVs or select a valid UV channel before baking.`
			);
		}
		const positions = Array.from(rawPositions);
		const indices = Array.from(rawIndices);
		const normals = rawNormals?.length === rawPositions.length ? Array.from(rawNormals) : new Array<number>(rawPositions.length).fill(0);
		if (!rawNormals || rawNormals.length !== rawPositions.length) {
			VertexData.ComputeNormals(positions, indices, normals);
		}
		return {
			mesh,
			material,
			originalMaterial: snapshotMaterial(mesh.material),
			positions,
			normals,
			uvs: Array.from(rawUvs),
			indices,
			uvSource,
			coordinatesIndex: uvSource === "uv2" ? 1 : 0,
		};
	});
}

/** Finds the nearest world-space triangle hit without relying on editor pickability flags. */
function pickClosest(scene: Scene, ray: Ray): IClosestPick | null {
	let closestDistance = Number.POSITIVE_INFINITY;
	let closest: IClosestPick | null = null;
	for (const candidate of scene.meshes) {
		if (!(candidate instanceof Mesh) || !candidate.geometry || candidate.getTotalVertices() === 0 || !candidate.isEnabled() || !candidate.isVisible) {
			continue;
		}
		const pick = ray.intersectsMesh(candidate, false);
		if (!pick.hit || !pick.pickedPoint || pick.distance < 0 || pick.distance >= closestDistance || pick.distance > ray.length) {
			continue;
		}
		const normal = pick.getNormal(true, true);
		if (!normal) {
			continue;
		}
		closestDistance = pick.distance;
		closest = { mesh: candidate, point: pick.pickedPoint.clone(), normal: normal.normalize(), subMeshId: pick.subMeshId };
	}
	return closest;
}

/** Returns whether a surface-to-light segment is blocked by real scene geometry. */
function isOccluded(scene: Scene, point: Vector3, normal: Vector3, direction: Vector3, distance: number, bias: number): boolean {
	if (distance <= bias) {
		return false;
	}
	const ray = new Ray(point.add(normal.scale(bias)), direction, distance - bias);
	return pickClosest(scene, ray) !== null;
}

/** Evaluates supported realtime lights at one world-space surface point. */
function sampleDirectLighting(scene: Scene, receiver: Mesh, point: Vector3, normal: Vector3, options: IValidatedBakedGiOptions, castShadowRays: boolean): ILightSample {
	const output = scene.ambientColor.clone();
	if (scene.environmentTexture) {
		const environmentFloor = Math.max(0, scene.environmentIntensity) * 0.08;
		output.addInPlace(new Color3(environmentFloor, environmentFloor, environmentFloor));
	}
	let rayCount = 0;
	for (const light of scene.lights) {
		if (!light.isEnabled() || light.intensity <= 0 || (light as Light & { canAffectMesh?: (mesh: Mesh) => boolean }).canAffectMesh?.(receiver) === false) {
			continue;
		}
		let directionToLight: Vector3;
		let attenuation = 1;
		let distance = options.maxDistance;
		if (isRectAreaLight(light)) {
			const rawBasis = getAreaLightBasis(light as any);
			const basisDirection = Vector3.FromArray(rawBasis.direction.asArray());
			const samples = getAreaLightSamplePoints(light as any, areaLightDiscSegments).map((sample) => Vector3.FromArray(sample.asArray()));
			for (const lightPoint of samples) {
				if (Vector3.Dot(basisDirection, point.subtract(lightPoint)) <= 0) {
					continue;
				}
				const delta = lightPoint.subtract(point);
				const sampleDistance = delta.length();
				if (sampleDistance <= options.shadowBias || (Number.isFinite(light.range) && light.range > 0 && sampleDistance > light.range)) {
					continue;
				}
				const sampleDirection = delta.scale(1 / sampleDistance);
				const lambert = Math.max(0, Vector3.Dot(normal, sampleDirection));
				if (lambert === 0) {
					continue;
				}
				let sampleAttenuation = 1;
				if (Number.isFinite(light.range) && light.range > 0) {
					const normalizedDistance = sampleDistance / light.range;
					sampleAttenuation = Math.max(0, 1 - normalizedDistance * normalizedDistance);
				}
				if (castShadowRays && options.shadowing) {
					rayCount++;
					if (isOccluded(scene, point, normal, sampleDirection, sampleDistance, options.shadowBias)) {
						continue;
					}
				}
				output.addInPlace(light.diffuse.scale((light.intensity * sampleAttenuation * lambert) / samples.length));
			}
			continue;
		}
		if (light instanceof HemisphericLight) {
			const sky = Math.max(0, Math.min(1, Vector3.Dot(normal, light.direction.normalize()) * 0.5 + 0.5));
			const ground = light.groundColor.scale(1 - sky);
			output.addInPlace(light.diffuse.scale(sky).add(ground).scale(light.intensity));
			continue;
		}
		if (light instanceof DirectionalLight) {
			directionToLight = light.getShadowDirection().negate().normalize();
		} else if (light instanceof PointLight || light instanceof SpotLight) {
			const lightPosition = light.getAbsolutePosition();
			const delta = lightPosition.subtract(point);
			distance = delta.length();
			if (distance === 0 || (Number.isFinite(light.range) && light.range > 0 && distance > light.range)) {
				continue;
			}
			directionToLight = delta.scale(1 / distance);
			if (Number.isFinite(light.range) && light.range > 0) {
				const normalizedDistance = distance / light.range;
				attenuation = Math.max(0, 1 - normalizedDistance * normalizedDistance);
			}
			if (light instanceof SpotLight) {
				const coneDot = Vector3.Dot(light.getShadowDirection().normalize(), directionToLight.negate());
				const coneLimit = Math.cos(light.angle * 0.5);
				if (coneDot <= coneLimit) {
					continue;
				}
				attenuation *= Math.pow((coneDot - coneLimit) / Math.max(1e-6, 1 - coneLimit), Math.max(0, light.exponent));
			}
		} else {
			continue;
		}
		const lambert = Math.max(0, Vector3.Dot(normal, directionToLight));
		if (lambert === 0 || attenuation === 0) {
			continue;
		}
		if (castShadowRays && options.shadowing) {
			rayCount++;
			if (isOccluded(scene, point, normal, directionToLight, distance, options.shadowBias)) {
				continue;
			}
		}
		output.addInPlace(light.diffuse.scale(light.intensity * attenuation * lambert));
	}
	return { color: output.scale(options.directIntensity), rayCount };
}

/** Selects the material leaf hit by a ray for deterministic one-bounce albedo. */
function pickedMaterial(pick: IClosestPick): Material | null {
	const material = pick.mesh.material;
	if (!material) {
		return null;
	}
	if (!isMultiMaterial(material)) {
		return material;
	}
	return pick.mesh.subMeshes[pick.subMeshId]?.getMaterial() ?? null;
}

/** Returns the constant material colors supported by the bounded CPU bounce integrator. */
function materialRadiance(material: Material | null): { albedo: Color3; emissive: Color3 } {
	if (material && isPBRMaterial(material)) {
		return { albedo: material.albedoColor, emissive: material.emissiveColor };
	}
	if (material && isStandardMaterial(material)) {
		return { albedo: material.diffuseColor, emissive: material.emissiveColor };
	}
	return { albedo: Color3.White(), emissive: Color3.Black() };
}

/** Van der Corput radical inverse used for stable hemisphere sample rotation. */
function radicalInverse(index: number): number {
	let bits = index;
	let inverse = 0;
	let fraction = 0.5;
	while (bits > 0) {
		inverse += (bits & 1) * fraction;
		bits >>>= 1;
		fraction *= 0.5;
	}
	return inverse;
}

/** Returns one deterministic cosine-weighted world-space hemisphere direction. */
function hemisphereDirection(normal: Vector3, sampleIndex: number, sampleCount: number): Vector3 {
	const radius = Math.sqrt((sampleIndex + 0.5) / sampleCount);
	const angle = Math.PI * 2 * radicalInverse(sampleIndex + 1);
	const localX = Math.cos(angle) * radius;
	const localY = Math.sin(angle) * radius;
	const localZ = Math.sqrt(Math.max(0, 1 - radius * radius));
	const tangentSeed = Math.abs(normal.y) < 0.999 ? Vector3.Up() : Vector3.Right();
	const tangent = Vector3.Cross(tangentSeed, normal).normalize();
	const bitangent = Vector3.Cross(normal, tangent).normalize();
	return tangent.scale(localX).add(bitangent.scale(localY)).add(normal.scale(localZ)).normalize();
}

/** Evaluates a deterministic one-bounce diffuse approximation at a surface point. */
function sampleIndirectLighting(scene: Scene, point: Vector3, normal: Vector3, options: IValidatedBakedGiOptions): ILightSample {
	if (options.bounces === 0 || options.indirectIntensity === 0) {
		return { color: Color3.Black(), rayCount: 0 };
	}
	const accumulated = Color3.Black();
	let rayCount = 0;
	for (let sampleIndex = 0; sampleIndex < options.samples; sampleIndex++) {
		const direction = hemisphereDirection(normal, sampleIndex, options.samples);
		const ray = new Ray(point.add(normal.scale(options.shadowBias)), direction, options.maxDistance);
		rayCount++;
		const pick = pickClosest(scene, ray);
		if (!pick) {
			continue;
		}
		const direct = sampleDirectLighting(scene, pick.mesh, pick.point, pick.normal, options, false).color;
		const surface = materialRadiance(pickedMaterial(pick));
		accumulated.addInPlace(
			new Color3(surface.albedo.r * direct.r + surface.emissive.r, surface.albedo.g * direct.g + surface.emissive.g, surface.albedo.b * direct.b + surface.emissive.b)
		);
	}
	return { color: accumulated.scale(options.indirectIntensity / options.samples), rayCount };
}

/** Returns barycentric weights at a UV point, or null for a degenerate/outside triangle. */
function barycentric(
	point: readonly [number, number],
	firstVertex: readonly [number, number],
	secondVertex: readonly [number, number],
	thirdVertex: readonly [number, number]
): [number, number, number] | null {
	const [px, py] = point;
	const [ax, ay] = firstVertex;
	const [bx, by] = secondVertex;
	const [cx, cy] = thirdVertex;
	const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
	if (Math.abs(denominator) < 1e-10) {
		return null;
	}
	const first = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator;
	const second = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator;
	const third = 1 - first - second;
	const epsilon = -1e-6;
	return first >= epsilon && second >= epsilon && third >= epsilon ? [first, second, third] : null;
}

/** Expands valid lightmap texels into empty chart padding without crossing existing coverage. */
function dilateLightmap(colors: Float32Array, counts: Uint16Array, resolution: number, iterations: number): void {
	for (let iteration = 0; iteration < iterations; iteration++) {
		const sourceCounts = counts.slice();
		const sourceColors = colors.slice();
		for (let y = 0; y < resolution; y++) {
			for (let x = 0; x < resolution; x++) {
				const pixel = y * resolution + x;
				if (sourceCounts[pixel] > 0) {
					continue;
				}
				let neighbors = 0;
				let red = 0;
				let green = 0;
				let blue = 0;
				for (const [offsetX, offsetY] of [
					[-1, 0],
					[1, 0],
					[0, -1],
					[0, 1],
				] as const) {
					const neighborX = x + offsetX;
					const neighborY = y + offsetY;
					if (neighborX < 0 || neighborY < 0 || neighborX >= resolution || neighborY >= resolution) {
						continue;
					}
					const neighbor = neighborY * resolution + neighborX;
					if (sourceCounts[neighbor] === 0) {
						continue;
					}
					red += sourceColors[neighbor * 3];
					green += sourceColors[neighbor * 3 + 1];
					blue += sourceColors[neighbor * 3 + 2];
					neighbors++;
				}
				if (neighbors > 0) {
					colors[pixel * 3] = red / neighbors;
					colors[pixel * 3 + 1] = green / neighbors;
					colors[pixel * 3 + 2] = blue / neighbors;
					counts[pixel] = 1;
				}
			}
		}
	}
}

/** Rasterizes and ray-traces one mesh into a bounded linear RGBA8 lightmap. */
export function rasterizeBakedGiLightmap(scene: Scene, prepared: IPreparedBakeMesh, options: IValidatedBakedGiOptions): IBakedGiRasterResult {
	const resolution = options.resolution;
	const colors = new Float32Array(resolution * resolution * 3);
	const counts = new Uint16Array(resolution * resolution);
	const world = prepared.mesh.computeWorldMatrix(true);
	let overlapTexels = 0;
	let rayCount = 0;

	for (let indexOffset = 0; indexOffset < prepared.indices.length; indexOffset += 3) {
		const vertexIndices = [prepared.indices[indexOffset], prepared.indices[indexOffset + 1], prepared.indices[indexOffset + 2]];
		if (vertexIndices.some((index) => index < 0 || index * 3 + 2 >= prepared.positions.length)) {
			throw new Error(`Mesh "${prepared.mesh.name}" contains an out-of-range triangle index.`);
		}
		const positions = vertexIndices.map((index) => Vector3.TransformCoordinates(Vector3.FromArray(prepared.positions, index * 3), world));
		const normals = vertexIndices.map((index) => Vector3.TransformNormal(Vector3.FromArray(prepared.normals, index * 3), world).normalize());
		const triangleUvs = vertexIndices.map((index) => [prepared.uvs[index * 2] * (resolution - 1), (1 - prepared.uvs[index * 2 + 1]) * (resolution - 1)] as const);
		const minimumX = Math.max(0, Math.floor(Math.min(...triangleUvs.map((uv) => uv[0]))));
		const maximumX = Math.min(resolution - 1, Math.ceil(Math.max(...triangleUvs.map((uv) => uv[0]))));
		const minimumY = Math.max(0, Math.floor(Math.min(...triangleUvs.map((uv) => uv[1]))));
		const maximumY = Math.min(resolution - 1, Math.ceil(Math.max(...triangleUvs.map((uv) => uv[1]))));
		for (let y = minimumY; y <= maximumY; y++) {
			for (let x = minimumX; x <= maximumX; x++) {
				const weights = barycentric([x + 0.5, y + 0.5], triangleUvs[0], triangleUvs[1], triangleUvs[2]);
				if (!weights) {
					continue;
				}
				const point = positions[0].scale(weights[0]).add(positions[1].scale(weights[1])).add(positions[2].scale(weights[2]));
				const normal = normals[0].scale(weights[0]).add(normals[1].scale(weights[1])).add(normals[2].scale(weights[2])).normalize();
				const direct = sampleDirectLighting(scene, prepared.mesh, point, normal, options, true);
				const indirect = sampleIndirectLighting(scene, point, normal, options);
				const pixel = y * resolution + x;
				if (counts[pixel] > 0) {
					overlapTexels++;
				}
				colors[pixel * 3] += direct.color.r + indirect.color.r;
				colors[pixel * 3 + 1] += direct.color.g + indirect.color.g;
				colors[pixel * 3 + 2] += direct.color.b + indirect.color.b;
				counts[pixel]++;
				rayCount += direct.rayCount + indirect.rayCount;
			}
		}
	}

	let coveredTexels = 0;
	for (let pixel = 0; pixel < counts.length; pixel++) {
		if (counts[pixel] === 0) {
			continue;
		}
		coveredTexels++;
		colors[pixel * 3] /= counts[pixel];
		colors[pixel * 3 + 1] /= counts[pixel];
		colors[pixel * 3 + 2] /= counts[pixel];
	}
	if (coveredTexels === 0) {
		throw new Error(`Mesh "${prepared.mesh.name}" has only degenerate or out-of-range ${prepared.uvSource.toUpperCase()} triangles.`);
	}
	dilateLightmap(colors, counts, resolution, options.dilation);

	const rgba = new Uint8Array(resolution * resolution * 4);
	let saturatedTexels = 0;
	for (let pixel = 0; pixel < counts.length; pixel++) {
		const source = pixel * 3;
		const target = pixel * 4;
		const red = Math.max(0, colors[source]);
		const green = Math.max(0, colors[source + 1]);
		const blue = Math.max(0, colors[source + 2]);
		if (red > 1 || green > 1 || blue > 1) {
			saturatedTexels++;
		}
		rgba[target] = Math.round(Math.min(1, red) * 255);
		rgba[target + 1] = Math.round(Math.min(1, green) * 255);
		rgba[target + 2] = Math.round(Math.min(1, blue) * 255);
		rgba[target + 3] = 255;
	}
	return { rgba, coveredTexels, overlapTexels, saturatedTexels, rayCount };
}

/** Creates a unique, lightmap-capable clone for one baked mesh. */
function createBakedMaterial(scene: Scene, source: Material, mesh: Mesh, texture: Texture, coordinatesIndex: number): ICreatedBakedMaterial {
	const configureLeaf = (leaf: Material, suffix: string): PBRMaterial | StandardMaterial => {
		if (!isPBRMaterial(leaf) && !isStandardMaterial(leaf)) {
			throw new Error(`Material "${leaf.name}" is not lightmap-capable.`);
		}
		const clone = leaf.clone(`${leaf.name} [Baked GI ${mesh.name}${suffix}]`);
		if (!clone || (!isPBRMaterial(clone) && !isStandardMaterial(clone))) {
			throw new Error(`Could not clone material "${leaf.name}" for baked GI.`);
		}
		clone.id = crypto.randomUUID();
		clone.lightmapTexture = texture;
		clone.lightmapTexture.coordinatesIndex = coordinatesIndex;
		clone.lightmapTexture.level = 1;
		clone.useLightmapAsShadowmap = false;
		clone.metadata = {
			...(clone.metadata ?? {}),
			babylonEditorBakedGi: { version: 1, sourceMaterialId: leaf.id, meshId: mesh.id },
		};
		return clone;
	};

	if (isMultiMaterial(source)) {
		const root = new MultiMaterial(`${source.name} [Baked GI ${mesh.name}]`, scene);
		root.id = crypto.randomUUID();
		const leaves: (PBRMaterial | StandardMaterial)[] = [];
		root.subMaterials = source.subMaterials.map((subMaterial, index) => {
			if (!subMaterial) {
				return null;
			}
			const leaf = configureLeaf(subMaterial, ` ${index + 1}`);
			leaves.push(leaf);
			return leaf;
		});
		root.metadata = { ...(source.metadata ?? {}), babylonEditorBakedGi: { version: 1, sourceMaterialId: source.id, meshId: mesh.id } };
		return { root, leaves };
	}
	const leaf = configureLeaf(source, "");
	return { root: leaf, leaves: [leaf] };
}

/** Finds a normal or MultiMaterial by stable id. */
function findMaterial(scene: Scene, id: string): Material | null {
	return scene.materials.find((material) => material.id === id) ?? scene.multiMaterials.find((material) => material.id === id) ?? null;
}

/** Restores an original material from a runtime object or persisted serialized snapshot. */
function restoreMaterial(scene: Scene, snapshot: TBakedGiMaterialSnapshot, originalMaterialId: string | null, projectDirectory: string): Material | null {
	if (snapshot.kind === "none") {
		return null;
	}
	if (originalMaterialId) {
		const existing = findMaterial(scene, originalMaterialId);
		if (existing) {
			return existing;
		}
	}
	const rootUrl = join(projectDirectory, "/");
	if (snapshot.kind === "single") {
		const parsed = Material.Parse(structuredClone(snapshot.material), scene, rootUrl);
		if (!parsed) {
			throw new Error(`Could not restore original material "${String(snapshot.material.name ?? originalMaterialId ?? "unknown")}".`);
		}
		return parsed;
	}
	const subMaterials = snapshot.subMaterials.map((serialized) => {
		if (!serialized) {
			return null;
		}
		const id = typeof serialized.id === "string" ? serialized.id : null;
		const existing = id ? findMaterial(scene, id) : null;
		if (existing) {
			return existing;
		}
		const parsed = Material.Parse(structuredClone(serialized), scene, rootUrl);
		if (!parsed) {
			throw new Error(`Could not restore MultiMaterial child "${String(serialized.name ?? id ?? "unknown")}".`);
		}
		return parsed;
	});
	const root = new MultiMaterial(String(snapshot.material.name ?? "Restored MultiMaterial"), scene);
	if (typeof snapshot.material.id === "string") {
		root.id = snapshot.material.id;
	}
	root.subMaterials = subMaterials;
	if (snapshot.material.metadata && typeof snapshot.material.metadata === "object") {
		root.metadata = structuredClone(snapshot.material.metadata);
	}
	return root;
}

/** Disposes only materials and lightmap textures created by a persisted bake. */
function disposeBakedMaterials(scene: Scene, entry: Pick<IBakedGiMeshEntry, "bakedMaterialId" | "bakedSubMaterialIds">): void {
	const textures = new Set<Texture>();
	for (const id of entry.bakedSubMaterialIds) {
		const material = findMaterial(scene, id);
		if (!material || (!isPBRMaterial(material) && !isStandardMaterial(material))) {
			continue;
		}
		if (material.lightmapTexture instanceof Texture) {
			textures.add(material.lightmapTexture);
			material.lightmapTexture = null;
		}
		material.dispose(false, false);
	}
	const root = findMaterial(scene, entry.bakedMaterialId);
	if (root && !entry.bakedSubMaterialIds.includes(root.id)) {
		root.dispose(false, false);
	}
	textures.forEach((texture) => texture.dispose());
}

/** Finds lighting scenarios that retain ownership of one generated baked-GI payload. */
function retainedScenarioIds(scene: Scene, bakeId: string, excludedScenarioId?: string): string[] {
	const scenarios = scene.metadata?.babylonEditorLightingScenarios;
	if (!Array.isArray(scenarios)) {
		return [];
	}
	return scenarios
		.filter(
			(scenario) =>
				scenario && typeof scenario === "object" && (scenario as any).id !== excludedScenarioId && (scenario as any).bakedLighting?.bakedGi?.sourceBakeId === bakeId
		)
		.map((scenario) => String((scenario as any).id));
}

/** Releases a scenario-retained baked-GI directory and materials only after the final owner is removed. */
export async function releaseRetainedBakedGiScenarioResources(
	scene: Scene,
	scenarioId: string,
	bakedGi: { sourceBakeId: string; outputDirectory: string; meshEntries: { materialId: string; subMaterialIds: (string | null)[] }[] }
): Promise<{ released: boolean; retainedByScenarioIds: string[]; retainedByActiveBake: boolean; deletedOutputDirectory: string | null }> {
	const retainedByScenarioIds = retainedScenarioIds(scene, bakedGi.sourceBakeId, scenarioId);
	const retainedByActiveBake = readBakedGlobalIlluminationManifest(scene)?.bakeId === bakedGi.sourceBakeId;
	if (retainedByActiveBake || retainedByScenarioIds.length) {
		return { released: false, retainedByScenarioIds, retainedByActiveBake, deletedOutputDirectory: null };
	}
	for (const entry of bakedGi.meshEntries) {
		disposeBakedMaterials(scene, {
			bakedMaterialId: entry.materialId,
			bakedSubMaterialIds: entry.subMaterialIds.filter((id): id is string => id !== null),
		});
	}
	const projectDirectory = getProjectDirectory();
	const absoluteDirectory = resolveGeneratedDirectory(projectDirectory, bakedGi.outputDirectory);
	await assertGeneratedDirectorySafe(projectDirectory, absoluteDirectory);
	await remove(absoluteDirectory);
	return { released: true, retainedByScenarioIds: [], retainedByActiveBake: false, deletedOutputDirectory: bakedGi.outputDirectory };
}

/** Bakes static diffuse GI into one generated lightmap per selected mesh and applies it atomically. */
export async function bakeBakedGlobalIllumination(scene: Scene, data: Record<string, unknown>, actionOptions: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (readBakedGlobalIlluminationManifest(scene)) {
		throw new Error("This scene already has an applied baked-GI manifest. Clear it with clear_baked_gi before creating a replacement bake.");
	}
	const options = validateOptions(data);
	const projectDirectory = getProjectDirectory();
	const outputRoot = resolveGeneratedDirectory(projectDirectory, options.outputDirectory);
	const preparedMeshes = prepareMeshes(scene, data, options);
	const bakeId = crypto.randomUUID();
	const relativeBakeDirectory = join(options.outputDirectory, bakeId);
	const finalDirectory = resolveGeneratedDirectory(projectDirectory, relativeBakeDirectory);
	const stagingDirectory = join(outputRoot, `.staging-${bakeId}`);
	await assertGeneratedDirectorySafe(projectDirectory, outputRoot);
	if ((await pathExists(finalDirectory)) || (await pathExists(stagingDirectory))) {
		throw new Error(`Generated baked-GI directory already exists for bake ${bakeId}; no files were changed.`);
	}

	const rasterResults: { prepared: IPreparedBakeMesh; result: IBakedGiRasterResult; filename: string; relativePath: string }[] = [];
	for (let index = 0; index < preparedMeshes.length; index++) {
		const prepared = preparedMeshes[index];
		const result = rasterizeBakedGiLightmap(scene, prepared, options);
		const safeMeshId = prepared.mesh.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || `mesh-${index + 1}`;
		const filename = `${String(index + 1).padStart(3, "0")}-${safeMeshId}.png`;
		rasterResults.push({ prepared, result, filename, relativePath: join(relativeBakeDirectory, filename) });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	await ensureDir(stagingDirectory);
	try {
		await Promise.all(
			rasterResults.map(async ({ result, filename }) => {
				const png = await sharp(result.rgba, { raw: { width: options.resolution, height: options.resolution, channels: 4 } })
					.png()
					.toBuffer();
				await writeFile(join(stagingDirectory, filename), png);
			})
		);
		await move(stagingDirectory, finalDirectory, { overwrite: false });
	} catch (error) {
		await remove(stagingDirectory);
		await remove(finalDirectory);
		throw error;
	}

	const assignments: { mesh: Mesh; original: Material | null; created: ICreatedBakedMaterial; texture: Texture; entry: IBakedGiMeshEntry }[] = [];
	try {
		for (const item of rasterResults) {
			const absoluteTexturePath = join(projectDirectory, item.relativePath);
			const texture = configureImportedTexture(new Texture(absoluteTexturePath, scene));
			texture.gammaSpace = false;
			texture.wrapU = Texture.CLAMP_ADDRESSMODE;
			texture.wrapV = Texture.CLAMP_ADDRESSMODE;
			texture.metadata = {
				...(texture.metadata ?? {}),
				babylonEditorBakedGi: { version: 1, bakeId, meshId: item.prepared.mesh.id, encoding: "linear-rgba8-clamped" },
			};
			const created = createBakedMaterial(scene, item.prepared.material, item.prepared.mesh, texture, item.prepared.coordinatesIndex);
			const entry: IBakedGiMeshEntry = {
				meshId: item.prepared.mesh.id,
				meshName: item.prepared.mesh.name,
				originalMaterialId: item.prepared.mesh.material?.id ?? null,
				originalMaterial: item.prepared.originalMaterial,
				bakedMaterialId: created.root.id,
				bakedSubMaterialIds: created.leaves.map((material) => material.id),
				lightmapPath: item.relativePath,
				coordinatesIndex: item.prepared.coordinatesIndex,
				uvSource: item.prepared.uvSource,
				coveredTexels: item.result.coveredTexels,
				overlapTexels: item.result.overlapTexels,
				saturatedTexels: item.result.saturatedTexels,
				rayCount: item.result.rayCount,
			};
			assignments.push({ mesh: item.prepared.mesh, original: item.prepared.mesh.material, created, texture, entry });
		}
		assignments.forEach((assignment) => {
			assignment.mesh.material = assignment.created.root;
		});
		const manifest: IBakedGiManifest = {
			version: 1,
			backend: BAKED_GI_BACKEND,
			bakeId,
			createdAt: new Date().toISOString(),
			outputDirectory: relativeBakeDirectory,
			resolution: options.resolution,
			samples: options.samples,
			bounces: options.bounces,
			directIntensity: options.directIntensity,
			indirectIntensity: options.indirectIntensity,
			shadowing: options.shadowing,
			shadowBias: options.shadowBias,
			maxDistance: options.maxDistance,
			dilation: options.dilation,
			encoding: "linear-rgba8-clamped",
			limitations: [
				"Static meshes with indexed triangles and authored UV0 or UV2 only; auto mode prefers UV2.",
				"One deterministic diffuse bounce maximum; constant material colors contribute to indirect light while texture albedo is not CPU-sampled.",
				"Linear light is stored in portable clamped RGBA8 PNG files; saturated texels are reported explicitly.",
			],
			meshEntries: assignments.map((assignment) => assignment.entry),
		};
		scene.metadata ??= {};
		scene.metadata[BAKED_GI_METADATA_KEY] = manifest;
	} catch (error) {
		assignments.forEach((assignment) => {
			assignment.mesh.material = assignment.original;
			assignment.created.leaves.forEach((material) => {
				material.lightmapTexture = null;
				material.dispose(false, false);
			});
			if (!assignment.created.leaves.includes(assignment.created.root as PBRMaterial | StandardMaterial)) {
				assignment.created.root.dispose(false, false);
			}
			assignment.texture.dispose();
		});
		await remove(finalDirectory);
		throw error;
	}

	actionOptions.editor.layout.assets.refresh();
	actionOptions.editor.layout.inspector.setEditedObject(scene);
	actionOptions.editor.layout.inspector.forceUpdate();
	return getBakedGlobalIllumination(scene);
}

/** Restores original materials and deletes only the generated directory owned by the active bake. */
export async function clearBakedGlobalIllumination(scene: Scene, data: Record<string, unknown>, actionOptions: IMCPActionOptions): Promise<Record<string, unknown>> {
	const manifest = readBakedGlobalIlluminationManifest(scene);
	if (!manifest) {
		return { cleared: false, configured: false, reason: "No baked-GI manifest is applied to this scene." };
	}
	if (data.confirm !== true) {
		throw new Error("Clearing baked GI restores original materials and deletes generated lightmaps. Retry with confirm: true.");
	}
	if (data.expectedBakeId !== undefined && data.expectedBakeId !== manifest.bakeId) {
		throw new Error(
			`Baked GI changed after inspection. Expected bake ${String(data.expectedBakeId)}, but the active bake is ${manifest.bakeId}. Inspect it again before clearing.`
		);
	}
	const projectDirectory = getProjectDirectory();
	const absoluteDirectory = resolveGeneratedDirectory(projectDirectory, manifest.outputDirectory);
	await assertGeneratedDirectorySafe(projectDirectory, absoluteDirectory);
	const restored = manifest.meshEntries.map((entry) => {
		const mesh = scene.getMeshById(entry.meshId);
		if (!(mesh instanceof Mesh)) {
			return { entry, mesh: null, material: null };
		}
		const material = restoreMaterial(scene, entry.originalMaterial, entry.originalMaterialId, projectDirectory);
		return { entry, mesh, material };
	});

	for (const item of restored) {
		if (item.mesh) {
			item.mesh.material = item.material;
		}
	}
	const retainedByScenarioIds = retainedScenarioIds(scene, manifest.bakeId);
	if (!retainedByScenarioIds.length) {
		manifest.meshEntries.forEach((entry) => disposeBakedMaterials(scene, entry));
	}
	delete scene.metadata![BAKED_GI_METADATA_KEY];
	const filesExisted = await pathExists(absoluteDirectory);
	if (!retainedByScenarioIds.length) {
		await remove(absoluteDirectory);
	}

	actionOptions.editor.layout.assets.refresh();
	actionOptions.editor.layout.inspector.setEditedObject(scene);
	actionOptions.editor.layout.inspector.forceUpdate();
	return {
		cleared: true,
		configured: false,
		bakeId: manifest.bakeId,
		restoredMeshIds: restored.filter((item) => item.mesh).map((item) => item.entry.meshId),
		missingMeshIds: restored.filter((item) => !item.mesh).map((item) => item.entry.meshId),
		deletedOutputDirectory: retainedByScenarioIds.length ? null : manifest.outputDirectory,
		retainedOutputDirectory: retainedByScenarioIds.length ? manifest.outputDirectory : null,
		retainedByScenarioIds,
		generatedFilesExisted: filesExisted,
	};
}
