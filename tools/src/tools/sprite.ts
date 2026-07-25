import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteMap } from "@babylonjs/core/Sprites/spriteMap";
import { IVector2Like } from "@babylonjs/core/Maths/math.like";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import { spritesVertexShader as spritesVertexShaderGlsl } from "@babylonjs/core/Shaders/sprites.vertex";
import { spritesVertexShaderWGSL as spritesVertexShaderWgsl } from "@babylonjs/core/ShadersWGSL/sprites.vertex";

declare module "@babylonjs/core/Sprites/sprite" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	export interface Sprite {
		metadata: any;
	}
}

export interface ISpriteAnimation {
	name: string;
	from: number;
	to: number;
	loop: boolean;
	delay: number;
}

export interface ISpriteMapTile {
	id: string;
	name: string;
	layer: number;
	position: IVector2Like;
	repeatCount: IVector2Like;
	repeatOffset: IVector2Like;
	tile: number;
}

interface ISpriteShaderStore {
	ShadersStore: Record<string, string>;
	ShadersStoreWGSL: Record<string, string>;
}

const rotatedPackedSpriteMarker = "babylonEditorPackedRotation";
const configuredPackedSpriteManagers = new WeakSet<object>();

/** Installs packed-frame UV rotation support into Babylon's shared sprite shader store before a SpriteManager is created. */
export function installRotatedPackedSpriteShaders(shaderStore: ISpriteShaderStore): void {
	if (!shaderStore.ShadersStore.spritesVertexShader?.includes(rotatedPackedSpriteMarker)) {
		const original = shaderStore.ShadersStore.spritesVertexShader ?? spritesVertexShaderGlsl.shader;
		const search =
			"vec2 uvOffset=vec2(abs(offset.x-inverts.x),abs(1.0-offset.y-inverts.y));vec2 uvPlace=cellInfo.xy;vec2 uvSize=cellInfo.zw;vUV.x=uvPlace.x+uvSize.x*uvOffset.x;vUV.y=uvPlace.y+uvSize.y*uvOffset.y;";
		const replacement = `vec2 uvOffset=vec2(abs(offset.x-inverts.x),abs(1.0-offset.y-inverts.y));vec2 uvPlace=cellInfo.xy;vec2 uvSize=cellInfo.zw;float ${rotatedPackedSpriteMarker}=step(0.0,-uvSize.x);uvSize.x=abs(uvSize.x);if(${rotatedPackedSpriteMarker}>0.5){uvOffset=vec2(1.0-uvOffset.y,uvOffset.x);}vUV.x=uvPlace.x+uvSize.x*uvOffset.x;vUV.y=uvPlace.y+uvSize.y*uvOffset.y;`;
		const patched = original.replace(search, replacement);
		if (patched === original) {
			throw new Error("Babylon GLSL sprite shader layout changed; rotated packed sprites cannot be installed safely.");
		}
		shaderStore.ShadersStore.spritesVertexShader = patched;
	}
	if (!shaderStore.ShadersStoreWGSL.spritesVertexShader?.includes(rotatedPackedSpriteMarker)) {
		const original = shaderStore.ShadersStoreWGSL.spritesVertexShader ?? spritesVertexShaderWgsl.shader;
		const search =
			"var uvOffset: vec2f= vec2f(abs(offset.x-vertexInputs.inverts.x),abs(1.0-offset.y-vertexInputs.inverts.y));var uvPlace: vec2f=vertexInputs.cellInfo.xy;var uvSize: vec2f=vertexInputs.cellInfo.zw;vertexOutputs.vUV.x=uvPlace.x+uvSize.x*uvOffset.x;vertexOutputs.vUV.y=uvPlace.y+uvSize.y*uvOffset.y;";
		const replacement = `var uvOffset: vec2f= vec2f(abs(offset.x-vertexInputs.inverts.x),abs(1.0-offset.y-vertexInputs.inverts.y));var uvPlace: vec2f=vertexInputs.cellInfo.xy;var uvSize: vec2f=vertexInputs.cellInfo.zw;let ${rotatedPackedSpriteMarker}: bool=uvSize.x<0.0;uvSize.x=abs(uvSize.x);if(${rotatedPackedSpriteMarker}){uvOffset=vec2f(1.0-uvOffset.y,uvOffset.x);}vertexOutputs.vUV.x=uvPlace.x+uvSize.x*uvOffset.x;vertexOutputs.vUV.y=uvPlace.y+uvSize.y*uvOffset.y;`;
		const patched = original.replace(search, replacement);
		if (patched === original) {
			throw new Error("Babylon WGSL sprite shader layout changed; rotated packed sprites cannot be installed safely.");
		}
		shaderStore.ShadersStoreWGSL.spritesVertexShader = patched;
	}
}

/** Marks rotated packed frames through a negative cell width consumed by the installed sprite shaders. */
export function configureRotatedPackedSpriteManager(spriteManager: object, atlasJson: any): void {
	if (configuredPackedSpriteManagers.has(spriteManager) || !atlasJson?.frames) {
		return;
	}
	const originalUpdate = (spriteManager as any)._customUpdate.bind(spriteManager);
	(spriteManager as any)._customUpdate = (sprite: any, baseSize: any): void => {
		originalUpdate(sprite, baseSize);
		const frames = atlasJson.frames;
		const frame = Array.isArray(frames) ? frames.find((candidate: any) => candidate.filename === sprite.cellRef) : frames[sprite.cellRef];
		if (frame?.rotated) {
			sprite._xSize = -Math.abs(frame.frame.w);
			sprite._ySize = frame.frame.h;
		}
	};
	configuredPackedSpriteManagers.add(spriteManager);
}

/**
 * This interface is used to define extra properties on TransformNode. For example for SpriteMap support.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface SpriteMapNode extends TransformNode {
	isSpriteMap?: boolean;
	spriteMap?: SpriteMap | null;
}

/**
 * This interface is used to define extra properties on TransformNode. For example for SpriteManager support.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface SpriteManagerNode extends TransformNode {
	isSpriteManager?: boolean;
	spriteManager?: SpriteManager | null;
}

export function normalizeAtlasJson(data: any) {
	if (!Array.isArray(data.frames)) {
		const frames: any[] = [];

		for (const key of Object.keys(data.frames)) {
			frames.push({
				filename: key,
				...data.frames[key],
			});
		}

		data.frames = frames;
	}
}

/**
 * Plays a sprite animation previously setup in the editor indentified by its name.
 * @param sprite defines the reference to the sprite to animate.
 * @param animationName defines the name of the animation to play previously setup in the editor.
 * @param onAnimationEnd defines an optional callback to be called when the animation ends.
 */
export function playSpriteAnimationFromName(sprite: Sprite, animationName: string, onAnimationEnd?: () => void) {
	const spriteAnimations = (sprite.metadata?.spriteAnimations ?? []) as ISpriteAnimation[];
	const animation = spriteAnimations.find((a) => a.name === animationName);

	if (!animation) {
		return console.error(`Animation with name "${animationName}" not found on sprite.`);
	}

	sprite.playAnimation(animation.from, animation.to, animation.loop, animation.delay, onAnimationEnd);
}
