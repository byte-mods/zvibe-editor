export type TileGridLayout = "rectangular" | "isometric" | "hexagonal-point-top" | "hexagonal-flat-top";

export type TileBrushOperation = "paint" | "erase";

export interface ITileTransform {
	quarterTurns: 0 | 1 | 2 | 3;
	flipX: boolean;
	flipY: boolean;
}

export interface ITileGridConfiguration {
	model: "unity-tile-grid-v1";
	version: 1;
	revision: number;
	layout: TileGridLayout;
}

export interface IGridBrushCell {
	offset: [number, number];
	tileIndex: number;
	transform?: Partial<ITileTransform>;
}

export interface IGridBrushContext<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly operation: TileBrushOperation;
	readonly layout: TileGridLayout;
	readonly anchor: [number, number];
	readonly brushSize: [number, number];
	readonly layer: number;
	readonly activeTileIndex: number;
	readonly data: TData;
}

export interface IGridBrushDefinition<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly dataVersion: number;
	setDefaultValues?(): TData;
	validate?(context: IGridBrushContext<TData>): true | string;
	paint(context: IGridBrushContext<TData>): IGridBrushCell[];
}

const gridBrushDefinitions = new Map<string, IGridBrushDefinition>();
const maximumGridBrushCells = 1024;

export const identityTileTransform: ITileTransform = { quarterTurns: 0, flipX: false, flipY: false };

/** Normalizes persisted layout data so legacy scenes deterministically become rectangular version-1 grids. */
export function normalizeTileGridConfiguration(value: unknown): ITileGridConfiguration {
	const candidate = value && typeof value === "object" ? (value as Partial<ITileGridConfiguration>) : {};
	const layouts: TileGridLayout[] = ["rectangular", "isometric", "hexagonal-point-top", "hexagonal-flat-top"];
	return {
		model: "unity-tile-grid-v1",
		version: 1,
		revision: Number.isInteger(candidate.revision) && candidate.revision! >= 0 ? candidate.revision! : 0,
		layout: layouts.includes(candidate.layout as TileGridLayout) ? (candidate.layout as TileGridLayout) : "rectangular",
	};
}

/** Coerces optional persisted transform fields into the four finite rotations and two reflection flags supported by the tile shader. */
export function normalizeTileTransform(value: unknown): ITileTransform {
	const candidate = value && typeof value === "object" ? (value as Partial<ITileTransform>) : {};
	const quarterTurns = Number.isInteger(candidate.quarterTurns) ? (((((candidate.quarterTurns as number) % 4) + 4) % 4) as 0 | 1 | 2 | 3) : 0;
	return { quarterTurns, flipX: candidate.flipX === true, flipY: candidate.flipY === true };
}

function tileGridPhysicalBounds(width: number, height: number, layout: TileGridLayout): [number, number] {
	if (layout === "isometric") {
		return [width + height, width + height];
	}
	if (layout === "hexagonal-point-top") {
		return [width + (height > 1 ? 0.5 : 0), Math.max(1, (height - 1) * 0.75 + 1)];
	}
	if (layout === "hexagonal-flat-top") {
		return [Math.max(1, (width - 1) * 0.75 + 1), height + (width > 1 ? 0.5 : 0)];
	}
	return [width, height];
}

function physicalToLocal(point: [number, number], width: number, height: number, layout: TileGridLayout): [number, number] {
	const bounds = tileGridPhysicalBounds(width, height, layout);
	return [point[0] / bounds[0] - 0.5, 0.5 - point[1] / bounds[1]];
}

