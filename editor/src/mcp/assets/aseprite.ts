import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path/posix";

import { Scene, Sprite, Tools, TransformNode } from "babylonjs";
import {
	ASEPRITE_ATLAS_MODEL,
	ASEPRITE_IMPORTER_MODEL,
	ASEPRITE_MAX_ATLAS_SIZE,
	ASEPRITE_MAX_FRAMES,
	ASEPRITE_MAX_LAYERS,
	applySpriteManagerLocalSpace,
	playVariableSpriteAnimation,
	restoreVariableSpriteAnimation,
	stopVariableSpriteAnimation,
} from "babylonjs-editor-tools";

import { SpriteManagerNode } from "../../editor/nodes/sprite-manager";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";
import { buildAsepriteSpriteAnimations } from "./aseprite-animation";
import { applyAsepriteImporterArtifact, getAsepriteImporterArtifactStatus, IAsepriteImporterResult } from "./aseprite-importer";
import { readAssetMetadata } from "./registry";

export const ASEPRITE_SCENE_MODEL = "zvibe-aseprite-scene-v1";

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function resolveAsepritePath(path: unknown): { absolutePath: string; projectPath: string } {
	if (typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0")) {
		throw new Error("Aseprite path must be a non-empty project path of at most 4,096 characters.");
	}
	const root = projectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
		throw new Error("Aseprite paths must stay inside the open project directory.");
	}
	const projectPath = relative(root, absolutePath).replace(/\\/g, "/");
	if (!projectPath.startsWith("assets/") || ![".ase", ".aseprite"].includes(extname(projectPath).toLowerCase())) {
		throw new Error("Aseprite assets must be .ase/.aseprite files inside the project assets directory.");
	}
	return { absolutePath, projectPath };
}

function boundedPage(value: unknown, fallback: number, maximum: number): number {
	return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(0, value as number)) : fallback;
}

function refreshEditor(options: IMCPActionOptions, root?: TransformNode): void {
	options.editor.layout.assets?.refresh?.();
	void options.editor.layout.graph.refresh().then(() => {
		if (root) {
			options.editor.layout.graph.setSelectedNode(root);
			options.editor.layout.inspector.setEditedObject(root);
		}
	});
	options.editor.layout.inspector.forceUpdate();
}

function validatePosition(value: unknown): [number, number, number] | null {
	if (value === undefined) {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || Math.abs(entry) > 1_000_000_000)) {
		throw new Error("Aseprite position must contain exactly three finite numbers within ±1,000,000,000.");
	}
	return value as [number, number, number];
}

function selectAnimation(animations: ReturnType<typeof buildAsepriteSpriteAnimations>, requested: unknown): (typeof animations)[number] {
	if (requested !== undefined && (typeof requested !== "string" || !requested.trim() || requested.length > 256)) {
		throw new Error("Aseprite animationName must be a non-empty string of at most 256 characters.");
	}
	const selected = requested === undefined ? animations[0] : animations.find((animation) => animation.name === requested);
	if (!selected) {
		throw new Error(`Aseprite animation "${String(requested)}" was not found. Available animations: ${animations.map((animation) => animation.name).join(", ")}.`);
	}
	return selected;
}

