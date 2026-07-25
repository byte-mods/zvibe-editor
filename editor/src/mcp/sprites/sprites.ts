import { basename, dirname, extname, join, relative } from "path/posix";
import { ensureDir, pathExists, writeJSON } from "fs-extra";

import sharp from "sharp";

import { Color4, Scene, Sprite, Tools, TransformNode, Vector2, Vector3 } from "babylonjs";

import { addSpriteManager, addSpriteMapNode } from "../../project/add/sprite";
import { projectConfiguration } from "../../project/configuration";
import { SpriteManagerNode } from "../../editor/nodes/sprite-manager";
import { SpriteMapNode } from "../../editor/nodes/sprite-map";
import { isSpriteManagerNode, isSpriteMapNode } from "../../tools/guards/sprites";

import { IMCPActionOptions } from "../action";
import { removePhysics2DBody, setPhysics2DBody } from "../physics2d/physics2d";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

type IAnimatedTile = { id: string; name: string; tileIds: string[]; frames: number[]; frameDuration: number; loop: boolean; enabled: boolean };
type ITileColliderGenerator = {
	id: string;
	nodeIds: string[];
	tileIndexes?: number[];
	layer?: number;
	merge: boolean;
	isTrigger: boolean;
	friction?: number;
	restitution?: number;
};
const animatedTileStates = new WeakMap<Scene, Map<string, { elapsed: number; frame: number }>>();

function resolveProjectPath(path: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	const projectDirectory = dirname(projectConfiguration.path);
	const absolutePath = join(projectDirectory, path);
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Sprite asset paths must stay inside the open project directory.");
	}
	return absolutePath;
}

type IAtlasSource = {
	path: string;
	absolutePath: string;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	trimX?: number;
	trimY?: number;
	trimmed: boolean;
	input?: Buffer;
};

function nextPowerOfTwo(value: number): number {
	let result = 1;
	while (result < value) result *= 2;
	return result;
}

function packAtlasSources(
	sources: IAtlasSource[],
	width: number,
	padding: number,
	allowRotation: boolean
): { placements: Map<string, { x: number; y: number; width: number; height: number; rotated: boolean }>; height: number } | null {
	let x = padding;
	let y = padding;
	let rowHeight = 0;
	const placements = new Map<string, { x: number; y: number; width: number; height: number; rotated: boolean }>();
	for (const source of sources) {
		const orientations = [
			{ width: source.width, height: source.height, rotated: false },
			...(allowRotation && source.width !== source.height ? [{ width: source.height, height: source.width, rotated: true }] : []),
		];
		const choose = (atX: number, currentRowHeight: number): (typeof orientations)[number] | null =>
			orientations
				.filter((orientation) => atX + orientation.width + padding <= width)
				.sort(
					(a, b) =>
						Math.max(currentRowHeight, a.height) - Math.max(currentRowHeight, b.height) || atX + a.width - (atX + b.width) || Number(a.rotated) - Number(b.rotated)
				)[0] ?? null;
		let orientation = choose(x, rowHeight);
		if (!orientation) {
			x = padding;
			y += rowHeight + padding;
			rowHeight = 0;
			orientation = choose(x, rowHeight);
		}
		if (!orientation) {
			return null;
		}
		placements.set(source.path, { x, y, ...orientation });
		x += orientation.width + padding;
		rowHeight = Math.max(rowHeight, orientation.height);
	}
	return { placements, height: y + rowHeight + padding };
}

function resolveSpriteManager(scene: Scene, data: any): SpriteManagerNode {
	const node = resolveNode({ scene, nodeId: data.managerNodeId, nodeName: data.managerNodeName });
	if (!isSpriteManagerNode(node)) {
		throw new Error(`Node "${node.name}" is not a SpriteManagerNode.`);
	}
	return node;
}

function resolveSpriteMap(scene: Scene, data: any): SpriteMapNode {
	const node = resolveNode({ scene, nodeId: data.mapNodeId, nodeName: data.mapNodeName });
	if (!isSpriteMapNode(node)) {
		throw new Error(`Node "${node.name}" is not a SpriteMapNode.`);
	}
	return node;
}

type ITilePalette = { id: string; name: string; mapNodeId: string; tileIndexes: number[]; activeTileIndex: number };

function getTilePalettes(scene: Scene): ITilePalette[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorTilePalettes ??= []);
}

function resolveTilePalette(scene: Scene, data: { paletteId?: string; paletteName?: string }): ITilePalette {
	const palette = getTilePalettes(scene).find((candidate) => candidate.id === data.paletteId || candidate.name === data.paletteName);
	if (!palette) throw new Error("Tile palette not found.");
	return palette;
}

function getAnimatedTiles(node: SpriteMapNode): IAnimatedTile[] {
	node.metadata ??= {};
	return (node.metadata.babylonEditorAnimatedTiles ??= []);
}

function getTileColliderGeneratorConfiguration(node: SpriteMapNode): ITileColliderGenerator | null {
	return node.metadata?.babylonEditorTileColliderGenerator ?? null;
}

