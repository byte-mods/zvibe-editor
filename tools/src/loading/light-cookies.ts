import type { Light } from "@babylonjs/core/Lights/light";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";

export const lightCookieMetadataKey = "babylonEditorLightCookie" as const;
export const lightCookieBackend = "unity-style-light-cookie-v1" as const;
export const lightCookieMaximumSources = 8;

export type LightCookieKind = "spot-2d" | "directional-2d" | "point-cube";

export interface ILightCookieMetadata {
	version: 1;
	revision: number;
	kind: LightCookieKind;
	enabled: boolean;
	intensity: number;
	texture: Record<string, unknown> | null;
	size: [number, number];
	offset: [number, number];
	near: number;
	far: number;
	upDirection: [number, number, number];
}

export interface ILightCookieEvidence extends Omit<ILightCookieMetadata, "texture"> {
	backend: typeof lightCookieBackend;
	lightId: string;
	lightName: string;
	lightType: "spot" | "directional" | "point";
	textureName: string;
	textureUrl: string | null;
	textureReady: boolean;
	textureIsCube: boolean;
	textureWidth: number;
	textureHeight: number;
}

const runtimeTextures = new WeakMap<Light, BaseTexture>();

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function tuple2(value: unknown, fallback: [number, number], minimum: number, maximum: number): [number, number] {
	return Array.isArray(value) && value.length === 2 ? [finite(value[0], fallback[0], minimum, maximum), finite(value[1], fallback[1], minimum, maximum)] : [...fallback];
}

function tuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		return [...fallback];
	}
	const direction = new Vector3(value[0], value[1], value[2]);
	if (direction.lengthSquared() < 0.000001) {
		return [...fallback];
	}
	direction.normalize();
	return [direction.x, direction.y, direction.z];
}

function lightType(light: Light): ILightCookieEvidence["lightType"] | null {
	return light.getTypeID() === 2 ? "spot" : light.getTypeID() === 1 ? "directional" : light.getTypeID() === 0 ? "point" : null;
}

export function lightCookieKindForLight(light: Light): LightCookieKind | null {
	const type = lightType(light);
	return type === "spot" ? "spot-2d" : type === "directional" ? "directional-2d" : type === "point" ? "point-cube" : null;
}

function nativeSpotTexture(light: Light): BaseTexture | null {
	return light.getTypeID() === 2 ? ((light as SpotLight).projectionTexture ?? null) : null;
}

export function getLightCookieTexture(light: Light): BaseTexture | null {
	return runtimeTextures.get(light) ?? nativeSpotTexture(light);
}

export function getLightCookieMetadata(light: Light): ILightCookieMetadata | null {
	const kind = lightCookieKindForLight(light);
	const source = light.metadata?.[lightCookieMetadataKey] as Partial<ILightCookieMetadata> | undefined;
	const texture = getLightCookieTexture(light);
	if (!kind || (!source && !texture)) {
		return null;
	}
	const near = finite(source?.near, light.getTypeID() === 2 ? (light as SpotLight).projectionTextureLightNear : 0.01, 0.000001, 1_000_000);
	const far = finite(source?.far, light.getTypeID() === 2 ? (light as SpotLight).projectionTextureLightFar : 1000, near + 0.000001, 10_000_000);
	return {
		version: 1,
		revision: Number.isInteger(source?.revision) && source!.revision! > 0 ? source!.revision! : 1,
		kind,
		enabled: source?.enabled !== false,
		intensity: finite(source?.intensity, 1, 0, 1),
		texture: source?.texture && typeof source.texture === "object" ? source.texture : ((texture?.serialize?.() as Record<string, unknown> | null) ?? null),
		size: tuple2(source?.size, [1000, 1000], 0.0001, 10_000_000),
		offset: tuple2(source?.offset, [0, 0], -1_000_000, 1_000_000),
		near,
		far,
		upDirection: tuple3(source?.upDirection, [0, 1, 0]),
	};
}

function writeMetadata(light: Light, metadata: ILightCookieMetadata | null): void {
	light.metadata ??= {};
	if (metadata) {
		light.metadata[lightCookieMetadataKey] = metadata;
	} else {
		delete light.metadata[lightCookieMetadataKey];
	}
}

export interface ISetLightCookieOptions {
	enabled?: boolean;
	intensity?: number;
	size?: [number, number];
	offset?: [number, number];
	near?: number;
	far?: number;
	upDirection?: [number, number, number];
	revision?: number;
}

