import { createHash, randomUUID } from "crypto";
import { dirname, relative } from "path/posix";
import { writeFile } from "fs/promises";

import { ensureDir, move, pathExists, remove } from "fs-extra";
import sharp from "sharp";

import {
	Color3,
	DirectionalLight,
	HemisphericLight,
	Light,
	Matrix,
	Mesh,
	PBRMaterial,
	PointLight,
	Ray,
	Scene,
	SpotLight,
	Texture,
	Vector3,
	VertexBuffer,
	VertexData,
} from "babylonjs";
import {
	areaLightDiscSegments,
	configureSubsurfaceScattering,
	getAreaLightBasis,
	getAreaLightSamplePoints,
	getSubsurfaceMaterialMetadata,
	getSubsurfaceRuntime,
	getSubsurfaceRuntimeSettings,
	ISubsurfaceMaterialMetadata,
	ISubsurfaceTransportCache,
	serializeSubsurfaceTransportTexture,
	setSubsurfaceMaterialMetadata,
	setSubsurfaceTransportTexture,
	clearSubsurfaceTransportTexture,
	subsurfaceTransportBackend,
	subsurfaceTransportLightingSignature,
	subsurfaceTransportMeshSignature,
	SubsurfaceTransportUvChannel,
	validateSubsurfaceTransportCache,
} from "babylonjs-editor-tools";

import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { isRectAreaLight } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "../assets/registry";
import { secureRenderingAssetPath } from "../rendering/rendering-asset-file";
import { resolveMaterial } from "../tools/resolve";

const maximumRayBudget = 2_000_000;
const maximumNominalTransportSamples = 1_048_576;

function configureSubsurfaceRuntime(scene: Scene): ReturnType<typeof configureSubsurfaceScattering> {
	return configureSubsurfaceScattering(scene as any, getProjectAssetsRootUrl() ?? "");
}

interface IValidatedTransportBakeOptions {
	resolution: number;
	sampleCount: number;
	maxDistance: number;
	bias: number;
	shadowing: boolean;
	dilation: number;
	uvChannel: SubsurfaceTransportUvChannel;
	intensity: number;
}

interface IPreparedTransportMesh {
	mesh: Mesh;
	positions: number[];
	normals: number[];
	uvs: number[];
	indices: number[];
	worldPositions: Vector3[];
	worldNormals: Vector3[];
}

interface IRayBudget {
	count: number;
}

interface ITransportRasterResult {
	rgba: Uint8Array;
	coveredTexels: number;
	overlapTexels: number;
	tracedTexels: number;
	hitTexels: number;
	rayCount: number;
	minimumThickness: number;
	maximumThickness: number;
	averageThickness: number;
}

interface IClosestPick {
	mesh: Mesh;
	point: Vector3;
	normal: Vector3;
	distance: number;
}

function pbrMaterial(scene: Scene, materialId: string): PBRMaterial {
	const material = resolveMaterial({ scene, materialId });
	if (!(material instanceof PBRMaterial)) {
		throw new Error(`Material "${material.name}" does not support subsurface transport. Use a PBRMaterial.`);
	}
	return material;
}

function materialMetadata(material: PBRMaterial): ISubsurfaceMaterialMetadata {
	const metadata = getSubsurfaceMaterialMetadata(material as any);
	if (!metadata) {
		throw new Error(`Material "${material.name}" has no portable subsurface assignment. Assign a diffusion profile before baking transport.`);
	}
	return metadata;
}

function meshUsesMaterial(mesh: Mesh, material: PBRMaterial): boolean {
	if (mesh.material === material) {
		return true;
	}
	return Boolean((mesh.material as { subMaterials?: Array<unknown> } | null)?.subMaterials?.includes(material));
}