function getTileColliderPosition(map: SpriteMapNode, x: number, y: number): { x: number; y: number; width: number; height: number } {
	const options = map.spriteMap!.options;
	const stage = options.stageSize ?? new Vector2(1, 1);
	const output = options.outputSize ?? new Vector2(100, 100);
	const width = output.x / stage.x;
	const height = output.y / stage.y;
	return { x: map.position.x + (x + 0.5 - stage.x / 2) * width, y: map.position.y + (stage.y / 2 - y - 0.5) * height, width, height };
}

function resolveAnimatedTile(node: SpriteMapNode, data: { id?: string; name?: string }): IAnimatedTile {
	const animation = getAnimatedTiles(node).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!animation) throw new Error("Animated tile not found.");
	return animation;
}

/** Advances one Sprite Map animation by elapsed milliseconds. Exported for deterministic editor tests. */
export function advanceSpriteMapAnimation(node: SpriteMapNode, animation: IAnimatedTile, elapsedMilliseconds: number, state: { elapsed: number; frame: number }): boolean {
	if (!animation.enabled || !node.spriteMap || !animation.frames.length) return false;
	state.elapsed += elapsedMilliseconds;
	if (state.elapsed < animation.frameDuration) return false;
	const frameSteps = Math.floor(state.elapsed / animation.frameDuration);
	state.elapsed %= animation.frameDuration;
	const nextFrame = state.frame + frameSteps;
	state.frame = animation.loop ? nextFrame % animation.frames.length : Math.min(animation.frames.length - 1, nextFrame);
	const frame = animation.frames[state.frame];
	for (const tileId of animation.tileIds) {
		const tile = node.tiles.find((candidate) => candidate.id === tileId);
		if (tile) tile.tile = frame;
	}
	node.updateFromOptions(node.spriteMap.options);
	return true;
}

/** Starts or reuses the scene-level preview updater for persisted animated tiles. */
export function configureSpriteMapAnimations(scene: Scene): void {
	if (animatedTileStates.has(scene)) return;
	animatedTileStates.set(scene, new Map());
	scene.onBeforeRenderObservable.add(() => {
		const states = animatedTileStates.get(scene);
		if (!states) return;
		for (const node of scene.transformNodes.filter(isSpriteMapNode))
			for (const animation of getAnimatedTiles(node)) {
				const state = states.get(animation.id) ?? { elapsed: 0, frame: 0 };
				states.set(animation.id, state);
				advanceSpriteMapAnimation(node, animation, scene.getEngine().getDeltaTime(), state);
			}
	});
}

function describeSprite(sprite: Sprite): any {
	return {
		id: sprite.uniqueId.toString(),
		name: sprite.name,
		position: sprite.position.asArray(),
		width: sprite.width,
		height: sprite.height,
		angle: sprite.angle,
		cellIndex: sprite.cellIndex,
		cellRef: sprite.cellRef,
		invertU: sprite.invertU,
		invertV: sprite.invertV,
		isVisible: sprite.isVisible,
		color: sprite.color.asArray(),
		animations: sprite.metadata?.spriteAnimations ?? [],
	};
}

function refresh(options: IMCPActionOptions, node: SpriteManagerNode | SpriteMapNode): void {
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
	options.editor.layout.inspector.setEditedObject(node);
}

export function listSpriteManagers(scene: Scene): any {
	return {
		managers: scene.transformNodes.filter(isSpriteManagerNode).map((node) => ({
			...toNodeSummary(node),
			atlasJsonRelativePath: node.atlasJsonRelativePath,
			hasSpritesheet: Boolean(node.spritesheet),
			spriteCount: node.spriteManager?.sprites.length ?? 0,
		})),
	};
}

export function createSpriteManager(scene: Scene, data: any, options: IMCPActionOptions): any {
	const parent = data.parentId || data.parentName ? resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) : undefined;
	const node = addSpriteManager(options.editor, parent);
	if (data.name) node.name = data.name;
	if (data.atlasJsonPath) node.buildFromAtlasJsonAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	else if (data.imagePath) node.buildFromImageAbsolutePath(resolveProjectPath(data.imagePath));
	refresh(options, node);
	return { ...toNodeSummary(node), hasSpritesheet: Boolean(node.spritesheet) };
}

export function setSpriteManager(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteManager(scene, data);
	if (data.name !== undefined) node.name = data.name;
	if (data.atlasJsonPath !== undefined) node.buildFromAtlasJsonAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	else if (data.imagePath !== undefined) node.buildFromImageAbsolutePath(resolveProjectPath(data.imagePath));

	const manager = node.spriteManager;
	if (!manager && Object.keys(data.properties ?? {}).length) throw new Error("Assign an image or atlas before configuring a sprite manager.");
	if (manager) Object.assign(manager, data.properties ?? {});
	refresh(options, node);
	return listSpriteManagers(scene).managers.find((candidate: any) => candidate.id === node.id);
}

