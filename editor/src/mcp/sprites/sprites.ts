import { basename, dirname, extname, join, relative } from "path/posix";
import { ensureDir, pathExists, writeJSON } from "fs-extra";

import sharp from "sharp";

import { Color4, Scene, Sprite, Tools, TransformNode, Vector2, Vector3 } from "babylonjs";
import {
	configureAdvancedSpriteMap,
	executeGridBrush,
	generateTilemapColliderGeometry,
	getSpriteMapTileGridConfiguration,
	IGridBrushCell,
	normalizeTilemapColliderSettings,
	normalizeTileGridConfiguration,
	normalizeTileTransform,
	ISpriteMapTile,
	ITileTransform,
	ITilemapColliderCell,
	ITilemapColliderGeometry,
	ITilemapColliderSettings,
	listGridBrushTypes as listRegisteredGridBrushTypes,
	TileGridLayout,
	tileGridLocalPointToCell,
	transformGridBrushCells,
} from "babylonjs-editor-tools";

import { addSpriteManager, addSpriteMapNode } from "../../project/add/sprite";
import { projectConfiguration } from "../../project/configuration";
import { SpriteManagerNode } from "../../editor/nodes/sprite-manager";
import { SpriteMapNode } from "../../editor/nodes/sprite-map";
import { isSpriteManagerNode, isSpriteMapNode } from "../../tools/guards/sprites";

import { IMCPActionOptions } from "../action";
import { listPhysics2D, removePhysics2DBody, setPhysics2DBody } from "../physics2d/physics2d";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

type IAnimatedTile = { id: string; name: string; tileIds: string[]; frames: number[]; frameDuration: number; loop: boolean; enabled: boolean };
type ITileColliderGeneratorEntry = { key: string; nodeId: string; fingerprint: string };
type ITileColliderGenerator = ITilemapColliderSettings & {
	id: string;
	revision: number;
	geometryRevision: number;
	nodeIds: string[];
	entries: ITileColliderGeneratorEntry[];
	sourceMapRevision: number;
	sourceCellSignatures: string[];
	tileIndexes?: number[];
	layer?: number;
	merge: boolean;
	lastBuild: {
		mode: "full" | "incremental";
		changedCellCount: number;
		reusedColliderCount: number;
		createdColliderCount: number;
		removedColliderCount: number;
		evidence: ITilemapColliderGeometry["evidence"];
	};
};

export interface ITileColliderGeneratorSnapshot {
	mapNodeId: string;
	generator: ITileColliderGenerator | null;
}
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
	while (result < value) {
		result *= 2;
	}
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

export interface ITilePaletteCell {
	position: [number, number];
	tileIndex: number;
	transform: ITileTransform;
}

export interface ITilePalette {
	model: "unity-tile-palette-v2";
	version: 2;
	revision: number;
	id: string;
	name: string;
	mapNodeId: string;
	layout: TileGridLayout;
	tileIndexes: number[];
	activeTileIndex: number;
	cells: ITilePaletteCell[];
	brush: { type: string; dataVersion: number; data: Record<string, unknown>; transform: ITileTransform };
}

export type ITilePaintViewportMode = "paint" | "erase" | "fill" | "pick" | "select";
export type ITilePaintViewportTarget = "map" | "palette";

export interface ITilePaintViewportState {
	model: "unity-tile-paint-viewport-v2";
	version: 2;
	revision: number;
	enabled: boolean;
	mapNodeId: string | null;
	paletteId: string | null;
	mode: ITilePaintViewportMode;
	target: ITilePaintViewportTarget;
	layer: number;
	brushSize: [number, number];
	selection: { target: ITilePaintViewportTarget; layer: number; cells: ITilePaletteCell[] } | null;
	stamp: ITilePaletteCell[];
	lastStroke: {
		id: string;
		mode: "paint" | "erase";
		layer: number;
		tileIndex: number | null;
		anchors: [number, number][];
		affectedCells: [number, number][];
		changedTiles: number;
		ruleChangedTiles: number;
	} | null;
}

export interface ITilePaintViewportSnapshot {
	mapNodeId: string;
	tiles: ISpriteMapTile[];
	paletteId?: string;
	palette?: ITilePalette;
}

const tilePaintViewportStates = new WeakMap<Scene, ITilePaintViewportState>();

function createTilePaintViewportState(): ITilePaintViewportState {
	return {
		model: "unity-tile-paint-viewport-v2",
		version: 2,
		revision: 0,
		enabled: false,
		mapNodeId: null,
		paletteId: null,
		mode: "paint",
		target: "map",
		layer: 0,
		brushSize: [1, 1],
		selection: null,
		stamp: [],
		lastStroke: null,
	};
}

function getTilePaintViewportState(scene: Scene): ITilePaintViewportState {
	let state = tilePaintViewportStates.get(scene);
	if (!state) {
		state = createTilePaintViewportState();
		tilePaintViewportStates.set(scene, state);
	}
	return state;
}

/** Returns the live transient tool state without cloning large stroke evidence. Editor viewport use only. */
export function getTilePaintViewportEditorState(scene: Scene): Readonly<ITilePaintViewportState> {
	return getTilePaintViewportState(scene);
}

function getTileMapRevision(node: SpriteMapNode): number {
	return node.metadata?.babylonEditorTileMapRevision ?? 0;
}

function incrementTileMapRevision(node: SpriteMapNode): number {
	node.metadata ??= {};
	return (node.metadata.babylonEditorTileMapRevision = getTileMapRevision(node) + 1);
}

function getTilePalettes(scene: Scene): ITilePalette[] {
	scene.metadata ??= {};
	const palettes = (scene.metadata.babylonEditorTilePalettes ??= []);
	for (let index = 0; index < palettes.length; index++) {
		palettes[index] = normalizeTilePalette(palettes[index]);
	}
	return palettes;
}

function normalizeBrushData(value: unknown, path = "brush.data", depth = 0, state = { entries: 0 }): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		if (value === undefined) {
			return {};
		}
		throw new Error(`${path} must be a JSON object.`);
	}
	if (depth > 8) {
		throw new Error(`${path} exceeds the maximum nesting depth of 8.`);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		state.entries++;
		if (state.entries > 512) {
			throw new Error("brush.data may contain at most 512 nested entries.");
		}
		if (typeof entry === "string") {
			if (entry.length > 4096) {
				throw new Error(`${path}.${key} exceeds 4,096 characters.`);
			}
			result[key] = entry;
		} else if (typeof entry === "number" || typeof entry === "boolean" || entry === null) {
			if (typeof entry === "number" && !Number.isFinite(entry)) {
				throw new Error(`${path}.${key} must be finite.`);
			}
			result[key] = entry;
		} else if (Array.isArray(entry)) {
			if (entry.length > 256) {
				throw new Error(`${path}.${key} may contain at most 256 entries.`);
			}
			result[key] = entry.map((item, itemIndex) => {
				if (item && typeof item === "object") {
					return normalizeBrushData({ value: item }, `${path}.${key}[${itemIndex}]`, depth + 1, state).value;
				}
				if (!["string", "number", "boolean"].includes(typeof item) && item !== null) {
					throw new Error(`${path}.${key}[${itemIndex}] is not JSON-safe.`);
				}
				return item;
			});
		} else if (typeof entry === "object") {
			result[key] = normalizeBrushData(entry, `${path}.${key}`, depth + 1, state);
		} else {
			throw new Error(`${path}.${key} is not JSON-safe.`);
		}
	}
	return result;
}

function normalizePaletteCells(value: unknown, tileIndexes: number[]): ITilePaletteCell[] {
	if (!Array.isArray(value)) {
		return tileIndexes.map((tileIndex, index) => ({ position: [index, 0], tileIndex, transform: normalizeTileTransform(null) }));
	}
	if (value.length > 4096) {
		throw new Error("A Tile Palette may contain at most 4,096 authored cells.");
	}
	const occupied = new Set<string>();
	return value.map((entry: any, index) => {
		const position = entry?.position;
		if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isInteger)) {
			throw new Error(`Tile Palette cell ${index} needs a two-integer position.`);
		}
		if (!Number.isInteger(entry.tileIndex) || entry.tileIndex < 0) {
			throw new Error(`Tile Palette cell ${index} needs a non-negative tileIndex.`);
		}
		const key = `${position[0]}:${position[1]}`;
		if (occupied.has(key)) {
			throw new Error(`Tile Palette contains duplicate cell [${position.join(", ")}].`);
		}
		occupied.add(key);
		return { position: [position[0], position[1]], tileIndex: entry.tileIndex, transform: normalizeTileTransform(entry.transform) };
	});
}

function normalizeTilePalette(value: any): ITilePalette {
	const tileIndexes = [...new Set<number>(((value?.tileIndexes ?? []) as unknown[]).map(Number).filter((entry) => Number.isInteger(entry) && entry >= 0))];
	const cells = normalizePaletteCells(value?.cells, tileIndexes);
	for (const cell of cells) {
		if (!tileIndexes.includes(cell.tileIndex)) {
			tileIndexes.push(cell.tileIndex);
		}
	}
	const activeTileIndex = Number.isInteger(value?.activeTileIndex) && value.activeTileIndex >= 0 ? value.activeTileIndex : (tileIndexes[0] ?? 0);
	if (!tileIndexes.includes(activeTileIndex)) {
		tileIndexes.push(activeTileIndex);
	}
	const grid = normalizeTileGridConfiguration({ layout: value?.layout });
	return {
		model: "unity-tile-palette-v2",
		version: 2,
		revision: Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
		id: String(value?.id ?? Tools.RandomId()),
		name: String(value?.name ?? "Palette"),
		mapNodeId: String(value?.mapNodeId ?? ""),
		layout: grid.layout,
		tileIndexes,
		activeTileIndex,
		cells,
		brush: {
			type: typeof value?.brush?.type === "string" && value.brush.type.trim() ? value.brush.type : "builtin.rectangle",
			dataVersion: Number.isInteger(value?.brush?.dataVersion) && value.brush.dataVersion > 0 ? value.brush.dataVersion : 1,
			data: normalizeBrushData(value?.brush?.data),
			transform: normalizeTileTransform(value?.brush?.transform),
		},
	};
}

function resolveTilePalette(scene: Scene, data: { paletteId?: string; paletteName?: string }): ITilePalette {
	const palette = getTilePalettes(scene).find((candidate) => candidate.id === data.paletteId || candidate.name === data.paletteName);
	if (!palette) {
		throw new Error("Tile palette not found.");
	}
	return palette;
}

