import { Color4, Constants, LinesMesh, MeshBuilder, Scene, Vector3 } from "babylonjs";

import { setNodeSerializable, setNodeVisibleInGraph } from "../../tools/node/metadata";

import { IPhysicsForceDebugVector, IPhysicsForceVisualizationSettings, PhysicsForceVectorCategory } from "./force-visualization-types";

const maximumRenderedVectorLength = 100_000;

const categoryColors: Readonly<Record<PhysicsForceVectorCategory, Color4>> = {
	"gravity-force": new Color4(0.35, 0.65, 1, 1),
	"net-force": new Color4(1, 0.25, 0.2, 1),
	"linear-velocity": new Color4(0.2, 1, 0.45, 1),
	"angular-velocity": new Color4(0.8, 0.35, 1, 1),
	"contact-normal": new Color4(1, 0.85, 0.1, 1),
	"contact-impulse": new Color4(1, 0.45, 0.05, 1),
	"constraint-axis": new Color4(0.1, 0.95, 1, 1),
	"constraint-separation": new Color4(1, 0.25, 0.75, 1),
};

/** Resolves the independently authored viewport scale for one exact vector category. */
function categoryScale(category: PhysicsForceVectorCategory, settings: IPhysicsForceVisualizationSettings): number {
	switch (category) {
		case "gravity-force":
		case "net-force":
			return settings.forceScale;
		case "contact-impulse":
			return settings.impulseScale;
		case "linear-velocity":
			return settings.velocityScale;
		case "angular-velocity":
			return settings.angularVelocityScale;
		case "contact-normal":
		case "constraint-axis":
			return settings.directionScale;
		case "constraint-separation":
			return settings.separationScale;
	}
}

/** Converts one raw vector into a finite, length-bounded viewport arrow without modifying its evidence. */
function arrow(vector: IPhysicsForceDebugVector, settings: IPhysicsForceVisualizationSettings): Vector3[] | null {
	if (![...vector.origin, ...vector.vector].every(Number.isFinite)) {
		return null;
	}
	const origin = Vector3.FromArray(vector.origin);
	const raw = Vector3.FromArray(vector.vector).scale(categoryScale(vector.category, settings));
	const rawLength = raw.length();
	if (!Number.isFinite(rawLength) || rawLength <= 0) {
		return null;
	}
	const direction = raw.scale(1 / rawLength);
	const length = Math.min(rawLength, maximumRenderedVectorLength);
	const end = origin.add(direction.scale(length));
	const reference = Math.abs(Vector3.Dot(direction, Vector3.Up())) > 0.95 ? Vector3.Right() : Vector3.Up();
	const side = Vector3.Cross(direction, reference).normalize();
	const headLength = Math.min(settings.pointSize, length * 0.35);
	const headBack = direction.scale(-headLength);
	const headSide = side.scale(headLength * 0.5);
	return [origin, end, end, end.add(headBack).add(headSide), end, end.add(headBack).subtract(headSide)];
}

/**
 * Builds one bounded line system for all visible vectors. The result is temporary editor-only
 * geometry: it cannot be picked, serialized, or displayed in the scene hierarchy.
 */
export function createPhysicsForceVectorOverlay(scene: Scene, vectors: readonly IPhysicsForceDebugVector[], settings: IPhysicsForceVisualizationSettings): LinesMesh | null {
	const lines: Vector3[][] = [];
	const colors: Color4[][] = [];
	for (const vector of vectors.slice(0, settings.maximumVectors)) {
		const points = arrow(vector, settings);
		if (!points) {
			continue;
		}
		const color = categoryColors[vector.category];
		for (let index = 0; index < points.length; index += 2) {
			lines.push([points[index], points[index + 1]]);
			colors.push([color, color]);
		}
	}
	if (!lines.length) {
		return null;
	}
	const overlay = MeshBuilder.CreateLineSystem("Physics Force Vectors", { lines, colors, useVertexAlpha: false }, scene);
	overlay.isPickable = false;
	overlay.alwaysSelectAsActiveMesh = true;
	overlay.renderingGroupId = 3;
	if (overlay.material) {
		overlay.material.disableDepthWrite = true;
		overlay.material.depthFunction = Constants.ALWAYS;
	}
	setNodeSerializable(overlay, false);
	setNodeVisibleInGraph(overlay, false);
	return overlay;
}