/** Packs project PNG files into a deterministic power-of-two TexturePacker-compatible atlas plus JSON descriptor. */
export async function packSpriteAtlas(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!Array.isArray(data.sourcePaths) || !data.sourcePaths.length) throw new Error("sourcePaths must contain at least one PNG asset path.");
	const padding = data.padding ?? 2;
	const maxSize = data.maxSize ?? 2048;
	if (!Number.isInteger(padding) || padding < 0 || padding > 64) throw new Error("padding must be an integer between 0 and 64.");
	if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 8192 || (maxSize & (maxSize - 1)) !== 0) {
		throw new Error("maxSize must be a power of two between 64 and 8192.");
	}
	if (extname(data.outputPath).toLowerCase() !== ".png") throw new Error("outputPath must be a project-relative .png atlas path.");

	const directory = dirname(projectConfiguration.path!);
	const sourcePaths = [...new Set<string>(data.sourcePaths)].sort();
	const trimTransparent = data.trimTransparent === true;
	const allowRotation = data.allowRotation === true;
	const sources: any[] = await Promise.all(
		sourcePaths.map(async (path) => {
			if (extname(path).toLowerCase() !== ".png") throw new Error(`Atlas source "${path}" must be a PNG file.`);
			const absolutePath = resolveProjectPath(path);
			if (!(await pathExists(absolutePath))) throw new Error(`Atlas source "${path}" does not exist.`);
			const metadata = await sharp(absolutePath).metadata();
			if (!metadata.width || !metadata.height) throw new Error(`Could not read dimensions for atlas source "${path}".`);
			if (!trimTransparent)
				return {
					path: relative(directory, absolutePath),
					absolutePath,
					width: metadata.width,
					height: metadata.height,
					sourceWidth: metadata.width,
					sourceHeight: metadata.height,
					trimmed: false,
				};
			const decoded = await sharp(absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			let left = metadata.width;
			let top = metadata.height;
			let right = -1;
			let bottom = -1;
			for (let y = 0; y < metadata.height; y++) {
				for (let x = 0; x < metadata.width; x++) {
					if (decoded.data[(y * metadata.width + x) * 4 + 3] === 0) continue;
					left = Math.min(left, x);
					top = Math.min(top, y);
					right = Math.max(right, x);
					bottom = Math.max(bottom, y);
				}
			}
			if (right < left || bottom < top) throw new Error(`Atlas source "${path}" is fully transparent and cannot be trimmed.`);
			const trimmedWidth = right - left + 1;
			const trimmedHeight = bottom - top + 1;
			const trimmed = await sharp(decoded.data, { raw: { width: metadata.width, height: metadata.height, channels: 4 } })
				.extract({ left, top, width: trimmedWidth, height: trimmedHeight })
				.png()
				.toBuffer({ resolveWithObject: true });
			return {
				path: relative(directory, absolutePath),
				absolutePath,
				input: trimmed.data,
				width: trimmed.info.width,
				height: trimmed.info.height,
				sourceWidth: metadata.width,
				sourceHeight: metadata.height,
				trimX: left,
				trimY: top,
				trimmed: trimmed.info.width !== metadata.width || trimmed.info.height !== metadata.height,
			};
		})
	);
	const names = sources.map((source) => basename(source.path));
	if (new Set(names).size !== names.length) throw new Error("Atlas source filenames must be unique; rename duplicate PNG filenames before packing.");

	let packed: ReturnType<typeof packAtlasSources> = null;
	let atlasWidth = nextPowerOfTwo(Math.max(...sources.map((source) => (allowRotation ? Math.min(source.width, source.height) : source.width) + padding * 2)));
	while (atlasWidth <= maxSize) {
		const candidate = packAtlasSources(sources, atlasWidth, padding, allowRotation);
		if (candidate && nextPowerOfTwo(candidate.height) <= maxSize) {
			packed = candidate;
			break;
		}
		atlasWidth *= 2;
	}
	if (!packed) throw new Error(`Sources do not fit in a ${maxSize}×${maxSize} atlas. Increase maxSize or split the atlas.`);

	const outputPath = resolveProjectPath(data.outputPath);
	const atlasHeight = nextPowerOfTwo(packed.height);
	const composites = await Promise.all(
		sources.map(async (source) => {
			const placement = packed!.placements.get(source.path)!;
			return {
				input: placement.rotated
					? await sharp(source.input ?? source.absolutePath)
							.rotate(90)
							.png()
							.toBuffer()
					: (source.input ?? source.absolutePath),
				left: placement.x,
				top: placement.y,
			};
		})
	);
	await ensureDir(dirname(outputPath));
	await sharp({ create: { width: atlasWidth, height: atlasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
		.composite(composites)
		.png()
		.toFile(outputPath);
	const frames = Object.fromEntries(
		sources.map((source) => {
			const placement = packed!.placements.get(source.path)!;
			return [
				basename(source.path),
				{
					frame: { x: placement.x, y: placement.y, w: placement.width, h: placement.height },
					rotated: placement.rotated,
					trimmed: source.trimmed,
					spriteSourceSize: { x: source.trimX ?? 0, y: source.trimY ?? 0, w: source.width, h: source.height },
					sourceSize: { w: source.sourceWidth, h: source.sourceHeight },
				},
			];
		})
	);
	const atlasJsonPath = outputPath.replace(/\.png$/i, ".json");
	await writeJSON(
		atlasJsonPath,
		{ frames, meta: { app: "Babylon.js Editor", version: "1", image: basename(outputPath), format: "RGBA8888", size: { w: atlasWidth, h: atlasHeight }, scale: "1" } },
		{ spaces: "\t" }
	);
	options.editor.layout.assets?.refresh?.();
	return {
		atlasPath: relative(directory, outputPath),
		atlasJsonPath: relative(directory, atlasJsonPath),
		width: atlasWidth,
		height: atlasHeight,
		padding,
		trimTransparent,
		allowRotation,
		rotatedFrames: sources.filter((source) => packed!.placements.get(source.path)!.rotated).map((source) => basename(source.path)),
		frames: Object.keys(frames),
	};
}

/** Writes a TexturePacker-compatible descriptor for explicitly named, irregular rectangles on one source image. */
export async function sliceSpriteSheet(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!Array.isArray(data.frames) || !data.frames.length) throw new Error("frames must contain at least one named rectangle.");
	if (extname(data.outputPath).toLowerCase() !== ".json") throw new Error("outputPath must be a project-relative .json atlas descriptor path.");
	const sourcePath = resolveProjectPath(data.sourcePath);
	const outputPath = resolveProjectPath(data.outputPath);
	if (!(await pathExists(sourcePath))) throw new Error(`Sprite sheet source "${data.sourcePath}" does not exist.`);
	const metadata = await sharp(sourcePath).metadata();
	if (!metadata.width || !metadata.height) throw new Error(`Could not read dimensions for sprite sheet source "${data.sourcePath}".`);
	const names = data.frames.map((frame: any) => frame.name);
	if (new Set(names).size !== names.length) throw new Error("Sprite frame names must be unique.");
	for (const frame of data.frames) {
		if (!frame.name?.trim()) throw new Error("Each sprite frame requires a name.");
		for (const key of ["x", "y", "width", "height"]) if (!Number.isInteger(frame[key])) throw new Error(`Sprite frame "${frame.name}" ${key} must be an integer.`);
		if (frame.x < 0 || frame.y < 0 || frame.width <= 0 || frame.height <= 0 || frame.x + frame.width > metadata.width || frame.y + frame.height > metadata.height) {
			throw new Error(`Sprite frame "${frame.name}" must stay within the ${metadata.width}×${metadata.height} source image.`);
		}
	}
	await ensureDir(dirname(outputPath));
	const frames = Object.fromEntries(
		data.frames.map((frame: any) => [
			frame.name,
			{
				frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
				rotated: false,
				trimmed: false,
				spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
				sourceSize: { w: frame.width, h: frame.height },
			},
		])
	);
	const directory = dirname(projectConfiguration.path!);
	await writeJSON(
		outputPath,
		{
			frames,
			meta: {
				app: "Babylon.js Editor",
				version: "1",
				image: relative(dirname(outputPath), sourcePath),
				format: "RGBA8888",
				size: { w: metadata.width, h: metadata.height },
				scale: "1",
			},
		},
		{ spaces: "\t" }
	);
	options.editor.layout.assets?.refresh?.();
	return {
		sourcePath: relative(directory, sourcePath),
		atlasJsonPath: relative(directory, outputPath),
		width: metadata.width,
		height: metadata.height,
		frames: Object.keys(frames),
	};
}

export function listSprites(scene: Scene, data: any): any {
	const node = resolveSpriteManager(scene, data);
	return { manager: toNodeSummary(node), sprites: node.spriteManager?.sprites.map(describeSprite) ?? [] };
}

export function createSprite(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteManager(scene, data);
	if (!node.spriteManager) throw new Error("Assign an image or atlas to the sprite manager before creating sprites.");
	const sprite = new Sprite(data.name ?? `Sprite ${node.spriteManager.sprites.length + 1}`, node.spriteManager);
	sprite.metadata = { spriteAnimations: [] };
	if (data.position) sprite.position.copyFrom(toVector3(data.position));
	if (data.width !== undefined) sprite.width = data.width;
	if (data.height !== undefined) sprite.height = data.height;
	if (data.cellIndex !== undefined) sprite.cellIndex = data.cellIndex;
	if (data.cellRef !== undefined) sprite.cellRef = data.cellRef;
	refresh(options, node);
	return describeSprite(sprite);
}

export function setSprite(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteManager(scene, data);
	const sprite = node.spriteManager?.sprites.find((candidate) => candidate.uniqueId.toString() === data.spriteId || candidate.name === data.spriteName);
	if (!sprite) throw new Error("Sprite not found. Provide spriteId (preferred) or spriteName.");
	for (const property of ["name", "width", "height", "angle", "cellIndex", "cellRef", "invertU", "invertV", "isVisible"]) {
		if (data[property] !== undefined) (sprite as any)[property] = data[property];
	}
	if (data.position) sprite.position.copyFrom(toVector3(data.position));
	if (data.color) sprite.color = new Color4(...data.color);
	if (data.animations !== undefined) sprite.metadata = { ...(sprite.metadata ?? {}), spriteAnimations: data.animations };
	refresh(options, node);
	return describeSprite(sprite);
}

export function playSpriteAnimation(scene: Scene, data: any): any {
	const node = resolveSpriteManager(scene, data);
	const sprite = node.spriteManager?.sprites.find((candidate) => candidate.uniqueId.toString() === data.spriteId || candidate.name === data.spriteName);
	if (!sprite) throw new Error("Sprite not found.");
	if (data.stop) sprite.stopAnimation();
	else sprite.playAnimation(data.from, data.to, data.loop ?? true, data.delay ?? 100);
	return { ...describeSprite(sprite), animationStarted: sprite.animationStarted };
}

export async function createSpriteMap(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const parent = data.parentId || data.parentName ? resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) : undefined;
	const node = addSpriteMapNode(options.editor, parent);
	if (data.name) node.name = data.name;
	if (data.atlasJsonPath) {
		await node.buildFromAbsolutePath(resolveProjectPath(data.atlasJsonPath), undefined, undefined, {
			layerCount: data.options?.layerCount,
			stageSize: data.options?.stageSize ? Vector2.FromArray(data.options.stageSize) : undefined,
			outputSize: data.options?.outputSize ? Vector2.FromArray(data.options.outputSize) : undefined,
			colorMultiply: data.options?.colorMultiply ? Vector3.FromArray(data.options.colorMultiply) : undefined,
		});
	}
	refresh(options, node);
	return describeSpriteMap(node);
}

function describeSpriteMap(node: SpriteMapNode): any {
	const options = node.spriteMap?.options;
	return {
		...toNodeSummary(node),
		atlasJsonRelativePath: node.atlasJsonRelativePath,
		options: options
			? {
					layerCount: options.layerCount,
					stageSize: options.stageSize?.asArray(),
					outputSize: options.outputSize?.asArray(),
					colorMultiply: options.colorMultiply?.asArray(),
				}
			: null,
		tiles: node.tiles,
		ruleTiles: node.metadata?.babylonEditorRuleTiles ?? [],
	};
}

function applyRuleTiles(node: SpriteMapNode): { changedTiles: number } {
	const rules = node.metadata?.babylonEditorRuleTiles ?? [];
	let changedTiles = 0;
	const lookup = new Map<string, any>();
	for (const tile of node.tiles) lookup.set(`${tile.layer}:${tile.position.x}:${tile.position.y}`, tile);
	for (const tile of node.tiles) {
		const mutableTile = tile as any;
		const source = mutableTile.ruleSource ?? tile.tile;
		mutableTile.ruleSource ??= source;
		const rule = rules.find(
			(candidate: any) =>
				candidate.sourceTile === source &&
				Object.entries(candidate.neighbors ?? {}).every(([direction, expected]) => {
					const offset =
						direction === "north"
							? [0, -1]
							: direction === "south"
								? [0, 1]
								: direction === "east"
									? [1, 0]
									: direction === "west"
										? [-1, 0]
										: direction === "northEast"
											? [1, -1]
											: direction === "northWest"
												? [-1, -1]
												: direction === "southEast"
													? [1, 1]
													: [-1, 1];
					const neighbor = lookup.get(`${tile.layer}:${tile.position.x + offset[0]}:${tile.position.y + offset[1]}`);
					const same = (neighbor?.ruleSource ?? neighbor?.tile) === source;
					return expected === "any" || (expected === "same" ? same : !same);
				})
		);
		let next = rule?.outputTile ?? source;
		if (rule?.variants?.length) {
			const total = rule.variants.reduce((sum: number, variant: any) => sum + variant.weight, 0);
			let random = (((tile.position.x * 73856093) ^ (tile.position.y * 19349663) ^ (tile.layer * 83492791) ^ (rule.seed ?? 0)) >>> 0) / 0x100000000;
			random *= total;
			for (const variant of rule.variants) {
				random -= variant.weight;
				if (random <= 0) {
					next = variant.tile;
					break;
				}
			}
		}
		if (tile.tile !== next) {
			tile.tile = next;
			changedTiles++;
		}
	}
	node.updateFromOptions(node.spriteMap?.options ?? ({} as any));
	return { changedTiles };
}

/** Replaces persisted neighbor rules and resolves matching SpriteMap cells deterministically. */
export function setSpriteMapRuleTiles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteMap(scene, data);
	if (!Array.isArray(data.rules)) throw new Error("Rule tiles must be an array.");
	for (const rule of data.rules) {
		if (rule.sourceTile === undefined || rule.sourceTile === null || ((rule.outputTile === undefined || rule.outputTile === null) && !rule.variants?.length))
			throw new Error("Each rule tile needs sourceTile and outputTile or variants.");
		for (const variant of rule.variants ?? [])
			if (variant.tile === undefined || variant.tile === null || !Number.isFinite(variant.weight) || variant.weight <= 0)
				throw new Error("Rule-tile variants need a tile and positive finite weight.");
		for (const direction of Object.keys(rule.neighbors ?? {}))
			if (!["north", "south", "east", "west", "northEast", "northWest", "southEast", "southWest"].includes(direction))
				throw new Error(`Unsupported rule-tile neighbor direction: ${direction}`);
		for (const value of Object.values(rule.neighbors ?? {}))
			if (!["same", "different", "any"].includes(value as string)) throw new Error("Rule-tile neighbor values must be same, different, or any.");
	}
	node.metadata ??= {};
	node.metadata.babylonEditorRuleTiles = structuredClone(data.rules);
	const result = applyRuleTiles(node);
	refresh(options, node);
	return { ...describeSpriteMap(node), ...result };
}

