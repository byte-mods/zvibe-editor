import { decomposePhysics2DPolygonContours, IPhysics2DPolygonContour, IPhysics2DPoint } from "./physics2d-polygons";

export type TilemapColliderType = "none" | "grid" | "sprite";
export type TilemapCompositeOperation = "none" | "merge" | "intersect" | "difference" | "flip";
export type TilemapCompositeGeometryType = "polygons" | "outlines";
export type TilemapColliderGenerationType = "synchronous" | "manual";

export interface ITilemapColliderLayerOverrides {
	priority: number;
	includeLayers: number;
	excludeLayers: number;
	forceSendLayers: number;
	forceReceiveLayers: number;
	contactCaptureLayers: number;
	callbackLayers: number;
}

export interface ITilemapColliderSettings {
	model: "unity-tilemap-collider-2d-v1";
	version: 1;
	compositeOperation: TilemapCompositeOperation;
	geometryType: TilemapCompositeGeometryType;
	generationType: TilemapColliderGenerationType;
	useDelaunayMesh: boolean;
	maxTileChangeCount: number;
	extrusionFactor: number;
	vertexDistance: number;
	offsetDistance: number;
	offset: IPhysics2DPoint;
	edgeRadius: number;
	tileColliderTypes: Record<string, TilemapColliderType>;
	spriteShapes: Record<string, IPhysics2DPolygonContour[]>;
	materialId: string | null;
	isTrigger: boolean;
	usedByEffector: boolean;
	friction: number;
	restitution: number;
	collisionLayer: number;
	layerOverrides: ITilemapColliderLayerOverrides;
}

export interface ITilemapColliderCell {
	x: number;
	y: number;
	layer: number;
	tileIndex: number;
	tileId: string;
}

export type ITilemapGeneratedColliderShape =
	| { shape: "box"; size: IPhysics2DPoint }
	| {
			shape: "polygon";
			version: 2;
			model: string;
			contours: IPhysics2DPolygonContour[];
			points: IPhysics2DPoint[];
			parts: IPhysics2DPoint[][];
			outerCount: number;
			holeCount: number;
			vertexCount: number;
			filledArea: number;
			decomposedArea: number;
			delaunayFlipCount: number;
	  }
	| { shape: "edge"; points: IPhysics2DPoint[]; parts: IPhysics2DPoint[][]; edgeRadius: number };

export interface ITilemapGeneratedCollider {
	key: string;
	name: string;
	position: IPhysics2DPoint;
	layer: number;
	tileIds: string[];
	shape: ITilemapGeneratedColliderShape;
}

export interface ITilemapColliderGeometry {
	model: "unity-tilemap-collider-2d-geometry-v1";
	colliders: ITilemapGeneratedCollider[];
	evidence: {
		inputCellCount: number;
		filteredCellCount: number;
		gridCellCount: number;
		spriteCellCount: number;
		outputColliderCount: number;
		boxCount: number;
		polygonCount: number;
		edgeCount: number;
		convexPartCount: number;
		compositeOperation: TilemapCompositeOperation;
		geometryType: TilemapCompositeGeometryType;
		triangulation: "convex-parts" | "bounded-delaunay-edge-flips-v1";
		delaunayFlipCount: number;
	};
}

const allLayersMask = 0xffffffff;

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be finite from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function mask(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > allLayersMask) {
		throw new Error(`${label} must be an unsigned 32-bit layer mask.`);
	}
	return value >>> 0;
}

function point(value: unknown, label: string): IPhysics2DPoint {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error(`${label} must be [x, y].`);
	}
	return [finite(value[0], -1_000_000, 1_000_000, `${label} x`), finite(value[1], -1_000_000, 1_000_000, `${label} y`)];
}

function normalizeTileTypes(value: unknown): Record<string, TilemapColliderType> {
	if (value === undefined) {
		return {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 4096) {
		throw new Error("tileColliderTypes must contain at most 4096 atlas-index entries.");
	}
	const result: Record<string, TilemapColliderType> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (!/^\d+$/.test(key) || Number(key) > 1_000_000 || !["none", "grid", "sprite"].includes(candidate as string)) {
			throw new Error("tileColliderTypes keys must be non-negative atlas indexes with none, grid, or sprite values.");
		}
		result[String(Number(key))] = candidate as TilemapColliderType;
	}
	return result;
}

