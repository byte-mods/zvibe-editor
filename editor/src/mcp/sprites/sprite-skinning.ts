import { createHash } from "crypto";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path/posix";

import { readFile } from "fs-extra";

import { Animation, AnimationGroup, Bone, Color3, Matrix, Mesh, Quaternion, Scene, Skeleton, StandardMaterial, Texture, Tools, Vector3, VertexData } from "babylonjs";

import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { projectConfiguration } from "../../project/configuration";
import { inspectPsdLayers, IPsdLayerDocumentInfo, IPsdLayerInfo } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

export const SPRITE_SKIN_METADATA_KEY = "babylonEditorSpriteSkin";

export interface ISpriteSkinBoneDefinition {
	id: string;
	name: string;
	parentId: string | null;
	position: [number, number];
	rotationDegrees: number;
	length: number;
	sourceLayerIndex: number | null;
}

export interface ISpriteSkinDefinition {
	model: "unity-sprite-skin-v1";
	revision: number;
	sourcePath: string | null;
	documentWidthPixels: number;
	documentHeightPixels: number;
	pixelsPerUnit: number;
	columns: number;
	rows: number;
	bones: ISpriteSkinBoneDefinition[];
	psd: { sourcePath: string; sourceFingerprint: string; layerIndices: number[] } | null;
}

interface ISpriteSkinBonePose {
	start: Vector3;
	end: Vector3;
	rotationRadians: number;
}

export interface IPsdSpriteSkinRigPlan {
	model: "unity-psd-sprite-rig-plan-v1";
	sourcePath: string;
	sourceFingerprint: string;
	fingerprint: string;
	documentWidthPixels: number;
	documentHeightPixels: number;
	pixelsPerUnit: number;
	columns: number;
	rows: number;
	bones: ISpriteSkinBoneDefinition[];
	layers: Array<{ index: number; name: string; kind: string; visible: boolean; included: boolean; boneId: string | null; parentBoneId: string | null }>;
	warnings: string[];
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function resolveProjectPath(path: string): string {
	const root = projectDirectory();
	const absolute = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error("Sprite skin source paths must stay inside the open project directory.");
	}
	return absolute;
}

function portableProjectPath(path: string): string {
	return relative(projectDirectory(), path).replace(/\\/g, "/");
}

function finiteNumber(value: unknown, label: string, minimum?: number, maximum?: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
		throw new Error(`${label} must be a finite number${minimum === undefined ? "" : ` from ${minimum}`}${maximum === undefined ? "" : ` through ${maximum}`}.`);
	}
	return value;
}

function normalizeBones(value: unknown): ISpriteSkinBoneDefinition[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
		throw new Error("A sprite skin requires 1–128 bones.");
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	const bones = value.map((candidate: any, index): ISpriteSkinBoneDefinition => {
		const id = typeof candidate?.id === "string" && candidate.id.trim() ? candidate.id.trim() : `bone-${index + 1}`;
		const name = typeof candidate?.name === "string" && candidate.name.trim() ? candidate.name.trim() : `Bone ${index + 1}`;
		if (id.length > 128 || name.length > 128 || ids.has(id) || names.has(name)) {
			throw new Error(`Sprite skin bone ids and names must be unique non-empty strings no longer than 128 characters (invalid bone ${index}).`);
		}
		ids.add(id);
		names.add(name);
		if (!Array.isArray(candidate.position) || candidate.position.length !== 2) {
			throw new Error(`Sprite skin bone "${name}" position must contain exactly two numbers.`);
		}
		return {
			id,
			name,
			parentId: candidate.parentId === null || candidate.parentId === undefined ? null : String(candidate.parentId),
			position: [
				finiteNumber(candidate.position[0], `${name}.position[0]`, -100_000, 100_000),
				finiteNumber(candidate.position[1], `${name}.position[1]`, -100_000, 100_000),
			],
			rotationDegrees: finiteNumber(candidate.rotationDegrees ?? 0, `${name}.rotationDegrees`, -360_000, 360_000),
			length: finiteNumber(candidate.length ?? 1, `${name}.length`, 0.001, 100_000),
			sourceLayerIndex:
				candidate.sourceLayerIndex === null || candidate.sourceLayerIndex === undefined ? null : finiteNumber(candidate.sourceLayerIndex, `${name}.sourceLayerIndex`, 0),
		};
	});
	if (bones.some((bone) => bone.sourceLayerIndex !== null && !Number.isInteger(bone.sourceLayerIndex))) {
		throw new Error("Sprite skin sourceLayerIndex values must be non-negative integers or null.");
	}
	const byId = new Map(bones.map((bone) => [bone.id, bone]));
	for (const bone of bones) {
		if (bone.parentId === bone.id || (bone.parentId && !byId.has(bone.parentId))) {
			throw new Error(`Sprite skin bone "${bone.name}" references an invalid parentId.`);
		}
		const visited = new Set<string>([bone.id]);
		let parentId = bone.parentId;
		while (parentId) {
			if (visited.has(parentId)) {
				throw new Error(`Sprite skin bone hierarchy contains a cycle at "${bone.name}".`);
			}
			visited.add(parentId);
			parentId = byId.get(parentId)?.parentId ?? null;
		}
	}
	return bones;
}

