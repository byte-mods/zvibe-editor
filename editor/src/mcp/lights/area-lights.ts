import { Light, Scene, Vector3 } from "babylonjs";
import { getAreaLightEvidence, getAreaLightMetadata, getDeferredLightingRuntimes, setAreaLightProperties as applyAreaLightProperties } from "babylonjs-editor-tools";

import { addDiscAreaLight, addRectangleAreaLight } from "../../project/add/light";
import { isClusteredLightContainer, isRectAreaLight } from "../../tools/guards/nodes";
import { IMCPActionOptions } from "../action";
import { resolveNode, toColor3, toNodeSummary, toVector3 } from "../tools/resolve";

function resolveAreaLight(scene: Scene, data: Record<string, any>) {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isRectAreaLight(node)) {
		throw new Error(`Node "${node.name}" is not a rectangle or disc area light.`);
	}
	return node;
}

function validateVector(value: unknown, name: string): void {
	if (value !== undefined && Vector3.FromArray(value as number[]).lengthSquared() < 0.000001) {
		throw new Error(`Area-light ${name} must be a non-zero vector.`);
	}
}

function validateDimensions(data: Record<string, any>): void {
	for (const name of ["width", "height", "radius", "range"] as const) {
		const value = data[name];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
			throw new Error(`Area-light ${name} must be a finite value greater than zero.`);
		}
	}
	validateVector(data.direction, "direction");
	validateVector(data.upDirection, "upDirection");
}

function result(scene: Scene, light: Light): Record<string, unknown> {
	return {
		light: toNodeSummary(light),
		areaLight: getAreaLightEvidence(light as any),
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

/** Creates one regular scene-owned Unity-style area light. */
export function createAreaLight(scene: Scene, data: Record<string, any>, options: IMCPActionOptions): Record<string, unknown> {
	validateDimensions(data);
	let parent;
	if (data.parentId || data.parentName) {
		parent = resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName });
		if (isClusteredLightContainer(parent)) {
			throw new Error("Area lights cannot be created in the ClusteredLightContainer; they require regular Babylon LTC lighting.");
		}
	}
	const shape = data.shape as "rectangle" | "disc";
	const light = shape === "disc" ? addDiscAreaLight(options.editor, parent) : addRectangleAreaLight(options.editor, parent);
	try {
		if (data.name) {
			light.name = data.name;
		}
		if (data.position) {
			light.position.copyFrom(toVector3(data.position));
		}
		if (data.color) {
			light.diffuse.copyFrom(toColor3(data.color));
		}
		if (data.specular) {
			light.specular.copyFrom(toColor3(data.specular));
		}
		if (data.intensity !== undefined) {
			light.intensity = data.intensity;
		}
		if (data.range !== undefined) {
			light.range = data.range;
		}
		if (data.enabled !== undefined) {
			light.setEnabled(data.enabled);
		}
		applyAreaLightProperties(light as any, {
			shape,
			width: data.width,
			height: data.height,
			radius: data.radius,
			direction: data.direction,
			upDirection: data.upDirection,
			revision: 1,
		});
		options.editor.layout.inspector.setEditedObject(light);
		options.editor.layout.inspector.forceUpdate();
		return result(scene, light);
	} catch (error) {
		light.dispose();
		throw error;
	}
}

/** Reads exact shape, basis, model, and revision evidence without changing the scene. */
export function getAreaLight(scene: Scene, data: Record<string, any>): Record<string, unknown> {
	return result(scene, resolveAreaLight(scene, data));
}

/** Mutates one exact-leased area light and advances its portable revision once. */
export function setAreaLight(scene: Scene, data: Record<string, any>, options: IMCPActionOptions): Record<string, unknown> {
	validateDimensions(data);
	const light = resolveAreaLight(scene, data);
	const current = getAreaLightMetadata(light as any);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`Area light changed after inspection. Expected revision ${data.expectedRevision ?? "missing"}, but the current revision is ${current.revision}.`);
	}
	const mutationKeys = ["shape", "width", "height", "radius", "direction", "upDirection", "position", "color", "specular", "intensity", "range", "enabled", "name"];
	if (!mutationKeys.some((key) => data[key] !== undefined)) {
		throw new Error("set_area_light requires at least one area-light property to change.");
	}
	if (data.name !== undefined) {
		light.name = data.name;
	}
	if (data.position !== undefined) {
		light.position.copyFrom(toVector3(data.position));
	}
	if (data.color !== undefined) {
		light.diffuse.copyFrom(toColor3(data.color));
	}
	if (data.specular !== undefined) {
		light.specular.copyFrom(toColor3(data.specular));
	}
	if (data.intensity !== undefined) {
		light.intensity = data.intensity;
	}
	if (data.range !== undefined) {
		light.range = data.range;
	}
	if (data.enabled !== undefined) {
		light.setEnabled(data.enabled);
	}
	applyAreaLightProperties(light as any, {
		shape: data.shape,
		width: data.width,
		height: data.height,
		radius: data.radius,
		direction: data.direction,
		upDirection: data.upDirection,
	});
	options.editor.layout.inspector.setEditedObject(light);
	options.editor.layout.inspector.forceUpdate();
	return result(scene, light);
}