function getAnimatedTiles(node: SpriteMapNode): IAnimatedTile[] {
	node.metadata ??= {};
	return (node.metadata.babylonEditorAnimatedTiles ??= []);
}

function getTileColliderGeneratorConfiguration(node: SpriteMapNode): ITileColliderGenerator | null {
	const candidate = node.metadata?.babylonEditorTileColliderGenerator;
	if (!candidate) {
		return null;
	}
	const settings = normalizeTilemapColliderSettings({
		...candidate,
		compositeOperation: candidate.compositeOperation ?? (candidate.merge === false ? "none" : "merge"),
		friction: candidate.friction ?? 0,
		restitution: candidate.restitution ?? 0,
	});
	const nodeIds = Array.isArray(candidate.nodeIds) ? candidate.nodeIds.map(String) : [];
	return {
		...settings,
		id: String(candidate.id ?? Tools.RandomId()),
		revision: Number.isSafeInteger(candidate.revision) && candidate.revision >= 1 ? candidate.revision : 1,
		geometryRevision: Number.isSafeInteger(candidate.geometryRevision) && candidate.geometryRevision >= 1 ? candidate.geometryRevision : nodeIds.length ? 1 : 0,
		nodeIds,
		entries: Array.isArray(candidate.entries)
			? candidate.entries.map((entry: any) => ({ key: String(entry.key), nodeId: String(entry.nodeId), fingerprint: String(entry.fingerprint) }))
			: nodeIds.map((nodeId, index) => ({ key: `legacy:${index}`, nodeId, fingerprint: "" })),
		sourceMapRevision: Number.isSafeInteger(candidate.sourceMapRevision) && candidate.sourceMapRevision >= 0 ? candidate.sourceMapRevision : 0,
		sourceCellSignatures: Array.isArray(candidate.sourceCellSignatures) ? candidate.sourceCellSignatures.map(String) : [],
		tileIndexes: Array.isArray(candidate.tileIndexes) ? candidate.tileIndexes.map(Number) : undefined,
		layer: Number.isInteger(candidate.layer) ? candidate.layer : undefined,
		merge: settings.compositeOperation !== "none",
		lastBuild:
			candidate.lastBuild ??
			({
				mode: "full",
				changedCellCount: 0,
				reusedColliderCount: 0,
				createdColliderCount: nodeIds.length,
				removedColliderCount: 0,
				evidence: {
					inputCellCount: 0,
					filteredCellCount: 0,
					gridCellCount: 0,
					spriteCellCount: 0,
					outputColliderCount: nodeIds.length,
					boxCount: nodeIds.length,
					polygonCount: 0,
					edgeCount: 0,
					convexPartCount: nodeIds.length,
					compositeOperation: settings.compositeOperation,
					geometryType: settings.geometryType,
					triangulation: settings.useDelaunayMesh ? "bounded-delaunay-edge-flips-v1" : "convex-parts",
					delaunayFlipCount: 0,
				},
			} satisfies ITileColliderGenerator["lastBuild"]),
	};
}

function validateTileColliderFilters(data: any): { tileIndexes?: number[]; layer?: number } {
	const tileIndexes = data.tileIndexes === undefined || data.tileIndexes === null ? undefined : [...new Set<number>((data.tileIndexes as unknown[]).map(Number))];
	if (tileIndexes?.some((index) => !Number.isInteger(index) || index < 0 || index > 1_000_000)) {
		throw new Error("tileIndexes must be non-negative integer atlas indexes no greater than 1,000,000.");
	}
	const layer = data.layer === undefined || data.layer === null ? undefined : Number(data.layer);
	if (layer !== undefined && (!Number.isInteger(layer) || layer < 0 || layer > 255)) {
		throw new Error("layer must be a non-negative integer no greater than 255.");
	}
	return { tileIndexes, layer };
}

function collectTileColliderCells(map: SpriteMapNode, generator: Pick<ITileColliderGenerator, "tileIndexes" | "layer">): ITilemapColliderCell[] {
	const cells: ITilemapColliderCell[] = [];
	for (const tile of map.tiles) {
		if ((generator.layer !== undefined && tile.layer !== generator.layer) || (generator.tileIndexes && !generator.tileIndexes.includes(tile.tile))) {
			continue;
		}
		for (let repeatX = 0; repeatX <= tile.repeatCount.x; repeatX++) {
			for (let repeatY = 0; repeatY <= tile.repeatCount.y; repeatY++) {
				cells.push({
					x: tile.position.x + repeatX * (tile.repeatOffset.x + 1),
					y: tile.position.y + repeatY * (tile.repeatOffset.y + 1),
					layer: tile.layer,
					tileIndex: tile.tile,
					tileId: tile.id,
				});
			}
		}
	}
	return cells;
}

function tileColliderCellSignatures(cells: ITilemapColliderCell[]): string[] {
	const unique = new Map(cells.map((cell) => [JSON.stringify([cell.layer, cell.x, cell.y]), cell]));
	return [...unique.values()].map((cell) => JSON.stringify([cell.layer, cell.x, cell.y, cell.tileIndex, cell.tileId])).sort();
}

function changedTileColliderCellCount(previous: string[], next: string[]): number {
	const toMap = (values: string[]): Map<string, string> =>
		new Map(
			values.map((value) => {
				try {
					const [layer, x, y] = JSON.parse(value);
					return [JSON.stringify([layer, x, y]), value];
				} catch {
					return [value, value];
				}
			})
		);
	const previousMap = toMap(previous);
	const nextMap = toMap(next);
	const keys = new Set([...previousMap.keys(), ...nextMap.keys()]);
	return [...keys].reduce((count, key) => count + Number(previousMap.get(key) !== nextMap.get(key)), 0);
}

function resolveAnimatedTile(node: SpriteMapNode, data: { id?: string; name?: string }): IAnimatedTile {
	const animation = getAnimatedTiles(node).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!animation) {
		throw new Error("Animated tile not found.");
	}
	return animation;
}

/** Advances one Sprite Map animation by elapsed milliseconds. Exported for deterministic editor tests. */
export function advanceSpriteMapAnimation(node: SpriteMapNode, animation: IAnimatedTile, elapsedMilliseconds: number, state: { elapsed: number; frame: number }): boolean {
	if (!animation.enabled || !node.spriteMap || !animation.frames.length) {
		return false;
	}
	state.elapsed += elapsedMilliseconds;
	if (state.elapsed < animation.frameDuration) {
		return false;
	}
	const frameSteps = Math.floor(state.elapsed / animation.frameDuration);
	state.elapsed %= animation.frameDuration;
	const nextFrame = state.frame + frameSteps;
	state.frame = animation.loop ? nextFrame % animation.frames.length : Math.min(animation.frames.length - 1, nextFrame);
	const frame = animation.frames[state.frame];
	for (const tileId of animation.tileIds) {
		const tile = node.tiles.find((candidate) => candidate.id === tileId);
		if (tile) {
			tile.tile = frame;
		}
	}
	node.updateFromOptions(node.spriteMap.options);
	return true;
}