function transportMesh(scene: Scene, meshId: string, material: PBRMaterial): Mesh {
	const mesh = scene.getMeshById(meshId);
	if (!(mesh instanceof Mesh) || !mesh.geometry || mesh.getTotalVertices() === 0) {
		throw new Error(`Subsurface transport mesh "${meshId}" was not found or has no vertex geometry.`);
	}
	if (!meshUsesMaterial(mesh, material)) {
		throw new Error(`Mesh "${mesh.name}" does not use material "${material.name}".`);
	}
	return mesh;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function validateBakeOptions(data: Record<string, unknown>): IValidatedTransportBakeOptions {
	const resolution = data.resolution ?? 64;
	const sampleCount = data.sampleCount ?? 8;
	const maxDistance = data.maxDistance ?? 1000;
	const bias = data.bias ?? 0.01;
	const shadowing = data.shadowing ?? true;
	const dilation = data.dilation ?? 2;
	const uvChannel = data.uvChannel ?? "uv0";
	const intensity = data.intensity ?? 1;
	if (!Number.isInteger(resolution) || (resolution as number) < 16 || (resolution as number) > 256) {
		throw new Error("Subsurface transport resolution must be an integer from 16 through 256.");
	}
	if (!Number.isInteger(sampleCount) || (sampleCount as number) < 1 || (sampleCount as number) > 64) {
		throw new Error("Subsurface transport sampleCount must be an integer from 1 through 64.");
	}
	if ((resolution as number) * (resolution as number) * (sampleCount as number) > maximumNominalTransportSamples) {
		throw new Error(`Subsurface transport exceeds the ${maximumNominalTransportSamples.toLocaleString()} nominal sample budget; lower resolution or sampleCount.`);
	}
	if (typeof shadowing !== "boolean") {
		throw new Error("Subsurface transport shadowing must be a boolean.");
	}
	if (!Number.isInteger(dilation) || (dilation as number) < 0 || (dilation as number) > 16) {
		throw new Error("Subsurface transport dilation must be an integer from 0 through 16.");
	}
	if (uvChannel !== "uv0" && uvChannel !== "uv2") {
		throw new Error('Subsurface transport uvChannel must be "uv0" or "uv2".');
	}
	return {
		resolution: resolution as number,
		sampleCount: sampleCount as number,
		maxDistance: finite(maxDistance, "Subsurface transport maxDistance", 0.000001, 1_000_000),
		bias: finite(bias, "Subsurface transport bias", 0.000001, 1000),
		shadowing,
		dilation: dilation as number,
		uvChannel,
		intensity: finite(intensity, "Subsurface transport intensity", 0, 16),
	};
}

function prepareMesh(mesh: Mesh, options: IValidatedTransportBakeOptions): IPreparedTransportMesh {
	const rawPositions = mesh.getVerticesData(VertexBuffer.PositionKind);
	const rawNormals = mesh.getVerticesData(VertexBuffer.NormalKind);
	const rawUvs = mesh.getVerticesData(options.uvChannel === "uv2" ? VertexBuffer.UV2Kind : VertexBuffer.UVKind);
	const rawIndices = mesh.getIndices();
	if (!rawPositions || rawPositions.length < 9 || !rawIndices || rawIndices.length < 3 || rawIndices.length % 3 !== 0) {
		throw new Error(`Mesh "${mesh.name}" requires indexed triangle geometry for subsurface transport.`);
	}
	const vertexCount = rawPositions.length / 3;
	if (!rawUvs || rawUvs.length !== vertexCount * 2) {
		throw new Error(`Mesh "${mesh.name}" has no complete ${options.uvChannel.toUpperCase()} coordinates for subsurface transport.`);
	}
	if (Array.from(rawUvs).some((value) => !Number.isFinite(value) || value < -0.000001 || value > 1.000001)) {
		throw new Error(`Mesh "${mesh.name}" ${options.uvChannel.toUpperCase()} coordinates must stay inside the portable 0–1 transport atlas.`);
	}
	const positions = Array.from(rawPositions);
	const indices = Array.from(rawIndices);
	const normals = rawNormals?.length === rawPositions.length ? Array.from(rawNormals) : new Array<number>(rawPositions.length).fill(0);
	if (!rawNormals || rawNormals.length !== rawPositions.length) {
		VertexData.ComputeNormals(positions, indices, normals);
	}
	const world = mesh.computeWorldMatrix(true);
	if (Math.abs(world.determinant()) < 1e-12) {
		throw new Error(`Mesh "${mesh.name}" has a non-invertible world transform and cannot produce correct transport normals.`);
	}
	const normalMatrix = Matrix.Transpose(world.clone().invert());
	const worldPositions = Array.from({ length: vertexCount }, (_, index) => Vector3.TransformCoordinates(Vector3.FromArray(positions, index * 3), world));
	const worldNormals = Array.from({ length: vertexCount }, (_, index) => Vector3.TransformNormal(Vector3.FromArray(normals, index * 3), normalMatrix).normalize());
	return { mesh, positions, normals, uvs: Array.from(rawUvs), indices, worldPositions, worldNormals };
}

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
	return first >= -1e-6 && second >= -1e-6 && third >= -1e-6 ? [first, second, third] : null;
}

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