/** Returns one logical cell's closed outline in SpriteMap output-plane local coordinates. */
export function getTileGridCellPolygon(cell: [number, number], width: number, height: number, layout: TileGridLayout): Array<[number, number]> {
	const [x, y] = cell;
	let physical: Array<[number, number]>;
	if (layout === "isometric") {
		const project = (gridX: number, gridY: number): [number, number] => [gridX - gridY + height, gridX + gridY];
		physical = [project(x, y), project(x + 1, y), project(x + 1, y + 1), project(x, y + 1)];
	} else if (layout === "hexagonal-point-top") {
		const centerX = x + 0.5 + (Math.abs(y) % 2) * 0.5;
		const centerY = y * 0.75 + 0.5;
		physical = [
			[centerX, centerY - 0.5],
			[centerX + 0.5, centerY - 0.25],
			[centerX + 0.5, centerY + 0.25],
			[centerX, centerY + 0.5],
			[centerX - 0.5, centerY + 0.25],
			[centerX - 0.5, centerY - 0.25],
		];
	} else if (layout === "hexagonal-flat-top") {
		const centerX = x * 0.75 + 0.5;
		const centerY = y + 0.5 + (Math.abs(x) % 2) * 0.5;
		physical = [
			[centerX - 0.5, centerY],
			[centerX - 0.25, centerY - 0.5],
			[centerX + 0.25, centerY - 0.5],
			[centerX + 0.5, centerY],
			[centerX + 0.25, centerY + 0.5],
			[centerX - 0.25, centerY + 0.5],
		];
	} else {
		physical = [
			[x, y],
			[x + 1, y],
			[x + 1, y + 1],
			[x, y + 1],
		];
	}
	return physical.map((point) => physicalToLocal(point, width, height, layout));
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const [x, y] = polygon[index];
		const [previousX, previousY] = polygon[previous];
		const crosses = y > point[1] !== previousY > point[1] && point[0] <= ((previousX - x) * (point[1] - y)) / (previousY - y || Number.EPSILON) + x;
		if (crosses) {
			inside = !inside;
		}
	}
	return inside;
}

/** Resolves a plane-local hit to one logical grid cell for every supported layout without accepting layout gaps or diamond corners. */
export function tileGridLocalPointToCell(localX: number, localY: number, width: number, height: number, layout: TileGridLayout): [number, number] | null {
	if (
		![localX, localY].every(Number.isFinite) ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		localX < -0.500001 ||
		localX > 0.500001 ||
		localY < -0.500001 ||
		localY > 0.500001
	) {
		return null;
	}
	if (layout === "rectangular") {
		return [Math.min(width - 1, Math.floor((localX + 0.5) * width)), Math.min(height - 1, Math.floor((0.5 - localY) * height))];
	}
	const bounds = tileGridPhysicalBounds(width, height, layout);
	const physicalX = (localX + 0.5) * bounds[0];
	const physicalY = (0.5 - localY) * bounds[1];
	let estimate: [number, number];
	if (layout === "isometric") {
		estimate = [Math.floor((physicalX - height + physicalY) * 0.5), Math.floor((physicalY - physicalX + height) * 0.5)];
	} else if (layout === "hexagonal-point-top") {
		const row = Math.floor(physicalY / 0.75);
		estimate = [Math.floor(physicalX - (Math.abs(row) % 2) * 0.5), row];
	} else {
		const column = Math.floor(physicalX / 0.75);
		estimate = [column, Math.floor(physicalY - (Math.abs(column) % 2) * 0.5)];
	}
	// At most 25 nearby polygons are tested; shared edges consistently favor the top-left candidate.
	for (let y = Math.max(0, estimate[1] - 2); y <= Math.min(height - 1, estimate[1] + 2); y++) {
		for (let x = Math.max(0, estimate[0] - 2); x <= Math.min(width - 1, estimate[0] + 2); x++) {
			if (pointInPolygon([localX, localY], getTileGridCellPolygon([x, y], width, height, layout))) {
				return [x, y];
			}
		}
	}
	return null;
}

/** Applies stamp-space reflections and quarter turns around the origin while retaining tile transform metadata. */
export function transformGridBrushCells(cells: IGridBrushCell[], transform: Partial<ITileTransform>): IGridBrushCell[] {
	const normalized = normalizeTileTransform(transform);
	return cells.map((cell) => {
		let [x, y] = cell.offset;
		if (normalized.flipX) {
			x = -x;
		}
		if (normalized.flipY) {
			y = -y;
		}
		for (let turn = 0; turn < normalized.quarterTurns; turn++) {
			[x, y] = [-y, x];
		}
		const tileTransform = normalizeTileTransform(cell.transform);
		return {
			...cell,
			offset: [x, y],
			transform: {
				quarterTurns: ((tileTransform.quarterTurns + normalized.quarterTurns) % 4) as 0 | 1 | 2 | 3,
				flipX: tileTransform.flipX !== normalized.flipX,
				flipY: tileTransform.flipY !== normalized.flipY,
			},
		};
	});
}