/** Resolves persisted rule tiles after external tile edits. */
export function resolveSpriteMapRuleTiles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteMap(scene, data);
	const result = applyRuleTiles(node);
	refresh(options, node);
	return { ...describeSpriteMap(node), ...result };
}

export function listSpriteMaps(scene: Scene): any {
	return { maps: scene.transformNodes.filter(isSpriteMapNode).map(describeSpriteMap) };
}

/** Lists reusable tile-palette assets persisted with the scene. */
export function listTilePalettes(scene: Scene): any {
	return { palettes: structuredClone(getTilePalettes(scene)) };
}

/** Creates a reusable palette that refers to atlas tile indexes on a Sprite Map. */
export function createTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	if (getTilePalettes(scene).some((palette) => palette.name === data.name)) throw new Error(`Tile palette \"${data.name}\" already exists.`);
	const tileIndexes: number[] = [...new Set<number>(((data.tileIndexes ?? []) as unknown[]).map((value) => Number(value)))];
	if (!tileIndexes.length || tileIndexes.some((index) => !Number.isInteger(index) || index < 0))
		throw new Error("tileIndexes must contain one or more non-negative integer atlas indexes.");
	const palette: ITilePalette = { id: Tools.RandomId(), name: data.name, mapNodeId: map.id, tileIndexes, activeTileIndex: data.activeTileIndex ?? tileIndexes[0] };
	if (!palette.tileIndexes.includes(palette.activeTileIndex)) throw new Error("activeTileIndex must be included in tileIndexes.");
	getTilePalettes(scene).push(palette);
	options.editor.layout.inspector.setEditedObject(map);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(palette);
}