function spriteSkinDefinition(mesh: Mesh): ISpriteSkinDefinition {
	const definition = mesh.metadata?.[SPRITE_SKIN_METADATA_KEY];
	if (definition?.model !== "unity-sprite-skin-v1") {
		throw new Error(`Mesh "${mesh.name}" is not a planar sprite skin.`);
	}
	return definition;
}

function resolveSpriteSkin(scene: Scene, data: any): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!(node instanceof Mesh)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	spriteSkinDefinition(node);
	return node;
}

function definitionFingerprint(mesh: Mesh, definition = spriteSkinDefinition(mesh)): string {
	return createHash("sha256")
		.update(JSON.stringify({ nodeId: mesh.id, definition, skeletonId: mesh.skeleton?.id ?? null, vertexCount: mesh.getTotalVertices(), indexCount: mesh.getTotalIndices() }))
		.digest("hex");
}

function verifyLease(mesh: Mesh, data: any): ISpriteSkinDefinition {
	const definition = spriteSkinDefinition(mesh);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== definition.revision) {
		throw new Error(`Sprite skin revision is ${definition.revision}; reread get_sprite_skin and retry with that expectedRevision.`);
	}
	const fingerprint = definitionFingerprint(mesh, definition);
	if (data.expectedFingerprint !== fingerprint) {
		throw new Error(`Sprite skin changed after inspection; reread get_sprite_skin and use fingerprint ${fingerprint}.`);
	}
	return definition;
}

function bonePoses(bones: ISpriteSkinBoneDefinition[]): Map<string, ISpriteSkinBonePose> {
	const result = new Map<string, ISpriteSkinBonePose>();
	const byId = new Map(bones.map((bone) => [bone.id, bone]));
	const visit = (bone: ISpriteSkinBoneDefinition): ISpriteSkinBonePose => {
		const existing = result.get(bone.id);
		if (existing) {
			return existing;
		}
		const parent = bone.parentId ? visit(byId.get(bone.parentId)!) : null;
		const parentRotation = parent?.rotationRadians ?? 0;
		const cosine = Math.cos(parentRotation);
		const sine = Math.sin(parentRotation);
		const start = parent
			? parent.start.add(new Vector3(bone.position[0] * cosine - bone.position[1] * sine, bone.position[0] * sine + bone.position[1] * cosine, 0))
			: new Vector3(bone.position[0], bone.position[1], 0);
		const rotationRadians = parentRotation + (bone.rotationDegrees * Math.PI) / 180;
		const end = start.add(new Vector3(Math.cos(rotationRadians) * bone.length, Math.sin(rotationRadians) * bone.length, 0));
		const pose = { start, end, rotationRadians };
		result.set(bone.id, pose);
		return pose;
	};
	bones.forEach(visit);
	return result;
}

function distanceToSegment(point: Vector3, start: Vector3, end: Vector3): number {
	const segment = end.subtract(start);
	const lengthSquared = segment.lengthSquared();
	const factor = lengthSquared <= 0.000001 ? 0 : Math.max(0, Math.min(1, Vector3.Dot(point.subtract(start), segment) / lengthSquared));
	return Vector3.Distance(point, start.add(segment.scale(factor)));
}