/** Starts or reuses the scene-level preview updater for persisted animated tiles. */
export function configureSpriteMapAnimations(scene: Scene): void {
	if (animatedTileStates.has(scene)) {
		return;
	}
	animatedTileStates.set(scene, new Map());
	scene.onBeforeRenderObservable.add(() => {
		const states = animatedTileStates.get(scene);
		if (!states) {
			return;
		}
		for (const node of scene.transformNodes.filter(isSpriteMapNode)) {
			for (const animation of getAnimatedTiles(node)) {
				const state = states.get(animation.id) ?? { elapsed: 0, frame: 0 };
				states.set(animation.id, state);
				advanceSpriteMapAnimation(node, animation, scene.getEngine().getDeltaTime(), state);
			}
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
	if (data.name) {
		node.name = data.name;
	}
	if (data.tileGrid) {
		node.metadata ??= {};
		node.metadata.babylonEditorTileGrid = normalizeTileGridConfiguration(data.tileGrid);
	}
	if (data.atlasJsonPath) {
		node.buildFromAtlasJsonAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	} else if (data.imagePath) {
		node.buildFromImageAbsolutePath(resolveProjectPath(data.imagePath));
	}
	refresh(options, node);
	return { ...toNodeSummary(node), hasSpritesheet: Boolean(node.spritesheet) };
}

export function setSpriteManager(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteManager(scene, data);
	if (data.name !== undefined) {
		node.name = data.name;
	}
	if (data.atlasJsonPath !== undefined) {
		node.buildFromAtlasJsonAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	} else if (data.imagePath !== undefined) {
		node.buildFromImageAbsolutePath(resolveProjectPath(data.imagePath));
	}

	const manager = node.spriteManager;
	if (!manager && Object.keys(data.properties ?? {}).length) {
		throw new Error("Assign an image or atlas before configuring a sprite manager.");
	}
	if (manager) {
		Object.assign(manager, data.properties ?? {});
	}
	refresh(options, node);
	return listSpriteManagers(scene).managers.find((candidate: any) => candidate.id === node.id);
}

/** Packs project PNG files into a deterministic power-of-two TexturePacker-compatible atlas plus JSON descriptor. */
export async function packSpriteAtlas(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!Array.isArray(data.sourcePaths) || !data.sourcePaths.length) {
		throw new Error("sourcePaths must contain at least one PNG asset path.");
	}
	const padding = data.padding ?? 2;
	const maxSize = data.maxSize ?? 2048;
	if (!Number.isInteger(padding) || padding < 0 || padding > 64) {
		throw new Error("padding must be an integer between 0 and 64.");
	}
	if (!Number.isInteger(maxSize) || maxSize < 64 || maxSize > 8192 || (maxSize & (maxSize - 1)) !== 0) {
		throw new Error("maxSize must be a power of two between 64 and 8192.");
	}
	if (extname(data.outputPath).toLowerCase() !== ".png") {
		throw new Error("outputPath must be a project-relative .png atlas path.");
	}

	const directory = dirname(projectConfiguration.path!);
	const sourcePaths = [...new Set<string>(data.sourcePaths)].sort();
	const trimTransparent = data.trimTransparent === true;
	const allowRotation = data.allowRotation === true;
	const sources: any[] = await Promise.all(
		sourcePaths.map(async (path) => {
			if (extname(path).toLowerCase() !== ".png") {
				throw new Error(`Atlas source "${path}" must be a PNG file.`);
			}
			const absolutePath = resolveProjectPath(path);
			if (!(await pathExists(absolutePath))) {
				throw new Error(`Atlas source "${path}" does not exist.`);
			}
			const metadata = await sharp(absolutePath).metadata();
			if (!metadata.width || !metadata.height) {
				throw new Error(`Could not read dimensions for atlas source "${path}".`);
			}
			if (!trimTransparent) {
				return {
					path: relative(directory, absolutePath),
					absolutePath,
					width: metadata.width,
					height: metadata.height,
					sourceWidth: metadata.width,
					sourceHeight: metadata.height,
					trimmed: false,
				};
			}
			const decoded = await sharp(absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			let left = metadata.width;
			let top = metadata.height;
			let right = -1;
			let bottom = -1;
			for (let y = 0; y < metadata.height; y++) {
				for (let x = 0; x < metadata.width; x++) {
					if (decoded.data[(y * metadata.width + x) * 4 + 3] === 0) {
						continue;
					}
					left = Math.min(left, x);
					top = Math.min(top, y);
					right = Math.max(right, x);
					bottom = Math.max(bottom, y);
				}
			}
			if (right < left || bottom < top) {
				throw new Error(`Atlas source "${path}" is fully transparent and cannot be trimmed.`);
			}
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
	if (new Set(names).size !== names.length) {
		throw new Error("Atlas source filenames must be unique; rename duplicate PNG filenames before packing.");
	}

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
	if (!packed) {
		throw new Error(`Sources do not fit in a ${maxSize}×${maxSize} atlas. Increase maxSize or split the atlas.`);
	}

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
	if (!Array.isArray(data.frames) || !data.frames.length) {
		throw new Error("frames must contain at least one named rectangle.");
	}
	if (extname(data.outputPath).toLowerCase() !== ".json") {
		throw new Error("outputPath must be a project-relative .json atlas descriptor path.");
	}
	const sourcePath = resolveProjectPath(data.sourcePath);
	const outputPath = resolveProjectPath(data.outputPath);
	if (!(await pathExists(sourcePath))) {
		throw new Error(`Sprite sheet source "${data.sourcePath}" does not exist.`);
	}
	const metadata = await sharp(sourcePath).metadata();
	if (!metadata.width || !metadata.height) {
		throw new Error(`Could not read dimensions for sprite sheet source "${data.sourcePath}".`);
	}
	const names = data.frames.map((frame: any) => frame.name);
	if (new Set(names).size !== names.length) {
		throw new Error("Sprite frame names must be unique.");
	}
	for (const frame of data.frames) {
		if (!frame.name?.trim()) {
			throw new Error("Each sprite frame requires a name.");
		}
		for (const key of ["x", "y", "width", "height"]) {
			if (!Number.isInteger(frame[key])) {
				throw new Error(`Sprite frame "${frame.name}" ${key} must be an integer.`);
			}
		}
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
	if (!node.spriteManager) {
		throw new Error("Assign an image or atlas to the sprite manager before creating sprites.");
	}
	const sprite = new Sprite(data.name ?? `Sprite ${node.spriteManager.sprites.length + 1}`, node.spriteManager);
	sprite.metadata = { spriteAnimations: [] };
	if (data.position) {
		sprite.position.copyFrom(toVector3(data.position));
	}
	if (data.width !== undefined) {
		sprite.width = data.width;
	}
	if (data.height !== undefined) {
		sprite.height = data.height;
	}
	if (data.cellIndex !== undefined) {
		sprite.cellIndex = data.cellIndex;
	}
	if (data.cellRef !== undefined) {
		sprite.cellRef = data.cellRef;
	}
	refresh(options, node);
	return describeSprite(sprite);
}

export function setSprite(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteManager(scene, data);
	const sprite = node.spriteManager?.sprites.find((candidate) => candidate.uniqueId.toString() === data.spriteId || candidate.name === data.spriteName);
	if (!sprite) {
		throw new Error("Sprite not found. Provide spriteId (preferred) or spriteName.");
	}
	for (const property of ["name", "width", "height", "angle", "cellIndex", "cellRef", "invertU", "invertV", "isVisible"]) {
		if (data[property] !== undefined) {
			(sprite as any)[property] = data[property];
		}
	}
	if (data.position) {
		sprite.position.copyFrom(toVector3(data.position));
	}
	if (data.color) {
		sprite.color = new Color4(...data.color);
	}
	if (data.animations !== undefined) {
		sprite.metadata = { ...(sprite.metadata ?? {}), spriteAnimations: data.animations };
	}
	refresh(options, node);
	return describeSprite(sprite);
}

export function playSpriteAnimation(scene: Scene, data: any): any {
	const node = resolveSpriteManager(scene, data);
	const sprite = node.spriteManager?.sprites.find((candidate) => candidate.uniqueId.toString() === data.spriteId || candidate.name === data.spriteName);
	if (!sprite) {
		throw new Error("Sprite not found.");
	}
	if (data.stop) {
		sprite.stopAnimation();
	} else {
		sprite.playAnimation(data.from, data.to, data.loop ?? true, data.delay ?? 100);
	}
	return { ...describeSprite(sprite), animationStarted: sprite.animationStarted };
}

export async function createSpriteMap(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const parent = data.parentId || data.parentName ? resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) : undefined;
	const node = addSpriteMapNode(options.editor, parent);
	if (data.name) {
		node.name = data.name;
	}
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
		tileRevision: getTileMapRevision(node),
		tileGrid: getSpriteMapTileGridConfiguration(node),
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
	for (const tile of node.tiles) {
		lookup.set(`${tile.layer}:${tile.position.x}:${tile.position.y}`, tile);
	}
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
	if (!Array.isArray(data.rules)) {
		throw new Error("Rule tiles must be an array.");
	}
	for (const rule of data.rules) {
		if (rule.sourceTile === undefined || rule.sourceTile === null || ((rule.outputTile === undefined || rule.outputTile === null) && !rule.variants?.length)) {
			throw new Error("Each rule tile needs sourceTile and outputTile or variants.");
		}
		for (const variant of rule.variants ?? []) {
			if (variant.tile === undefined || variant.tile === null || !Number.isFinite(variant.weight) || variant.weight <= 0) {
				throw new Error("Rule-tile variants need a tile and positive finite weight.");
			}
		}
		for (const direction of Object.keys(rule.neighbors ?? {})) {
			if (!["north", "south", "east", "west", "northEast", "northWest", "southEast", "southWest"].includes(direction)) {
				throw new Error(`Unsupported rule-tile neighbor direction: ${direction}`);
			}
		}
		for (const value of Object.values(rule.neighbors ?? {})) {
			if (!["same", "different", "any"].includes(value as string)) {
				throw new Error("Rule-tile neighbor values must be same, different, or any.");
			}
		}
	}
	node.metadata ??= {};
	node.metadata.babylonEditorRuleTiles = structuredClone(data.rules);
	const result = applyRuleTiles(node);
	incrementTileMapRevision(node);
	synchronizeTileColliderGenerator(scene, node, options);
	refresh(options, node);
	return { ...describeSpriteMap(node), ...result };
}

/** Resolves persisted rule tiles after external tile edits. */
export function resolveSpriteMapRuleTiles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteMap(scene, data);
	const result = applyRuleTiles(node);
	if (result.changedTiles) {
		incrementTileMapRevision(node);
		synchronizeTileColliderGenerator(scene, node, options);
	}
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

/** Reads one versioned palette including its exact revision, editable cells, layout, and selected GridBrush. */
export function getTilePalette(scene: Scene, data: any): any {
	return structuredClone(resolveTilePalette(scene, data));
}

/** Lists built-in and project-script GridBrush registrations without exposing their callbacks. */
export function listGridBrushTypes(): any {
	return { brushes: listRegisteredGridBrushTypes() };
}

/** Reads a Sprite Map's exact-leased logical grid layout used by rendering, picking, painting, and colliders. */
export function getTileGridConfiguration(scene: Scene, data: any): any {
	const map = resolveSpriteMap(scene, data);
	return { map: toNodeSummary(map), grid: getSpriteMapTileGridConfiguration(map) };
}

/** Reprojects one Sprite Map to a rectangular, isometric, or hexagonal grid under an exact configuration lease. */
export function setTileGridConfiguration(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const current = getSpriteMapTileGridConfiguration(map);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== current.revision) {
		throw new Error(`Tile grid revision is ${current.revision}; reread get_tile_grid_configuration and retry with that expectedRevision.`);
	}
	const next = normalizeTileGridConfiguration({
		...current,
		revision: current.revision + 1,
		layout: data.layout ?? current.layout,
	});
	map.metadata ??= {};
	map.metadata.babylonEditorTileGrid = next;
	if (map.spriteMap) {
		configureAdvancedSpriteMap(map.spriteMap, next.layout);
		map.updateFromOptions(map.spriteMap.options);
	}
	const state = getTilePaintViewportState(scene);
	if (state.mapNodeId === map.id) {
		tilePaintViewportStates.set(scene, { ...structuredClone(state), revision: state.revision + 1, selection: null, stamp: [] });
	}
	refresh(options, map);
	return getTileGridConfiguration(scene, { mapNodeId: map.id });
}

function getTilePaintGrid(node: SpriteMapNode): { width: number; height: number; layerCount: number } {
	if (!node.spriteMap) {
		throw new Error("Assign an atlas JSON before configuring Tile Paint viewport tooling.");
	}
	const stageSize = node.spriteMap.options.stageSize;
	const layerCount = node.spriteMap.options.layerCount ?? 1;
	if (!stageSize || !Number.isInteger(stageSize.x) || !Number.isInteger(stageSize.y) || stageSize.x < 1 || stageSize.y < 1 || stageSize.x > 4096 || stageSize.y > 4096) {
		throw new Error("Sprite Map Stage Size must contain positive integer X/Y values no greater than 4096 before painting.");
	}
	if (!Number.isInteger(layerCount) || layerCount < 1 || layerCount > 8) {
		throw new Error("Sprite Map Layer Count must be an integer from 1 through 8 before painting.");
	}
	if (stageSize.x * stageSize.y * layerCount > 1_048_576) {
		throw new Error("Sprite Map paint grid exceeds 1,048,576 cells. Reduce Stage Size or Layer Count.");
	}
	return { width: stageSize.x, height: stageSize.y, layerCount };
}

function validateTilePaintBrush(brushSize: unknown): [number, number] {
	if (!Array.isArray(brushSize) || brushSize.length !== 2 || brushSize.some((value) => !Number.isInteger(value) || value < 1 || value > 32)) {
		throw new Error("brushSize must contain two integers from 1 through 32.");
	}
	return [brushSize[0], brushSize[1]];
}

function validateTilePaintAnchors(anchors: unknown): [number, number][] {
	if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > 256) {
		throw new Error("anchors must contain 1 through 256 grid coordinates.");
	}
	const normalized: [number, number][] = [];
	const unique = new Set<string>();
	for (const anchor of anchors) {
		if (!Array.isArray(anchor) || anchor.length !== 2 || anchor.some((value) => !Number.isInteger(value))) {
			throw new Error("Each tile-paint anchor must be a two-item integer grid coordinate.");
		}
		const key = `${anchor[0]}:${anchor[1]}`;
		if (!unique.has(key)) {
			unique.add(key);
			normalized.push([anchor[0], anchor[1]]);
		}
	}
	return normalized;
}

function resolveTilePaintTarget(scene: Scene, state: ITilePaintViewportState): { map: SpriteMapNode; palette: ITilePalette } {
	if (!state.mapNodeId || !state.paletteId) {
		throw new Error("Tile Paint viewport has no Sprite Map and palette target. Configure it with set_tile_paint_viewport first.");
	}
	const map = resolveSpriteMap(scene, { mapNodeId: state.mapNodeId });
	const palette = resolveTilePalette(scene, { paletteId: state.paletteId });
	if (palette.mapNodeId !== map.id) {
		throw new Error("The configured Tile Paint palette belongs to a different Sprite Map. Select a palette owned by the configured map.");
	}
	return { map, palette };
}

function refreshTilePaintViewport(options: IMCPActionOptions): void {
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.preview?.forceUpdate?.();
}

/** Converts a Sprite Map output-plane local point into its top-left-origin tile grid cell. */
export function spriteMapLocalPointToGrid(
	localX: number,
	localY: number,
	stageWidth: number,
	stageHeight: number,
	layout: TileGridLayout = "rectangular"
): [number, number] | null {
	return tileGridLocalPointToCell(localX, localY, stageWidth, stageHeight, layout);
}

/** Reads the transient Unity-style Tile Paint scene-view tool and exact tile-content revision. */
export function getTilePaintViewport(scene: Scene): any {
	const state = getTilePaintViewportState(scene);
	let map: SpriteMapNode | null = null;
	let palette: ITilePalette | null = null;
	let grid: ReturnType<typeof getTilePaintGrid> | null = null;
	if (state.mapNodeId) {
		const candidate = scene.getTransformNodeById(state.mapNodeId);
		if (candidate && isSpriteMapNode(candidate)) {
			map = candidate;
			try {
				grid = getTilePaintGrid(map);
			} catch {
				grid = null;
			}
		}
	}
	if (state.paletteId) {
		palette = getTilePalettes(scene).find((candidate) => candidate.id === state.paletteId) ?? null;
	}
	return {
		...structuredClone(state),
		map: map ? toNodeSummary(map) : null,
		palette: palette ? structuredClone(palette) : null,
		grid,
		mapRevision: map ? getTileMapRevision(map) : null,
	};
}

/** Configures or disables the transient scene-view Tile Paint tool under an exact state revision lease. */
export function setTilePaintViewport(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getTilePaintViewportState(scene);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== current.revision) {
		throw new Error(`Tile Paint viewport revision is ${current.revision}; reread get_tile_paint_viewport and retry with that expectedRevision.`);
	}
	const enabled = data.enabled ?? current.enabled;
	const next: ITilePaintViewportState = {
		...structuredClone(current),
		revision: current.revision + 1,
		enabled,
		mode: data.mode ?? current.mode,
		target: data.target ?? current.target,
		layer: data.layer ?? current.layer,
		brushSize: data.brushSize === undefined ? current.brushSize : validateTilePaintBrush(data.brushSize),
		mapNodeId: data.mapNodeId === undefined ? current.mapNodeId : data.mapNodeId,
		paletteId: data.paletteId === undefined ? current.paletteId : data.paletteId,
		selection: data.target !== undefined && data.target !== current.target ? null : current.selection,
		stamp: data.target !== undefined && data.target !== current.target ? [] : current.stamp,
	};
	if (!Number.isInteger(next.layer) || next.layer < 0) {
		throw new Error("Tile Paint layer must be a non-negative integer.");
	}
	let map: SpriteMapNode | undefined;
	if (enabled) {
		const target = resolveTilePaintTarget(scene, next);
		map = target.map;
		const grid = getTilePaintGrid(map);
		if (next.layer >= grid.layerCount) {
			throw new Error(`Tile Paint layer ${next.layer} is outside this Sprite Map's 0-${grid.layerCount - 1} layer range.`);
		}
	}
	tilePaintViewportStates.set(scene, next);
	refreshTilePaintViewport(options);
	return getTilePaintViewport(scene);
}

function applyTilePaintCells(operation: {
	map: SpriteMapNode;
	palette: ITilePalette;
	mode: "paint" | "erase";
	layer: number;
	tileIndex: number;
	anchors: [number, number][];
	brushSize: [number, number];
	stamp?: IGridBrushCell[];
}): { affectedCells: [number, number][]; changedTiles: number; ruleChangedTiles: number } {
	const { map, palette, mode, layer, tileIndex, anchors, brushSize } = operation;
	const grid = getTilePaintGrid(map);
	if (layer >= grid.layerCount) {
		throw new Error(`Tile Paint layer ${layer} is outside this Sprite Map's 0-${grid.layerCount - 1} layer range.`);
	}
	if (mode === "paint" && !palette.tileIndexes.includes(tileIndex)) {
		throw new Error("tileIndex must belong to the configured Tile Paint palette.");
	}
	const stamp =
		operation.stamp ??
		executeGridBrush("builtin.rectangle", {
			operation: mode,
			layout: getSpriteMapTileGridConfiguration(map).layout,
			anchor: [0, 0],
			brushSize,
			layer,
			activeTileIndex: tileIndex,
			data: {},
		});
	if (mode === "paint" && stamp.some((cell) => !palette.tileIndexes.includes(cell.tileIndex))) {
		throw new Error("Every GridBrush tileIndex must belong to the configured Tile Paint palette.");
	}
	const affected = new Map<string, { cell: [number, number]; tileIndex: number; transform: ITileTransform }>();
	for (const [anchorX, anchorY] of anchors) {
		for (const stampCell of stamp) {
			const cell: [number, number] = [anchorX + stampCell.offset[0], anchorY + stampCell.offset[1]];
			if (cell[0] < 0 || cell[1] < 0 || cell[0] >= grid.width || cell[1] >= grid.height) {
				throw new Error(`Tile Paint brush at [${anchorX}, ${anchorY}] must stay inside the ${grid.width}×${grid.height} Sprite Map stage.`);
			}
			affected.set(`${cell[0]}:${cell[1]}`, { cell, tileIndex: stampCell.tileIndex, transform: normalizeTileTransform(stampCell.transform) });
			if (affected.size > 1024) {
				throw new Error("One Tile Paint stroke may affect at most 1,024 unique cells. Reduce the path or brush size.");
			}
		}
	}
	const affectedEntries = [...affected.values()];
	const affectedCells = affectedEntries.map((entry) => entry.cell);
	const lookup = new Map<string, ISpriteMapTile>();
	for (const tile of map.tiles) {
		lookup.set(`${tile.layer}:${tile.position.x}:${tile.position.y}`, tile);
	}
	let changedTiles = 0;
	for (const {
		cell: [gridX, gridY],
		tileIndex: cellTileIndex,
		transform,
	} of affectedEntries) {
		const key = `${layer}:${gridX}:${gridY}`;
		const existing = lookup.get(key);
		if (mode === "erase") {
			if (existing) {
				map.tiles.splice(map.tiles.indexOf(existing), 1);
				lookup.delete(key);
				changedTiles++;
			}
		} else if (existing) {
			if (
				existing.tile !== cellTileIndex ||
				(existing as any).ruleSource !== cellTileIndex ||
				JSON.stringify(normalizeTileTransform(existing.transform)) !== JSON.stringify(transform)
			) {
				existing.tile = cellTileIndex;
				existing.transform = transform;
				(existing as any).ruleSource = cellTileIndex;
				changedTiles++;
			}
		} else {
			const tile = {
				id: Tools.RandomId(),
				name: `Palette ${cellTileIndex} [${gridX}, ${gridY}] L${layer}`,
				layer,
				position: { x: gridX, y: gridY },
				repeatCount: { x: 0, y: 0 },
				repeatOffset: { x: 0, y: 0 },
				tile: cellTileIndex,
				transform,
			} as ISpriteMapTile;
			map.tiles.push(tile);
			lookup.set(key, tile);
			changedTiles++;
		}
	}
	map.updateFromOptions(map.spriteMap!.options);
	const { changedTiles: ruleChangedTiles } = applyRuleTiles(map);
	return { affectedCells, changedTiles, ruleChangedTiles };
}

/** Applies a bounded multi-anchor Tile Paint stroke through the same backend used by the scene viewport. */
export function applyTilePaintViewportStroke(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = getTilePaintViewportState(scene);
	if (!state.enabled) {
		throw new Error("Tile Paint viewport is disabled. Enable and configure it with set_tile_paint_viewport first.");
	}
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== state.revision) {
		throw new Error(`Tile Paint viewport revision is ${state.revision}; reread get_tile_paint_viewport and retry with that expectedRevision.`);
	}
	const { map, palette } = resolveTilePaintTarget(scene, state);
	const mapRevision = getTileMapRevision(map);
	if (!Number.isInteger(data.expectedMapRevision) || data.expectedMapRevision !== mapRevision) {
		throw new Error(`Sprite Map tile revision is ${mapRevision}; reread get_tile_paint_viewport and retry with that expectedMapRevision.`);
	}
	const anchors = validateTilePaintAnchors(data.anchors ?? (data.position ? [data.position] : undefined));
	const brushSize = data.brushSize === undefined ? state.brushSize : validateTilePaintBrush(data.brushSize);
	const mode = data.mode ?? state.mode;
	if (mode !== "paint" && mode !== "erase") {
		throw new Error(`Tile Paint viewport mode "${mode}" uses apply_tile_palette_operation rather than a drag stroke.`);
	}
	const layer = data.layer ?? state.layer;
	const tileIndex = data.tileIndex ?? palette.activeTileIndex;
	if (!Number.isInteger(layer) || layer < 0) {
		throw new Error("Tile Paint stroke layer must be a non-negative integer.");
	}
	if (!Number.isInteger(tileIndex) || tileIndex < 0) {
		throw new Error("Tile Paint stroke tileIndex must be a non-negative integer.");
	}
	const before = structuredClone(map.tiles);
	try {
		const result = applyTilePaintCells({ map, palette, mode, layer, tileIndex, anchors, brushSize });
		if (result.changedTiles || result.ruleChangedTiles) {
			incrementTileMapRevision(map);
			synchronizeTileColliderGenerator(scene, map, options);
		}
		const next: ITilePaintViewportState = {
			...structuredClone(state),
			revision: state.revision + 1,
			lastStroke: {
				id: Tools.RandomId(),
				mode,
				layer,
				tileIndex: mode === "paint" ? tileIndex : null,
				anchors,
				affectedCells: result.affectedCells,
				changedTiles: result.changedTiles,
				ruleChangedTiles: result.ruleChangedTiles,
			},
		};
		tilePaintViewportStates.set(scene, next);
		refreshTilePaintViewport(options);
		return { ...getTilePaintViewport(scene), stroke: structuredClone(next.lastStroke) };
	} catch (error) {
		map.tiles = before;
		map.updateFromOptions(map.spriteMap!.options);
		throw error;
	}
}

function tileOperationNeighbors(layout: TileGridLayout, position: [number, number]): [number, number][] {
	const [x, y] = position;
	if (layout === "hexagonal-point-top") {
		const diagonal = Math.abs(y) % 2 === 0 ? -1 : 1;
		return [
			[x - 1, y],
			[x + 1, y],
			[x, y - 1],
			[x, y + 1],
			[x + diagonal, y - 1],
			[x + diagonal, y + 1],
		];
	}
	if (layout === "hexagonal-flat-top") {
		const diagonal = Math.abs(x) % 2 === 0 ? -1 : 1;
		return [
			[x - 1, y],
			[x + 1, y],
			[x, y - 1],
			[x, y + 1],
			[x - 1, y + diagonal],
			[x + 1, y + diagonal],
		];
	}
	return [
		[x - 1, y],
		[x + 1, y],
		[x, y - 1],
		[x, y + 1],
	];
}

function validateTileOperationPosition(value: unknown, name: string): [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isInteger)) {
		throw new Error(`${name} must be a two-integer grid coordinate.`);
	}
	return [value[0], value[1]];
}