/** Updates palette membership or its active brush tile. */
export function setTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	if (data.name !== undefined && getTilePalettes(scene).some((candidate) => candidate !== palette && candidate.name === data.name))
		throw new Error(`Tile palette \"${data.name}\" already exists.`);
	if (data.tileIndexes !== undefined) {
		const tileIndexes: number[] = [...new Set<number>((data.tileIndexes as unknown[]).map((value) => Number(value)))];
		if (!tileIndexes.length || tileIndexes.some((index) => !Number.isInteger(index) || index < 0))
			throw new Error("tileIndexes must contain one or more non-negative integer atlas indexes.");
		palette.tileIndexes = tileIndexes;
	}
	if (data.activeTileIndex !== undefined) palette.activeTileIndex = data.activeTileIndex;
	if (!palette.tileIndexes.includes(palette.activeTileIndex)) throw new Error("activeTileIndex must be included in tileIndexes.");
	if (data.name !== undefined) palette.name = data.name;
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(palette);
}

/** Paints or erases a rectangular brush stroke using a persisted palette's active tile. */
export function paintTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	const map = resolveSpriteMap(scene, { mapNodeId: data.mapNodeId ?? palette.mapNodeId });
	if (map.id !== palette.mapNodeId) throw new Error("Tile palette belongs to a different Sprite Map.");
	if (!map.spriteMap) throw new Error("Assign an atlas JSON before painting Sprite Map tiles.");
	const position = data.position;
	if (!Array.isArray(position) || position.length !== 2 || position.some((value) => !Number.isInteger(value)))
		throw new Error("position must be a two-item integer grid coordinate.");
	const width = data.width ?? 1;
	const height = data.height ?? 1;
	const layer = data.layer ?? 0;
	if (![width, height, layer].every(Number.isInteger) || width < 1 || height < 1 || layer < 0)
		throw new Error("width and height must be positive integers and layer must be non-negative.");
	const tileIndex = data.tileIndex ?? palette.activeTileIndex;
	if (data.mode !== "erase" && !palette.tileIndexes.includes(tileIndex)) throw new Error("tileIndex must belong to the selected palette.");
	let changedTiles = 0;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const gridX = position[0] + x;
			const gridY = position[1] + y;
			const existing = map.tiles.find((tile) => tile.layer === layer && tile.position.x === gridX && tile.position.y === gridY);
			if (data.mode === "erase") {
				if (existing) {
					map.tiles.splice(map.tiles.indexOf(existing), 1);
					changedTiles++;
				}
			} else if (existing) {
				existing.tile = tileIndex;
				(existing as any).ruleSource = tileIndex;
				changedTiles++;
			} else {
				map.tiles.push({
					id: Tools.RandomId(),
					name: `Palette ${tileIndex}`,
					layer,
					position: { x: gridX, y: gridY },
					repeatCount: { x: 0, y: 0 },
					repeatOffset: { x: 0, y: 0 },
					tile: tileIndex,
				} as any);
				changedTiles++;
			}
		}
	map.updateFromOptions(map.spriteMap.options);
	applyRuleTiles(map);
	refresh(options, map);
	return { palette: structuredClone(palette), map: describeSpriteMap(map), changedTiles };
}