function createGrid(width: number, height: number, columns: number, rows: number, bones: ISpriteSkinBoneDefinition[]): VertexData {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	const matricesIndices: number[] = [];
	const matricesWeights: number[] = [];
	const poses = bonePoses(bones);
	for (let y = 0; y <= rows; y++) {
		for (let x = 0; x <= columns; x++) {
			const px = (x / columns - 0.5) * width;
			const py = (y / rows - 0.5) * height;
			positions.push(px, py, 0);
			normals.push(0, 0, -1);
			uvs.push(x / columns, 1 - y / rows);
			const nearest = bones
				.map((bone, boneIndex) => ({ boneIndex, distance: distanceToSegment(new Vector3(px, py, 0), poses.get(bone.id)!.start, poses.get(bone.id)!.end) }))
				.sort((first, second) => first.distance - second.distance || first.boneIndex - second.boneIndex)
				.slice(0, Math.min(4, bones.length));
			const raw = nearest.map((entry) => 1 / Math.max(0.01, entry.distance));
			const sum = raw.reduce((total, value) => total + value, 0);
			for (let influence = 0; influence < 4; influence++) {
				matricesIndices.push(nearest[influence]?.boneIndex ?? 0);
				matricesWeights.push(raw[influence] === undefined ? 0 : raw[influence] / sum);
			}
		}
	}
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < columns; x++) {
			const first = y * (columns + 1) + x;
			indices.push(first, first + columns + 1, first + 1, first + 1, first + columns + 1, first + columns + 2);
		}
	}
	const data = new VertexData();
	data.positions = positions;
	data.normals = normals;
	data.uvs = uvs;
	data.indices = indices;
	data.matricesIndices = matricesIndices;
	data.matricesWeights = matricesWeights;
	return data;
}

function createSkeleton(scene: Scene, name: string, bones: ISpriteSkinBoneDefinition[]): Skeleton {
	const skeleton = new Skeleton(`${name} Skeleton`, Tools.RandomId(), scene);
	const created = new Map<string, Bone>();
	const pending = [...bones];
	while (pending.length) {
		const index = pending.findIndex((bone) => !bone.parentId || created.has(bone.parentId));
		if (index === -1) {
			throw new Error("Unable to resolve sprite skin bone hierarchy.");
		}
		const definition = pending.splice(index, 1)[0];
		const matrix = Matrix.Compose(
			Vector3.One(),
			Quaternion.RotationAxis(Vector3.Forward(), (definition.rotationDegrees * Math.PI) / 180),
			new Vector3(definition.position[0], definition.position[1], 0)
		);
		created.set(definition.id, new Bone(definition.name, skeleton, definition.parentId ? created.get(definition.parentId)! : null, matrix, matrix.clone(), matrix.clone()));
	}
	return skeleton;
}

function configureMaterial(scene: Scene, mesh: Mesh, sourcePath: string | null): void {
	const material = new StandardMaterial(`${mesh.name} Material`, scene);
	material.disableLighting = true;
	material.emissiveColor = Color3.White();
	material.backFaceCulling = false;
	if (sourcePath && ![".psd", ".psb"].includes(extname(sourcePath).toLowerCase())) {
		const texture = configureImportedTexture(new Texture(resolveProjectPath(sourcePath), scene, true, false, Texture.TRILINEAR_SAMPLINGMODE), true);
		texture.hasAlpha = true;
		material.diffuseTexture = texture;
		material.emissiveTexture = texture;
		material.useAlphaFromDiffuseTexture = true;
		material.transparencyMode = StandardMaterial.MATERIAL_ALPHATESTANDBLEND;
	}
	mesh.material = material;
}

function describeSpriteSkin(mesh: Mesh): any {
	const definition = spriteSkinDefinition(mesh);
	return {
		node: toNodeSummary(mesh),
		skeleton: mesh.skeleton ? { id: mesh.skeleton.id, name: mesh.skeleton.name, boneCount: mesh.skeleton.bones.length } : null,
		definition: structuredClone(definition),
		fingerprint: definitionFingerprint(mesh, definition),
		vertexCount: mesh.getTotalVertices(),
		triangleCount: mesh.getTotalIndices() / 3,
		animationGroups: mesh
			.getScene()
			.animationGroups.filter((group) => group.targetedAnimations.some((targeted) => mesh.skeleton?.bones.includes(targeted.target as Bone)))
			.map((group) => group.name),
	};
}

