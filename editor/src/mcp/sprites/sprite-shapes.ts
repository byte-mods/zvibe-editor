import { existsSync } from "fs";
import { dirname, isAbsolute, join, normalize } from "path/posix";

import { Color3, Mesh, MultiMaterial, Node, Scene, StandardMaterial, SubMesh, Texture, Tools, VertexData } from "babylonjs";
import {
	createDefaultSpriteShapeDefinition,
	createDefaultSpriteShapeProfile,
	generateSpriteShapeGeometry,
	ISpriteShapeDefinition,
	ISpriteShapeGeometry,
	ISpriteShapeProfile,
	normalizeSpriteShapeDefinition,
	normalizeSpriteShapeProfile,
} from "babylonjs-editor-tools";

import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { configureAddedMesh } from "../../project/add/configure";
import { projectConfiguration } from "../../project/configuration";
import { isMesh } from "../../tools/guards/nodes";
import { setNodeSerializable } from "../../tools/node/metadata";

import { IMCPActionOptions } from "../action";
import { listPhysics2D, removePhysics2DBody, setPhysics2DBody } from "../physics2d/physics2d";
import { resolveNode, toNodeSummary } from "../tools/resolve";

const PROFILE_METADATA_KEY = "babylonEditorSpriteShapeProfiles";
const DEFINITION_METADATA_KEY = "babylonEditorSpriteShape";
const GENERATED_METADATA_KEY = "babylonEditorSpriteShapeGenerated";
const OWNED_MATERIAL_METADATA_KEY = "babylonEditorSpriteShapeMaterialId";
const OWNED_COLLIDER_METADATA_KEY = "babylonEditorSpriteShapeColliderOwned";

export interface ISpriteShapeSnapshot {
	nodeId: string;
	definition: ISpriteShapeDefinition;
}

export interface ISpriteShapeProfileSnapshot {
	profile: ISpriteShapeProfile;
}

function getProfiles(scene: Scene): ISpriteShapeProfile[] {
	scene.metadata ??= {};
	const values = (scene.metadata[PROFILE_METADATA_KEY] ??= []) as unknown[];
	for (let index = 0; index < values.length; index++) {
		values[index] = normalizeSpriteShapeProfile(values[index]);
	}
	return values as ISpriteShapeProfile[];
}

function getProfile(scene: Scene, data: { profileId?: string; profileName?: string }): ISpriteShapeProfile {
	const profile = getProfiles(scene).find((candidate) => candidate.id === data.profileId || candidate.name === data.profileName);
	if (!profile) {
		throw new Error(`Sprite Shape profile "${data.profileId ?? data.profileName ?? "unknown"}" was not found. List profiles and retry with an exact id.`);
	}
	return profile;
}

function getShape(scene: Scene, data: { nodeId?: string; nodeName?: string }): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.[DEFINITION_METADATA_KEY]?.model !== "unity-sprite-shape-controller-v1") {
		throw new Error(`Node "${node.name}" is not a Sprite Shape mesh.`);
	}
	return node;
}

function getDefinition(mesh: Mesh): ISpriteShapeDefinition {
	return normalizeSpriteShapeDefinition(mesh.metadata?.[DEFINITION_METADATA_KEY]);
}

function resolveTexturePath(path: string | null): string | null {
	if (path === null) {
		return null;
	}
	if (!projectConfiguration.path) {
		throw new Error(`Sprite Shape texture "${path}" requires an open project.`);
	}
	const root = dirname(projectConfiguration.path);
	const absolutePath = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
		throw new Error(`Sprite Shape texture "${path}" must stay inside the open project directory.`);
	}
	if (!existsSync(absolutePath)) {
		throw new Error(`Sprite Shape texture was not found: ${path}`);
	}
	return absolutePath;
}

function validateProfileTextures(profile: ISpriteShapeProfile): void {
	resolveTexturePath(profile.edgeTexturePath);
	resolveTexturePath(profile.fillTexturePath);
	for (const range of profile.angleRanges) {
		resolveTexturePath(range.texturePath);
	}
}