function createManager(
	scene: Scene,
	context: {
		result: IAsepriteImporterResult;
		atlasJsonPath: string;
		rootId: string;
		name: string;
		layerIndex: number | null;
		parent: TransformNode;
		data: any;
	}
): { node: SpriteManagerNode; sprite: Sprite; animationName: string } {
	const { result, atlasJsonPath, rootId, name, layerIndex, parent, data } = context;
	const node = new SpriteManagerNode(name, scene);
	node.id = `${rootId}:${layerIndex === null ? "composite" : `layer-${layerIndex}`}`;
	node.parent = parent;
	node.metadata = {
		babylonEditorSpriteLocalSpace: true,
		babylonEditorAsepriteManager: { model: ASEPRITE_SCENE_MODEL, rootId, layerIndex, sourceSha256: result.sourceSha256, settingsSha256: result.settingsSha256 },
	};
	node.buildFromAtlasJsonAbsolutePath(atlasJsonPath);
	if (!node.spriteManager) {
		node.dispose();
		throw new Error("Aseprite atlas could not create its SpriteManager. Reapply the importer and inspect the atlas image reference.");
	}
	const sprite = new Sprite(layerIndex === null ? "Composite" : result.document.layers[layerIndex].name, node.spriteManager);
	const animations = buildAsepriteSpriteAnimations(result, layerIndex);
	const selected = selectAnimation(animations, data.animationName);
	const first = selected.frames![0];
	sprite.cellRef = first.cellRef ?? "";
	sprite.cellIndex = first.cellIndex ?? 0;
	sprite.isVisible = first.visible;
	sprite.metadata = {
		spriteAnimations: structuredClone(animations),
		babylonEditorLocalSpriteTransform: structuredClone(first.localTransform),
		babylonEditorAsepriteSprite: { model: ASEPRITE_SCENE_MODEL, rootId, layerIndex, sourceSha256: result.sourceSha256, settingsSha256: result.settingsSha256 },
		spriteAnimationPlayback: { name: selected.name, playing: false, speed: data.speed ?? 1, frameCursor: 0, elapsedMs: 0, completedCycles: 0, baseVisible: true },
	};
	if (data.playOnAwake !== false) {
		playVariableSpriteAnimation(sprite as any, selected, { speed: data.speed ?? 1 });
	}
	applySpriteManagerLocalSpace(node as any);
	return { node, sprite, animationName: selected.name };
}

function instantiationSummary(root: TransformNode, managers: Array<{ node: SpriteManagerNode; sprite: Sprite; animationName: string }>, mode: string): any {
	return {
		root: { id: root.id, name: root.name, position: root.position.asArray(), metadata: root.metadata?.babylonEditorAsepriteAsset },
		mode,
		managerCount: managers.length,
		managers: managers.map(({ node, sprite, animationName }) => ({
			id: node.id,
			name: node.name,
			layerIndex: node.metadata?.babylonEditorAsepriteManager?.layerIndex ?? null,
			spriteId: sprite.uniqueId.toString(),
			spriteName: sprite.name,
			animationName,
			animationCount: sprite.metadata?.spriteAnimations?.length ?? 0,
			frameCount: sprite.metadata?.spriteAnimations?.find((animation: any) => animation.name === animationName)?.frames?.length ?? 0,
			playing: sprite.metadata?.spriteAnimationPlayback?.playing === true,
		})),
	};
}

/** Reports the complete bounded native Aseprite importer and scene-instantiation contract. */
export function getAsepriteCapabilities(): any {
	return {
		importerModel: ASEPRITE_IMPORTER_MODEL,
		atlasModel: ASEPRITE_ATLAS_MODEL,
		sceneModel: ASEPRITE_SCENE_MODEL,
		sourceExtensions: [".ase", ".aseprite"],
		colorDepths: ["indexed-8", "grayscale-16", "rgba-32"],
		layerKinds: ["group", "image", "tilemap"],
		animationDirections: ["forward", "reverse", "pingpong", "pingpong_reverse"],
		features: ["linked cels", "external tilesets", "all 19 blend modes", "tags", "variable frame timing", "cel events", "slices", "pivots", "nine-patch metadata"],
		limits: { frames: ASEPRITE_MAX_FRAMES, layers: ASEPRITE_MAX_LAYERS, maximumAtlasSize: ASEPRITE_MAX_ATLAS_SIZE, eventsPerSpriteFrame: 32 },
	};
}