interface IPsdPlanBone extends ISpriteSkinBoneDefinition {
	absolutePosition: [number, number];
}

function uniqueBoneName(layer: IPsdLayerInfo, used: Set<string>): string {
	const base = layer.name.trim().slice(0, 96) || `Layer ${layer.index}`;
	let name = base;
	let suffix = 2;
	while (used.has(name)) {
		name = `${base} ${suffix++}`;
	}
	used.add(name);
	return name;
}

/** Builds a deterministic bone hierarchy from already-inspected PSD layer records without reading or mutating files. */
export function buildPsdSpriteSkinRigPlan(
	document: IPsdLayerDocumentInfo,
	options: {
		sourcePath: string;
		sourceFingerprint: string;
		pixelsPerUnit?: number;
		columns?: number;
		rows?: number;
		includeHidden?: boolean;
		includeGroupBones?: boolean;
		layerIndices?: number[];
	}
): IPsdSpriteSkinRigPlan {
	const pixelsPerUnit = finiteNumber(options.pixelsPerUnit ?? 100, "pixelsPerUnit", 0.01, 100_000);
	const columns = finiteNumber(options.columns ?? 16, "columns", 1, 64);
	const rows = finiteNumber(options.rows ?? 16, "rows", 1, 64);
	if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
		throw new Error("PSD sprite rig columns and rows must be integers.");
	}
	const selected = options.layerIndices === undefined ? null : new Set(options.layerIndices);
	if (selected && (selected.size !== options.layerIndices!.length || selected.size > 128 || [...selected].some((index) => !Number.isInteger(index) || index < 0))) {
		throw new Error("PSD sprite rig layerIndices must contain at most 128 unique non-negative integers.");
	}
	const width = (document.width / pixelsPerUnit) * 100;
	const height = (document.height / pixelsPerUnit) * 100;
	const usedNames = new Set<string>(["Root"]);
	const bones: IPsdPlanBone[] = [
		{
			id: "root",
			name: "Root",
			parentId: null,
			position: [0, 0],
			absolutePosition: [0, 0],
			rotationDegrees: 90,
			length: Math.max(1, Math.min(width, height) * 0.25),
			sourceLayerIndex: null,
		},
	];
	const stack: string[] = ["root"];
	const groupMarkers: Array<string | null> = [];
	const byId = new Map<string, IPsdPlanBone>([["root", bones[0]]]);
	const layerResults: IPsdSpriteSkinRigPlan["layers"] = [];
	const warnings: string[] = [];
	const center = (layer: IPsdLayerInfo): [number, number] => [
		((layer.left + layer.right) / 2 / document.width - 0.5) * width,
		(0.5 - (layer.top + layer.bottom) / 2 / document.height) * height,
	];
	const appendBone = (layer: IPsdLayerInfo, id: string, parentId: string): void => {
		const absolutePosition = center(layer);
		const parentPosition = byId.get(parentId)?.absolutePosition ?? [0, 0];
		const layerWidth = (Math.max(1, layer.width) / pixelsPerUnit) * 100;
		const layerHeight = (Math.max(1, layer.height) / pixelsPerUnit) * 100;
		const bone: IPsdPlanBone = {
			id,
			name: uniqueBoneName(layer, usedNames),
			parentId,
			position: [absolutePosition[0] - parentPosition[0], absolutePosition[1] - parentPosition[1]],
			absolutePosition,
			rotationDegrees: layerHeight >= layerWidth ? 90 : 0,
			length: Math.max(1, Math.max(layerWidth, layerHeight) * 0.5),
			sourceLayerIndex: layer.index,
		};
		bones.push(bone);
		byId.set(id, bone);
	};

	for (const layer of document.layers) {
		if (layer.kind === "groupEnd") {
			const groupId = groupMarkers.pop() ?? null;
			if (groupId && stack.at(-1) === groupId) {
				stack.pop();
			}
			layerResults.push({ index: layer.index, name: layer.name, kind: layer.kind, visible: layer.visible, included: false, boneId: null, parentBoneId: stack.at(-1)! });
			continue;
		}
		if (layer.kind === "groupStart") {
			const included = options.includeGroupBones !== false && (options.includeHidden === true || layer.visible);
			const id = `group-${layer.index}`;
			const parentId = stack.at(-1)!;
			if (included) {
				appendBone(layer, id, parentId);
				stack.push(id);
			}
			groupMarkers.push(included ? id : null);
			layerResults.push({ index: layer.index, name: layer.name, kind: layer.kind, visible: layer.visible, included, boneId: included ? id : null, parentBoneId: parentId });
			continue;
		}
		const included =
			layer.kind === "pixel" && layer.width > 0 && layer.height > 0 && (options.includeHidden === true || layer.visible) && (!selected || selected.has(layer.index));
		const parentId = stack.at(-1)!;
		const id = `layer-${layer.index}`;
		if (included) {
			appendBone(layer, id, parentId);
		}
		layerResults.push({ index: layer.index, name: layer.name, kind: layer.kind, visible: layer.visible, included, boneId: included ? id : null, parentBoneId: parentId });
	}
	if (groupMarkers.length > 0) {
		warnings.push(`${groupMarkers.length} PSD group marker(s) were not closed; their inferred hierarchy was retained.`);
	}
	if (selected) {
		const found = new Set(layerResults.filter((layer) => layer.included).map((layer) => layer.index));
		const missing = [...selected].filter((index) => !found.has(index));
		if (missing.length) {
			warnings.push(`Requested PSD layer indices were not eligible pixel layers: ${missing.join(", ")}.`);
		}
	}
	if (bones.length === 1) {
		warnings.push("No eligible PSD pixel layers were found; the plan contains only the root bone.");
	}
	const publicBones = bones.map(({ absolutePosition: _absolutePosition, ...bone }) => bone);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				model: "unity-psd-sprite-rig-plan-v1",
				sourcePath: options.sourcePath,
				sourceFingerprint: options.sourceFingerprint,
				documentWidthPixels: document.width,
				documentHeightPixels: document.height,
				pixelsPerUnit,
				columns,
				rows,
				bones: publicBones,
				layers: layerResults,
			})
		)
		.digest("hex");
	return {
		model: "unity-psd-sprite-rig-plan-v1",
		sourcePath: options.sourcePath,
		sourceFingerprint: options.sourceFingerprint,
		fingerprint,
		documentWidthPixels: document.width,
		documentHeightPixels: document.height,
		pixelsPerUnit,
		columns,
		rows,
		bones: publicBones,
		layers: layerResults,
		warnings,
	};
}