function disposeOwnedMaterials(mesh: Mesh): void {
	const materialId = mesh.metadata?.[OWNED_MATERIAL_METADATA_KEY];
	const material = mesh.material;
	if (material && materialId && material.id === materialId) {
		if (material instanceof MultiMaterial) {
			material.dispose(true, true, true);
		} else {
			material.dispose(true, true);
		}
	}
	mesh.material = null;
	if (mesh.metadata) {
		delete mesh.metadata[OWNED_MATERIAL_METADATA_KEY];
	}
}

function createSlotMaterial(mesh: Mesh, geometry: ISpriteShapeGeometry, slotIndex: number): StandardMaterial {
	const slot = geometry.materialSlots[slotIndex];
	const material = new StandardMaterial(`${mesh.name} ${slot.kind === "fill" ? "Fill" : slot.angleRangeId ? `Edge ${slot.angleRangeId}` : "Edge"}`, mesh.getScene());
	material.diffuseColor = Color3.FromArray(slot.color);
	material.alpha = slot.color[3];
	material.disableLighting = true;
	material.backFaceCulling = false;
	const texturePath = resolveTexturePath(slot.texturePath);
	if (texturePath) {
		const texture = configureImportedTexture(new Texture(texturePath, mesh.getScene(), true, false, Texture.NEAREST_NEAREST), true);
		texture.hasAlpha = true;
		material.diffuseTexture = texture;
		material.useAlphaFromDiffuseTexture = true;
	}
	return material;
}

function applyGeneratedGeometry(mesh: Mesh, geometry: ISpriteShapeGeometry): void {
	const vertexData = new VertexData();
	vertexData.positions = geometry.positions;
	vertexData.indices = geometry.indices;
	vertexData.normals = geometry.normals;
	vertexData.uvs = geometry.uvs;
	vertexData.colors = geometry.colors;
	if (geometry.tangents) {
		vertexData.tangents = geometry.tangents;
	}
	vertexData.applyToMesh(mesh, true);
	mesh.useVertexColors = true;
	mesh.hasVertexAlpha = geometry.colors.some((_, index) => index % 4 === 3 && geometry.colors[index] < 1);
	mesh.releaseSubMeshes(true);
	for (const subMesh of geometry.subMeshes) {
		new SubMesh(subMesh.materialIndex, 0, geometry.positions.length / 3, subMesh.indexStart, subMesh.indexCount, mesh, mesh, false, true);
	}
	mesh.refreshBoundingInfo({ updatePositionsArray: true });
}

function applyGeneratedMaterials(mesh: Mesh, geometry: ISpriteShapeGeometry): void {
	disposeOwnedMaterials(mesh);
	const material = new MultiMaterial(`${mesh.name} Sprite Shape`, mesh.getScene());
	material.subMaterials = geometry.materialSlots.map((_, index) => createSlotMaterial(mesh, geometry, index));
	mesh.material = material;
	mesh.metadata ??= {};
	mesh.metadata[OWNED_MATERIAL_METADATA_KEY] = material.id;
}

