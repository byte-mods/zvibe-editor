import {
	AbstractMesh,
	Color3,
	DirectionalLight,
	HemisphericLight,
	Light,
	Mesh,
	MultiMaterial,
	PBRMaterial,
	PointLight,
	Ray,
	Scene,
	SphericalHarmonics,
	SpotLight,
	StandardMaterial,
	Vector3,
} from "babylonjs";
import {
	configureLightProbeVolumes,
	getLightProbeRuntimeEvidence,
	ILightProbeBake,
	ILightProbeCell,
	ILightProbeSample,
	ILightProbeVolume,
	lightProbeRuntimeBackend,
	lightProbeVolumesMetadataKey,
	maximumLightProbeCellsPerVolume,
	maximumLightProbesPerVolume,
	maximumLightProbeTargetsPerVolume,
	maximumLightProbeVolumes,
	validateLightProbeVolumes,
	areaLightDiscSegments,
	getAreaLightBasis,
	getAreaLightSamplePoints,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { isRectAreaLight } from "../../tools/guards/nodes";

const bakeBackend = "bounded-cpu-adaptive-sh9-v1" as const;

interface IProbeBakeOptions {
	samples: number;
	maxDistance: number;
	shadowBias: number;
	environmentIntensity: number;
	directIntensity: number;
	bounceIntensity: number;
	geometryMeshIds: string[] | null;
}

interface IClosestPick {
	mesh: Mesh;
	point: Vector3;
	normal: Vector3;
	distance: number;
	subMeshId: number;
}

interface IWorkingCell {
	minimum: [number, number, number];
	maximum: [number, number, number];
	level: number;
}

function readVolumes(scene: Scene): ILightProbeVolume[] {
	return validateLightProbeVolumes(scene.metadata?.[lightProbeVolumesMetadataKey]);
}

function publishVolumes(scene: Scene, volumes: ILightProbeVolume[], options?: IMCPActionOptions): void {
	const validated = validateLightProbeVolumes(volumes);
	scene.metadata ??= {};
	scene.metadata[lightProbeVolumesMetadataKey] = validated;
	configureLightProbeVolumes(scene as any);
	options?.editor.layout.inspector.setEditedObject(scene);
	options?.editor.layout.inspector.forceUpdate();
}

function findVolume(volumes: ILightProbeVolume[], data: Record<string, unknown>): ILightProbeVolume {
	const volume = volumes.find((candidate) => candidate.id === data.id || (!!data.name && candidate.name === data.name));
	if (!volume) {
		throw new Error("Light Probe Volume not found. Refresh list_light_probe_volumes and provide its exact id.");
	}
	return volume;
}

function expectRevision(volume: ILightProbeVolume, expectedRevision: unknown): void {
	if (!Number.isInteger(expectedRevision) || expectedRevision !== volume.revision) {
		throw new Error(`Light Probe Volume "${volume.name}" changed. Refresh it and retry with expectedRevision: ${volume.revision}.`);
	}
}

function tuple(value: unknown, fallback: [number, number, number], field: string): [number, number, number] {
	const source = value ?? fallback;
	if (!Array.isArray(source) || source.length !== 3 || source.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		throw new Error(`${field} must contain exactly three finite numbers.`);
	}
	return [source[0], source[1], source[2]];
}

function eligibleTargetMeshes(scene: Scene): AbstractMesh[] {
	return scene.meshes.filter((mesh) => {
		const materials = mesh.material instanceof MultiMaterial ? mesh.material.subMaterials : [mesh.material];
		return materials.some((material) => material instanceof PBRMaterial || material instanceof StandardMaterial);
	});
}

function resolveTargetMeshIds(scene: Scene, value: unknown, fallbackToEligible: boolean): string[] {
	const ids = value === undefined && fallbackToEligible ? eligibleTargetMeshes(scene).map((mesh) => mesh.id) : value;
	if (!Array.isArray(ids) || ids.length < 1 || ids.length > maximumLightProbeTargetsPerVolume || ids.some((id) => typeof id !== "string" || !id)) {
		throw new Error(`targetMeshIds must contain 1–${maximumLightProbeTargetsPerVolume} mesh ids.`);
	}
	if (new Set(ids).size !== ids.length) {
		throw new Error("targetMeshIds must not contain duplicates.");
	}
	for (const id of ids) {
		const mesh = scene.getMeshById(id);
		if (!mesh) {
			throw new Error(`Target mesh "${id}" was not found in the active scene.`);
		}
		if (!eligibleTargetMeshes(scene).includes(mesh)) {
			throw new Error(`Target mesh "${mesh.name}" requires a PBR or Standard material (including MultiMaterial leaves).`);
		}
	}
	return [...ids];
}

function sceneBounds(scene: Scene): { minimum: [number, number, number]; maximum: [number, number, number] } {
	const meshes = scene.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
	if (!meshes.length) {
		return { minimum: [-500, -500, -500], maximum: [500, 500, 500] };
	}
	let minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	let maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
	for (const mesh of meshes) {
		mesh.computeWorldMatrix(true);
		mesh.refreshBoundingInfo(true, true);
		minimum = Vector3.Minimize(minimum, mesh.getBoundingInfo().boundingBox.minimumWorld);
		maximum = Vector3.Maximize(maximum, mesh.getBoundingInfo().boundingBox.maximumWorld);
	}
	const extent = maximum.subtract(minimum);
	const padding = new Vector3(Math.max(50, extent.x * 0.1), Math.max(50, extent.y * 0.1), Math.max(50, extent.z * 0.1));
	return { minimum: minimum.subtract(padding).asArray() as [number, number, number], maximum: maximum.add(padding).asArray() as [number, number, number] };
}

function summarizeVolume(volume: ILightProbeVolume): Record<string, unknown> {
	return {
		version: volume.version,
		id: volume.id,
		name: volume.name,
		revision: volume.revision,
		enabled: volume.enabled,
		priority: volume.priority,
		minimum: volume.minimum,
		maximum: volume.maximum,
		baseResolution: volume.baseResolution,
		adaptiveLevels: volume.adaptiveLevels,
		blendDistance: volume.blendDistance,
		targetMeshIds: volume.targetMeshIds,
		bake: volume.bake
			? {
					bakeId: volume.bake.bakeId,
					backend: volume.bake.backend,
					bakedAt: volume.bake.bakedAt,
					samples: volume.bake.samples,
					maxDistance: volume.bake.maxDistance,
					shadowBias: volume.bake.shadowBias,
					environmentIntensity: volume.bake.environmentIntensity,
					directIntensity: volume.bake.directIntensity,
					bounceIntensity: volume.bake.bounceIntensity,
					evidence: volume.bake.evidence,
				}
			: null,
	};
}

/** Lists bounded Light Probe Volumes and optionally pages exact baked probes/cells for one volume. */
export function listLightProbeVolumes(scene: Scene, data: Record<string, unknown> = {}): Record<string, unknown> {
	const volumes = readVolumes(scene);
	const selected = data.id || data.name ? [findVolume(volumes, data)] : volumes;
	const offset = Number.isInteger(data.offset) ? (data.offset as number) : 0;
	const limit = Number.isInteger(data.limit) ? (data.limit as number) : 20;
	if (offset < 0 || limit < 1 || limit > 50) {
		throw new Error("Light Probe Volume pagination requires offset >= 0 and limit from 1 through 50.");
	}
	const page = selected.slice(offset, offset + limit);
	const result: Record<string, unknown> = {
		total: selected.length,
		count: page.length,
		offset,
		hasMore: offset + page.length < selected.length,
		nextOffset: offset + page.length < selected.length ? offset + page.length : null,
		volumes: page.map(summarizeVolume),
		runtime: getLightProbeRuntimeEvidence(scene as any),
	};
	if (data.includeBakeData === true) {
		if (page.length !== 1 || !page[0].bake) {
			throw new Error("includeBakeData requires one exact baked volume selected by id or name.");
		}
		const probeOffset = Number.isInteger(data.probeOffset) ? (data.probeOffset as number) : 0;
		const probeLimit = Number.isInteger(data.probeLimit) ? (data.probeLimit as number) : 16;
		const cellOffset = Number.isInteger(data.cellOffset) ? (data.cellOffset as number) : 0;
		const cellLimit = Number.isInteger(data.cellLimit) ? (data.cellLimit as number) : 16;
		if (probeOffset < 0 || cellOffset < 0 || probeLimit < 1 || probeLimit > 64 || cellLimit < 1 || cellLimit > 64) {
			throw new Error("Bake-data pagination offsets must be non-negative and limits must be from 1 through 64.");
		}
		result.bakeData = {
			probes: page[0].bake.probes.slice(probeOffset, probeOffset + probeLimit),
			probeTotal: page[0].bake.probes.length,
			probeOffset,
			probeHasMore: probeOffset + probeLimit < page[0].bake.probes.length,
			cells: page[0].bake.cells.slice(cellOffset, cellOffset + cellLimit),
			cellTotal: page[0].bake.cells.length,
			cellOffset,
			cellHasMore: cellOffset + cellLimit < page[0].bake.cells.length,
		};
	}
	return result;
}

/** Creates one persisted bounded adaptive Light Probe Volume. */
export function createLightProbeVolume(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const volumes = readVolumes(scene);
	if (volumes.length >= maximumLightProbeVolumes) {
		throw new Error(`The active scene already has the maximum ${maximumLightProbeVolumes} Light Probe Volumes.`);
	}
	const name = typeof data.name === "string" ? data.name.trim() : "";
	if (!name || name.length > 128 || volumes.some((volume) => volume.name === name)) {
		throw new Error("Light Probe Volume name must be unique and contain 1–128 characters.");
	}
	const bounds = sceneBounds(scene);
	const volume: ILightProbeVolume = {
		version: 1,
		id: crypto.randomUUID(),
		name,
		revision: 1,
		enabled: data.enabled === undefined ? true : data.enabled === true,
		priority: data.priority === undefined ? 0 : (data.priority as number),
		minimum: tuple(data.minimum, bounds.minimum, "minimum"),
		maximum: tuple(data.maximum, bounds.maximum, "maximum"),
		baseResolution: tuple(data.baseResolution, [3, 3, 3], "baseResolution"),
		adaptiveLevels: data.adaptiveLevels === undefined ? 1 : (data.adaptiveLevels as number),
		blendDistance: data.blendDistance === undefined ? 100 : (data.blendDistance as number),
		targetMeshIds: resolveTargetMeshIds(scene, data.targetMeshIds, true),
		bake: null,
	};
	publishVolumes(scene, [...volumes, volume], options);
	return { created: true, volume: summarizeVolume(volume), runtime: getLightProbeRuntimeEvidence(scene as any) };
}

/** Updates authoring/runtime fields with an exact revision lease; spatial-layout changes invalidate the old bake. */
export function setLightProbeVolume(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const volumes = readVolumes(scene);
	const volume = findVolume(volumes, data);
	expectRevision(volume, data.expectedRevision);
	const next = structuredClone(volume);
	if (data.newName !== undefined) {
		next.name = String(data.newName).trim();
	}
	if (data.enabled !== undefined) {
		next.enabled = data.enabled === true;
	}
	if (data.priority !== undefined) {
		next.priority = data.priority as number;
	}
	if (data.minimum !== undefined) {
		next.minimum = tuple(data.minimum, next.minimum, "minimum");
	}
	if (data.maximum !== undefined) {
		next.maximum = tuple(data.maximum, next.maximum, "maximum");
	}
	if (data.baseResolution !== undefined) {
		next.baseResolution = tuple(data.baseResolution, next.baseResolution, "baseResolution");
	}
	if (data.adaptiveLevels !== undefined) {
		next.adaptiveLevels = data.adaptiveLevels as number;
	}
	if (data.blendDistance !== undefined) {
		next.blendDistance = data.blendDistance as number;
	}
	if (data.targetMeshIds !== undefined) {
		next.targetMeshIds = resolveTargetMeshIds(scene, data.targetMeshIds, false);
	}
	if (!next.name || next.name.length > 128 || volumes.some((candidate) => candidate.id !== next.id && candidate.name === next.name)) {
		throw new Error("Light Probe Volume name must be unique and contain 1–128 characters.");
	}
	const layoutChanged =
		JSON.stringify(next.minimum) !== JSON.stringify(volume.minimum) ||
		JSON.stringify(next.maximum) !== JSON.stringify(volume.maximum) ||
		JSON.stringify(next.baseResolution) !== JSON.stringify(volume.baseResolution) ||
		next.adaptiveLevels !== volume.adaptiveLevels;
	if (layoutChanged) {
		next.bake = null;
	}
	next.revision++;
	const replaced = volumes.map((candidate) => (candidate.id === volume.id ? next : candidate));
	publishVolumes(scene, replaced, options);
	return { updated: true, bakeInvalidated: layoutChanged && !!volume.bake, volume: summarizeVolume(next), runtime: getLightProbeRuntimeEvidence(scene as any) };
}

function validateBakeOptions(data: Record<string, unknown>): IProbeBakeOptions {
	const samples = data.samples ?? 32;
	const maxDistance = data.maxDistance ?? 10_000;
	const shadowBias = data.shadowBias ?? 1;
	const environmentIntensity = data.environmentIntensity ?? 1;
	const directIntensity = data.directIntensity ?? 1;
	const bounceIntensity = data.bounceIntensity ?? 1;
	if (!Number.isInteger(samples) || (samples as number) < 8 || (samples as number) > 256) {
		throw new Error("Probe samples must be an integer from 8 through 256.");
	}
	if (!Number.isFinite(maxDistance) || (maxDistance as number) < 10 || (maxDistance as number) > 1_000_000) {
		throw new Error("Probe maxDistance must be from 10 through 1000000 centimeters.");
	}
	if (!Number.isFinite(shadowBias) || (shadowBias as number) <= 0 || (shadowBias as number) > 1000) {
		throw new Error("Probe shadowBias must be greater than 0 and at most 1000 centimeters.");
	}
	for (const [field, value] of [
		["environmentIntensity", environmentIntensity],
		["directIntensity", directIntensity],
		["bounceIntensity", bounceIntensity],
	] as const) {
		if (!Number.isFinite(value) || (value as number) < 0 || (value as number) > 16) {
			throw new Error(`${field} must be from 0 through 16.`);
		}
	}
	let geometryMeshIds: string[] | null = null;
	if (data.geometryMeshIds !== undefined) {
		if (!Array.isArray(data.geometryMeshIds) || data.geometryMeshIds.length > 256 || data.geometryMeshIds.some((id) => typeof id !== "string" || !id)) {
			throw new Error("geometryMeshIds must contain at most 256 mesh ids.");
		}
		geometryMeshIds = [...new Set(data.geometryMeshIds as string[])];
	}
	return {
		samples: samples as number,
		maxDistance: maxDistance as number,
		shadowBias: shadowBias as number,
		environmentIntensity: environmentIntensity as number,
		directIntensity: directIntensity as number,
		bounceIntensity: bounceIntensity as number,
		geometryMeshIds,
	};
}

function resolveGeometryMeshes(scene: Scene, volume: ILightProbeVolume, options: IProbeBakeOptions): Mesh[] {
	const targetIds = options.geometryMeshIds ? new Set<string>() : new Set(volume.targetMeshIds);
	const meshes = scene.meshes.filter(
		(mesh): mesh is Mesh =>
			mesh instanceof Mesh &&
			mesh.getTotalVertices() > 0 &&
			mesh.getTotalIndices() > 0 &&
			!targetIds.has(mesh.id) &&
			(!options.geometryMeshIds || options.geometryMeshIds.includes(mesh.id))
	);
	if (options.geometryMeshIds) {
		for (const id of options.geometryMeshIds) {
			if (!meshes.some((mesh) => mesh.id === id)) {
				throw new Error(`Geometry mesh "${id}" was not found or has no indexed triangle geometry.`);
			}
		}
	}
	for (const mesh of meshes) {
		mesh.computeWorldMatrix(true);
		mesh.refreshBoundingInfo();
	}
	return meshes;
}

function boxesIntersect(minimum: number[], maximum: number[], mesh: Mesh): boolean {
	const bounds = mesh.getBoundingInfo().boundingBox;
	return !(
		bounds.maximumWorld.x < minimum[0] ||
		bounds.minimumWorld.x > maximum[0] ||
		bounds.maximumWorld.y < minimum[1] ||
		bounds.minimumWorld.y > maximum[1] ||
		bounds.maximumWorld.z < minimum[2] ||
		bounds.minimumWorld.z > maximum[2]
	);
}

function splitCell(cell: IWorkingCell): IWorkingCell[] {
	const middle = cell.minimum.map((value, axis) => (value + cell.maximum[axis]) * 0.5);
	const output: IWorkingCell[] = [];
	for (let corner = 0; corner < 8; corner++) {
		const minimum = [0, 1, 2].map((axis) => (corner & (1 << axis) ? middle[axis] : cell.minimum[axis])) as [number, number, number];
		const maximum = [0, 1, 2].map((axis) => (corner & (1 << axis) ? cell.maximum[axis] : middle[axis])) as [number, number, number];
		output.push({ minimum, maximum, level: cell.level + 1 });
	}
	return output;
}

function generateAdaptiveCells(volume: ILightProbeVolume, geometry: Mesh[]): IWorkingCell[] {
	let cells: IWorkingCell[] = [];
	for (let z = 0; z < volume.baseResolution[2] - 1; z++) {
		for (let y = 0; y < volume.baseResolution[1] - 1; y++) {
			for (let x = 0; x < volume.baseResolution[0] - 1; x++) {
				const indices = [x, y, z];
				const minimum = indices.map(
					(index, axis) => volume.minimum[axis] + ((volume.maximum[axis] - volume.minimum[axis]) * index) / (volume.baseResolution[axis] - 1)
				) as [number, number, number];
				const maximum = indices.map(
					(index, axis) => volume.minimum[axis] + ((volume.maximum[axis] - volume.minimum[axis]) * (index + 1)) / (volume.baseResolution[axis] - 1)
				) as [number, number, number];
				cells.push({ minimum, maximum, level: 0 });
			}
		}
	}
	for (let level = 0; level < volume.adaptiveLevels; level++) {
		const refined: IWorkingCell[] = [];
		for (const cell of cells) {
			if (cell.level === level && geometry.some((mesh) => boxesIntersect(cell.minimum, cell.maximum, mesh))) {
				refined.push(...splitCell(cell));
			} else {
				refined.push(cell);
			}
		}
		cells = refined;
		if (cells.length > maximumLightProbeCellsPerVolume) {
			throw new Error(`Adaptive subdivision would exceed ${maximumLightProbeCellsPerVolume} cells. Lower baseResolution or adaptiveLevels.`);
		}
	}
	return cells;
}

function materialRadiance(mesh: Mesh, subMeshId: number): { albedo: Color3; emissive: Color3 } {
	const material = mesh.material instanceof MultiMaterial ? mesh.subMeshes[subMeshId]?.getMaterial() : mesh.material;
	if (material instanceof PBRMaterial) {
		return { albedo: material.albedoColor.clone(), emissive: material.emissiveColor.clone() };
	}
	if (material instanceof StandardMaterial) {
		return { albedo: material.diffuseColor.clone(), emissive: material.emissiveColor.clone() };
	}
	return { albedo: Color3.White(), emissive: Color3.Black() };
}

function pickClosest(geometry: Mesh[], ray: Ray): IClosestPick | null {
	let closest: IClosestPick | null = null;
	for (const mesh of geometry) {
		if (!mesh.isEnabled() || !mesh.isVisible) {
			continue;
		}
		const pick = ray.intersectsMesh(mesh, false);
		if (!pick.hit || !pick.pickedPoint || pick.distance < 0 || pick.distance > ray.length || (closest && pick.distance >= closest.distance)) {
			continue;
		}
		const normal = pick.getNormal(true, true);
		if (!normal) {
			continue;
		}
		closest = { mesh, point: pick.pickedPoint.clone(), normal: normal.normalize(), distance: pick.distance, subMeshId: pick.subMeshId };
	}
	return closest;
}

function occluded(geometry: Mesh[], point: Vector3, direction: Vector3, distance: number, bias: number): { blocked: boolean; rays: number } {
	if (distance <= bias) {
		return { blocked: false, rays: 0 };
	}
	const ray = new Ray(point.add(direction.scale(bias)), direction, distance - bias);
	return { blocked: !!pickClosest(geometry, ray), rays: 1 };
}

function analyticAreaLight(geometry: Mesh[], point: Vector3, light: Light, options: IProbeBakeOptions): { direction: Vector3; color: Color3; rays: number }[] {
	if (!isRectAreaLight(light) || !light.isEnabled() || light.intensity <= 0) {
		return [];
	}
	const rawBasis = getAreaLightBasis(light as any);
	const basisDirection = Vector3.FromArray(rawBasis.direction.asArray());
	const surfacePoints = getAreaLightSamplePoints(light as any, areaLightDiscSegments).map((sample) => Vector3.FromArray(sample.asArray()));
	return surfacePoints.flatMap((surfacePoint) => {
		if (Vector3.Dot(basisDirection, point.subtract(surfacePoint)) <= 0) {
			return [];
		}
		const delta = surfacePoint.subtract(point);
		const distance = delta.length();
		if (distance <= options.shadowBias || (Number.isFinite(light.range) && light.range > 0 && distance > light.range)) {
			return [];
		}
		const direction = delta.scale(1 / distance);
		let attenuation = 1;
		if (Number.isFinite(light.range) && light.range > 0) {
			const normalized = distance / light.range;
			attenuation = Math.max(0, 1 - normalized * normalized);
		}
		const shadow = occluded(geometry, point, direction, distance, options.shadowBias);
		return [
			{
				direction,
				color: shadow.blocked ? Color3.Black() : light.diffuse.scale((light.intensity * attenuation * options.directIntensity) / surfacePoints.length),
				rays: shadow.rays,
			},
		];
	});
}

function analyticLight(geometry: Mesh[], point: Vector3, light: Light, options: IProbeBakeOptions): { direction: Vector3; color: Color3; rays: number } | null {
	if (!light.isEnabled() || light.intensity <= 0 || light instanceof HemisphericLight) {
		return null;
	}
	let direction: Vector3;
	let distance = options.maxDistance;
	let attenuation = 1;
	if (light instanceof DirectionalLight) {
		direction = light.getShadowDirection().negate().normalize();
	} else if (light instanceof PointLight || light instanceof SpotLight) {
		const delta = light.getAbsolutePosition().subtract(point);
		distance = delta.length();
		if (distance <= options.shadowBias || (Number.isFinite(light.range) && light.range > 0 && distance > light.range)) {
			return null;
		}
		direction = delta.scale(1 / distance);
		if (Number.isFinite(light.range) && light.range > 0) {
			const normalized = distance / light.range;
			attenuation = Math.max(0, 1 - normalized * normalized);
		}
		if (light instanceof SpotLight) {
			const coneDot = Vector3.Dot(light.getShadowDirection().normalize(), direction.negate());
			const coneLimit = Math.cos(light.angle * 0.5);
			if (coneDot <= coneLimit) {
				return null;
			}
			attenuation *= Math.pow((coneDot - coneLimit) / Math.max(1e-6, 1 - coneLimit), Math.max(0, light.exponent));
		}
	} else {
		return null;
	}
	const shadow = occluded(geometry, point, direction, distance, options.shadowBias);
	if (shadow.blocked) {
		return { direction, color: Color3.Black(), rays: shadow.rays };
	}
	return { direction, color: light.diffuse.scale(light.intensity * attenuation * options.directIntensity), rays: shadow.rays };
}

function surfaceLighting(scene: Scene, geometry: Mesh[], pick: IClosestPick, options: IProbeBakeOptions): { color: Color3; rays: number } {
	let output = scene.ambientColor.scale(options.environmentIntensity);
	let rays = 0;
	for (const light of scene.lights) {
		if (!light.isEnabled() || light.intensity <= 0) {
			continue;
		}
		if (light instanceof HemisphericLight) {
			const sky = Math.max(0, Math.min(1, Vector3.Dot(pick.normal, light.direction.normalize()) * 0.5 + 0.5));
			output.addInPlace(
				light.diffuse
					.scale(sky)
					.add(light.groundColor.scale(1 - sky))
					.scale(light.intensity * options.directIntensity)
			);
			continue;
		}
		if (isRectAreaLight(light)) {
			for (const sample of analyticAreaLight(geometry, pick.point.add(pick.normal.scale(options.shadowBias)), light, options)) {
				rays += sample.rays;
				output.addInPlace(sample.color.scale(Math.max(0, Vector3.Dot(pick.normal, sample.direction))));
			}
			continue;
		}
		const sample = analyticLight(geometry, pick.point.add(pick.normal.scale(options.shadowBias)), light, options);
		if (!sample) {
			continue;
		}
		rays += sample.rays;
		const lambert = Math.max(0, Vector3.Dot(pick.normal, sample.direction));
		output.addInPlace(sample.color.scale(lambert));
	}
	return { color: output, rays };
}

function sampleDirection(index: number, count: number): Vector3 {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const y = 1 - ((index + 0.5) * 2) / count;
	const radius = Math.sqrt(Math.max(0, 1 - y * y));
	const angle = golden * index;
	return new Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}

function coefficientsFromHarmonics(harmonics: SphericalHarmonics): number[] {
	return [harmonics.l00, harmonics.l1_1, harmonics.l10, harmonics.l11, harmonics.l2_2, harmonics.l2_1, harmonics.l20, harmonics.l21, harmonics.l22].flatMap((value) =>
		value.asArray()
	);
}

function bakeProbe(scene: Scene, geometry: Mesh[], position: Vector3, options: IProbeBakeOptions): ILightProbeSample {
	const harmonics = new SphericalHarmonics();
	let rays = 0;
	let nearHits = 0;
	for (let index = 0; index < options.samples; index++) {
		const direction = sampleDirection(index, options.samples);
		const pick = pickClosest(geometry, new Ray(position, direction, options.maxDistance));
		rays++;
		let radiance: Color3;
		if (pick) {
			if (pick.distance <= options.shadowBias * 4) {
				nearHits++;
			}
			const surface = surfaceLighting(scene, geometry, pick, options);
			const material = materialRadiance(pick.mesh, pick.subMeshId);
			rays += surface.rays;
			radiance = surface.color.multiply(material.albedo).add(material.emissive).scale(options.bounceIntensity);
		} else {
			const background = new Color3(scene.clearColor.r, scene.clearColor.g, scene.clearColor.b).scale(options.environmentIntensity);
			for (const light of scene.lights) {
				if (light instanceof HemisphericLight && light.isEnabled()) {
					const sky = Math.max(0, Math.min(1, Vector3.Dot(direction, light.direction.normalize()) * 0.5 + 0.5));
					background.addInPlace(
						light.diffuse
							.scale(sky)
							.add(light.groundColor.scale(1 - sky))
							.scale(light.intensity * options.environmentIntensity)
					);
				}
			}
			radiance = background;
		}
		harmonics.addLight(direction, radiance, (Math.PI * 4) / options.samples);
	}
	for (const light of scene.lights) {
		if (isRectAreaLight(light)) {
			for (const sample of analyticAreaLight(geometry, position, light, options)) {
				rays += sample.rays;
				harmonics.addLight(sample.direction, sample.color, 1);
			}
			continue;
		}
		const sample = analyticLight(geometry, position, light, options);
		if (!sample) {
			continue;
		}
		rays += sample.rays;
		harmonics.addLight(sample.direction, sample.color, 1);
	}
	harmonics.convertIncidentRadianceToIrradiance();
	harmonics.convertIrradianceToLambertianRadiance();
	harmonics.preScaleForRendering();
	return { position: position.asArray() as [number, number, number], coefficients: coefficientsFromHarmonics(harmonics), validity: 1 - nearHits / options.samples, rays };
}

function materializeCells(cells: IWorkingCell[]): { positions: [number, number, number][]; cells: ILightProbeCell[] } {
	const positions: [number, number, number][] = [];
	const indices = new Map<string, number>();
	const output: ILightProbeCell[] = cells.map((cell) => {
		const probeIndices: number[] = [];
		for (let corner = 0; corner < 8; corner++) {
			const position = [0, 1, 2].map((axis) => (corner & (1 << axis) ? cell.maximum[axis] : cell.minimum[axis])) as [number, number, number];
			const key = position.map((value) => value.toFixed(6)).join(":");
			let index = indices.get(key);
			if (index === undefined) {
				index = positions.length;
				indices.set(key, index);
				positions.push(position);
			}
			probeIndices.push(index);
		}
		return { minimum: cell.minimum, maximum: cell.maximum, probeIndices: probeIndices as ILightProbeCell["probeIndices"], level: cell.level };
	});
	if (positions.length > maximumLightProbesPerVolume) {
		throw new Error(`Adaptive layout would require ${positions.length} probes, exceeding the ${maximumLightProbesPerVolume} bound. Lower baseResolution or adaptiveLevels.`);
	}
	return { positions, cells: output };
}

/** Bakes direct, environment, emissive, and one-bounce radiance into adaptive SH9 probes before atomically publishing them. */
export function bakeLightProbeVolume(scene: Scene, data: Record<string, unknown>, actionOptions: IMCPActionOptions): Record<string, unknown> {
	const volumes = readVolumes(scene);
	const volume = findVolume(volumes, data);
	expectRevision(volume, data.expectedRevision);
	const options = validateBakeOptions(data);
	const geometry = resolveGeometryMeshes(scene, volume, options);
	const workingCells = generateAdaptiveCells(volume, geometry);
	const layout = materializeCells(workingCells);
	const probes = layout.positions.map((position) => bakeProbe(scene, geometry, Vector3.FromArray(position), options));
	const validities = probes.map((probe) => probe.validity);
	const maximumCoefficient = probes.reduce((maximum, probe) => Math.max(maximum, ...probe.coefficients.map(Math.abs)), 0);
	const baseCellCount = (volume.baseResolution[0] - 1) * (volume.baseResolution[1] - 1) * (volume.baseResolution[2] - 1);
	const bake: ILightProbeBake = {
		bakeId: crypto.randomUUID(),
		backend: bakeBackend,
		bakedAt: new Date().toISOString(),
		samples: options.samples,
		maxDistance: options.maxDistance,
		shadowBias: options.shadowBias,
		environmentIntensity: options.environmentIntensity,
		directIntensity: options.directIntensity,
		bounceIntensity: options.bounceIntensity,
		probes,
		cells: layout.cells,
		evidence: {
			probeCount: probes.length,
			cellCount: layout.cells.length,
			baseCellCount,
			refinedCellCount: layout.cells.filter((cell) => cell.level > 0).length,
			totalRays: probes.reduce((sum, probe) => sum + probe.rays, 0),
			minimumValidity: Math.min(...validities),
			averageValidity: validities.reduce((sum, value) => sum + value, 0) / validities.length,
			maximumCoefficient,
			geometryMeshCount: geometry.length,
		},
	};
	const next = structuredClone(volume);
	next.bake = bake;
	next.revision++;
	publishVolumes(
		scene,
		volumes.map((candidate) => (candidate.id === volume.id ? next : candidate)),
		actionOptions
	);
	return {
		baked: true,
		volume: summarizeVolume(next),
		runtime: getLightProbeRuntimeEvidence(scene as any),
		limitations: [
			"Static indexed geometry is ray traced on CPU; moving target meshes are excluded from geometry by default.",
			"Constant PBR/Standard albedo and emissive colors contribute to bounce radiance; material textures and environment cubemap pixels are not CPU sampled.",
			"Adaptive subdivision refines geometry-intersecting cells up to two levels and is bounded to 4096 probes and 8192 leaf cells per volume.",
		],
	};
}

/** Deletes a volume and its baked coefficients with confirmation plus an exact revision lease. */
export function deleteLightProbeVolume(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	const volumes = readVolumes(scene);
	const volume = findVolume(volumes, data);
	expectRevision(volume, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a Light Probe Volume permanently removes its baked coefficients. Retry with confirm: true.");
	}
	publishVolumes(
		scene,
		volumes.filter((candidate) => candidate.id !== volume.id),
		options
	);
	return { deleted: true, id: volume.id, name: volume.name, bakeId: volume.bake?.bakeId ?? null, runtime: getLightProbeRuntimeEvidence(scene as any) };
}

/** Returns exact runtime/plugin evidence and optionally evaluates one mesh at an explicit or current world position. */
export function getLightProbeRuntime(scene: Scene, data: Record<string, unknown> = {}, options?: IMCPActionOptions): Record<string, unknown> {
	let runtime = (scene as any).lightProbeVolumes as ReturnType<typeof configureLightProbeVolumes> | undefined;
	if (!runtime) {
		runtime = configureLightProbeVolumes(scene as any);
	}
	let evaluation: Record<string, unknown> | null = null;
	if (data.meshId || data.meshName) {
		const mesh = scene.meshes.find((candidate) => candidate.id === data.meshId || candidate.name === data.meshName);
		if (!mesh) {
			throw new Error("Runtime evaluation mesh was not found. Provide its exact id or name.");
		}
		const position = data.position === undefined ? mesh.getBoundingInfo().boundingBox.centerWorld : Vector3.FromArray(tuple(data.position, [0, 0, 0], "position"));
		const value = runtime.evaluate(mesh as any, position as any);
		evaluation = value
			? { meshId: mesh.id, meshName: mesh.name, position: position.asArray(), ...value }
			: {
					meshId: mesh.id,
					meshName: mesh.name,
					position: position.asArray(),
					coefficients: null,
					reason: "No enabled baked volume targets this mesh at the requested position.",
				};
	}
	options?.editor.layout.inspector.forceUpdate();
	return { backend: lightProbeRuntimeBackend, runtime: runtime.inspect(), evaluation };
}