/** Returns paginated source, dependency, layer, tag, slice, tileset, and atlas evidence without mutating the asset. */
export async function inspectAsepriteImport(_scene: Scene, data: any): Promise<any> {
	const { absolutePath, projectPath } = resolveAsepritePath(data.path);
	const status = await getAsepriteImporterArtifactStatus(absolutePath);
	const result = status.result;
	const page = <T>(values: T[], offsetValue: unknown, limitValue: unknown, maximum: number): any => {
		const offset = boundedPage(offsetValue, 0, values.length);
		const limit = boundedPage(limitValue, Math.min(100, maximum), maximum);
		const items = values.slice(offset, offset + limit);
		return { total: values.length, offset, count: items.length, nextOffset: offset + items.length < values.length ? offset + items.length : null, items };
	};
	return {
		path: projectPath,
		fingerprint: status.fingerprint,
		sourceSha256: status.sourceSha256,
		current: status.current,
		exists: status.exists,
		dependencies: page(status.dependencies, data.dependencyOffset, data.dependencyLimit, 100),
		artifact: result
			? {
					atlasImagePath: relative(projectDirectory(), result.atlasImagePath).replace(/\\/g, "/"),
					atlasJsonPath: relative(projectDirectory(), result.atlasJsonPath).replace(/\\/g, "/"),
					atlasImageBytes: result.atlasImageBytes,
					atlasJsonBytes: result.atlasJsonBytes,
					settings: result.settings,
					document: {
						width: result.document.width,
						height: result.document.height,
						colorDepth: result.document.colorDepth,
						frameCount: result.document.frameCount,
						frameDurationsMs: result.document.frameDurationsMs,
						pixelRatio: result.document.pixelRatio,
						grid: result.document.grid,
						colorProfile: result.document.colorProfile,
						warnings: result.document.warnings,
						statistics: result.document.statistics,
					},
					layers: page(result.document.layers, data.layerOffset, data.layerLimit, 200),
					tags: page(result.document.tags, data.tagOffset, data.tagLimit, 200),
					slices: page(result.document.slices, data.sliceOffset, data.sliceLimit, 200),
					tilesets: page(result.document.tilesets, data.tilesetOffset, data.tilesetLimit, 200),
					frames: page(result.atlas.frames, data.frameOffset, data.frameLimit, 500),
					atlas: { model: result.atlas.model, width: result.atlas.width, height: result.atlas.height, statistics: result.atlas.statistics },
				}
			: null,
	};
}

/** Publishes one exact inspected Aseprite atlas lease after explicit confirmation. */
export async function applyAsepriteImport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { absolutePath } = resolveAsepritePath(data.path);
	if (typeof data.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedFingerprint)) {
		throw new Error("apply_aseprite_import requires the exact 64-character expectedFingerprint returned by inspect_aseprite_import.");
	}
	if (data.confirm !== true) {
		throw new Error("apply_aseprite_import requires confirm=true because it replaces the generated atlas artifact.");
	}
	await applyAsepriteImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshEditor(options);
	return inspectAsepriteImport(scene, data);
}