function inwardDirection(normal: Vector3, sampleIndex: number, sampleCount: number, seed: number): Vector3 {
	const inward = normal.negate();
	const radius = Math.sqrt((sampleIndex + 0.5) / sampleCount);
	const rotation = (seed * 0.6180339887498949) % 1;
	const angle = Math.PI * 2 * ((radicalInverse(sampleIndex + 1) + rotation) % 1);
	const tangentSeed = Math.abs(inward.y) < 0.999 ? Vector3.Up() : Vector3.Right();
	const tangent = Vector3.Cross(tangentSeed, inward).normalize();
	const bitangent = Vector3.Cross(inward, tangent).normalize();
	return tangent
		.scale(Math.cos(angle) * radius)
		.add(bitangent.scale(Math.sin(angle) * radius))
		.add(inward.scale(Math.sqrt(Math.max(0, 1 - radius * radius))))
		.normalize();
}

function consumeRay(budget: IRayBudget): void {
	budget.count++;
	if (budget.count > maximumRayBudget) {
		throw new Error(`Subsurface transport exceeded the bounded ${maximumRayBudget.toLocaleString()} traced-ray budget.`);
	}
}

function closestPick(scene: Scene, ray: Ray): IClosestPick | null {
	let closest: IClosestPick | null = null;
	for (const candidate of scene.meshes) {
		if (!(candidate instanceof Mesh) || !candidate.geometry || candidate.getTotalVertices() === 0 || !candidate.isEnabled() || !candidate.isVisible) {
			continue;
		}
		const pick = ray.intersectsMesh(candidate, false);
		if (!pick.hit || !pick.pickedPoint || pick.distance < 0 || pick.distance > ray.length || (closest && pick.distance >= closest.distance)) {
			continue;
		}
		const normal = pick.getNormal(true, true);
		if (!normal) {
			continue;
		}
		closest = { mesh: candidate, point: pick.pickedPoint.clone(), normal: normal.normalize(), distance: pick.distance };
	}
	return closest;
}

function occluded(
	scene: Scene,
	segment: { point: Vector3; normal: Vector3; direction: Vector3; distance: number },
	options: IValidatedTransportBakeOptions,
	budget: IRayBudget
): boolean {
	if (!options.shadowing || segment.distance <= options.bias) {
		return false;
	}
	consumeRay(budget);
	return closestPick(scene, new Ray(segment.point.add(segment.normal.scale(options.bias)), segment.direction, segment.distance - options.bias)) !== null;
}

