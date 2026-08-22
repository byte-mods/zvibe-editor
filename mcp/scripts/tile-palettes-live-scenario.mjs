#!/usr/bin/env node
/** Real stdio/editor lifecycle for layout-aware Tile Palettes, selection operations, GridBrush execution, and cleanup. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 90_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

const required = [
	"create_sprite_manager",
	"set_sprite_manager",
	"pack_sprite_atlas",
	"slice_sprite_sheet",
	"list_sprites",
	"create_sprite",
	"set_sprite",
	"play_sprite_animation",
	"create_sprite_map",
	"set_sprite_map",
	"set_sprite_map_rule_tiles",
	"resolve_sprite_map_rule_tiles",
	"get_tile_palette",
	"get_tile_grid_configuration",
	"set_tile_grid_configuration",
	"list_grid_brush_types",
	"set_tile_palette",
	"paint_tile_palette",
	"apply_tile_palette_operation",
	"list_animated_tiles",
	"create_animated_tile",
	"set_animated_tile",
	"delete_animated_tile",
];
const suffix = `${Date.now()}-${process.pid}`;
const fixtureName = `MCP Tile Palette ${suffix}`;
const assetFolder = `assets/mcp-tile-palette-${suffix}`;
const scriptName = `tile-palette-setup-${suffix}.js`;
let mapNodeId;
let managerNodeId;
let paletteId;

async function cleanup() {
	try {
		const viewport = await call("get_tile_paint_viewport");
		if (viewport.enabled || viewport.mapNodeId || viewport.paletteId) {
			await call("set_tile_paint_viewport", { expectedRevision: viewport.revision, enabled: false, mapNodeId: null, paletteId: null });
		}
		if (paletteId) {
			const palette = await call("get_tile_palette", { paletteId });
			await call("delete_tile_palette", { paletteId, expectedRevision: palette.revision });
			paletteId = undefined;
		}
		if (mapNodeId) {
			await call("delete_node", { nodeId: mapNodeId });
			mapNodeId = undefined;
		}
		if (managerNodeId) {
			await call("delete_node", { nodeId: managerNodeId });
			managerNodeId = undefined;
		}
		for (const path of [assetFolder, `agentdata/${scriptName}`]) await call("delete_asset", { path, confirm: true });
	} catch (error) {
		if (!/not found/i.test(String(error))) throw error;
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tile-palettes-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of required) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Tile Palette live scenario.");
	const setupSource = `
import { dirname, join } from "path";
import { ensureDir } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const directory = join(dirname(editor.state.projectPath), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 239, g: 68, b: 68, alpha: 1 } } }).png().toFile(join(directory, "tile-red.png"));
	await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 59, g: 130, b: 246, alpha: 1 } } }).png().toFile(join(directory, "tile-blue.png"));
	return JSON.stringify({ created: true });
}`;
	await call("run_agent_script", { name: scriptName, content: setupSource });
	const packed = await call("pack_sprite_atlas", {
		sourcePaths: [`${assetFolder}/tile-red.png`, `${assetFolder}/tile-blue.png`],
		outputPath: `${assetFolder}/packed.png`,
		padding: 1,
		maxSize: 64,
	});
	if (packed.frames.length !== 2 || packed.atlasJsonPath !== `${assetFolder}/packed.json`) throw new Error("Packed sprite atlas evidence is incomplete.");
	const sliced = await call("slice_sprite_sheet", {
		sourcePath: `${assetFolder}/tile-red.png`,
		outputPath: `${assetFolder}/sliced.json`,
		frames: [{ name: "single", x: 0, y: 0, width: 4, height: 4 }],
	});
	if (sliced.frames[0] !== "single") throw new Error("Sprite-sheet slicing evidence is incomplete.");

	let manager = await call("create_sprite_manager", { name: `${fixtureName} Manager`, atlasJsonPath: packed.atlasJsonPath });
	managerNodeId = manager.id;
	manager = await call("set_sprite_manager", { managerNodeId, name: `${fixtureName} Manager Updated`, properties: { fogEnabled: true, pixelPerfect: true } });
	if (manager.name !== `${fixtureName} Manager Updated` || !manager.hasSpritesheet) throw new Error("Sprite Manager update evidence is incomplete.");
	let sprite = await call("create_sprite", { managerNodeId, name: `${fixtureName} Sprite`, position: [1, 2, 3], width: 2, height: 3, cellRef: "tile-red.png" });
	sprite = await call("set_sprite", {
		managerNodeId,
		spriteId: sprite.id,
		angle: 0.25,
		color: [0.5, 0.75, 1, 1],
		animations: [{ name: "Pulse", from: 0, to: 1, loop: true, delay: 50 }],
	});
	if (sprite.animations.length !== 1 || sprite.angle !== 0.25) throw new Error("Sprite property update evidence is incomplete.");
	let playback = await call("play_sprite_animation", { managerNodeId, spriteId: sprite.id, from: 0, to: 1, loop: true, delay: 50 });
	if (!playback.animationStarted) throw new Error("Sprite animation did not start.");
	playback = await call("play_sprite_animation", { managerNodeId, spriteId: sprite.id, stop: true });
	if (playback.animationStarted) throw new Error("Sprite animation did not stop.");
	const sprites = await call("list_sprites", { managerNodeId });
	if (!sprites.sprites.some((candidate) => candidate.id === sprite.id)) throw new Error("Created Sprite was not listed.");

	let map = await call("create_sprite_map", {
		name: fixtureName,
		atlasJsonPath: packed.atlasJsonPath,
		options: { layerCount: 1, stageSize: [4, 4], outputSize: [400, 400], colorMultiply: [1, 1, 1] },
	});
	mapNodeId = map.id;
	map = await call("set_sprite_map", { mapNodeId, name: `${fixtureName} Updated`, options: { outputSize: [512, 512], colorMultiply: [0.9, 1, 0.9] } });
	if (map.name !== `${fixtureName} Updated` || map.options.outputSize[0] !== 512) throw new Error(`Sprite Map update evidence is incomplete: ${JSON.stringify(map)}`);
	let grid = (await call("get_tile_grid_configuration", { mapNodeId })).grid;
	grid = (await call("set_tile_grid_configuration", { mapNodeId, expectedRevision: grid.revision, layout: "isometric" })).grid;
	if (grid.layout !== "isometric" || grid.revision !== 1) throw new Error("Isometric grid configuration did not apply exactly.");
	let palette = await call("create_tile_palette", { mapNodeId, name: `${fixtureName} Palette`, layout: "isometric", tileIndexes: [0, 1] });
	paletteId = palette.id;
	palette = await call("set_tile_palette", { paletteId, expectedRevision: palette.revision, name: `${fixtureName} Palette Updated`, activeTileIndex: 0 });
	if (palette.revision !== 1 || palette.name !== `${fixtureName} Palette Updated`) throw new Error("Tile Palette update evidence is incomplete.");
	let paintedDirect = await call("paint_tile_palette", { paletteId, mapNodeId, position: [3, 3], tileIndex: 0, mode: "paint" });
	const animatedTileId = paintedDirect.map.tiles.find((tile) => tile.position?.x === 3 && tile.position?.y === 3)?.id;
	if (!animatedTileId) throw new Error("Direct Tile Palette paint did not create a target tile.");
	let animated = await call("create_animated_tile", { mapNodeId, name: `${fixtureName} Animated`, tileIds: [animatedTileId], frames: [0, 1], frameDuration: 80 });
	animated = await call("set_animated_tile", { mapNodeId, id: animated.id, frameDuration: 120, enabled: false });
	if (animated.frameDuration !== 120 || animated.enabled !== false) throw new Error("Animated Tile update evidence is incomplete.");
	const animatedList = await call("list_animated_tiles", { mapNodeId });
	if (!animatedList.animations.some((candidate) => candidate.id === animated.id)) throw new Error("Animated Tile was not listed.");
	await call("delete_animated_tile", { mapNodeId, id: animated.id });
	let ruled = await call("set_sprite_map_rule_tiles", { mapNodeId, rules: [{ sourceTile: 0, outputTile: 1, neighbors: { north: "any" } }] });
	if (ruled.ruleTiles.length !== 1) throw new Error("Sprite Map rule-tile authoring evidence is incomplete.");
	ruled = await call("resolve_sprite_map_rule_tiles", { mapNodeId });
	if (ruled.ruleTiles.length !== 1) throw new Error("Sprite Map rule-tile resolution evidence is incomplete.");
	const brushes = await call("list_grid_brush_types");
	if (!brushes.brushes.some((brush) => brush.id === "builtin.rectangle")) throw new Error("Built-in GridBrush registration is missing.");
	let viewport = await call("get_tile_paint_viewport");
	viewport = await call("set_tile_paint_viewport", { expectedRevision: viewport.revision, enabled: true, mapNodeId, paletteId, mode: "paint", target: "map", brushSize: [2, 2] });
	let result = await call("apply_tile_palette_operation", {
		expectedRevision: viewport.revision,
		expectedMapRevision: viewport.mapRevision,
		expectedPaletteRevision: viewport.palette.revision,
		operation: "custom",
		position: [0, 0],
		brushType: "builtin.rectangle",
	});
	if (result.affectedCells.length !== 4 || !result.mapChanged) throw new Error("GridBrush map painting evidence is incomplete.");
	const revisionAfterBrushPaint = result.mapRevision;
	result = await call("apply_tile_palette_operation", {
		expectedRevision: result.revision,
		expectedMapRevision: result.mapRevision,
		expectedPaletteRevision: result.palette.revision,
		operation: "select",
		position: [0, 0],
		endPosition: [1, 1],
	});
	if (result.selection?.cells.length !== 4) throw new Error("Tile selection did not capture four cells.");
	result = await call("apply_tile_palette_operation", {
		expectedRevision: result.revision,
		expectedMapRevision: result.mapRevision,
		expectedPaletteRevision: result.palette.revision,
		operation: "rotate",
	});
	if (!result.mapChanged || result.mapRevision !== revisionAfterBrushPaint + 1) throw new Error("Selection rotation did not mutate tile transforms.");
	result = await call("apply_tile_palette_operation", {
		expectedRevision: result.revision,
		expectedMapRevision: result.mapRevision,
		expectedPaletteRevision: result.palette.revision,
		operation: "pick",
		position: [0, 0],
	});
	if (result.picked?.tileIndex !== 1) throw new Error(`Tile picker did not return the rule-resolved frame: ${JSON.stringify(result.picked)}`);
	viewport = await call("set_tile_paint_viewport", { expectedRevision: result.revision, target: "palette", mode: "paint" });
	result = await call("apply_tile_palette_operation", {
		expectedRevision: viewport.revision,
		expectedMapRevision: viewport.mapRevision,
		expectedPaletteRevision: viewport.palette.revision,
		operation: "paint",
		target: "palette",
		position: [2, 2],
		brushSize: [1, 1],
	});
	if (!result.paletteChanged || result.palette.revision !== 1) throw new Error("Palette editing mode did not publish a new palette revision.");
	grid = (await call("set_tile_grid_configuration", { mapNodeId, expectedRevision: grid.revision, layout: "hexagonal-point-top" })).grid;
	if (grid.layout !== "hexagonal-point-top" || grid.revision !== 2) throw new Error("Hexagonal grid configuration did not apply exactly.");
	await cleanup();
	console.log(
		"[tile-palettes-live] PASS — 23/23 dedicated tools, atlas packing/slicing, Sprite Manager animation, Sprite Map rule tiles, animated tiles, isometric/hex layouts, GridBrush paint, exact leases, and cleanup verified."
	);
} catch (error) {
	console.error(`[tile-palettes-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		await cleanup();
	} catch (error) {
		console.error(`[tile-palettes-live] cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