/** Instantiates a current atlas as one composite sprite or a mirrored group/layer SpriteManager hierarchy. */
export async function instantiateAsepriteAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { absolutePath, projectPath } = resolveAsepritePath(data.path);
	const status = await getAsepriteImporterArtifactStatus(absolutePath);
	if (!status.current || !status.result) {
		throw new Error("Aseprite atlas is missing or stale. Inspect and apply the importer before instantiating the asset.");
	}
	const mode = data.mode ?? "composite";
	if (!["composite", "layers"].includes(mode)) {
		throw new Error("Aseprite instantiation mode must be composite or layers.");
	}
	if (mode === "layers" && status.result.settings.layerMode !== "compositeAndLayers") {
		throw new Error('Layer instantiation requires importer layerMode="compositeAndLayers". Update and apply the importer first.');
	}
	if (data.playOnAwake !== undefined && typeof data.playOnAwake !== "boolean") {
		throw new Error("Aseprite playOnAwake must be a boolean.");
	}
	const speed = data.speed ?? 1;
	if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
		throw new Error("Aseprite animation speed must be greater than zero and at most 100.");
	}
	const id = data.id ?? Tools.RandomId();
	const name = data.name ?? basename(projectPath).replace(/\.ase(?:prite)?$/i, "");
	if (typeof id !== "string" || !id.trim() || id.length > 256 || typeof name !== "string" || !name.trim() || name.length > 256) {
		throw new Error("Aseprite root id and name must be non-empty strings of at most 256 characters.");
	}
	if (scene.getNodeById(id)) {
		throw new Error(`A scene node already uses Aseprite root id "${id}".`);
	}
	const position = validatePosition(data.position);
	const metadata = await readAssetMetadata(absolutePath);
	const root = new TransformNode(name.trim(), scene);
	root.id = id.trim();
	root.metadata = {
		babylonEditorAsepriteAsset: {
			model: ASEPRITE_SCENE_MODEL,
			sourcePath: projectPath,
			sourceGuid: metadata.guid,
			fingerprint: status.fingerprint,
			sourceSha256: status.result.sourceSha256,
			settingsSha256: status.result.settingsSha256,
			mode,
			revision: 1,
		},
	};
	const createdNodes: TransformNode[] = [root];
	const managers: Array<{ node: SpriteManagerNode; sprite: Sprite; animationName: string }> = [];
	try {
		if (data.parentId || data.parentName) {
			root.parent = resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) as any;
		}
		if (position) {
			root.position.copyFromFloats(...position);
		}
		if (mode === "composite") {
			const manager = createManager(scene, {
				result: status.result,
				atlasJsonPath: status.result.atlasJsonPath,
				rootId: root.id,
				name: `${root.name} Composite`,
				layerIndex: null,
				parent: root,
				data,
			});
			managers.push(manager);
			createdNodes.push(manager.node);
		} else {
			const layerIndices = [...new Set(status.result.atlas.frames.flatMap((frame) => (frame.layerIndex === null ? [] : [frame.layerIndex])))].sort((a, b) => a - b);
			const neededGroups = new Set<number>();
			for (const layerIndex of layerIndices) {
				let parentIndex = status.result.document.layers[layerIndex].parentIndex;
				while (parentIndex !== null) {
					neededGroups.add(parentIndex);
					parentIndex = status.result.document.layers[parentIndex].parentIndex;
				}
			}
			const groups = new Map<number, TransformNode>();
			for (const layer of status.result.document.layers.filter((candidate) => candidate.type === "group" && neededGroups.has(candidate.index))) {
				const group = new TransformNode(layer.name, scene);
				group.id = `${root.id}:group-${layer.index}`;
				group.parent = layer.parentIndex === null ? root : (groups.get(layer.parentIndex) ?? root);
				group.metadata = { babylonEditorAsepriteGroup: { model: ASEPRITE_SCENE_MODEL, rootId: root.id, layerIndex: layer.index } };
				group.setEnabled(layer.visible);
				groups.set(layer.index, group);
				createdNodes.push(group);
			}
			for (const layerIndex of layerIndices) {
				const layer = status.result.document.layers[layerIndex];
				const manager = createManager(scene, {
					result: status.result,
					atlasJsonPath: status.result.atlasJsonPath,
					rootId: root.id,
					name: layer.name,
					layerIndex,
					parent: layer.parentIndex === null ? root : (groups.get(layer.parentIndex) ?? root),
					data,
				});
				manager.node.setEnabled(layer.visible);
				managers.push(manager);
				createdNodes.push(manager.node);
			}
		}
		options.editor.sceneWorkspace?.claimNewObjectsForActiveScene?.(createdNodes);
		refreshEditor(options, root);
		return instantiationSummary(root, managers, mode);
	} catch (error) {
		root.dispose(false, true);
		throw error;
	}
}

function asepriteRoots(scene: Scene): TransformNode[] {
	return scene.transformNodes.filter((node) => node.metadata?.babylonEditorAsepriteAsset?.model === ASEPRITE_SCENE_MODEL);
}