/** Inspects a project-contained PSD/PSB and returns a deterministic, exact-fingerprint sprite-rig plan. */
export async function inspectPsdSpriteSkinRig(_scene: Scene, data: any): Promise<IPsdSpriteSkinRigPlan> {
	const absolutePath = resolveProjectPath(data.sourcePath);
	if (![".psd", ".psb"].includes(extname(absolutePath).toLowerCase())) {
		throw new Error("PSD sprite rig generation requires a .psd or .psb sourcePath.");
	}
	const bytes = await readFile(absolutePath);
	const sourceFingerprint = createHash("sha256").update(bytes).digest("hex");
	const document = inspectPsdLayers(bytes);
	return buildPsdSpriteSkinRigPlan(document, {
		sourcePath: portableProjectPath(absolutePath),
		sourceFingerprint,
		pixelsPerUnit: data.pixelsPerUnit,
		columns: data.columns,
		rows: data.rows,
		includeHidden: data.includeHidden,
		includeGroupBones: data.includeGroupBones,
		layerIndices: data.layerIndices,
	});
}

/** Applies the exact current PSD plan as a real weighted sprite mesh and Babylon skeleton. */
export async function applyPsdSpriteSkinRig(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const plan = await inspectPsdSpriteSkinRig(scene, data);
	if (data.expectedFingerprint !== plan.fingerprint) {
		throw new Error(`PSD sprite rig plan changed after inspection; inspect again and use fingerprint ${plan.fingerprint}.`);
	}
	return createSpriteSkin(
		scene,
		{
			name: data.name,
			documentWidthPixels: plan.documentWidthPixels,
			documentHeightPixels: plan.documentHeightPixels,
			pixelsPerUnit: plan.pixelsPerUnit,
			columns: plan.columns,
			rows: plan.rows,
			bones: plan.bones,
			sourcePath: data.texturePath ?? null,
			psd: {
				sourcePath: plan.sourcePath,
				sourceFingerprint: plan.sourceFingerprint,
				layerIndices: plan.layers.filter((layer) => layer.included).map((layer) => layer.index),
			},
		},
		options
	);
}

