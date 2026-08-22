import { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import type { Scene } from "@babylonjs/core/scene";

export interface IGeometryBufferRequirements {
	transparent?: boolean;
	depth?: boolean;
	normal?: boolean;
	position?: boolean;
	velocity?: boolean;
	velocityLinear?: boolean;
	reflectivity?: boolean;
	screenspaceDepth?: boolean;
	irradiance?: boolean;
}

export interface IGeometryBufferLeaseEvidence {
	active: boolean;
	owned: boolean;
	holderCount: number;
	holders: string[];
	ready: boolean;
	width: number;
	height: number;
	textureCount: number;
	requirements: Required<IGeometryBufferRequirements>;
}

type IGeometryBufferFlags = Required<IGeometryBufferRequirements>;

interface IGeometryBufferLeaseState {
	renderer: GeometryBufferRenderer;
	owned: boolean;
	baseline: IGeometryBufferFlags;
	holders: Map<string, IGeometryBufferRequirements>;
}

const states = new WeakMap<Scene, IGeometryBufferLeaseState>();

function flags(renderer: GeometryBufferRenderer): IGeometryBufferFlags {
	return {
		transparent: Boolean(renderer.renderTransparentMeshes),
		depth: renderer.enableDepth,
		normal: renderer.enableNormal,
		position: renderer.enablePosition,
		velocity: renderer.enableVelocity,
		velocityLinear: renderer.enableVelocityLinear,
		reflectivity: renderer.enableReflectivity,
		screenspaceDepth: renderer.enableScreenspaceDepth,
		irradiance: renderer.enableIrradiance,
	};
}

function combined(state: IGeometryBufferLeaseState): IGeometryBufferFlags {
	const result = { ...state.baseline };
	for (const requirements of state.holders.values()) {
		for (const key of Object.keys(result) as Array<keyof IGeometryBufferFlags>) {
			result[key] ||= requirements[key] === true;
		}
	}
	return result;
}

function apply(renderer: GeometryBufferRenderer, value: IGeometryBufferFlags): void {
	if (renderer.renderTransparentMeshes !== value.transparent) {
		renderer.renderTransparentMeshes = value.transparent;
	}
	if (renderer.enableDepth !== value.depth) {
		renderer.enableDepth = value.depth;
	}
	if (renderer.enableNormal !== value.normal) {
		renderer.enableNormal = value.normal;
	}
	if (renderer.enablePosition !== value.position) {
		renderer.enablePosition = value.position;
	}
	if (renderer.enableVelocity !== value.velocity) {
		renderer.enableVelocity = value.velocity;
	}
	if (renderer.enableVelocityLinear !== value.velocityLinear) {
		renderer.enableVelocityLinear = value.velocityLinear;
	}
	if (renderer.enableReflectivity !== value.reflectivity) {
		renderer.enableReflectivity = value.reflectivity;
	}
	if (renderer.enableScreenspaceDepth !== value.screenspaceDepth) {
		renderer.enableScreenspaceDepth = value.screenspaceDepth;
	}
	if (renderer.enableIrradiance !== value.irradiance) {
		renderer.enableIrradiance = value.irradiance;
	}
}

function evidence(state: IGeometryBufferLeaseState | undefined): IGeometryBufferLeaseEvidence {
	if (!state) {
		return {
			active: false,
			owned: false,
			holderCount: 0,
			holders: [],
			ready: false,
			width: 0,
			height: 0,
			textureCount: 0,
			requirements: {
				transparent: false,
				depth: false,
				normal: false,
				position: false,
				velocity: false,
				velocityLinear: false,
				reflectivity: false,
				screenspaceDepth: false,
				irradiance: false,
			},
		};
	}
	const target = state.renderer.getGBuffer();
	const size = target.getSize();
	return {
		active: true,
		owned: state.owned,
		holderCount: state.holders.size,
		holders: [...state.holders.keys()].sort(),
		ready: target.isReady(),
		width: size.width,
		height: size.height,
		textureCount: target.count,
		requirements: combined(state),
	};
}

/** Acquires or updates one named scene-wide G-buffer requirement lease. */
export function acquireGeometryBufferLease(scene: Scene, holder: string, requirements: IGeometryBufferRequirements): GeometryBufferRenderer {
	if (!holder.trim() || holder.length > 256) {
		throw new Error("Geometry-buffer holder must contain 1–256 characters.");
	}
	let state = states.get(scene);
	if (!state) {
		const existing = scene.geometryBufferRenderer;
		const renderer = existing ?? scene.enableGeometryBufferRenderer(1);
		if (!renderer?.isSupported) {
			throw new Error(
				"A native Babylon geometry buffer is unavailable because this rendering backend does not support a geometry buffer; multiple render targets are required."
			);
		}
		state = { renderer, owned: !existing, baseline: flags(renderer), holders: new Map() };
		states.set(scene, state);
	}
	state.holders.set(holder, { ...requirements });
	apply(state.renderer, combined(state));
	return state.renderer;
}

/** Releases one named requirement and restores or disposes the shared G-buffer exactly after the final holder. */
export function releaseGeometryBufferLease(scene: Scene, holder: string): IGeometryBufferLeaseEvidence {
	const state = states.get(scene);
	if (!state || !state.holders.delete(holder)) {
		return evidence(state);
	}
	if (state.holders.size) {
		apply(state.renderer, combined(state));
		return evidence(state);
	}
	apply(state.renderer, state.baseline);
	if (state.owned && scene.geometryBufferRenderer === state.renderer) {
		scene.disableGeometryBufferRenderer();
	}
	states.delete(scene);
	return evidence(undefined);
}

/** Returns bounded immutable evidence for the shared scene G-buffer lease. */
export function getGeometryBufferLeaseEvidence(scene: Scene): IGeometryBufferLeaseEvidence {
	return structuredClone(evidence(states.get(scene)));
}