function findAsepriteRoot(scene: Scene, data: { id?: unknown; name?: unknown }): TransformNode {
	const roots = asepriteRoots(scene);
	const root = roots.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!root) {
		throw new Error("Aseprite scene instance was not found. Provide an exact id or name returned by list_aseprite_instances.");
	}
	return root;
}

function instanceManagers(root: TransformNode): SpriteManagerNode[] {
	return root
		.getDescendants(false)
		.filter((node): node is SpriteManagerNode => node.getClassName() === "SpriteManagerNode" && Boolean((node as SpriteManagerNode).spriteManager));
}

function describeInstance(root: TransformNode, managerOffset = 0, managerLimit = 100): any {
	const metadata = root.metadata.babylonEditorAsepriteAsset;
	const managers = instanceManagers(root);
	const offset = boundedPage(managerOffset, 0, managers.length);
	const limit = boundedPage(managerLimit, 100, 200);
	const page = managers.slice(offset, offset + limit);
	return {
		id: root.id,
		name: root.name,
		position: root.position.asArray(),
		enabled: root.isEnabled(),
		metadata: structuredClone(metadata),
		managerCount: managers.length,
		managerPage: {
			total: managers.length,
			offset,
			count: page.length,
			nextOffset: offset + page.length < managers.length ? offset + page.length : null,
			items: page.map((node) => {
				const sprite = node.spriteManager!.sprites[0];
				return {
					id: node.id,
					name: node.name,
					layerIndex: node.metadata?.babylonEditorAsepriteManager?.layerIndex ?? null,
					enabled: node.isEnabled(),
					spriteId: sprite?.uniqueId.toString() ?? null,
					spriteName: sprite?.name ?? null,
					animations: (sprite?.metadata?.spriteAnimations ?? []).map((animation: any) => ({
						name: animation.name,
						frameCount: animation.frames?.length ?? Math.max(0, animation.to - animation.from + 1),
						repeat: animation.repeat ?? (animation.loop ? 0 : 1),
						durationMs:
							animation.frames?.reduce((sum: number, frame: any) => sum + frame.durationMs, 0) ?? animation.delay * Math.max(0, animation.to - animation.from + 1),
					})),
					playback: structuredClone(sprite?.metadata?.spriteAnimationPlayback ?? null),
				};
			}),
		},
	};
}

/** Lists bounded persistent Aseprite scene roots without returning every manager or frame. */
export function listAsepriteInstances(scene: Scene, data: any = {}): any {
	const roots = asepriteRoots(scene);
	const offset = boundedPage(data.offset, 0, roots.length);
	const limit = boundedPage(data.limit, 50, 100);
	const page = roots.slice(offset, offset + limit);
	return {
		total: roots.length,
		offset,
		count: page.length,
		nextOffset: offset + page.length < roots.length ? offset + page.length : null,
		instances: page.map((root) => describeInstance(root, 0, 0)),
	};
}

/** Reads one exact Aseprite root plus a bounded page of managers, animation clips, and playback state. */
export function getAsepriteInstance(scene: Scene, data: any): any {
	return describeInstance(findAsepriteRoot(scene, data), data.managerOffset, data.managerLimit);
}