/** Assigns or updates one validated cookie and persists a portable serialized texture snapshot on the light. */
export function setLightCookie(light: Light, texture: BaseTexture | null, options: ISetLightCookieOptions = {}): ILightCookieEvidence | null {
	const kind = lightCookieKindForLight(light);
	if (!kind) {
		throw new Error(`Light "${light.name}" (${light.getClassName()}) does not support Unity-style cookies; use a spot, directional, or point light.`);
	}
	if (!texture) {
		runtimeTextures.delete(light);
		if (light.getTypeID() === 2) {
			(light as SpotLight).projectionTexture = null;
		}
		writeMetadata(light, null);
		return null;
	}
	if (!light.getScene().lights.includes(light)) {
		throw new Error(`Light "${light.name}" must be a regular scene light before assigning a cookie; remove it from the ClusteredLightContainer first.`);
	}
	if (kind === "point-cube" && !texture.isCube) {
		throw new Error(`Point-light cookie "${texture.name}" must be a cubemap texture.`);
	}
	if (kind !== "point-cube" && texture.isCube) {
		throw new Error(`${kind === "spot-2d" ? "Spot" : "Directional"}-light cookie "${texture.name}" must be a 2D texture.`);
	}
	const current = getLightCookieMetadata(light);
	const sameTexture = texture === getLightCookieTexture(light);
	const near = finite(options.near, current?.near ?? 0.000001, 0.000001, 1_000_000);
	const far = finite(options.far, current?.far ?? 1000, near + 0.000001, 10_000_000);
	const metadata: ILightCookieMetadata = {
		version: 1,
		revision: options.revision ?? (current?.revision ?? 0) + 1,
		kind,
		enabled: options.enabled ?? current?.enabled ?? true,
		intensity: finite(options.intensity, current?.intensity ?? 1, 0, 1),
		texture: sameTexture && current?.texture ? current.texture : ((texture.serialize?.() as Record<string, unknown> | null) ?? null),
		size: tuple2(options.size, current?.size ?? [1000, 1000], 0.0001, 10_000_000),
		offset: tuple2(options.offset, current?.offset ?? [0, 0], -1_000_000, 1_000_000),
		near,
		far,
		upDirection: tuple3(options.upDirection, current?.upDirection ?? [0, 1, 0]),
	};
	runtimeTextures.set(light, texture);
	if (light.getTypeID() === 2) {
		const spot = light as SpotLight;
		spot.projectionTexture = texture;
		spot.projectionTextureLightNear = metadata.near;
		spot.projectionTextureLightFar = metadata.far;
		spot.projectionTextureUpDirection = Vector3.FromArray(metadata.upDirection);
	}
	writeMetadata(light, metadata);
	return getLightCookieEvidence(light);
}

/** Rehydrates editor-owned directional and point cookies after full or additive scene loading. */
export function configureLightCookies(scene: Scene, rootUrl = "", lights: Light[] = scene.lights): ILightCookieEvidence[] {
	for (const light of lights) {
		const metadata = getLightCookieMetadata(light);
		if (!metadata) {
			continue;
		}
		let texture = getLightCookieTexture(light);
		if (!texture && metadata.texture) {
			texture = Texture.Parse(structuredClone(metadata.texture), scene, rootUrl);
		}
		if (texture) {
			setLightCookie(light, texture, { ...metadata, revision: metadata.revision });
		}
	}
	return lights.map(getLightCookieEvidence).filter((evidence): evidence is ILightCookieEvidence => evidence !== null);
}

export function getLightCookieEvidence(light: Light): ILightCookieEvidence | null {
	const type = lightType(light);
	const metadata = getLightCookieMetadata(light);
	const texture = getLightCookieTexture(light);
	if (!type || !metadata || !texture) {
		return null;
	}
	const size = texture.getSize();
	const value = texture as BaseTexture & { url?: string };
	return {
		backend: lightCookieBackend,
		version: metadata.version,
		revision: metadata.revision,
		kind: metadata.kind,
		enabled: metadata.enabled,
		intensity: metadata.intensity,
		size: metadata.size,
		offset: metadata.offset,
		near: metadata.near,
		far: metadata.far,
		upDirection: metadata.upDirection,
		lightId: light.id,
		lightName: light.name,
		lightType: type,
		textureName: texture.name,
		textureUrl: typeof value.url === "string" ? value.url : null,
		textureReady: texture.isReadyOrNotBlocking(),
		textureIsCube: texture.isCube,
		textureWidth: size.width,
		textureHeight: size.height,
	};
}