function normalizeSpriteShapes(value: unknown): Record<string, IPhysics2DPolygonContour[]> {
	if (value === undefined) {
		return {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 4096) {
		throw new Error("spriteShapes must contain at most 4096 atlas-index entries.");
	}
	const result: Record<string, IPhysics2DPolygonContour[]> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (!/^\d+$/.test(key) || Number(key) > 1_000_000) {
			throw new Error("spriteShapes keys must be non-negative atlas indexes.");
		}
		const decomposition = decomposePhysics2DPolygonContours(candidate);
		for (const contour of decomposition.contours) {
			for (const coordinate of [...contour.points, ...contour.holes.flatMap((hole) => hole.points)]) {
				if (coordinate[0] < -0.5 || coordinate[0] > 0.5 || coordinate[1] < -0.5 || coordinate[1] > 0.5) {
					throw new Error(`Sprite collider ${key} points must stay inside normalized cell bounds [-0.5, 0.5].`);
				}
			}
		}
		result[String(Number(key))] = decomposition.contours;
	}
	return result;
}

/** Validates and fills the complete Unity-style Tilemap Collider 2D settings model. */
export function normalizeTilemapColliderSettings(value: Partial<ITilemapColliderSettings> & { merge?: boolean } = {}): ITilemapColliderSettings {
	const compositeOperation = value.compositeOperation ?? (value.merge === false ? "none" : "merge");
	if (!["none", "merge", "intersect", "difference", "flip"].includes(compositeOperation)) {
		throw new Error("compositeOperation must be none, merge, intersect, difference, or flip.");
	}
	const geometryType = value.geometryType ?? "polygons";
	if (geometryType !== "polygons" && geometryType !== "outlines") {
		throw new Error("geometryType must be polygons or outlines.");
	}
	const generationType = value.generationType ?? "synchronous";
	if (generationType !== "synchronous" && generationType !== "manual") {
		throw new Error("generationType must be synchronous or manual.");
	}
	const layerOverrides = value.layerOverrides ?? ({} as Partial<ITilemapColliderLayerOverrides>);
	return {
		model: "unity-tilemap-collider-2d-v1",
		version: 1,
		compositeOperation,
		geometryType,
		generationType,
		useDelaunayMesh: value.useDelaunayMesh ?? false,
		maxTileChangeCount: integer(value.maxTileChangeCount ?? 1000, 1, 1_000_000, "maxTileChangeCount"),
		extrusionFactor: finite(value.extrusionFactor ?? 0, 0, 1_000_000, "extrusionFactor"),
		vertexDistance: finite(value.vertexDistance ?? 0.01, 0.000001, 1_000_000, "vertexDistance"),
		offsetDistance: finite(value.offsetDistance ?? 0, 0, 1_000_000, "offsetDistance"),
		offset: point(value.offset ?? [0, 0], "offset"),
		edgeRadius: finite(value.edgeRadius ?? 0.5, 0.001, 1_000_000, "edgeRadius"),
		tileColliderTypes: normalizeTileTypes(value.tileColliderTypes),
		spriteShapes: normalizeSpriteShapes(value.spriteShapes),
		materialId: value.materialId === undefined || value.materialId === null ? null : String(value.materialId),
		isTrigger: value.isTrigger ?? false,
		usedByEffector: value.usedByEffector ?? false,
		friction: finite(value.friction ?? 0, 0, 1, "friction"),
		restitution: finite(value.restitution ?? 0, 0, 1, "restitution"),
		collisionLayer: integer(value.collisionLayer ?? 0, 0, 31, "collisionLayer"),
		layerOverrides: {
			priority: integer(layerOverrides.priority ?? 0, -128, 127, "layerOverrides.priority"),
			includeLayers: mask(layerOverrides.includeLayers ?? 0, "layerOverrides.includeLayers"),
			excludeLayers: mask(layerOverrides.excludeLayers ?? 0, "layerOverrides.excludeLayers"),
			forceSendLayers: mask(layerOverrides.forceSendLayers ?? allLayersMask, "layerOverrides.forceSendLayers"),
			forceReceiveLayers: mask(layerOverrides.forceReceiveLayers ?? allLayersMask, "layerOverrides.forceReceiveLayers"),
			contactCaptureLayers: mask(layerOverrides.contactCaptureLayers ?? allLayersMask, "layerOverrides.contactCaptureLayers"),
			callbackLayers: mask(layerOverrides.callbackLayers ?? allLayersMask, "layerOverrides.callbackLayers"),
		},
	};
}