/** Deletes a palette asset without removing painted tiles. */
export function deleteTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	getTilePalettes(scene).splice(getTilePalettes(scene).indexOf(palette), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: palette.id };
}

/** Lists animations that cycle selected Sprite Map cells through atlas frames. */
export function listAnimatedTiles(scene: Scene, data: any): any {
	const map = resolveSpriteMap(scene, data);
	return { map: toNodeSummary(map), animations: structuredClone(getAnimatedTiles(map)) };
}

/** Creates a persisted animated tile sequence. */
export function createAnimatedTile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	if (!map.spriteMap) throw new Error("Assign an atlas JSON before creating animated tiles.");
	if (getAnimatedTiles(map).some((animation) => animation.name === data.name)) throw new Error(`Animated tile \"${data.name}\" already exists.`);
	const tileIds: string[] = [...new Set<string>(((data.tileIds ?? []) as unknown[]).map((value) => String(value)))];
	const frames: number[] = [...new Set<number>(((data.frames ?? []) as unknown[]).map((value) => Number(value)))];
	if (!tileIds.length || tileIds.some((id) => !map.tiles.some((tile) => tile.id === id))) throw new Error("tileIds must contain existing Sprite Map tile ids.");
	if (frames.length < 2 || frames.some((frame) => !Number.isInteger(frame) || frame < 0)) throw new Error("frames must contain at least two non-negative integer atlas indexes.");
	if (!Number.isFinite(data.frameDuration) || data.frameDuration <= 0) throw new Error("frameDuration must be positive milliseconds.");
	const animation: IAnimatedTile = {
		id: Tools.RandomId(),
		name: data.name,
		tileIds,
		frames,
		frameDuration: data.frameDuration,
		loop: data.loop ?? true,
		enabled: data.enabled ?? true,
	};
	getAnimatedTiles(map).push(animation);
	configureSpriteMapAnimations(scene);
	refresh(options, map);
	return structuredClone(animation);
}