function synchronizeCollider(mesh: Mesh, definition: ISpriteShapeDefinition, geometry: ISpriteShapeGeometry, options: IMCPActionOptions): void {
	const scene = mesh.getScene();
	const existing = listPhysics2D(scene).bodies.find((body: { nodeId: string }) => body.nodeId === mesh.id);
	const ownsCollider = mesh.metadata?.[OWNED_COLLIDER_METADATA_KEY] === true;
	if (!definition.collider.enabled) {
		if (existing && ownsCollider) {
			removePhysics2DBody(scene, { nodeId: mesh.id, expectedRevision: existing.revision }, options);
		}
		if (mesh.metadata) {
			delete mesh.metadata[OWNED_COLLIDER_METADATA_KEY];
		}
		return;
	}
	if (!geometry.collider) {
		throw new Error("Sprite Shape collider generation returned no geometry while the collider is enabled.");
	}
	if (existing && !ownsCollider) {
		throw new Error(`Sprite Shape "${mesh.name}" already has a non-Sprite-Shape 2D body. Remove it before enabling generated collision.`);
	}
	const collider =
		geometry.collider.type === "polygon"
			? { shape: "polygon", contours: geometry.collider.contours }
			: {
					shape: "edge",
					model: "unity-sprite-shape-edge-collider-v1",
					points: geometry.collider.points,
					parts: geometry.collider.parts,
					edgeRadius: definition.collider.edgeRadius,
				};
	setPhysics2DBody(
		scene,
		{
			nodeId: mesh.id,
			expectedRevision: existing?.revision,
			bodyType: "static",
			collider,
			gravity: [0, 0],
			friction: definition.collider.friction,
			restitution: definition.collider.restitution,
			isTrigger: definition.collider.isTrigger,
		},
		options
	);
	mesh.metadata ??= {};
	mesh.metadata[OWNED_COLLIDER_METADATA_KEY] = true;
}

function generatedSummary(geometry: ISpriteShapeGeometry, profileRevision: number): Record<string, unknown> {
	return {
		model: geometry.model,
		profileRevision,
		vertexCount: geometry.positions.length / 3,
		indexCount: geometry.indices.length,
		subMeshCount: geometry.subMeshes.length,
		materialSlotCount: geometry.materialSlots.length,
		sampleCount: geometry.sampleCount,
		edgeQuadCount: geometry.edgeQuadCount,
		fillTriangleCount: geometry.fillTriangleCount,
		length: geometry.length,
		colliderType: geometry.collider?.type ?? null,
		colliderPartCount: geometry.collider?.parts.length ?? 0,
	};
}

function applySpriteShape(mesh: Mesh, profile: ISpriteShapeProfile, definition: ISpriteShapeDefinition, geometry: ISpriteShapeGeometry, options: IMCPActionOptions): void {
	applyGeneratedGeometry(mesh, geometry);
	applyGeneratedMaterials(mesh, geometry);
	mesh.metadata ??= {};
	mesh.metadata[DEFINITION_METADATA_KEY] = structuredClone(definition);
	mesh.metadata[GENERATED_METADATA_KEY] = generatedSummary(geometry, profile.revision);
	synchronizeCollider(mesh, definition, geometry, options);
}

function shapeState(scene: Scene, mesh: Mesh): Record<string, unknown> {
	const definition = getDefinition(mesh);
	const profile = getProfile(scene, { profileId: definition.profileId });
	return {
		node: toNodeSummary(mesh),
		definition,
		profile: structuredClone(profile),
		generated: structuredClone(mesh.metadata?.[GENERATED_METADATA_KEY] ?? null),
	};
}

function refresh(options: IMCPActionOptions, mesh?: Mesh): void {
	if (mesh) {
		options.editor.layout.inspector.setEditedObject(mesh);
		options.editor.layout.preview.gizmo.setAttachedObject(mesh);
	}
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.preview.forceUpdate();
}

function paginate<T>(
	items: T[],
	data: { offset?: number; limit?: number }
): { total: number; count: number; offset: number; hasMore: boolean; nextOffset: number | null; items: T[] } {
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 20;
	const returned = items.slice(offset, offset + limit);
	return {
		total: items.length,
		count: returned.length,
		offset,
		hasMore: offset + returned.length < items.length,
		nextOffset: offset + returned.length < items.length ? offset + returned.length : null,
		items: returned,
	};
}

/** Lists bounded shared Sprite Shape profiles with exact revisions. */
export function listSpriteShapeProfiles(scene: Scene, data: { offset?: number; limit?: number } = {}): Record<string, unknown> {
	const profiles = getProfiles(scene)
		.map((profile) => ({
			id: profile.id,
			name: profile.name,
			revision: profile.revision,
			edgeTexturePath: profile.edgeTexturePath,
			fillTexturePath: profile.fillTexturePath,
			angleRangeCount: profile.angleRanges.length,
			shapeCount: scene.meshes.filter((mesh) => mesh.metadata?.[DEFINITION_METADATA_KEY]?.profileId === profile.id).length,
		}))
		.sort((first, second) => first.name.localeCompare(second.name) || first.id.localeCompare(second.id));
	return { profiles: paginate(profiles, data) };
}