/** Lists every authored planar sprite skin in the scene. */
export function listSpriteSkins(scene: Scene): any {
	return { spriteSkins: scene.meshes.filter((mesh) => mesh.metadata?.[SPRITE_SKIN_METADATA_KEY]?.model === "unity-sprite-skin-v1").map(describeSpriteSkin) };
}

/** Inspects one sprite skin, including the exact lease needed by authored mutations. */
export function getSpriteSkin(scene: Scene, data: any): any {
	return describeSpriteSkin(resolveSpriteSkin(scene, data));
}

/** Opens the focused editor workspace and optionally selects one authored sprite mesh. */
export function openSpriteSkinningWorkspace(scene: Scene, data: any, options: IMCPActionOptions): any {
	let selected: any = null;
	if (data.nodeId || data.nodeName) {
		const mesh = resolveSpriteSkin(scene, data);
		options.editor.layout.graph.setSelectedNode(mesh);
		options.editor.layout.inspector.setEditedObject(mesh);
		selected = toNodeSummary(mesh);
	}
	options.editor.layout.animations.openSpriteSkinningWorkspace();
	return { opened: true, selected };
}

/** Creates a tessellated planar mesh, a persistent Babylon skeleton, and normalized automatic weights. */
export function createSpriteSkin(scene: Scene, data: any, options: IMCPActionOptions): any {
	const documentWidthPixels = finiteNumber(data.documentWidthPixels, "documentWidthPixels", 1, 32_768);
	const documentHeightPixels = finiteNumber(data.documentHeightPixels, "documentHeightPixels", 1, 32_768);
	const pixelsPerUnit = finiteNumber(data.pixelsPerUnit ?? 100, "pixelsPerUnit", 0.01, 100_000);
	const columns = finiteNumber(data.columns ?? 16, "columns", 1, 64);
	const rows = finiteNumber(data.rows ?? 16, "rows", 1, 64);
	if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
		throw new Error("Sprite skin columns and rows must be integers.");
	}
	const width = (documentWidthPixels / pixelsPerUnit) * 100;
	const height = (documentHeightPixels / pixelsPerUnit) * 100;
	const bones = normalizeBones(
		data.bones ?? [{ id: "root", name: "Root", parentId: null, position: [0, -height / 2], rotationDegrees: 90, length: height, sourceLayerIndex: null }]
	);
	const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Sprite Skin";
	const mesh = new Mesh(name, scene);
	mesh.id = Tools.RandomId();
	createGrid(width, height, columns, rows, bones).applyToMesh(mesh, true);
	mesh.skeleton = createSkeleton(scene, name, bones);
	mesh.numBoneInfluencers = Math.min(4, bones.length);
	mesh.metadata = {
		...(mesh.metadata ?? {}),
		[SPRITE_SKIN_METADATA_KEY]: {
			model: "unity-sprite-skin-v1",
			revision: 1,
			sourcePath: data.sourcePath ?? null,
			documentWidthPixels,
			documentHeightPixels,
			pixelsPerUnit,
			columns,
			rows,
			bones,
			psd: data.psd ?? null,
		} satisfies ISpriteSkinDefinition,
	};
	configureMaterial(scene, mesh, data.sourcePath ?? null);
	void options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(mesh));
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.preview.gizmo.setAttachedObject(mesh);
	return describeSpriteSkin(mesh);
}