function directLighting(scene: Scene, receiver: Mesh, point: Vector3, normal: Vector3, options: IValidatedTransportBakeOptions, budget: IRayBudget): Color3 {
	const output = scene.ambientColor.clone();
	if (scene.environmentTexture) {
		const floor = Math.max(0, scene.environmentIntensity) * 0.08;
		output.addInPlace(new Color3(floor, floor, floor));
	}
	for (const light of scene.lights) {
		if (!light.isEnabled() || light.intensity <= 0 || (light as Light & { canAffectMesh?: (mesh: Mesh) => boolean }).canAffectMesh?.(receiver) === false) {
			continue;
		}
		if (isRectAreaLight(light)) {
			const basis = getAreaLightBasis(light as any);
			const basisDirection = Vector3.FromArray(basis.direction.asArray());
			const samples = getAreaLightSamplePoints(light as any, areaLightDiscSegments).map((sample) => Vector3.FromArray(sample.asArray()));
			for (const lightPoint of samples) {
				if (Vector3.Dot(basisDirection, point.subtract(lightPoint)) <= 0) {
					continue;
				}
				const delta = lightPoint.subtract(point);
				const distance = delta.length();
				if (distance <= options.bias || (Number.isFinite(light.range) && light.range > 0 && distance > light.range)) {
					continue;
				}
				const direction = delta.scale(1 / distance);
				const lambert = Math.max(0, Vector3.Dot(normal, direction));
				if (lambert === 0 || occluded(scene, { point, normal, direction, distance }, options, budget)) {
					continue;
				}
				const attenuation = Number.isFinite(light.range) && light.range > 0 ? Math.max(0, 1 - Math.pow(distance / light.range, 2)) : 1;
				output.addInPlace(light.diffuse.scale((light.intensity * attenuation * lambert) / samples.length));
			}
			continue;
		}
		if (light instanceof HemisphericLight) {
			const sky = Math.max(0, Math.min(1, Vector3.Dot(normal, light.direction.normalize()) * 0.5 + 0.5));
			output.addInPlace(
				light.diffuse
					.scale(sky)
					.add(light.groundColor.scale(1 - sky))
					.scale(light.intensity)
			);
			continue;
		}
		let direction: Vector3;
		let distance = options.maxDistance;
		let attenuation = 1;
		if (light instanceof DirectionalLight) {
			direction = light.getShadowDirection().negate().normalize();
		} else if (light instanceof PointLight || light instanceof SpotLight) {
			const delta = light.getAbsolutePosition().subtract(point);
			distance = delta.length();
			if (distance <= options.bias || (Number.isFinite(light.range) && light.range > 0 && distance > light.range)) {
				continue;
			}
			direction = delta.scale(1 / distance);
			if (Number.isFinite(light.range) && light.range > 0) {
				attenuation = Math.max(0, 1 - Math.pow(distance / light.range, 2));
			}
			if (light instanceof SpotLight) {
				const coneDot = Vector3.Dot(light.getShadowDirection().normalize(), direction.negate());
				const coneLimit = Math.cos(light.angle * 0.5);
				if (coneDot <= coneLimit) {
					continue;
				}
				attenuation *= Math.pow((coneDot - coneLimit) / Math.max(1e-6, 1 - coneLimit), Math.max(0, light.exponent));
			}
		} else {
			continue;
		}
		const lambert = Math.max(0, Vector3.Dot(normal, direction));
		if (lambert === 0 || attenuation === 0 || occluded(scene, { point, normal, direction, distance }, options, budget)) {
			continue;
		}
		output.addInPlace(light.diffuse.scale(light.intensity * attenuation * lambert));
	}
	return output;
}

function transmission(incoming: Color3, distance: number, metadata: ISubsurfaceMaterialMetadata, metersPerUnit: number): Color3 {
	const distanceMillimeters = distance * metersPerUnit * 1000;
	const profileDistance = metadata.profile.scatteringDistance.map((value) => Math.max(0.001, value * metadata.profile.worldScale));
	const tint = metadata.profile.transmissionTint;
	const intensity = metadata.subsurfaceMask * (metadata.transmissionEnabled ? metadata.transmissionIntensity : 1);
	return new Color3(
		incoming.r * Math.exp(-distanceMillimeters / profileDistance[0]) * tint[0] * intensity,
		incoming.g * Math.exp(-distanceMillimeters / profileDistance[1]) * tint[1] * intensity,
		incoming.b * Math.exp(-distanceMillimeters / profileDistance[2]) * tint[2] * intensity
	);
}

function normalizeAndDilate(colors: Float32Array, counts: Uint16Array, resolution: number, iterations: number): void {
	for (let pixel = 0; pixel < counts.length; pixel++) {
		if (counts[pixel] > 1) {
			colors[pixel * 3] /= counts[pixel];
			colors[pixel * 3 + 1] /= counts[pixel];
			colors[pixel * 3 + 2] /= counts[pixel];
		}
		if (counts[pixel] > 0) {
			counts[pixel] = 1;
		}
	}
	for (let iteration = 0; iteration < iterations; iteration++) {
		const sourceColors = colors.slice();
		const sourceCounts = counts.slice();
		for (let y = 0; y < resolution; y++) {
			for (let x = 0; x < resolution; x++) {
				const pixel = y * resolution + x;
				if (sourceCounts[pixel] > 0) {
					continue;
				}
				let neighbors = 0;
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
					colors[pixel * 3] += sourceColors[neighbor * 3];
					colors[pixel * 3 + 1] += sourceColors[neighbor * 3 + 1];
					colors[pixel * 3 + 2] += sourceColors[neighbor * 3 + 2];
					neighbors++;
				}
				if (neighbors > 0) {
					colors[pixel * 3] /= neighbors;
					colors[pixel * 3 + 1] /= neighbors;
					colors[pixel * 3 + 2] /= neighbors;
					counts[pixel] = 1;
				}
			}
		}
	}
}