function paletteCellLookup(cells: ITilePaletteCell[]): Map<string, ITilePaletteCell> {
	return new Map(cells.map((cell) => [`${cell.position[0]}:${cell.position[1]}`, cell]));
}

function mapCellLookup(map: SpriteMapNode, layer: number): Map<string, ISpriteMapTile> {
	return new Map(map.tiles.filter((tile) => tile.layer === layer).map((tile) => [`${tile.position.x}:${tile.position.y}`, tile]));
}

/** Applies one exact-leased Unity-style palette/map operation through the same persisted owners used by the viewport. */
export function applyTilePaletteOperation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = getTilePaintViewportState(scene);
	if (!state.enabled) {
		throw new Error("Tile Paint viewport is disabled. Enable and configure it before applying palette operations.");
	}
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== state.revision) {
		throw new Error(`Tile Paint viewport revision is ${state.revision}; reread get_tile_paint_viewport and retry with that expectedRevision.`);
	}
	const { map, palette } = resolveTilePaintTarget(scene, state);
	const mapRevision = getTileMapRevision(map);
	if (!Number.isInteger(data.expectedMapRevision) || data.expectedMapRevision !== mapRevision) {
		throw new Error(`Sprite Map tile revision is ${mapRevision}; reread get_tile_paint_viewport and retry with that expectedMapRevision.`);
	}
	if (!Number.isInteger(data.expectedPaletteRevision) || data.expectedPaletteRevision !== palette.revision) {
		throw new Error(`Tile palette revision is ${palette.revision}; reread get_tile_paint_viewport and retry with that expectedPaletteRevision.`);
	}
	const operation = String(data.operation);
	const target: ITilePaintViewportTarget = data.target ?? state.target;
	const layer = data.layer ?? state.layer;
	const grid = getTilePaintGrid(map);
	if (!Number.isInteger(layer) || layer < 0 || layer >= grid.layerCount) {
		throw new Error(`Tile operation layer must be in the 0-${grid.layerCount - 1} range.`);
	}
	const position = data.position === undefined ? null : validateTileOperationPosition(data.position, "position");
	const maximumCells = data.maxCells ?? 1024;
	if (!Number.isInteger(maximumCells) || maximumCells < 1 || maximumCells > 4096) {
		throw new Error("maxCells must be an integer from 1 through 4,096.");
	}
	const layout = target === "palette" ? palette.layout : getSpriteMapTileGridConfiguration(map).layout;
	const beforeMap = structuredClone(map.tiles);
	const beforePalette = structuredClone(palette);
	let mapChanged = false;
	let paletteChanged = false;
	let affectedCells: [number, number][] = [];
	let picked: ITilePaletteCell | null = null;
	let selection: ITilePaintViewportState["selection"] = state.selection;
	let stamp: ITilePaletteCell[] = state.stamp;

	const sourceCells = (): ITilePaletteCell[] =>
		target === "palette"
			? palette.cells
			: map.tiles
					.filter((tile) => tile.layer === layer)
					.map((tile) => ({ position: [tile.position.x, tile.position.y], tileIndex: tile.tile, transform: normalizeTileTransform(tile.transform) }));
	const removeCells = (positions: [number, number][]): void => {
		const keys = new Set(positions.map((cell) => `${cell[0]}:${cell[1]}`));
		if (target === "palette") {
			const next = palette.cells.filter((cell) => !keys.has(`${cell.position[0]}:${cell.position[1]}`));
			paletteChanged ||= next.length !== palette.cells.length;
			palette.cells = next;
		} else {
			const next = map.tiles.filter((tile) => tile.layer !== layer || !keys.has(`${tile.position.x}:${tile.position.y}`));
			mapChanged ||= next.length !== map.tiles.length;
			map.tiles = next;
		}
	};
	const upsertCells = (cells: ITilePaletteCell[]): void => {
		if (target === "palette") {
			const lookup = paletteCellLookup(palette.cells);
			for (const cell of cells) {
				if (Math.abs(cell.position[0]) > 1024 || Math.abs(cell.position[1]) > 1024) {
					throw new Error("Palette edit positions must stay in the -1,024 through 1,024 range.");
				}
				const key = `${cell.position[0]}:${cell.position[1]}`;
				const previous = lookup.get(key);
				if (!previous) {
					const created = structuredClone(cell);
					palette.cells.push(created);
					lookup.set(key, created);
					paletteChanged = true;
				} else if (previous.tileIndex !== cell.tileIndex || JSON.stringify(previous.transform) !== JSON.stringify(cell.transform)) {
					Object.assign(previous, structuredClone(cell));
					paletteChanged = true;
				}
			}
			if (palette.cells.length > 4096) {
				throw new Error("A Tile Palette may contain at most 4,096 authored cells.");
			}
		} else {
			const lookup = mapCellLookup(map, layer);
			for (const cell of cells) {
				if (cell.position[0] < 0 || cell.position[1] < 0 || cell.position[0] >= grid.width || cell.position[1] >= grid.height) {
					throw new Error(`Tile operation cell [${cell.position.join(", ")}] is outside the ${grid.width}×${grid.height} Sprite Map stage.`);
				}
				const key = `${cell.position[0]}:${cell.position[1]}`;
				const previous = lookup.get(key);
				if (!previous) {
					const created = {
						id: Tools.RandomId(),
						name: `Palette ${cell.tileIndex} [${cell.position.join(", ")}] L${layer}`,
						layer,
						position: { x: cell.position[0], y: cell.position[1] },
						repeatCount: { x: 0, y: 0 },
						repeatOffset: { x: 0, y: 0 },
						tile: cell.tileIndex,
						transform: cell.transform,
					} as ISpriteMapTile;
					map.tiles.push(created);
					lookup.set(key, created);
					mapChanged = true;
				} else if (previous.tile !== cell.tileIndex || JSON.stringify(normalizeTileTransform(previous.transform)) !== JSON.stringify(cell.transform)) {
					previous.tile = cell.tileIndex;
					previous.transform = cell.transform;
					(previous as any).ruleSource = cell.tileIndex;
					mapChanged = true;
				}
			}
		}
	};

	try {
		if (["paint", "erase", "custom"].includes(operation)) {
			if (!position) {
				throw new Error(`${operation} requires position.`);
			}
			const brushSize = data.brushSize === undefined ? state.brushSize : validateTilePaintBrush(data.brushSize);
			const brushType = operation === "custom" ? (data.brushType ?? palette.brush.type) : palette.brush.type;
			const brushData = normalizeBrushData(data.brushData ?? palette.brush.data);
			const activeTileIndex = data.tileIndex ?? palette.activeTileIndex;
			if (!palette.tileIndexes.includes(activeTileIndex)) {
				throw new Error("tileIndex must belong to the configured palette.");
			}
			let brushCells = executeGridBrush(brushType, {
				operation: operation === "erase" ? "erase" : "paint",
				layout,
				anchor: position,
				brushSize,
				layer,
				activeTileIndex,
				data: brushData,
			});
			brushCells = transformGridBrushCells(brushCells, data.transform ?? palette.brush.transform);
			if (brushCells.length > maximumCells) {
				throw new Error(`GridBrush returned ${brushCells.length} cells, exceeding maxCells ${maximumCells}.`);
			}
			affectedCells = brushCells.map((cell) => [position[0] + cell.offset[0], position[1] + cell.offset[1]]);
			if (operation === "erase") {
				removeCells(affectedCells);
			} else {
				for (const cell of brushCells) {
					if (!palette.tileIndexes.includes(cell.tileIndex)) {
						throw new Error("Every GridBrush tileIndex must belong to the configured palette.");
					}
				}
				upsertCells(
					brushCells.map((cell) => ({
						position: [position[0] + cell.offset[0], position[1] + cell.offset[1]],
						tileIndex: cell.tileIndex,
						transform: normalizeTileTransform(cell.transform),
					}))
				);
			}
			stamp = brushCells.map((cell) => ({ position: cell.offset, tileIndex: cell.tileIndex, transform: normalizeTileTransform(cell.transform) }));
		} else if (operation === "fill") {
			if (!position) {
				throw new Error("fill requires position.");
			}
			const lookup = paletteCellLookup(sourceCells());
			const source = lookup.get(`${position[0]}:${position[1]}`);
			if (target === "palette" && !source) {
				throw new Error("Palette fill requires an occupied starting cell so the operation remains bounded.");
			}
			const sourceIndex = source?.tileIndex ?? null;
			const queue: [number, number][] = [position];
			const visited = new Set<string>();
			while (queue.length) {
				const cell = queue.shift()!;
				const key = `${cell[0]}:${cell[1]}`;
				if (visited.has(key)) {
					continue;
				}
				if (target === "map" && (cell[0] < 0 || cell[1] < 0 || cell[0] >= grid.width || cell[1] >= grid.height)) {
					continue;
				}
				if ((lookup.get(key)?.tileIndex ?? null) !== sourceIndex) {
					continue;
				}
				visited.add(key);
				if (visited.size > maximumCells) {
					throw new Error(`Fill exceeds maxCells ${maximumCells}; raise the explicit bound or reduce the region.`);
				}
				queue.push(...tileOperationNeighbors(layout, cell));
			}
			affectedCells = [...visited].map((key) => key.split(":").map(Number) as [number, number]);
			upsertCells(affectedCells.map((cell) => ({ position: cell, tileIndex: data.tileIndex ?? palette.activeTileIndex, transform: normalizeTileTransform(data.transform) })));
		} else if (operation === "pick") {
			if (!position) {
				throw new Error("pick requires position.");
			}
			picked = paletteCellLookup(sourceCells()).get(`${position[0]}:${position[1]}`) ?? null;
			if (!picked) {
				throw new Error(`No tile exists at [${position.join(", ")}] to pick.`);
			}
			stamp = [{ position: [0, 0], tileIndex: picked.tileIndex, transform: picked.transform }];
			affectedCells = [position];
		} else if (operation === "select") {
			if (!position) {
				throw new Error("select requires position.");
			}
			const end = validateTileOperationPosition(data.endPosition ?? position, "endPosition");
			const minX = Math.min(position[0], end[0]);
			const maxX = Math.max(position[0], end[0]);
			const minY = Math.min(position[1], end[1]);
			const maxY = Math.max(position[1], end[1]);
			const selected = sourceCells().filter((cell) => cell.position[0] >= minX && cell.position[0] <= maxX && cell.position[1] >= minY && cell.position[1] <= maxY);
			if (selected.length > maximumCells) {
				throw new Error(`Selection exceeds maxCells ${maximumCells}.`);
			}
			selection = { target, layer, cells: structuredClone(selected) };
			affectedCells = selected.map((cell) => cell.position);
			stamp = selected.map((cell) => ({ position: [cell.position[0] - minX, cell.position[1] - minY], tileIndex: cell.tileIndex, transform: cell.transform }));
		} else if (["move", "rotate", "flip-x", "flip-y"].includes(operation)) {
			if (!state.selection || state.selection.target !== target || state.selection.layer !== layer || !state.selection.cells.length) {
				throw new Error(`${operation} requires a non-empty selection on the same target and layer.`);
			}
			const selected = structuredClone(state.selection.cells);
			const minX = Math.min(...selected.map((cell) => cell.position[0]));
			const minY = Math.min(...selected.map((cell) => cell.position[1]));
			const offsets: IGridBrushCell[] = selected.map((cell) => ({
				offset: [cell.position[0] - minX, cell.position[1] - minY],
				tileIndex: cell.tileIndex,
				transform: cell.transform,
			}));
			const transform =
				operation === "rotate" ? { quarterTurns: data.quarterTurns ?? 1 } : operation === "flip-x" ? { flipX: true } : operation === "flip-y" ? { flipY: true } : {};
			const transformed = transformGridBrushCells(offsets, transform);
			const transformedMinX = Math.min(...transformed.map((cell) => cell.offset[0]));
			const transformedMinY = Math.min(...transformed.map((cell) => cell.offset[1]));
			const movement = operation === "move" ? validateTileOperationPosition(data.offset, "offset") : ([0, 0] as [number, number]);
			const moved = transformed.map((cell) => ({
				position: [minX + movement[0] + cell.offset[0] - transformedMinX, minY + movement[1] + cell.offset[1] - transformedMinY] as [number, number],
				tileIndex: cell.tileIndex,
				transform: normalizeTileTransform(cell.transform),
			}));
			removeCells(selected.map((cell) => cell.position));
			upsertCells(moved);
			selection = { target, layer, cells: moved };
			stamp = moved.map((cell) => ({
				position: [cell.position[0] - moved[0].position[0], cell.position[1] - moved[0].position[1]],
				tileIndex: cell.tileIndex,
				transform: cell.transform,
			}));
			affectedCells = [...selected.map((cell) => cell.position), ...moved.map((cell) => cell.position)];
		} else {
			throw new Error(`Unsupported Tile Palette operation "${operation}".`);
		}

		let ruleChangedTiles = 0;
		if (mapChanged) {
			map.updateFromOptions(map.spriteMap!.options);
			ruleChangedTiles = applyRuleTiles(map).changedTiles;
			incrementTileMapRevision(map);
			synchronizeTileColliderGenerator(scene, map, options);
		}
		if (paletteChanged) {
			palette.revision++;
			palette.tileIndexes = [...new Set([...palette.tileIndexes, ...palette.cells.map((cell) => cell.tileIndex)])];
		}
		const next: ITilePaintViewportState = {
			...structuredClone(state),
			revision: state.revision + 1,
			target,
			mode: ["paint", "erase", "fill", "pick", "select"].includes(operation) ? (operation as ITilePaintViewportMode) : state.mode,
			selection,
			stamp,
			lastStroke:
				operation === "paint" || operation === "erase" || operation === "custom"
					? {
							id: Tools.RandomId(),
							mode: operation === "erase" ? "erase" : "paint",
							layer,
							tileIndex: operation === "erase" ? null : (data.tileIndex ?? palette.activeTileIndex),
							anchors: position ? [position] : [],
							affectedCells,
							changedTiles: affectedCells.length,
							ruleChangedTiles,
						}
					: null,
		};
		tilePaintViewportStates.set(scene, next);
		refreshTilePaintViewport(options);
		return {
			...getTilePaintViewport(scene),
			operation,
			target,
			affectedCells,
			picked,
			selection: structuredClone(selection),
			mapChanged,
			paletteChanged,
		};
	} catch (error) {
		map.tiles = beforeMap;
		Object.assign(palette, beforePalette);
		if (map.spriteMap) {
			map.updateFromOptions(map.spriteMap.options);
		}
		throw error;
	}
}