/** Updates a persisted animated tile sequence. */
export function setAnimatedTile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const animation = resolveAnimatedTile(map, data);
	const next = { ...animation, ...data, id: animation.id, name: data.name ?? animation.name };
	if (next.frames.length < 2 || next.frames.some((frame: number) => !Number.isInteger(frame) || frame < 0))
		throw new Error("frames must contain at least two non-negative integer atlas indexes.");
	if (!Number.isFinite(next.frameDuration) || next.frameDuration <= 0) throw new Error("frameDuration must be positive milliseconds.");
	if (!next.tileIds.length || next.tileIds.some((id: string) => !map.tiles.some((tile) => tile.id === id))) throw new Error("tileIds must contain existing Sprite Map tile ids.");
	if (data.name !== undefined && getAnimatedTiles(map).some((candidate) => candidate !== animation && candidate.name === data.name))
		throw new Error(`Animated tile \"${data.name}\" already exists.`);
	Object.assign(animation, next);
	configureSpriteMapAnimations(scene);
	refresh(options, map);
	return structuredClone(animation);
}

/** Deletes an animated-tile sequence without deleting painted cells. */
export function deleteAnimatedTile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const animation = resolveAnimatedTile(map, data);
	getAnimatedTiles(map).splice(getAnimatedTiles(map).indexOf(animation), 1);
	refresh(options, map);
	return { deleted: true, id: animation.id };
}

/** Returns the generated static 2D collider nodes for a Sprite Map. */
export function getTileColliderGenerator(scene: Scene, data: any): any {
	const map = resolveSpriteMap(scene, data);
	return { map: toNodeSummary(map), generator: structuredClone(getTileColliderGeneratorConfiguration(map)) };
}

/** Removes generated static 2D bodies and their helper transform nodes. */
export function clearTileColliderGenerator(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator) return { cleared: false, removedCount: 0 };
	for (const nodeId of generator.nodeIds) {
		const node = scene.getNodeById(nodeId) as TransformNode | null;
		if (node) node.dispose();
		try {
			removePhysics2DBody(scene, { nodeId }, options);
		} catch {
			// The generated node may have been manually removed already.
		}
	}
	delete map.metadata.babylonEditorTileColliderGenerator;
	options.editor.layout.inspector.forceUpdate();
	return { cleared: true, removedCount: generator.nodeIds.length };
}