function cellKey(cell: Pick<ITilemapColliderCell, "x" | "y">): string {
	return `${cell.x},${cell.y}`;
}

function combineCells(cells: ITilemapColliderCell[], operation: TilemapCompositeOperation): ITilemapColliderCell[] {
	if (operation === "none") {
		return cells;
	}
	const layers = [...new Set(cells.map((cell) => cell.layer))].sort((a, b) => a - b);
	if (layers.length < 2 || operation === "merge") {
		const combined = new Map<string, ITilemapColliderCell[]>();
		for (const cell of cells) {
			combined.set(cellKey(cell), [...(combined.get(cellKey(cell)) ?? []), cell]);
		}
		return [...combined.entries()]
			.sort(([first], [second]) => first.localeCompare(second, undefined, { numeric: true }))
			.map(([, candidates]) => ({
				...((candidates as Array<ITilemapColliderCell & { type?: TilemapColliderType }>).find((candidate) => candidate.type === "sprite") ?? candidates[0]),
				layer: -1,
				tileId: candidates.map((candidate) => candidate.tileId).join("+"),
			}));
	}
	const byLayer = new Map(layers.map((layer) => [layer, new Map(cells.filter((cell) => cell.layer === layer).map((cell) => [cellKey(cell), cell]))]));
	const keys = new Set(cells.map(cellKey));
	const firstLayer = byLayer.get(layers[0])!;
	return [...keys]
		.sort((first, second) => first.localeCompare(second, undefined, { numeric: true }))
		.flatMap((key) => {
			const memberships = layers.filter((layer) => byLayer.get(layer)!.has(key));
			const keep =
				operation === "intersect"
					? memberships.length === layers.length
					: operation === "difference"
						? firstLayer.has(key) && memberships.length === 1
						: memberships.length % 2 === 1;
			if (!keep) {
				return [];
			}
			const source =
				memberships
					.map((layer) => byLayer.get(layer)!.get(key)!)
					.find((candidate) => (candidate as ITilemapColliderCell & { type?: TilemapColliderType }).type === "sprite") ?? byLayer.get(memberships[0])!.get(key)!;
			return [{ ...source, layer: -1 }];
		});
}

function rectangleRuns(cells: ITilemapColliderCell[], merge: boolean): Array<{ x: number; y: number; width: number; height: number; layer: number; tileIds: string[] }> {
	if (!merge) {
		return cells.map((cell) => ({ x: cell.x, y: cell.y, width: 1, height: 1, layer: cell.layer, tileIds: [cell.tileId] }));
	}
	const result: Array<{ x: number; y: number; width: number; height: number; layer: number; tileIds: string[] }> = [];
	const byLayer = new Map<number, ITilemapColliderCell[]>();
	for (const cell of cells) {
		byLayer.set(cell.layer, [...(byLayer.get(cell.layer) ?? []), cell]);
	}
	for (const [layer, layerCells] of [...byLayer.entries()].sort(([first], [second]) => first - second)) {
		const unique = new Map(layerCells.map((cell) => [cellKey(cell), cell]));
		while (unique.size) {
			const cell = [...unique.values()].sort((first, second) => first.y - second.y || first.x - second.x)[0];
			let width = 1;
			while (unique.has(`${cell.x + width},${cell.y}`)) {
				width++;
			}
			let height = 1;
			while ([...Array(width).keys()].every((offset) => unique.has(`${cell.x + offset},${cell.y + height}`))) {
				height++;
			}
			const tileIds: string[] = [];
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const key = `${cell.x + x},${cell.y + y}`;
					tileIds.push(unique.get(key)!.tileId);
					unique.delete(key);
				}
			}
			result.push({ x: cell.x, y: cell.y, width, height, layer, tileIds });
		}
	}
	return result;
}