/** Captures all authored Sprite Map cells for one editor Undo/Redo transaction. */
export function getTilePaintViewportSnapshot(scene: Scene, data: any): ITilePaintViewportSnapshot {
	const map = resolveSpriteMap(scene, data);
	const state = getTilePaintViewportState(scene);
	const palette = state.paletteId ? getTilePalettes(scene).find((candidate) => candidate.id === state.paletteId) : undefined;
	return { mapNodeId: map.id, tiles: structuredClone(map.tiles), paletteId: palette?.id, palette: palette ? structuredClone(palette) : undefined };
}

/** Restores a trusted editor Tile Paint snapshot and invalidates all older exact leases. */
export function restoreTilePaintViewportSnapshot(scene: Scene, snapshot: ITilePaintViewportSnapshot, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, { mapNodeId: snapshot.mapNodeId });
	if (!map.spriteMap) {
		throw new Error("Assign an atlas JSON before restoring a Tile Paint viewport snapshot.");
	}
	if (!Array.isArray(snapshot.tiles) || snapshot.tiles.length > 1_048_576) {
		throw new Error("Tile Paint snapshot must contain no more than 1,048,576 cells.");
	}
	map.tiles = structuredClone(snapshot.tiles);
	if (snapshot.paletteId && snapshot.palette) {
		const palette = getTilePalettes(scene).find((candidate) => candidate.id === snapshot.paletteId);
		if (palette) {
			Object.assign(palette, structuredClone(snapshot.palette));
		}
	}
	map.updateFromOptions(map.spriteMap.options);
	incrementTileMapRevision(map);
	synchronizeTileColliderGenerator(scene, map, options);
	const state = getTilePaintViewportState(scene);
	if (state.mapNodeId === map.id) {
		tilePaintViewportStates.set(scene, { ...structuredClone(state), revision: state.revision + 1, lastStroke: null });
	}
	refreshTilePaintViewport(options);
	return getTilePaintViewport(scene);
}