/** Generates static box colliders from matching painted Sprite Map cells, including repeated cells. */
export function generateTileColliders(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	if (!map.spriteMap) throw new Error("Assign an atlas JSON before generating tile colliders.");
	clearTileColliderGenerator(scene, data, options);
	const tileIndexes = data.tileIndexes === undefined ? undefined : [...new Set<number>((data.tileIndexes as unknown[]).map((value) => Number(value)))];
	if (tileIndexes?.some((index) => !Number.isInteger(index) || index < 0)) throw new Error("tileIndexes must be non-negative integer atlas indexes.");
	const layer = data.layer;
	if (layer !== undefined && (!Number.isInteger(layer) || layer < 0)) throw new Error("layer must be a non-negative integer.");
	const sourceTiles = map.tiles.filter((tile) => (layer === undefined || tile.layer === layer) && (!tileIndexes || tileIndexes.includes(tile.tile)));
	const merge = data.merge ?? true;
	const cells: { x: number; y: number; layer: number; tileId: string }[] = [];
	for (const tile of sourceTiles)
		for (let repeatX = 0; repeatX <= tile.repeatCount.x; repeatX++)
			for (let repeatY = 0; repeatY <= tile.repeatCount.y; repeatY++)
				cells.push({
					x: tile.position.x + repeatX * (tile.repeatOffset.x + 1),
					y: tile.position.y + repeatY * (tile.repeatOffset.y + 1),
					layer: tile.layer,
					tileId: tile.id,
				});
	const runs: { x: number; y: number; layer: number; width: number; height: number; tileIds: string[] }[] = [];
	if (merge) {
		const byLayer = new Map<number, typeof cells>();
		for (const cell of cells) byLayer.set(cell.layer, [...(byLayer.get(cell.layer) ?? []), cell]);
		for (const [tileLayer, layerCells] of [...byLayer.entries()].sort(([first], [second]) => first - second)) {
			const unique = new Map(layerCells.map((cell) => [`${cell.x},${cell.y}`, cell]));
			const remaining = new Map([...unique.entries()].sort(([first], [second]) => first.localeCompare(second, undefined, { numeric: true })));
			while (remaining.size) {
				const cell = [...remaining.values()].sort((first, second) => first.y - second.y || first.x - second.x)[0];
				let width = 1;
				while (remaining.has(`${cell.x + width},${cell.y}`)) width++;
				let height = 1;
				while ([...Array(width).keys()].every((offset) => remaining.has(`${cell.x + offset},${cell.y + height}`))) height++;
				const tileIds: string[] = [];
				for (let y = 0; y < height; y++)
					for (let x = 0; x < width; x++) {
						const key = `${cell.x + x},${cell.y + y}`;
						tileIds.push(remaining.get(key)!.tileId);
						remaining.delete(key);
					}
				runs.push({ x: cell.x, y: cell.y, layer: tileLayer, width, height, tileIds });
			}
		}
	} else for (const cell of cells) runs.push({ ...cell, width: 1, height: 1, tileIds: [cell.tileId] });
	const nodeIds: string[] = [];
	for (const run of runs) {
		const position = getTileColliderPosition(map, run.x + (run.width - 1) / 2, run.y + (run.height - 1) / 2);
		const node = new TransformNode(`${map.name} Tile Collider ${run.x},${run.y}`, scene);
		node.position.set(position.x, position.y, map.position.z);
		node.metadata = { babylonEditorTileCollider: { mapNodeId: map.id, tileIds: run.tileIds } };
		setPhysics2DBody(
			scene,
			{
				nodeId: node.id,
				bodyType: "static",
				collider: { shape: "box", size: [position.width * run.width, position.height * run.height] },
				isTrigger: data.isTrigger ?? false,
				friction: data.friction,
				restitution: data.restitution,
			},
			options
		);
		nodeIds.push(node.id);
	}
	const generator: ITileColliderGenerator = {
		id: Tools.RandomId(),
		nodeIds,
		tileIndexes,
		layer,
		merge,
		isTrigger: data.isTrigger ?? false,
		friction: data.friction,
		restitution: data.restitution,
	};
	map.metadata ??= {};
	map.metadata.babylonEditorTileColliderGenerator = generator;
	refresh(options, map);
	return { generator: structuredClone(generator), colliderCount: nodeIds.length };
}

/** Rebuilds generated Sprite Map colliders from their persisted filter and physics settings after tiles change. */
export function refreshTileColliders(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator) throw new Error(`Sprite Map "${map.name}" has no generated tile colliders to refresh.`);
	const result = generateTileColliders(
		scene,
		{
			mapNodeId: map.id,
			tileIndexes: generator.tileIndexes,
			layer: generator.layer,
			merge: generator.merge,
			isTrigger: generator.isTrigger,
			friction: generator.friction,
			restitution: generator.restitution,
		},
		options
	);
	return { ...result, refreshed: true };
}

export async function setSpriteMap(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveSpriteMap(scene, data);
	if (data.name !== undefined) node.name = data.name;
	if (data.atlasJsonPath !== undefined) await node.buildFromAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	if (data.options && node.spriteMap) {
		const current = node.spriteMap.options;
		node.updateFromOptions({
			layerCount: data.options.layerCount ?? current.layerCount,
			stageSize: data.options.stageSize ? Vector2.FromArray(data.options.stageSize) : current.stageSize,
			outputSize: data.options.outputSize ? Vector2.FromArray(data.options.outputSize) : current.outputSize,
			colorMultiply: data.options.colorMultiply ? Vector3.FromArray(data.options.colorMultiply) : current.colorMultiply,
		});
	}
	refresh(options, node);
	return describeSpriteMap(node);
}

export function setSpriteMapTiles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteMap(scene, data);
	if (!node.spriteMap) throw new Error("Assign an atlas JSON before editing Sprite Map tiles.");
	if (data.mode === "replace") node.tiles = data.tiles ?? [];
	else if (data.mode === "add") node.tiles.push(...(data.tiles ?? []).map((tile: any) => ({ id: Tools.RandomId(), ...tile })));
	else if (data.mode === "remove") node.tiles = node.tiles.filter((tile) => !(data.tileIds ?? []).includes(tile.id));
	else throw new Error("Tile mode must be replace, add, or remove.");
	node.updateFromOptions(node.spriteMap.options);
	applyRuleTiles(node);
	refresh(options, node);
	return describeSpriteMap(node);
}