function encodeRgbm(colors: Float32Array, counts: Uint16Array): Uint8Array {
	const output = new Uint8Array(counts.length * 4);
	for (let pixel = 0; pixel < counts.length; pixel++) {
		if (counts[pixel] === 0) {
			continue;
		}
		const red = Math.max(0, colors[pixel * 3]);
		const green = Math.max(0, colors[pixel * 3 + 1]);
		const blue = Math.max(0, colors[pixel * 3 + 2]);
		const maximum = Math.min(16, Math.max(red, green, blue));
		if (maximum <= 0) {
			output[pixel * 4 + 3] = 1;
			continue;
		}
		const multiplier = Math.max(1 / 255, Math.ceil((maximum / 16) * 255) / 255);
		output[pixel * 4] = Math.round(Math.min(1, red / (multiplier * 16)) * 255);
		output[pixel * 4 + 1] = Math.round(Math.min(1, green / (multiplier * 16)) * 255);
		output[pixel * 4 + 2] = Math.round(Math.min(1, blue / (multiplier * 16)) * 255);
		output[pixel * 4 + 3] = Math.round(multiplier * 255);
	}
	return output;
}

function rasterizeTransport(
	scene: Scene,
	prepared: IPreparedTransportMesh,
	metadata: ISubsurfaceMaterialMetadata,
	options: IValidatedTransportBakeOptions
): ITransportRasterResult {
	const { resolution } = options;
	const colors = new Float32Array(resolution * resolution * 3);
	const counts = new Uint16Array(resolution * resolution);
	const hitCounts = new Uint16Array(resolution * resolution);
	const budget: IRayBudget = { count: 0 };
	let minimumThickness = Number.POSITIVE_INFINITY;
	let maximumThickness = 0;
	let thicknessSum = 0;
	let thicknessSamples = 0;
	for (let triangle = 0; triangle < prepared.indices.length; triangle += 3) {
		const vertices = [prepared.indices[triangle], prepared.indices[triangle + 1], prepared.indices[triangle + 2]];
		const uvs = vertices.map((index) => [prepared.uvs[index * 2], prepared.uvs[index * 2 + 1]] as [number, number]);
		const minimumX = Math.max(0, Math.floor(Math.min(...uvs.map((uv) => uv[0])) * resolution));
		const maximumX = Math.min(resolution - 1, Math.ceil(Math.max(...uvs.map((uv) => uv[0])) * resolution) - 1);
		const minimumY = Math.max(0, Math.floor((1 - Math.max(...uvs.map((uv) => uv[1]))) * resolution));
		const maximumY = Math.min(resolution - 1, Math.ceil((1 - Math.min(...uvs.map((uv) => uv[1]))) * resolution) - 1);
		for (let y = minimumY; y <= maximumY; y++) {
			for (let x = minimumX; x <= maximumX; x++) {
				const uv: [number, number] = [(x + 0.5) / resolution, 1 - (y + 0.5) / resolution];
				const weights = barycentric(uv, uvs[0], uvs[1], uvs[2]);
				if (!weights) {
					continue;
				}
				const point = prepared.worldPositions[vertices[0]]
					.scale(weights[0])
					.add(prepared.worldPositions[vertices[1]].scale(weights[1]))
					.add(prepared.worldPositions[vertices[2]].scale(weights[2]));
				const normal = prepared.worldNormals[vertices[0]]
					.scale(weights[0])
					.add(prepared.worldNormals[vertices[1]].scale(weights[1]))
					.add(prepared.worldNormals[vertices[2]].scale(weights[2]))
					.normalize();
				const pixel = y * resolution + x;
				let hits = 0;
				for (let sample = 0; sample < options.sampleCount; sample++) {
					const direction = inwardDirection(normal, sample, options.sampleCount, pixel + triangle * 17);
					consumeRay(budget);
					const pick = new Ray(point.subtract(normal.scale(options.bias)), direction, options.maxDistance).intersectsMesh(prepared.mesh, false);
					if (!pick.hit || !pick.pickedPoint || pick.distance <= options.bias * 0.5 || pick.distance > options.maxDistance) {
						continue;
					}
					let exitNormal = pick.getNormal(true, true)?.normalize();
					if (!exitNormal) {
						continue;
					}
					if (Vector3.Dot(exitNormal, direction) < 0) {
						exitNormal = exitNormal.negate();
					}
					const incoming = directLighting(scene, prepared.mesh, pick.pickedPoint, exitNormal, options, budget);
					const transported = transmission(incoming, pick.distance, metadata, getSubsurfaceRuntimeSettings(scene as any).metersPerUnit);
					colors[pixel * 3] += transported.r / options.sampleCount;
					colors[pixel * 3 + 1] += transported.g / options.sampleCount;
					colors[pixel * 3 + 2] += transported.b / options.sampleCount;
					hits++;
					minimumThickness = Math.min(minimumThickness, pick.distance);
					maximumThickness = Math.max(maximumThickness, pick.distance);
					thicknessSum += pick.distance;
					thicknessSamples++;
				}
				counts[pixel]++;
				if (hits > 0) {
					hitCounts[pixel]++;
				}
			}
		}
	}
	const coveredTexels = counts.filter((count) => count > 0).length;
	const overlapTexels = counts.filter((count) => count > 1).length;
	const hitTexels = hitCounts.filter((count) => count > 0).length;
	if (coveredTexels === 0) {
		throw new Error(`Mesh "${prepared.mesh.name}" has no rasterized ${options.uvChannel.toUpperCase()} transport coverage at ${resolution}×${resolution}.`);
	}
	normalizeAndDilate(colors, counts, resolution, options.dilation);
	return {
		rgba: encodeRgbm(colors, counts),
		coveredTexels,
		overlapTexels,
		tracedTexels: coveredTexels,
		hitTexels,
		rayCount: budget.count,
		minimumThickness: thicknessSamples ? minimumThickness : 0,
		maximumThickness: thicknessSamples ? maximumThickness : 0,
		averageThickness: thicknessSamples ? thicknessSum / thicknessSamples : 0,
	};
}