/** Reads one complete reusable Sprite Shape profile. */
export function getSpriteShapeProfile(scene: Scene, data: { profileId?: string; profileName?: string }): ISpriteShapeProfile {
	return structuredClone(getProfile(scene, data));
}

/** Creates one bounded reusable Sprite Shape profile. */
export function createSpriteShapeProfile(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): ISpriteShapeProfile {
	const id = typeof data.id === "string" ? data.id : Tools.RandomId();
	if (getProfiles(scene).some((profile) => profile.id === id || profile.name === data.name)) {
		throw new Error("Sprite Shape profile id and name must be unique in the scene.");
	}
	const defaults = createDefaultSpriteShapeProfile(id, typeof data.name === "string" ? data.name : "Sprite Shape Profile");
	const profile = normalizeSpriteShapeProfile({ ...defaults, ...data, model: defaults.model, version: defaults.version, id, revision: 1 });
	validateProfileTextures(profile);
	getProfiles(scene).push(profile);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(profile);
}

/** Exact-revision updates one shared profile and rebuilds every dependent shape. */
export function setSpriteShapeProfile(
	scene: Scene,
	data: { profileId?: string; profileName?: string; expectedRevision: number; update: Partial<ISpriteShapeProfile> },
	options: IMCPActionOptions
): ISpriteShapeProfile {
	const profile = getProfile(scene, data);
	if (data.expectedRevision !== profile.revision) {
		throw new Error(`Sprite Shape profile revision is ${profile.revision}; reread get_sprite_shape_profile and retry with that expectedRevision.`);
	}
	const next = normalizeSpriteShapeProfile({
		...profile,
		...structuredClone(data.update),
		model: profile.model,
		version: profile.version,
		id: profile.id,
		revision: profile.revision + 1,
	});
	if (next.name !== profile.name && getProfiles(scene).some((candidate) => candidate.id !== profile.id && candidate.name === next.name)) {
		throw new Error(`Sprite Shape profile name "${next.name}" is already in use.`);
	}
	validateProfileTextures(next);
	const dependents = scene.meshes.filter(isMesh).filter((mesh) => mesh.metadata?.[DEFINITION_METADATA_KEY]?.profileId === profile.id);
	const generated = dependents.map((mesh) => ({ mesh, definition: getDefinition(mesh), geometry: generateSpriteShapeGeometry(next, getDefinition(mesh)) }));
	const profiles = getProfiles(scene);
	const index = profiles.findIndex((candidate) => candidate.id === profile.id);
	profiles[index] = next;
	try {
		for (const entry of generated) {
			applySpriteShape(entry.mesh, next, entry.definition, entry.geometry, options);
		}
	} catch (error) {
		profiles[index] = profile;
		for (const entry of generated) {
			const oldGeometry = generateSpriteShapeGeometry(profile, entry.definition);
			applySpriteShape(entry.mesh, profile, entry.definition, oldGeometry, options);
		}
		throw error;
	}
	refresh(options);
	return structuredClone(next);
}

/** Deletes an unused Sprite Shape profile. */
export function deleteSpriteShapeProfile(
	scene: Scene,
	data: { profileId?: string; profileName?: string; expectedRevision: number },
	options: IMCPActionOptions
): Record<string, unknown> {
	const profile = getProfile(scene, data);
	if (data.expectedRevision !== profile.revision) {
		throw new Error(`Sprite Shape profile revision is ${profile.revision}; reread get_sprite_shape_profile and retry with that expectedRevision.`);
	}
	const users = scene.meshes.filter((mesh) => mesh.metadata?.[DEFINITION_METADATA_KEY]?.profileId === profile.id);
	if (users.length) {
		throw new Error(`Sprite Shape profile "${profile.name}" is used by ${users.length} shape(s). Retarget or delete them first.`);
	}
	const profiles = getProfiles(scene);
	profiles.splice(
		profiles.findIndex((candidate) => candidate.id === profile.id),
		1
	);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: profile.id, revision: profile.revision };
}