/** Creates a reusable palette that refers to atlas tile indexes on a Sprite Map. */
export function createTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	if (getTilePalettes(scene).some((palette) => palette.name === data.name)) {
		throw new Error(`Tile palette "${data.name}" already exists.`);
	}
	const tileIndexes: number[] = [...new Set<number>(((data.tileIndexes ?? []) as unknown[]).map((value) => Number(value)))];
	if (!tileIndexes.length || tileIndexes.some((index) => !Number.isInteger(index) || index < 0)) {
		throw new Error("tileIndexes must contain one or more non-negative integer atlas indexes.");
	}
	const palette = normalizeTilePalette({
		model: "unity-tile-palette-v2",
		version: 2,
		revision: 0,
		id: Tools.RandomId(),
		name: data.name,
		mapNodeId: map.id,
		layout: data.layout ?? getSpriteMapTileGridConfiguration(map).layout,
		tileIndexes,
		activeTileIndex: data.activeTileIndex ?? tileIndexes[0],
		cells: data.cells,
		brush: data.brush,
	});
	if (!palette.tileIndexes.includes(palette.activeTileIndex)) {
		throw new Error("activeTileIndex must be included in tileIndexes.");
	}
	getTilePalettes(scene).push(palette);
	options.editor.layout.inspector.setEditedObject(map);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(palette);
}