function validateGridBrushDefinition(definition: IGridBrushDefinition): void {
	if (!definition || typeof definition !== "object" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(definition.id)) {
		throw new Error("GridBrush id must contain 1 through 128 safe identifier characters.");
	}
	if (!Number.isInteger(definition.dataVersion) || definition.dataVersion < 1 || definition.dataVersion > 100000) {
		throw new Error("GridBrush dataVersion must be an integer from 1 through 100000.");
	}
	if (typeof definition.paint !== "function") {
		throw new Error(`GridBrush "${definition.id}" must implement paint.`);
	}
}

/** Registers or hot-replaces a project-defined GridBrush used by the editor and generated project module graph. */
export function registerGridBrush<TData extends Record<string, unknown> = Record<string, unknown>>(definition: IGridBrushDefinition<TData>): () => void {
	validateGridBrushDefinition(definition as IGridBrushDefinition);
	gridBrushDefinitions.set(definition.id, definition as IGridBrushDefinition);
	return () => {
		if (gridBrushDefinitions.get(definition.id) === definition) {
			gridBrushDefinitions.delete(definition.id);
		}
	};
}

/** Lists non-executable GridBrush metadata so authoring clients can select a registered implementation safely. */
export function listGridBrushTypes(): Array<{ id: string; displayName: string; description: string; dataVersion: number; defaultData: Record<string, unknown> }> {
	return [...gridBrushDefinitions.values()]
		.map((definition) => ({
			id: definition.id,
			displayName: definition.displayName?.trim() || definition.id,
			description: definition.description?.trim() || "",
			dataVersion: definition.dataVersion,
			defaultData: structuredClone(definition.setDefaultValues?.() ?? {}),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

/** Executes one registered brush and rejects malformed, duplicate, or unbounded cell output before it reaches scene data. */
export function executeGridBrush<TData extends Record<string, unknown> = Record<string, unknown>>(id: string, context: IGridBrushContext<TData>): IGridBrushCell[] {
	const definition = gridBrushDefinitions.get(id) as IGridBrushDefinition<TData> | undefined;
	if (!definition) {
		throw new Error(`GridBrush "${id}" is not registered. Attach its project registration script and run or reload project scripts.`);
	}
	const validation = definition.validate?.(context);
	if (typeof validation === "string") {
		throw new Error(`GridBrush "${id}" rejected its data: ${validation}`);
	}
	const cells = definition.paint(context);
	if (!Array.isArray(cells) || cells.length > maximumGridBrushCells) {
		throw new Error(`GridBrush "${id}" must return an array of at most ${maximumGridBrushCells} cells.`);
	}
	const occupied = new Set<string>();
	return cells.map((cell, index) => {
		if (!cell || !Array.isArray(cell.offset) || cell.offset.length !== 2 || !cell.offset.every(Number.isInteger)) {
			throw new Error(`GridBrush "${id}" cell ${index} must have a two-integer offset.`);
		}
		if (!Number.isInteger(cell.tileIndex) || cell.tileIndex < 0) {
			throw new Error(`GridBrush "${id}" cell ${index} must have a non-negative tileIndex.`);
		}
		const key = `${cell.offset[0]}:${cell.offset[1]}`;
		if (occupied.has(key)) {
			throw new Error(`GridBrush "${id}" returned duplicate offset [${cell.offset.join(", ")}].`);
		}
		occupied.add(key);
		return { offset: [cell.offset[0], cell.offset[1]], tileIndex: cell.tileIndex, transform: normalizeTileTransform(cell.transform) };
	});
}

registerGridBrush({
	id: "builtin.rectangle",
	displayName: "Rectangle",
	description: "Paints the selected tile across the configured rectangular brush footprint.",
	dataVersion: 1,
	paint: (context) => {
		const cells: IGridBrushCell[] = [];
		for (let y = 0; y < context.brushSize[1]; y++) {
			for (let x = 0; x < context.brushSize[0]; x++) {
				cells.push({ offset: [x, y], tileIndex: context.activeTileIndex });
			}
		}
		return cells;
	},
});