/** Lists bounded Sprite Shape mesh summaries and exact controller revisions. */
export function listSpriteShapes(scene: Scene, data: { offset?: number; limit?: number } = {}): Record<string, unknown> {
	const shapes = scene.meshes
		.filter(isMesh)
		.filter((mesh) => mesh.metadata?.[DEFINITION_METADATA_KEY]?.model === "unity-sprite-shape-controller-v1")
		.map((mesh) => {
			const definition = getDefinition(mesh);
			return {
				node: toNodeSummary(mesh),
				revision: definition.revision,
				profileId: definition.profileId,
				closed: definition.closed,
				controlPointCount: definition.points.length,
				generated: structuredClone(mesh.metadata?.[GENERATED_METADATA_KEY] ?? null),
			};
		})
		.sort((first, second) => first.node.name.localeCompare(second.node.name) || first.node.id.localeCompare(second.node.id));
	return { shapes: paginate(shapes, data) };
}

/** Reads one complete Sprite Shape controller, shared profile, and generated evidence. */
export function getSpriteShape(scene: Scene, data: { nodeId?: string; nodeName?: string }): Record<string, unknown> {
	return shapeState(scene, getShape(scene, data));
}

/** Creates one editable Sprite Shape mesh through the normal editor node path. */
export function createSpriteShape(scene: Scene, data: Record<string, unknown>, options: IMCPActionOptions): Record<string, unknown> {
	let profile: ISpriteShapeProfile;
	if (typeof data.profileId === "string" || typeof data.profileName === "string") {
		profile = getProfile(scene, { profileId: data.profileId as string | undefined, profileName: data.profileName as string | undefined });
	} else {
		profile = getProfiles(scene)[0] ?? createSpriteShapeProfile(scene, { name: "Default Sprite Shape Profile" }, options);
	}
	const defaults = createDefaultSpriteShapeDefinition(profile.id);
	const definitionUpdate = (data.definition ?? {}) as Partial<ISpriteShapeDefinition>;
	const definition = normalizeSpriteShapeDefinition({
		...defaults,
		...structuredClone(definitionUpdate),
		collider: { ...defaults.collider, ...structuredClone(definitionUpdate.collider ?? {}) },
		model: defaults.model,
		version: defaults.version,
		revision: 1,
		profileId: profile.id,
	});
	const geometry = generateSpriteShapeGeometry(profile, definition);
	validateProfileTextures(profile);
	const parent =
		data.parentId || data.parentName ? resolveNode({ scene, nodeId: data.parentId as string | undefined, nodeName: data.parentName as string | undefined }) : undefined;
	const mesh = new Mesh(typeof data.name === "string" ? data.name : "New Sprite Shape", scene);
	mesh.metadata = {};
	try {
		// Give configureAddedMesh real geometry to identify, then publish owned materials/collision
		// only after it assigns the persistent node id used by every external reference.
		applyGeneratedGeometry(mesh, geometry);
		configureAddedMesh(options.editor, mesh, parent as Node | undefined);
		applySpriteShape(mesh, profile, definition, geometry, options);
		setNodeSerializable(mesh, true);
		refresh(options, mesh);
		return shapeState(scene, mesh);
	} catch (error) {
		const body = listPhysics2D(scene).bodies.find((candidate: { nodeId: string }) => candidate.nodeId === mesh.id);
		if (mesh.metadata?.[OWNED_COLLIDER_METADATA_KEY] && body) {
			try {
				removePhysics2DBody(scene, { nodeId: mesh.id, expectedRevision: body.revision }, options);
			} catch {
				// Preserve the original creation error; mesh disposal below removes the failed node.
			}
		}
		disposeOwnedMaterials(mesh);
		mesh.dispose(false, true);
		throw error;
	}
}