/** Updates palette membership or its active brush tile. */
export function setTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== palette.revision) {
		throw new Error(`Tile palette revision is ${palette.revision}; reread get_tile_palette and retry with that expectedRevision.`);
	}
	if (data.name !== undefined && getTilePalettes(scene).some((candidate) => candidate !== palette && candidate.name === data.name)) {
		throw new Error(`Tile palette "${data.name}" already exists.`);
	}
	const next = structuredClone(palette);
	if (data.tileIndexes !== undefined) {
		const tileIndexes: number[] = [...new Set<number>((data.tileIndexes as unknown[]).map((value) => Number(value)))];
		if (!tileIndexes.length || tileIndexes.some((index) => !Number.isInteger(index) || index < 0)) {
			throw new Error("tileIndexes must contain one or more non-negative integer atlas indexes.");
		}
		next.tileIndexes = tileIndexes;
	}
	if (data.activeTileIndex !== undefined) {
		next.activeTileIndex = data.activeTileIndex;
	}
	if (data.layout !== undefined) {
		next.layout = normalizeTileGridConfiguration({ layout: data.layout }).layout;
	}
	if (data.cells !== undefined) {
		next.cells = normalizePaletteCells(data.cells, next.tileIndexes);
	}
	if (data.brush !== undefined) {
		if (typeof data.brush.type !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(data.brush.type)) {
			throw new Error("GridBrush type must be a safe id of at most 128 characters.");
		}
		next.brush = {
			type: data.brush.type,
			dataVersion: Number.isInteger(data.brush.dataVersion) && data.brush.dataVersion > 0 ? data.brush.dataVersion : next.brush.dataVersion,
			data: data.brush.data === undefined ? next.brush.data : normalizeBrushData(data.brush.data),
			transform: data.brush.transform === undefined ? next.brush.transform : normalizeTileTransform(data.brush.transform),
		};
	}
	for (const cell of next.cells) {
		if (!next.tileIndexes.includes(cell.tileIndex)) {
			next.tileIndexes.push(cell.tileIndex);
		}
	}
	if (!next.tileIndexes.includes(next.activeTileIndex)) {
		throw new Error("activeTileIndex must be included in tileIndexes.");
	}
	if (data.name !== undefined) {
		next.name = data.name;
	}
	next.revision = palette.revision + 1;
	Object.assign(palette, next);
	const state = getTilePaintViewportState(scene);
	if (state.paletteId === palette.id) {
		tilePaintViewportStates.set(scene, { ...structuredClone(state), revision: state.revision + 1, lastStroke: null });
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(palette);
}

/** Paints or erases a rectangular brush stroke using a persisted palette's active tile. */
export function paintTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	const map = resolveSpriteMap(scene, { mapNodeId: data.mapNodeId ?? palette.mapNodeId });
	if (map.id !== palette.mapNodeId) {
		throw new Error("Tile palette belongs to a different Sprite Map.");
	}
	const anchors = validateTilePaintAnchors([data.position]);
	const brushSize = validateTilePaintBrush([data.width ?? 1, data.height ?? 1]);
	const layer = data.layer ?? 0;
	if (!Number.isInteger(layer) || layer < 0) {
		throw new Error("layer must be a non-negative integer.");
	}
	const tileIndex = data.tileIndex ?? palette.activeTileIndex;
	if (!Number.isInteger(tileIndex) || tileIndex < 0) {
		throw new Error("tileIndex must be a non-negative integer.");
	}
	const result = applyTilePaintCells({ map, palette, mode: data.mode ?? "paint", layer, tileIndex, anchors, brushSize });
	if (result.changedTiles || result.ruleChangedTiles) {
		incrementTileMapRevision(map);
		synchronizeTileColliderGenerator(scene, map, options);
	}
	refresh(options, map);
	return { palette: structuredClone(palette), map: describeSpriteMap(map), ...result };
}

/** Deletes a palette asset without removing painted tiles. */
export function deleteTilePalette(scene: Scene, data: any, options: IMCPActionOptions): any {
	const palette = resolveTilePalette(scene, data);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== palette.revision) {
		throw new Error(`Tile palette revision is ${palette.revision}; reread get_tile_palette and retry with that expectedRevision.`);
	}
	getTilePalettes(scene).splice(getTilePalettes(scene).indexOf(palette), 1);
	const state = getTilePaintViewportState(scene);
	if (state.paletteId === palette.id) {
		tilePaintViewportStates.set(scene, { ...structuredClone(state), revision: state.revision + 1, enabled: false, paletteId: null, lastStroke: null });
	}
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
	if (!map.spriteMap) {
		throw new Error("Assign an atlas JSON before creating animated tiles.");
	}
	if (getAnimatedTiles(map).some((animation) => animation.name === data.name)) {
		throw new Error(`Animated tile "${data.name}" already exists.`);
	}
	const tileIds: string[] = [...new Set<string>(((data.tileIds ?? []) as unknown[]).map((value) => String(value)))];
	const frames: number[] = [...new Set<number>(((data.frames ?? []) as unknown[]).map((value) => Number(value)))];
	if (!tileIds.length || tileIds.some((id) => !map.tiles.some((tile) => tile.id === id))) {
		throw new Error("tileIds must contain existing Sprite Map tile ids.");
	}
	if (frames.length < 2 || frames.some((frame) => !Number.isInteger(frame) || frame < 0)) {
		throw new Error("frames must contain at least two non-negative integer atlas indexes.");
	}
	if (!Number.isFinite(data.frameDuration) || data.frameDuration <= 0) {
		throw new Error("frameDuration must be positive milliseconds.");
	}
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
	if (next.frames.length < 2 || next.frames.some((frame: number) => !Number.isInteger(frame) || frame < 0)) {
		throw new Error("frames must contain at least two non-negative integer atlas indexes.");
	}
	if (!Number.isFinite(next.frameDuration) || next.frameDuration <= 0) {
		throw new Error("frameDuration must be positive milliseconds.");
	}
	if (!next.tileIds.length || next.tileIds.some((id: string) => !map.tiles.some((tile) => tile.id === id))) {
		throw new Error("tileIds must contain existing Sprite Map tile ids.");
	}
	if (data.name !== undefined && getAnimatedTiles(map).some((candidate) => candidate !== animation && candidate.name === data.name)) {
		throw new Error(`Animated tile "${data.name}" already exists.`);
	}
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

function tileColliderFingerprint(collider: ITilemapColliderGeometry["colliders"][number], generator: ITileColliderGenerator): string {
	return JSON.stringify({
		position: collider.position,
		tileIds: collider.tileIds,
		shape: collider.shape,
		materialId: generator.materialId,
		isTrigger: generator.isTrigger,
		usedByEffector: generator.usedByEffector,
		friction: generator.friction,
		restitution: generator.restitution,
		collisionLayer: generator.collisionLayer,
		layerOverrides: generator.layerOverrides,
	});
}

function removeTileColliderEntry(scene: Scene, entry: ITileColliderGeneratorEntry, options: IMCPActionOptions): void {
	try {
		const body = listPhysics2D(scene).bodies.find((candidate: { nodeId: string }) => candidate.nodeId === entry.nodeId);
		if (body) {
			removePhysics2DBody(scene, { nodeId: entry.nodeId, expectedRevision: body.revision }, options);
		}
	} catch {
		// Generated body may have been removed manually.
	}
	scene.getNodeById(entry.nodeId)?.dispose();
}

function buildTileColliderGenerator(scene: Scene, map: SpriteMapNode, generator: ITileColliderGenerator, options: IMCPActionOptions, forceFull: boolean): any {
	if (!map.spriteMap) {
		throw new Error("Assign an atlas JSON before generating tile colliders.");
	}
	const stage = map.spriteMap.options.stageSize ?? new Vector2(1, 1);
	const output = map.spriteMap.options.outputSize ?? new Vector2(100, 100);
	const cells = collectTileColliderCells(map, generator);
	const signatures = tileColliderCellSignatures(cells);
	const changedCellCount = changedTileColliderCellCount(generator.sourceCellSignatures, signatures);
	const mode = forceFull || changedCellCount > generator.maxTileChangeCount ? "full" : "incremental";
	const geometry = generateTilemapColliderGeometry(generator, cells, [stage.x, stage.y], [output.x / stage.x, output.y / stage.y]);
	const existingEntries = new Map(generator.entries.map((entry) => [entry.key, entry]));
	const nextEntries: ITileColliderGeneratorEntry[] = [];
	const createdEntries: ITileColliderGeneratorEntry[] = [];
	let reusedColliderCount = 0;
	try {
		for (const collider of geometry.colliders) {
			const fingerprint = tileColliderFingerprint(collider, generator);
			const existing = mode === "incremental" ? existingEntries.get(collider.key) : undefined;
			const hasBody = existing ? scene.metadata?.babylonEditorPhysics2D?.some((body: any) => body.nodeId === existing.nodeId) : false;
			if (existing && existing.fingerprint === fingerprint && scene.getNodeById(existing.nodeId) && hasBody) {
				nextEntries.push(existing);
				existingEntries.delete(collider.key);
				reusedColliderCount++;
				continue;
			}
			const node = new TransformNode(`${map.name} ${collider.name}`, scene);
			// Replacement builds coexist with the old generated bodies until the whole build succeeds.
			node.id = Tools.RandomId();
			node.position.set(map.position.x + collider.position[0], map.position.y + collider.position[1], map.position.z);
			node.metadata = {
				babylonEditorTileCollider: {
					model: "unity-tilemap-collider-2d-generated-v1",
					mapNodeId: map.id,
					key: collider.key,
					tileIds: collider.tileIds,
					geometryRevision: generator.geometryRevision + 1,
				},
			};
			setPhysics2DBody(
				scene,
				{
					nodeId: node.id,
					bodyType: "static",
					collider: collider.shape,
					materialId: generator.materialId,
					isTrigger: generator.isTrigger,
					usedByEffector: generator.usedByEffector,
					friction: generator.friction,
					restitution: generator.restitution,
					collisionLayer: generator.collisionLayer,
					layerOverrides: generator.layerOverrides,
				},
				options
			);
			const entry = { key: collider.key, nodeId: node.id, fingerprint };
			nextEntries.push(entry);
			createdEntries.push(entry);
		}
	} catch (error) {
		for (const entry of createdEntries) {
			removeTileColliderEntry(scene, entry, options);
		}
		throw error;
	}
	const reusedNodeIds = new Set(nextEntries.filter((entry) => !createdEntries.includes(entry)).map((entry) => entry.nodeId));
	const removedEntries = generator.entries.filter((entry) => !reusedNodeIds.has(entry.nodeId));
	for (const entry of removedEntries) {
		removeTileColliderEntry(scene, entry, options);
	}
	const next: ITileColliderGenerator = {
		...structuredClone(generator),
		geometryRevision: generator.geometryRevision + 1,
		nodeIds: nextEntries.map((entry) => entry.nodeId),
		entries: nextEntries,
		sourceMapRevision: getTileMapRevision(map),
		sourceCellSignatures: signatures,
		lastBuild: {
			mode,
			changedCellCount,
			reusedColliderCount,
			createdColliderCount: createdEntries.length,
			removedColliderCount: removedEntries.length,
			evidence: geometry.evidence,
		},
	};
	map.metadata ??= {};
	map.metadata.babylonEditorTileColliderGenerator = next;
	refresh(options, map);
	return {
		map: toNodeSummary(map),
		generator: {
			...structuredClone(next),
			mapRevision: getTileMapRevision(map),
			pendingChangeCount: 0,
			hasTilemapChanges: false,
		},
		colliderCount: next.nodeIds.length,
		...structuredClone(next.lastBuild),
	};
}