function localCellCenter(x: number, y: number, stageSize: IPhysics2DPoint, cellSize: IPhysics2DPoint): IPhysics2DPoint {
	return [(x + 0.5 - stageSize[0] / 2) * cellSize[0], (stageSize[1] / 2 - y - 0.5) * cellSize[1]];
}

function simplifyRing(points: IPhysics2DPoint[], distance: number): IPhysics2DPoint[] {
	const result = points.filter((candidate, index) => {
		const previous = points[(index - 1 + points.length) % points.length];
		return Math.hypot(candidate[0] - previous[0], candidate[1] - previous[1]) >= distance;
	});
	return result.length >= 3 ? result : points;
}

function expandRing(points: IPhysics2DPoint[], distance: number): IPhysics2DPoint[] {
	if (!distance) {
		return points;
	}
	const center = points.reduce<IPhysics2DPoint>((sum, candidate) => [sum[0] + candidate[0] / points.length, sum[1] + candidate[1] / points.length], [0, 0]);
	return points.map((candidate) => {
		const dx = candidate[0] - center[0];
		const dy = candidate[1] - center[1];
		const length = Math.hypot(dx, dy) || 1;
		return [candidate[0] + (dx / length) * distance, candidate[1] + (dy / length) * distance];
	});
}

function triangulateConvexParts(parts: IPhysics2DPoint[][]): IPhysics2DPoint[][] {
	return parts.flatMap((part) => (part.length <= 3 ? [part] : [...Array(part.length - 2).keys()].map((index) => [part[0], part[index + 1], part[index + 2]])));
}