function safeName(value: string): string {
	return (
		value
			.replace(/[^a-z0-9_-]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96) || "Subsurface"
	);
}

async function outputPath(data: Record<string, unknown>, mesh: Mesh, revision: number): Promise<string> {
	const path = typeof data.outputPath === "string" ? data.outputPath : `assets/Lighting/Subsurface/${safeName(mesh.name)}-${safeName(mesh.id)}-r${revision}.transport.png`;
	return secureRenderingAssetPath(path, ".png", "Subsurface transport");
}

async function writeAtomicPng(path: string, bytes: Buffer): Promise<void> {
	if (await pathExists(path)) {
		throw new Error(`Subsurface transport output already exists: ${path}. Choose a new outputPath or let the editor generate a revisioned path.`);
	}
	await ensureDir(dirname(path));
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, bytes);
		await move(temporary, path, { overwrite: false });
	} finally {
		await remove(temporary);
	}
}

async function loadTransportTexture(scene: Scene, absolutePath: string): Promise<Texture> {
	const texture = configureImportedTexture(new Texture(absolutePath, scene, false, false));
	const relativePath = relative(dirname(projectConfiguration.path!), absolutePath).replace(/\\/g, "/");
	texture.name = relativePath;
	texture.url = relativePath;
	texture.gammaSpace = false;
	texture.metadata = { ...(texture.metadata ?? {}), babylonEditorAuthoredTexturePath: relativePath };
	return texture;
}

async function removeGeneratedCacheFile(cache: ISubsurfaceTransportCache): Promise<string[]> {
	if (cache.ownership !== "editor-generated") {
		return [];
	}
	const absolutePath = await secureRenderingAssetPath(cache.texturePath, ".png", "Subsurface transport");
	const sidecar = `${absolutePath}${ASSET_META_SUFFIX}`;
	await remove(absolutePath);
	await remove(sidecar);
	return [absolutePath, sidecar];
}

/** Reads exact portable cache, stale, texture, and aggregate runtime evidence for one PBR material. */
export function getSubsurfaceTransport(scene: Scene, data: any): any {
	const material = pbrMaterial(scene, data.materialId);
	const metadata = materialMetadata(material);
	const runtime = getSubsurfaceRuntime(scene as any);
	return {
		materialId: material.id,
		materialName: material.name,
		materialRevision: metadata.revision,
		settingsRevision: getSubsurfaceRuntimeSettings(scene as any).revision,
		caches: structuredClone(metadata.transportCaches),
		runtime: runtime.transport,
		limitations: [
			"The portable backend traces static scene geometry and lighting into a UV cache; it is not hardware DXR and does not update animated geometry or lights until re-baked.",
			"Each cache requires indexed closed or layered geometry and bounded 0–1 UV0/UV2 coordinates.",
		],
	};
}