function synchronizeTileColliderGenerator(scene: Scene, map: SpriteMapNode, options: IMCPActionOptions): void {
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator || generator.generationType !== "synchronous" || generator.sourceMapRevision === getTileMapRevision(map)) {
		return;
	}
	buildTileColliderGenerator(scene, map, generator, options, false);
}

/** Returns the generated static 2D collider nodes for a Sprite Map. */
export function getTileColliderGenerator(scene: Scene, data: any): any {
	const map = resolveSpriteMap(scene, data);
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator) {
		return { map: toNodeSummary(map), generator: null };
	}
	const signatures = tileColliderCellSignatures(collectTileColliderCells(map, generator));
	const pendingChangeCount = changedTileColliderCellCount(generator.sourceCellSignatures, signatures);
	return {
		map: toNodeSummary(map),
		generator: {
			...structuredClone(generator),
			mapRevision: getTileMapRevision(map),
			pendingChangeCount,
			hasTilemapChanges: pendingChangeCount > 0 || generator.sourceMapRevision !== getTileMapRevision(map),
		},
	};
}

/** Removes generated static 2D bodies and their helper transform nodes. */
export function clearTileColliderGenerator(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator) {
		return { cleared: false, removedCount: 0 };
	}
	if (data.expectedRevision !== generator.revision) {
		throw new Error(`Tilemap Collider revision is ${generator.revision}; reread get_tile_collider_generator and retry with that expectedRevision.`);
	}
	for (const entry of generator.entries) {
		removeTileColliderEntry(scene, entry, options);
	}
	delete map.metadata.babylonEditorTileColliderGenerator;
	options.editor.layout.inspector.forceUpdate();
	return { cleared: true, removedCount: generator.nodeIds.length };
}

/** Generates static box colliders from matching painted Sprite Map cells, including repeated cells. */
export function generateTileColliders(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	if (!map.spriteMap) {
		throw new Error("Assign an atlas JSON before generating tile colliders.");
	}
	const existing = getTileColliderGeneratorConfiguration(map);
	if (existing && data.expectedRevision !== existing.revision) {
		throw new Error(`Tilemap Collider revision is ${existing.revision}; reread get_tile_collider_generator and retry with that expectedRevision.`);
	}
	const filters = validateTileColliderFilters(data);
	const settings = normalizeTilemapColliderSettings({
		...data,
		compositeOperation: data.compositeOperation ?? (data.merge === false ? "none" : "merge"),
	});
	const generator: ITileColliderGenerator = {
		...settings,
		id: existing?.id ?? Tools.RandomId(),
		revision: (existing?.revision ?? 0) + 1,
		geometryRevision: existing?.geometryRevision ?? 0,
		nodeIds: existing?.nodeIds ?? [],
		entries: existing?.entries ?? [],
		sourceMapRevision: existing?.sourceMapRevision ?? 0,
		sourceCellSignatures: existing?.sourceCellSignatures ?? [],
		...filters,
		merge: settings.compositeOperation !== "none",
		lastBuild:
			existing?.lastBuild ??
			({
				mode: "full",
				changedCellCount: 0,
				reusedColliderCount: 0,
				createdColliderCount: 0,
				removedColliderCount: 0,
				evidence: {
					inputCellCount: 0,
					filteredCellCount: 0,
					gridCellCount: 0,
					spriteCellCount: 0,
					outputColliderCount: 0,
					boxCount: 0,
					polygonCount: 0,
					edgeCount: 0,
					convexPartCount: 0,
					compositeOperation: settings.compositeOperation,
					geometryType: settings.geometryType,
					triangulation: settings.useDelaunayMesh ? "bounded-delaunay-edge-flips-v1" : "convex-parts",
					delaunayFlipCount: 0,
				},
			} satisfies ITileColliderGenerator["lastBuild"]),
	};
	return buildTileColliderGenerator(scene, map, generator, options, true);
}

/** Rebuilds generated Sprite Map colliders from their persisted filter and physics settings after tiles change. */
export function refreshTileColliders(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const generator = getTileColliderGeneratorConfiguration(map);
	if (!generator) {
		throw new Error(`Sprite Map "${map.name}" has no generated tile colliders to refresh.`);
	}
	if (data.expectedRevision !== generator.revision) {
		throw new Error(`Tilemap Collider revision is ${generator.revision}; reread get_tile_collider_generator and retry with that expectedRevision.`);
	}
	return { ...buildTileColliderGenerator(scene, map, generator, options, data.forceFull ?? false), refreshed: true };
}

/** Exact-revision updates advanced Tilemap Collider 2D settings and optionally regenerates synchronously. */
export function setTileColliderGenerator(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	const existing = getTileColliderGeneratorConfiguration(map);
	if (!existing) {
		throw new Error(`Sprite Map "${map.name}" has no Tilemap Collider configuration. Generate one first.`);
	}
	if (data.expectedRevision !== existing.revision) {
		throw new Error(`Tilemap Collider revision is ${existing.revision}; reread get_tile_collider_generator and retry with that expectedRevision.`);
	}
	const update = data.update ?? {};
	const filters = validateTileColliderFilters({
		tileIndexes: Object.prototype.hasOwnProperty.call(update, "tileIndexes") ? update.tileIndexes : existing.tileIndexes,
		layer: Object.prototype.hasOwnProperty.call(update, "layer") ? update.layer : existing.layer,
	});
	const settings = normalizeTilemapColliderSettings({ ...existing, ...update });
	if (settings.materialId && !scene.metadata?.babylonEditorPhysics2DMaterials?.some((material: any) => material.id === settings.materialId)) {
		throw new Error(`2D physics material "${settings.materialId}" was not found.`);
	}
	const next: ITileColliderGenerator = {
		...structuredClone(existing),
		...settings,
		...filters,
		revision: existing.revision + 1,
		merge: settings.compositeOperation !== "none",
	};
	if (next.generationType === "synchronous") {
		return buildTileColliderGenerator(scene, map, next, options, true);
	}
	map.metadata ??= {};
	map.metadata.babylonEditorTileColliderGenerator = next;
	options.editor.layout.inspector.forceUpdate();
	return { ...getTileColliderGenerator(scene, { mapNodeId: map.id }), colliderCount: next.nodeIds.length, configured: true };
}

/** Captures a complete Tilemap Collider configuration for editor Undo/Redo. */
export function getTileColliderGeneratorSnapshot(scene: Scene, data: any): ITileColliderGeneratorSnapshot {
	const map = resolveSpriteMap(scene, data);
	return { mapNodeId: map.id, generator: structuredClone(getTileColliderGeneratorConfiguration(map)) };
}

/** Restores a trusted editor Tilemap Collider snapshot and regenerates its exact geometry. */
export function restoreTileColliderGeneratorSnapshot(scene: Scene, snapshot: ITileColliderGeneratorSnapshot, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, { mapNodeId: snapshot.mapNodeId });
	const current = getTileColliderGeneratorConfiguration(map);
	if (!snapshot.generator) {
		return current ? clearTileColliderGenerator(scene, { mapNodeId: map.id, expectedRevision: current.revision }, options) : { cleared: false, removedCount: 0 };
	}
	const target = structuredClone(snapshot.generator);
	const targetBodiesExist = target.entries.every(
		(entry) => scene.getNodeById(entry.nodeId) && scene.metadata?.babylonEditorPhysics2D?.some((body: any) => body.nodeId === entry.nodeId)
	);
	if (target.generationType === "manual" && targetBodiesExist && current?.entries.every((entry, index) => entry.nodeId === target.entries[index]?.nodeId)) {
		map.metadata ??= {};
		map.metadata.babylonEditorTileColliderGenerator = target;
		refresh(options, map);
		return { ...getTileColliderGenerator(scene, { mapNodeId: map.id }), colliderCount: target.nodeIds.length, restoredWithoutRegeneration: true };
	}
	target.entries = current?.entries ?? [];
	target.nodeIds = current?.nodeIds ?? [];
	target.geometryRevision = Math.max(0, snapshot.generator.geometryRevision - 1);
	return buildTileColliderGenerator(scene, map, target, options, true);
}

/** Records a normal editor-side Sprite Map change and applies synchronous/manual Tilemap Collider behavior. */
export function notifySpriteMapTileDataChanged(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = resolveSpriteMap(scene, data);
	incrementTileMapRevision(map);
	synchronizeTileColliderGenerator(scene, map, options);
	refresh(options, map);
	return getTileColliderGenerator(scene, { mapNodeId: map.id });
}

export async function setSpriteMap(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveSpriteMap(scene, data);
	if (data.name !== undefined) {
		node.name = data.name;
	}
	if (data.atlasJsonPath !== undefined) {
		await node.buildFromAbsolutePath(resolveProjectPath(data.atlasJsonPath));
	}
	if (data.options && node.spriteMap) {
		const current = node.spriteMap.options;
		current.layerCount = data.options.layerCount ?? current.layerCount;
		current.stageSize = data.options.stageSize ? Vector2.FromArray(data.options.stageSize) : current.stageSize;
		current.outputSize = data.options.outputSize ? Vector2.FromArray(data.options.outputSize) : current.outputSize;
		current.colorMultiply = data.options.colorMultiply ? Vector3.FromArray(data.options.colorMultiply) : current.colorMultiply;
		node.updateFromOptions(current);
	}
	if (data.atlasJsonPath !== undefined || data.options !== undefined) {
		incrementTileMapRevision(node);
		synchronizeTileColliderGenerator(scene, node, options);
	}
	refresh(options, node);
	return describeSpriteMap(node);
}

export function setSpriteMapTiles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveSpriteMap(scene, data);
	if (!node.spriteMap) {
		throw new Error("Assign an atlas JSON before editing Sprite Map tiles.");
	}
	if (data.mode === "replace") {
		node.tiles = data.tiles ?? [];
	} else if (data.mode === "add") {
		node.tiles.push(...(data.tiles ?? []).map((tile: any) => ({ id: Tools.RandomId(), ...tile })));
	} else if (data.mode === "remove") {
		node.tiles = node.tiles.filter((tile) => !(data.tileIds ?? []).includes(tile.id));
	} else {
		throw new Error("Tile mode must be replace, add, or remove.");
	}
	node.updateFromOptions(node.spriteMap.options);
	applyRuleTiles(node);
	incrementTileMapRevision(node);
	synchronizeTileColliderGenerator(scene, node, options);
	refresh(options, node);
	return describeSpriteMap(node);
}