function orientation(first: IPhysics2DPoint, second: IPhysics2DPoint, third: IPhysics2DPoint): number {
	return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function counterClockwiseTriangle(first: IPhysics2DPoint, second: IPhysics2DPoint, third: IPhysics2DPoint): IPhysics2DPoint[] {
	return orientation(first, second, third) >= 0 ? [first, second, third] : [first, third, second];
}

function pointKey(value: IPhysics2DPoint): string {
	return `${value[0]},${value[1]}`;
}

function inCircumcircle(first: IPhysics2DPoint, second: IPhysics2DPoint, third: IPhysics2DPoint, pointValue: IPhysics2DPoint): boolean {
	const ax = first[0] - pointValue[0];
	const ay = first[1] - pointValue[1];
	const bx = second[0] - pointValue[0];
	const by = second[1] - pointValue[1];
	const cx = third[0] - pointValue[0];
	const cy = third[1] - pointValue[1];
	const determinant = (ax * ax + ay * ay) * (bx * cy - by * cx) - (bx * bx + by * by) * (ax * cy - ay * cx) + (cx * cx + cy * cy) * (ax * by - ay * bx);
	return orientation(first, second, third) >= 0 ? determinant > 0.000000001 : determinant < -0.000000001;
}

/** Legalizes unconstrained internal triangle edges without changing the decomposed collider domain. */
function triangulateDelaunay(parts: IPhysics2DPoint[][]): { parts: IPhysics2DPoint[][]; flipCount: number } {
	const triangles = triangulateConvexParts(parts).map((part) => counterClockwiseTriangle(part[0], part[1], part[2]));
	let flipCount = 0;
	const maximumFlips = triangles.length * triangles.length;
	for (let pass = 0; pass < maximumFlips; pass++) {
		let flipped = false;
		for (let firstIndex = 0; firstIndex < triangles.length && !flipped; firstIndex++) {
			for (let secondIndex = firstIndex + 1; secondIndex < triangles.length; secondIndex++) {
				const first = triangles[firstIndex];
				const second = triangles[secondIndex];
				const shared = first.filter((candidate) => second.some((other) => pointKey(candidate) === pointKey(other)));
				if (shared.length !== 2) {
					continue;
				}
				const firstOpposite = first.find((candidate) => !shared.some((other) => pointKey(candidate) === pointKey(other)))!;
				const secondOpposite = second.find((candidate) => !shared.some((other) => pointKey(candidate) === pointKey(other)))!;
				if (orientation(shared[0], shared[1], firstOpposite) * orientation(shared[0], shared[1], secondOpposite) >= -0.000000001) {
					continue;
				}
				if (!inCircumcircle(shared[0], firstOpposite, shared[1], secondOpposite)) {
					continue;
				}
				triangles[firstIndex] = counterClockwiseTriangle(firstOpposite, secondOpposite, shared[0]);
				triangles[secondIndex] = counterClockwiseTriangle(secondOpposite, firstOpposite, shared[1]);
				flipCount++;
				flipped = true;
				break;
			}
		}
		if (!flipped) {
			break;
		}
	}
	return { parts: triangles, flipCount };
}

function edgeCollider(
	first: IPhysics2DPoint,
	second: IPhysics2DPoint,
	options: { key: string; name: string; layer: number; tileIds: string[]; radius: number }
): ITilemapGeneratedCollider {
	const { key, name, layer, tileIds, radius } = options;
	const position: IPhysics2DPoint = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
	const localFirst: IPhysics2DPoint = [first[0] - position[0], first[1] - position[1]];
	const localSecond: IPhysics2DPoint = [second[0] - position[0], second[1] - position[1]];
	const dx = localSecond[0] - localFirst[0];
	const dy = localSecond[1] - localFirst[1];
	const length = Math.hypot(dx, dy) || 1;
	const nx = (-dy / length) * radius;
	const ny = (dx / length) * radius;
	return {
		key,
		name,
		position,
		layer,
		tileIds,
		shape: {
			shape: "edge",
			points: [localFirst, localSecond],
			parts: [
				[
					[localFirst[0] + nx, localFirst[1] + ny],
					[localSecond[0] + nx, localSecond[1] + ny],
					[localSecond[0] - nx, localSecond[1] - ny],
					[localFirst[0] - nx, localFirst[1] - ny],
				],
			],
			edgeRadius: radius,
		},
	};
}

function gridBoundaryEdges(
	cells: ITilemapColliderCell[],
	stageSize: IPhysics2DPoint,
	cellSize: IPhysics2DPoint,
	expansion: number,
	edgeRadius: number
): ITilemapGeneratedCollider[] {
	const occupancy = new Map(cells.map((cell) => [`${cell.layer}:${cellKey(cell)}`, cell]));
	const result: ITilemapGeneratedCollider[] = [];
	for (const cell of cells.sort((first, second) => first.layer - second.layer || first.y - second.y || first.x - second.x)) {
		const center = localCellCenter(cell.x, cell.y, stageSize, cellSize);
		const halfWidth = cellSize[0] / 2 + expansion;
		const halfHeight = cellSize[1] / 2 + expansion;
		const corners = {
			topLeft: [center[0] - halfWidth, center[1] + halfHeight] as IPhysics2DPoint,
			topRight: [center[0] + halfWidth, center[1] + halfHeight] as IPhysics2DPoint,
			bottomRight: [center[0] + halfWidth, center[1] - halfHeight] as IPhysics2DPoint,
			bottomLeft: [center[0] - halfWidth, center[1] - halfHeight] as IPhysics2DPoint,
		};
		for (const boundary of [
			{ side: "top", neighbor: `${cell.layer}:${cell.x},${cell.y - 1}`, first: corners.topLeft, second: corners.topRight },
			{ side: "right", neighbor: `${cell.layer}:${cell.x + 1},${cell.y}`, first: corners.topRight, second: corners.bottomRight },
			{ side: "bottom", neighbor: `${cell.layer}:${cell.x},${cell.y + 1}`, first: corners.bottomRight, second: corners.bottomLeft },
			{ side: "left", neighbor: `${cell.layer}:${cell.x - 1},${cell.y}`, first: corners.bottomLeft, second: corners.topLeft },
		]) {
			if (!occupancy.has(boundary.neighbor)) {
				result.push(
					edgeCollider(boundary.first, boundary.second, {
						key: `grid-edge:${cell.layer}:${cell.x}:${cell.y}:${boundary.side}`,
						name: `Tile outline ${cell.x},${cell.y} ${boundary.side}`,
						layer: cell.layer,
						tileIds: [cell.tileId],
						radius: edgeRadius,
					})
				);
			}
		}
	}
	return result;
}

type ISpriteColliderTemplate = {
	contours: IPhysics2DPolygonContour[];
	decomposition: ReturnType<typeof decomposePhysics2DPolygonContours>;
	triangulation: { parts: IPhysics2DPoint[][]; flipCount: number };
};

function spriteColliders(
	cell: ITilemapColliderCell,
	settings: ITilemapColliderSettings,
	stageSize: IPhysics2DPoint,
	cellSize: IPhysics2DPoint,
	expansion: number,
	templates: Map<number, ISpriteColliderTemplate>
): ITilemapGeneratedCollider[] {
	const source = settings.spriteShapes[String(cell.tileIndex)];
	if (!source) {
		throw new Error(`Tile ${cell.tileIndex} uses Sprite collider type but has no normalized spriteShapes entry.`);
	}
	const position = localCellCenter(cell.x, cell.y, stageSize, cellSize);
	let template = templates.get(cell.tileIndex);
	if (!template) {
		const contours = source.map((contour) => ({
			id: contour.id,
			points: simplifyRing(
				expandRing(
					contour.points.map(([x, y]) => [x * cellSize[0], -y * cellSize[1]]),
					expansion
				),
				settings.vertexDistance
			),
			holes: contour.holes.map((hole) => ({
				id: hole.id,
				points: simplifyRing(
					expandRing(
						hole.points.map(([x, y]) => [x * cellSize[0], -y * cellSize[1]]),
						-expansion
					),
					settings.vertexDistance
				),
			})),
		}));
		const decomposition = decomposePhysics2DPolygonContours(contours);
		template = {
			contours,
			decomposition,
			triangulation: settings.useDelaunayMesh ? triangulateDelaunay(decomposition.parts) : { parts: decomposition.parts, flipCount: 0 },
		};
		templates.set(cell.tileIndex, template);
	}
	const { contours, decomposition, triangulation } = template;
	if (settings.geometryType === "outlines") {
		return contours.flatMap((contour, contourIndex) =>
			[contour.points, ...contour.holes.map((hole) => hole.points)].flatMap((ring, ringIndex) =>
				ring.map((first, pointIndex) => {
					const second = ring[(pointIndex + 1) % ring.length];
					return edgeCollider([first[0] + position[0], first[1] + position[1]], [second[0] + position[0], second[1] + position[1]], {
						key: `sprite-edge:${cell.layer}:${cell.x}:${cell.y}:${cell.tileIndex}:${contourIndex}:${ringIndex}:${pointIndex}`,
						name: `Sprite tile ${cell.tileIndex} outline`,
						layer: cell.layer,
						tileIds: [cell.tileId],
						radius: settings.edgeRadius,
					});
				})
			)
		);
	}
	return [
		{
			key: `sprite-polygon:${cell.layer}:${cell.x}:${cell.y}:${cell.tileIndex}`,
			name: `Sprite tile ${cell.tileIndex} collider`,
			position,
			layer: cell.layer,
			tileIds: [cell.tileId],
			shape: {
				shape: "polygon",
				version: 2,
				model: decomposition.model,
				contours: decomposition.contours,
				points: decomposition.contours[0].points,
				parts: triangulation.parts,
				outerCount: decomposition.outerCount,
				holeCount: decomposition.holeCount,
				vertexCount: decomposition.vertexCount,
				filledArea: decomposition.filledArea,
				decomposedArea: decomposition.decomposedArea,
				delaunayFlipCount: triangulation.flipCount,
			},
		},
	];
}

/** Generates deterministic box, compound polygon, or boundary-edge bodies for Sprite Map cells. */
export function generateTilemapColliderGeometry(
	settingsValue: Partial<ITilemapColliderSettings>,
	cellsValue: ITilemapColliderCell[],
	stageSizeValue: IPhysics2DPoint,
	cellSizeValue: IPhysics2DPoint
): ITilemapColliderGeometry {
	const settings = normalizeTilemapColliderSettings(settingsValue);
	const stageSize: IPhysics2DPoint = [integer(stageSizeValue[0], 1, 4096, "stageSize width"), integer(stageSizeValue[1], 1, 4096, "stageSize height")];
	const cellSize: IPhysics2DPoint = [finite(cellSizeValue[0], 0.000001, 1_000_000, "cellSize width"), finite(cellSizeValue[1], 0.000001, 1_000_000, "cellSize height")];
	if (!Array.isArray(cellsValue) || cellsValue.length > 65_536) {
		throw new Error("Tilemap collider generation supports at most 65,536 expanded cells.");
	}
	const inputCells = cellsValue.map((cell, index) => ({
		x: integer(cell.x, 0, stageSize[0] - 1, `cell ${index} x`),
		y: integer(cell.y, 0, stageSize[1] - 1, `cell ${index} y`),
		layer: integer(cell.layer, 0, 255, `cell ${index} layer`),
		tileIndex: integer(cell.tileIndex, 0, 1_000_000, `cell ${index} tileIndex`),
		tileId: String(cell.tileId),
	}));
	const unique = new Map(inputCells.map((cell) => [`${cell.layer}:${cellKey(cell)}`, cell]));
	const typed = [...unique.values()].flatMap((cell) => {
		const type = settings.tileColliderTypes[String(cell.tileIndex)] ?? "grid";
		return type === "none" ? [] : [{ ...cell, type }];
	});
	const combined = combineCells(typed, settings.compositeOperation) as Array<ITilemapColliderCell & { type: TilemapColliderType }>;
	const gridCells = combined.filter((cell) => cell.type !== "sprite");
	const spriteCells = combined.filter((cell) => cell.type === "sprite");
	const expansion = settings.extrusionFactor + (settings.compositeOperation === "none" ? 0 : settings.offsetDistance);
	const colliders: ITilemapGeneratedCollider[] = [];
	const spriteTemplates = new Map<number, ISpriteColliderTemplate>();
	if (settings.geometryType === "outlines") {
		const gridEdges = gridBoundaryEdges(gridCells, stageSize, cellSize, expansion, settings.edgeRadius);
		for (const edge of gridEdges) {
			edge.position = [edge.position[0] + settings.offset[0], edge.position[1] + settings.offset[1]];
		}
		colliders.push(...gridEdges);
	} else {
		const merge = settings.compositeOperation !== "none";
		for (const run of rectangleRuns(gridCells, merge)) {
			const position = localCellCenter(run.x + (run.width - 1) / 2, run.y + (run.height - 1) / 2, stageSize, cellSize);
			colliders.push({
				key: `grid-box:${run.layer}:${run.x}:${run.y}:${run.width}:${run.height}`,
				name: `Tile collider ${run.x},${run.y}`,
				position: [position[0] + settings.offset[0], position[1] + settings.offset[1]],
				layer: run.layer,
				tileIds: run.tileIds,
				shape: { shape: "box", size: [cellSize[0] * run.width + expansion * 2, cellSize[1] * run.height + expansion * 2] },
			});
		}
	}
	for (const cell of spriteCells) {
		for (const collider of spriteColliders(cell, settings, stageSize, cellSize, expansion, spriteTemplates)) {
			collider.position = [collider.position[0] + settings.offset[0], collider.position[1] + settings.offset[1]];
			colliders.push(collider);
		}
	}
	if (colliders.length > 65_536) {
		throw new Error("Tilemap collider generation produced more than 65,536 collider bodies.");
	}
	const counts = colliders.reduce(
		(result, collider) => {
			result[collider.shape.shape]++;
			result.parts += collider.shape.shape === "box" ? 1 : collider.shape.parts.length;
			return result;
		},
		{ box: 0, polygon: 0, edge: 0, parts: 0 }
	);
	const delaunayFlipCount = settings.useDelaunayMesh
		? colliders.reduce((count, collider) => count + (collider.shape.shape === "polygon" ? collider.shape.delaunayFlipCount : 0), 0)
		: 0;
	return {
		model: "unity-tilemap-collider-2d-geometry-v1",
		colliders,
		evidence: {
			inputCellCount: inputCells.length,
			filteredCellCount: typed.length,
			gridCellCount: gridCells.length,
			spriteCellCount: spriteCells.length,
			outputColliderCount: colliders.length,
			boxCount: counts.box,
			polygonCount: counts.polygon,
			edgeCount: counts.edge,
			convexPartCount: counts.parts,
			compositeOperation: settings.compositeOperation,
			geometryType: settings.geometryType,
			triangulation: settings.useDelaunayMesh ? "bounded-delaunay-edge-flips-v1" : "convex-parts",
			delaunayFlipCount,
		},
	};
}