/** Replaces a sprite skin's complete bone hierarchy and deterministically regenerates bind matrices and automatic weights. */
export function replaceSpriteSkinBones(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mesh = resolveSpriteSkin(scene, data);
	const definition = verifyLease(mesh, data);
	const bones = normalizeBones(data.bones);
	const width = (definition.documentWidthPixels / definition.pixelsPerUnit) * 100;
	const height = (definition.documentHeightPixels / definition.pixelsPerUnit) * 100;
	const previousSkeleton = mesh.skeleton;
	const previousBones = new Set(previousSkeleton?.bones ?? []);
	const boneTracks = scene.animationGroups.flatMap((group) =>
		group.targetedAnimations.filter((targeted) => previousBones.has(targeted.target as Bone)).map((targeted) => ({ group, targeted, boneName: (targeted.target as Bone).name }))
	);
	const missingAnimatedBone = boneTracks.find((track) => !bones.some((bone) => bone.name === track.boneName));
	if (missingAnimatedBone) {
		throw new Error(`Cannot remove animated sprite bone "${missingAnimatedBone.boneName}" while AnimationGroup "${missingAnimatedBone.group.name}" still targets it.`);
	}
	const grid = createGrid(width, height, definition.columns, definition.rows, bones);
	const replacement = createSkeleton(scene, mesh.name, bones);
	grid.applyToMesh(mesh, true);
	mesh.skeleton = replacement;
	boneTracks.forEach((track) => (track.targeted.target = replacement.bones.find((bone) => bone.name === track.boneName)!));
	mesh.numBoneInfluencers = Math.min(4, bones.length);
	definition.bones = bones;
	definition.revision++;
	previousSkeleton?.dispose();
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();
	return describeSpriteSkin(mesh);
}

/** Creates an ordinary editable AnimationGroup targeted at the sprite skin's Babylon bones. */
export function createSpriteSkinAnimationClip(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mesh = resolveSpriteSkin(scene, data);
	verifyLease(mesh, data);
	if (!mesh.skeleton) {
		throw new Error(`Sprite skin "${mesh.name}" has no skeleton.`);
	}
	const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : `${mesh.name} Clip`;
	if (scene.animationGroups.some((group) => group.name === name)) {
		throw new Error(`AnimationGroup "${name}" already exists.`);
	}
	if (!Array.isArray(data.tracks) || data.tracks.length < 1 || data.tracks.length > 256) {
		throw new Error("A 2D animation clip requires 1–256 bone tracks.");
	}
	const framesPerSecond = finiteNumber(data.framesPerSecond ?? 60, "framesPerSecond", 1, 240);
	const group = new AnimationGroup(name, scene);
	try {
		for (const [trackIndex, track] of data.tracks.entries()) {
			const bone = mesh.skeleton.bones.find((candidate) => candidate.name === track.boneName);
			if (!bone) {
				throw new Error(`2D animation track ${trackIndex} references missing bone "${track.boneName}".`);
			}
			const property = track.property === "position" ? "position" : "rotationQuaternion";
			const type = property === "position" ? Animation.ANIMATIONTYPE_VECTOR3 : Animation.ANIMATIONTYPE_QUATERNION;
			if (!Array.isArray(track.keys) || track.keys.length < 1 || track.keys.length > 4096) {
				throw new Error(`2D animation track ${trackIndex} requires 1–4096 keys.`);
			}
			let previousFrame = -Infinity;
			const keys = track.keys.map((key: any, keyIndex: number) => {
				const frame = finiteNumber(key.frame, `tracks[${trackIndex}].keys[${keyIndex}].frame`, -1_000_000, 1_000_000);
				if (frame <= previousFrame) {
					throw new Error(`2D animation track ${trackIndex} key frames must be strictly increasing.`);
				}
				previousFrame = frame;
				if (property === "position") {
					if (!Array.isArray(key.value) || key.value.length !== 2) {
						throw new Error(`2D position key ${trackIndex}:${keyIndex} must contain [x, y].`);
					}
					return { frame, value: new Vector3(finiteNumber(key.value[0], "position x"), finiteNumber(key.value[1], "position y"), 0) };
				}
				return { frame, value: Quaternion.RotationAxis(Vector3.Forward(), (finiteNumber(key.value, "rotationDegrees") * Math.PI) / 180) };
			});
			const animation = new Animation(`${bone.name} ${property}`, property, framesPerSecond, type, Animation.ANIMATIONLOOPMODE_CYCLE);
			animation.setKeys(keys);
			group.addTargetedAnimation(animation, bone);
		}
	} catch (error) {
		group.dispose();
		throw error;
	}
	group.metadata = { ...(group.metadata ?? {}), babylonEditorSpriteSkinClip: { model: "unity-sprite-skin-clip-v1", nodeId: mesh.id } };
	options.editor.layout.animations?.openAnimationWindow?.(group.name);
	return { name: group.name, nodeId: mesh.id, framesPerSecond, trackCount: group.targetedAnimations.length };
}