/** Plays, resumes, pauses, stops, or seeks every layer stream under one exact-revision Aseprite root. */
export function controlAsepriteAnimation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const root = findAsepriteRoot(scene, data);
	const metadata = root.metadata.babylonEditorAsepriteAsset;
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== metadata.revision) {
		throw new Error(`Aseprite instance revision changed. Inspect again and use expectedRevision ${metadata.revision}.`);
	}
	if (!["play", "pause", "stop", "seek"].includes(data.action)) {
		throw new Error("Aseprite animation action must be play, pause, stop, or seek.");
	}
	const managers = instanceManagers(root);
	if (!managers.length) {
		throw new Error("Aseprite instance contains no live SpriteManager streams.");
	}
	const speed = data.speed ?? managers[0].spriteManager!.sprites[0]?.metadata?.spriteAnimationPlayback?.speed ?? 1;
	if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > 100) {
		throw new Error("Aseprite animation speed must be greater than zero and at most 100.");
	}
	const targets = managers.map((node) => {
		const sprite = node.spriteManager!.sprites[0];
		if (!sprite) {
			throw new Error(`Aseprite SpriteManager "${node.name}" has no generated sprite.`);
		}
		const animations = sprite.metadata?.spriteAnimations ?? [];
		const requestedName = data.animationName ?? sprite.metadata?.spriteAnimationPlayback?.name ?? animations[0]?.name;
		const animation = animations.find((candidate: any) => candidate.name === requestedName);
		if (!animation?.frames?.length) {
			throw new Error(`Aseprite animation "${String(requestedName)}" is unavailable on SpriteManager "${node.name}".`);
		}
		const frameCursor = data.action === "seek" ? data.frameCursor : 0;
		const elapsedMs = data.elapsedMs ?? 0;
		if (
			data.action === "seek" &&
			(!Number.isSafeInteger(frameCursor) ||
				frameCursor < 0 ||
				frameCursor >= animation.frames.length ||
				typeof elapsedMs !== "number" ||
				!Number.isFinite(elapsedMs) ||
				elapsedMs < 0 ||
				elapsedMs >= animation.frames[frameCursor].durationMs)
		) {
			throw new Error(`Aseprite seek position is outside animation "${animation.name}" frame timing.`);
		}
		return { node, sprite, animation };
	});
	const snapshots = targets.map(({ sprite }) => structuredClone(sprite.metadata));
	try {
		for (const { node, sprite, animation } of targets) {
			if (data.action === "pause") {
				stopVariableSpriteAnimation(sprite as any);
			} else if (data.action === "stop") {
				playVariableSpriteAnimation(sprite as any, animation, { speed, emitInitialEvents: false });
				stopVariableSpriteAnimation(sprite as any, true);
			} else if (data.action === "seek") {
				playVariableSpriteAnimation(sprite as any, animation, { speed, frameCursor: data.frameCursor, elapsedMs: data.elapsedMs ?? 0, emitInitialEvents: false });
				if (data.playing !== true) {
					stopVariableSpriteAnimation(sprite as any);
				}
			} else {
				const playback = sprite.metadata?.spriteAnimationPlayback;
				// A finite animation that already exhausted its repeat count must restart instead of resuming its terminal cursor and stopping again immediately.
				const resume =
					data.restart !== true &&
					playback?.name === animation.name &&
					playback.frameCursor < animation.frames.length &&
					(animation.repeat === 0 || playback.completedCycles < animation.repeat);
				playVariableSpriteAnimation(sprite as any, animation, {
					speed,
					frameCursor: resume ? playback.frameCursor : 0,
					elapsedMs: resume ? playback.elapsedMs : 0,
					completedCycles: resume ? playback.completedCycles : 0,
					emitInitialEvents: !resume,
				});
			}
			applySpriteManagerLocalSpace(node as any);
		}
	} catch (error) {
		for (const [index, target] of targets.entries()) {
			stopVariableSpriteAnimation(target.sprite as any);
			target.sprite.metadata = snapshots[index];
			restoreVariableSpriteAnimation(target.sprite as any);
		}
		throw error;
	}
	metadata.revision++;
	refreshEditor(options, root);
	return describeInstance(root);
}

/** Deletes one confirmed Aseprite scene hierarchy while retaining its source and importer artifacts. */
export function deleteAsepriteInstance(scene: Scene, data: any, options: IMCPActionOptions): any {
	const root = findAsepriteRoot(scene, data);
	if (data.confirm !== true) {
		throw new Error("delete_aseprite_instance requires confirm=true because the instantiated sprite hierarchy is removed.");
	}
	const id = root.id;
	root.dispose(false, true);
	refreshEditor(options);
	return { deleted: true, id };
}