/** Exact-revision replaces or partially updates one Sprite Shape controller atomically. */
export function setSpriteShape(
	scene: Scene,
	data: { nodeId?: string; nodeName?: string; expectedRevision: number; update: Partial<ISpriteShapeDefinition> },
	options: IMCPActionOptions
): Record<string, unknown> {
	const mesh = getShape(scene, data);
	const current = getDefinition(mesh);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`Sprite Shape revision is ${current.revision}; reread get_sprite_shape and retry with that expectedRevision.`);
	}
	const update = structuredClone(data.update);
	const next = normalizeSpriteShapeDefinition({
		...current,
		...update,
		collider: { ...current.collider, ...update.collider },
		model: current.model,
		version: current.version,
		revision: current.revision + 1,
	});
	const profile = getProfile(scene, { profileId: next.profileId });
	validateProfileTextures(profile);
	const geometry = generateSpriteShapeGeometry(profile, next);
	try {
		applySpriteShape(mesh, profile, next, geometry, options);
	} catch (error) {
		const oldProfile = getProfile(scene, { profileId: current.profileId });
		applySpriteShape(mesh, oldProfile, current, generateSpriteShapeGeometry(oldProfile, current), options);
		throw error;
	}
	refresh(options, mesh);
	return shapeState(scene, mesh);
}

/** Deletes one Sprite Shape mesh plus only its owned generated body/materials. */
export function deleteSpriteShape(scene: Scene, data: { nodeId?: string; nodeName?: string; expectedRevision: number }, options: IMCPActionOptions): Record<string, unknown> {
	const mesh = getShape(scene, data);
	const definition = getDefinition(mesh);
	if (data.expectedRevision !== definition.revision) {
		throw new Error(`Sprite Shape revision is ${definition.revision}; reread get_sprite_shape and retry with that expectedRevision.`);
	}
	const body = listPhysics2D(scene).bodies.find((candidate: { nodeId: string }) => candidate.nodeId === mesh.id);
	if (mesh.metadata?.[OWNED_COLLIDER_METADATA_KEY] && body) {
		removePhysics2DBody(scene, { nodeId: mesh.id, expectedRevision: body.revision }, options);
	}
	const result = { deleted: true, nodeId: mesh.id, name: mesh.name, revision: definition.revision };
	disposeOwnedMaterials(mesh);
	mesh.dispose(false, true);
	void options.editor.layout.graph.refresh();
	refresh(options);
	return result;
}

/** Captures the complete authored definition for one scene-handle Undo/Redo transaction. */
export function getSpriteShapeSnapshot(mesh: Mesh): ISpriteShapeSnapshot {
	return { nodeId: mesh.id, definition: structuredClone(getDefinition(mesh)) };
}

/** Restores a captured definition as a new exact revision while retaining the live mesh identity. */
export function restoreSpriteShapeSnapshot(scene: Scene, snapshot: ISpriteShapeSnapshot, options: IMCPActionOptions): Record<string, unknown> {
	const mesh = getShape(scene, { nodeId: snapshot.nodeId });
	const current = getDefinition(mesh);
	return setSpriteShape(scene, { nodeId: mesh.id, expectedRevision: current.revision, update: snapshot.definition }, options);
}

/** Captures one complete shared profile for exact Inspector Undo/Redo. */
export function getSpriteShapeProfileSnapshot(scene: Scene, data: { profileId?: string; profileName?: string }): ISpriteShapeProfileSnapshot {
	return { profile: getSpriteShapeProfile(scene, data) };
}

/** Restores a shared profile as a new exact revision and rebuilds every dependent shape. */
export function restoreSpriteShapeProfileSnapshot(scene: Scene, snapshot: ISpriteShapeProfileSnapshot, options: IMCPActionOptions): ISpriteShapeProfile {
	const current = getProfile(scene, { profileId: snapshot.profile.id });
	return setSpriteShapeProfile(scene, { profileId: current.id, expectedRevision: current.revision, update: snapshot.profile }, options);
}