/** Bakes one exact camera-independent off-screen transport cache and publishes it atomically. */
export async function bakeSubsurfaceTransport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = pbrMaterial(scene, data.materialId);
	const metadata = materialMetadata(material);
	if (data.expectedRevision !== metadata.revision) {
		throw new Error(`Subsurface material revision is stale. Expected ${metadata.revision}.`);
	}
	const mesh = transportMesh(scene, data.meshId, material);
	const previousCache = metadata.transportCaches.find((cache) => cache.meshId === mesh.id) ?? null;
	if (previousCache && data.expectedCacheRevision !== previousCache.revision) {
		throw new Error(`Subsurface transport cache revision is stale. Expected ${previousCache.revision}.`);
	}
	if (!previousCache && data.expectedCacheRevision !== undefined) {
		throw new Error("A first subsurface transport bake must omit expectedCacheRevision.");
	}
	const bakeOptions = validateBakeOptions(data);
	const prepared = prepareMesh(mesh, bakeOptions);
	const raster = rasterizeTransport(scene, prepared, metadata, bakeOptions);
	const png = await sharp(raster.rgba, { raw: { width: bakeOptions.resolution, height: bakeOptions.resolution, channels: 4 } })
		.png({ compressionLevel: 9, palette: false })
		.toBuffer();
	const contentRevision = createHash("sha256").update(png).digest("hex");
	const cacheRevision = (previousCache?.revision ?? 0) + 1;
	const absolutePath = await outputPath(data, mesh, cacheRevision);
	await writeAtomicPng(absolutePath, png);
	const relativePath = relative(dirname(projectConfiguration.path!), absolutePath).replace(/\\/g, "/");
	let texture: Texture | null = null;
	let publishedCache: ISubsurfaceTransportCache;
	let publishedRuntime: ReturnType<typeof configureSubsurfaceScattering>["transport"];
	let publishedMaterialRevision: number;
	try {
		texture = await loadTransportTexture(scene, absolutePath);
		publishedCache = validateSubsurfaceTransportCache({
			version: 1,
			backend: subsurfaceTransportBackend,
			ownership: "editor-generated",
			revision: cacheRevision,
			meshId: mesh.id,
			meshName: mesh.name,
			texture: serializeSubsurfaceTransportTexture(texture as any),
			texturePath: relativePath,
			contentRevision,
			uvChannel: bakeOptions.uvChannel,
			resolution: bakeOptions.resolution,
			sampleCount: bakeOptions.sampleCount,
			maxDistance: bakeOptions.maxDistance,
			bias: bakeOptions.bias,
			shadowing: bakeOptions.shadowing,
			dilation: bakeOptions.dilation,
			encoding: "linear-rgbm8",
			rgbmRange: 16,
			intensity: bakeOptions.intensity,
			profileId: metadata.profile.id,
			profileRevision: metadata.profile.revision,
			profileContentRevision: metadata.profile.contentRevision,
			geometrySignature: subsurfaceTransportMeshSignature(mesh as any, bakeOptions.uvChannel),
			lightingSignature: subsurfaceTransportLightingSignature(scene as any),
			coveredTexels: raster.coveredTexels,
			overlapTexels: raster.overlapTexels,
			tracedTexels: raster.tracedTexels,
			hitTexels: raster.hitTexels,
			rayCount: raster.rayCount,
			minimumThickness: raster.minimumThickness,
			maximumThickness: raster.maximumThickness,
			averageThickness: raster.averageThickness,
			limitations: [
				"Static camera-independent CPU ray-traced cache; re-bake after signed geometry, transform, profile, or scene-lighting changes.",
				"Linear radiance is stored as bounded RGBM8 range 16 and composed by the shared GLSL/WGSL PBR material plugin.",
			],
		});
		const nextMetadata: ISubsurfaceMaterialMetadata = {
			...metadata,
			version: 3,
			revision: metadata.revision + 1,
			transportCaches: [...metadata.transportCaches.filter((entry) => entry.meshId !== mesh.id), publishedCache].sort((left, right) =>
				left.meshId.localeCompare(right.meshId)
			),
		};
		setSubsurfaceTransportTexture(material as any, mesh.id, publishedCache.revision, publishedCache.contentRevision, texture as any);
		setSubsurfaceMaterialMetadata(material as any, nextMetadata);
		const runtime = configureSubsurfaceRuntime(scene);
		if (runtime.errors.length || runtime.transport.caches.find((entry) => entry.materialId === material.id && entry.meshId === mesh.id)?.stale) {
			throw new Error(`Baked subsurface transport could not be activated: ${[...runtime.errors, ...runtime.transport.warnings].join(" ")}`);
		}
		publishedRuntime = runtime.transport;
		publishedMaterialRevision = nextMetadata.revision;
	} catch (error) {
		clearSubsurfaceTransportTexture(material as any, mesh.id);
		setSubsurfaceMaterialMetadata(material as any, metadata);
		configureSubsurfaceRuntime(scene);
		await remove(absolutePath);
		throw error;
	}
	const cleanupWarnings: string[] = [];
	const removed: string[] = [];
	if (previousCache && previousCache.texturePath !== publishedCache.texturePath) {
		try {
			removed.push(...(await removeGeneratedCacheFile(previousCache)));
		} catch (error) {
			cleanupWarnings.push(`Previous generated cache cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try {
		await refreshAssetRegistryPaths([absolutePath, ...removed]);
	} catch (error) {
		cleanupWarnings.push(`Asset registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return {
		materialId: material.id,
		materialName: material.name,
		materialRevision: publishedMaterialRevision,
		cache: publishedCache,
		runtime: publishedRuntime,
		cleanupWarnings,
	};
}

/** Exact-revision, confirmation-gated removal of one generated transport cache and file. */
export async function clearSubsurfaceTransport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = pbrMaterial(scene, data.materialId);
	const metadata = materialMetadata(material);
	if (data.expectedRevision !== metadata.revision) {
		throw new Error(`Subsurface material revision is stale. Expected ${metadata.revision}.`);
	}
	const cache = metadata.transportCaches.find((entry) => entry.meshId === data.meshId);
	if (!cache) {
		throw new Error(`Material "${material.name}" has no subsurface transport cache for mesh "${data.meshId}".`);
	}
	if (data.expectedCacheRevision !== cache.revision) {
		throw new Error(`Subsurface transport cache revision is stale. Expected ${cache.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing subsurface transport requires confirm: true.");
	}
	const absolutePath = await secureRenderingAssetPath(cache.texturePath, ".png", "Subsurface transport");
	const sidecarPath = `${absolutePath}${ASSET_META_SUFFIX}`;
	const tombstones: Array<{ source: string; tombstone: string }> = [];
	try {
		for (const source of [absolutePath, sidecarPath]) {
			if (await pathExists(source)) {
				const tombstone = `${source}.${randomUUID()}.delete`;
				await move(source, tombstone, { overwrite: false });
				tombstones.push({ source, tombstone });
			}
		}
	} catch (error) {
		for (const entry of tombstones.reverse()) {
			if (await pathExists(entry.tombstone)) {
				await move(entry.tombstone, entry.source, { overwrite: false });
			}
		}
		throw error;
	}
	let publishedRuntime: ReturnType<typeof configureSubsurfaceScattering>["transport"];
	let publishedMaterialRevision: number;
	try {
		clearSubsurfaceTransportTexture(material as any, cache.meshId);
		const nextMetadata: ISubsurfaceMaterialMetadata = {
			...metadata,
			version: 3,
			revision: metadata.revision + 1,
			transportCaches: metadata.transportCaches.filter((entry) => entry.meshId !== cache.meshId),
		};
		setSubsurfaceMaterialMetadata(material as any, nextMetadata);
		const runtime = configureSubsurfaceRuntime(scene);
		if (runtime.errors.length) {
			throw new Error(`Subsurface transport cleanup could not be activated: ${runtime.errors.join(" ")}`);
		}
		publishedRuntime = runtime.transport;
		publishedMaterialRevision = nextMetadata.revision;
	} catch (error) {
		for (const entry of tombstones.reverse()) {
			if (await pathExists(entry.tombstone)) {
				await move(entry.tombstone, entry.source, { overwrite: false });
			}
		}
		setSubsurfaceMaterialMetadata(material as any, metadata);
		configureSubsurfaceRuntime(scene);
		throw error;
	}
	const cleanupWarnings: string[] = [];
	for (const entry of tombstones) {
		try {
			await remove(entry.tombstone);
		} catch (error) {
			cleanupWarnings.push(`Generated cache tombstone cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	try {
		await refreshAssetRegistryPaths([absolutePath, sidecarPath]);
	} catch (error) {
		cleanupWarnings.push(`Asset registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return {
		cleared: true,
		materialId: material.id,
		materialRevision: publishedMaterialRevision,
		meshId: cache.meshId,
		texturePath: cache.texturePath,
		runtime: publishedRuntime,
		cleanupWarnings,
	};
}
