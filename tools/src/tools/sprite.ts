import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteMap } from "@babylonjs/core/Sprites/spriteMap";
import { IVector2Like } from "@babylonjs/core/Maths/math.like";
import { Quaternion, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Observable, Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import { spritesVertexShader as spritesVertexShaderGlsl } from "@babylonjs/core/Shaders/sprites.vertex";
import { spritesVertexShaderWGSL as spritesVertexShaderWgsl } from "@babylonjs/core/ShadersWGSL/sprites.vertex";

import { ITileTransform, normalizeTileGridConfiguration, normalizeTileTransform, TileGridLayout } from "../loading/grid-brush";

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
	frames?: ISpriteAnimationFrame[];
	repeat?: number;
}

export interface ISpriteAnimationEvent {
	text: string;
	color?: [number, number, number, number];
}

export interface ISpriteAnimationFrame {
	cellRef: string | null;
	cellIndex: number | null;
	durationMs: number;
	sourceFrame: number;
	visible: boolean;
	events?: ISpriteAnimationEvent[];
	localTransform?: ISpriteLocalTransform;
}

export interface ISpriteLocalTransform {
	position: [number, number, number];
	width: number;
	height: number;
	angle: number;
}

export interface ISpriteAnimationPlayback {
	name: string;
	playing: boolean;
	speed: number;
	frameCursor: number;
	elapsedMs: number;
	completedCycles: number;
	baseVisible: boolean;
}

export interface ISpriteAnimationEventInvocation extends ISpriteAnimationEvent {
	animationName: string;
	sourceFrame: number;
	spriteName: string;
	spriteUniqueId: number;
}

export const onSpriteAnimationEventObservable = new Observable<ISpriteAnimationEventInvocation>();

interface IVariableSpriteAnimationController {
	scene: Scene;
	observer: Observer<Scene>;
	disposeObserver: Observer<Sprite>;
}

const variableSpriteAnimationControllers = new WeakMap<Sprite, IVariableSpriteAnimationController>();
const localSpaceSpriteManagerObservers = new WeakMap<object, { scene: Scene; observer: Observer<Scene> }>();

export interface ISpriteMapTile {
	id: string;
	name: string;
	layer: number;
	position: IVector2Like;
	repeatCount: IVector2Like;
	repeatOffset: IVector2Like;
	tile: number;
	transform?: Partial<ITileTransform>;
}

interface ISpriteShaderStore {
	ShadersStore: Record<string, string>;
	ShadersStoreWGSL: Record<string, string>;
}

const rotatedPackedSpriteMarker = "babylonEditorPackedRotation";
const configuredPackedSpriteManagers = new WeakSet<object>();
const configuredAdvancedSpriteMaps = new WeakSet<object>();

interface IAdvancedSpriteMapLike {
	name: string;
	options: { stageSize?: { x: number; y: number }; layerCount?: number };
	_tileMaterial?: never;
	_material: {
		setVector2(name: string, value: Vector2): void;
		setTextureArray(name: string, textures: IAdvancedTileMapTexture[]): void;
	};
	_tileMaps: IAdvancedTileMapTexture[];
	_createTileBuffer(buffer: ArrayBufferView | number[] | null, layer?: number): IAdvancedTileMapTexture;
}

interface IAdvancedTileMapTexture {
	dispose(): void;
}

const advancedSpriteMapShaderMarker = "babylonEditorAdvancedTileMap";

function patchAdvancedSpriteMapShader(source: string): string {
	if (source.includes(advancedSpriteMapShaderMarker)) {
		return source;
	}
	const declaration = "uniform vec3 colorMul;";
	const mapping = "vec2 tileUV=fract(tUV);vec2 tileID=floor(tUV);";
	if (!source.includes(declaration) || !source.includes(mapping)) {
		throw new Error("Babylon SpriteMap shader layout changed; advanced tile layouts cannot be installed safely.");
	}
	const mapped = `float ${advancedSpriteMapShaderMarker}=mousePosition.x;vec2 tileID=vec2(0.0);vec2 baseTileUV=vec2(0.0);float tileOutside=0.0;vec2 normalizedUV=tUV/stageSize;if(${advancedSpriteMapShaderMarker}<0.5){tileID=floor(tUV);baseTileUV=tUV-floor(tUV);}else if(${advancedSpriteMapShaderMarker}<1.5){float span=stageSize.x+stageSize.y;float diagonal=(normalizedUV.x-0.5)*span;float depth=(1.0-normalizedUV.y)*span;vec2 logical=(vec2(diagonal+depth,depth-diagonal))*0.5;vec2 logicalCell=floor(logical);tileID=vec2(logicalCell.x,stageSize.y-1.0-logicalCell.y);baseTileUV=vec2(fract(logical.x),1.0-fract(logical.y));tileOutside=float(logicalCell.x<0.0||logicalCell.y<0.0||logicalCell.x>=stageSize.x||logicalCell.y>=stageSize.y);}else if(${advancedSpriteMapShaderMarker}<2.5){vec2 bounds=vec2(stageSize.x+(stageSize.y>1.0?0.5:0.0),max(1.0,(stageSize.y-1.0)*0.75+1.0));vec2 screen=vec2(normalizedUV.x*bounds.x,(1.0-normalizedUV.y)*bounds.y);float row=floor(screen.y/0.75);float column=floor(screen.x-mod(abs(row),2.0)*0.5);vec2 center=vec2(column+0.5+mod(abs(row),2.0)*0.5,row*0.75+0.5);vec2 local=screen-center;tileID=vec2(column,stageSize.y-1.0-row);baseTileUV=vec2(local.x+0.5,0.5-local.y);tileOutside=float(column<0.0||row<0.0||column>=stageSize.x||row>=stageSize.y||abs(local.x)+2.0*abs(local.y)>1.0);}else{vec2 bounds=vec2(max(1.0,(stageSize.x-1.0)*0.75+1.0),stageSize.y+(stageSize.x>1.0?0.5:0.0));vec2 screen=vec2(normalizedUV.x*bounds.x,(1.0-normalizedUV.y)*bounds.y);float column=floor(screen.x/0.75);float row=floor(screen.y-mod(abs(column),2.0)*0.5);vec2 center=vec2(column*0.75+0.5,row+0.5+mod(abs(column),2.0)*0.5);vec2 local=screen-center;tileID=vec2(column,stageSize.y-1.0-row);baseTileUV=vec2(local.x+0.5,0.5-local.y);tileOutside=float(column<0.0||row<0.0||column>=stageSize.x||row>=stageSize.y||2.0*abs(local.x)+abs(local.y)>1.0);}`;
	return source
		.replace(declaration, `${declaration}uniform vec2 mousePosition;`)
		.replace(mapping, mapped)
		.replace("for(int i=0; i<LAYERS; i++) {float frameID;", "for(int i=0; i<LAYERS; i++) {float frameID;vec4 tileData=vec4(0.0);vec2 tileUV=baseTileUV;")
		.replace(/frameID = (texture(?:2D)?\([^;]+?\))\.x;/g, "tileData=$1;frameID=tileData.x;")
		.replace(
			"mat4 frameData=getFrameData(frameID+0.5);",
			"if(tileData.z>0.5){tileUV.x=1.0-tileUV.x;}if(tileData.w>0.5){tileUV.y=1.0-tileUV.y;}float quarterTurns=mod(floor(tileData.y+0.5),4.0);if(quarterTurns>2.5){tileUV=vec2(1.0-tileUV.y,tileUV.x);}else if(quarterTurns>1.5){tileUV=vec2(1.0-tileUV.x,1.0-tileUV.y);}else if(quarterTurns>0.5){tileUV=vec2(tileUV.y,1.0-tileUV.x);}vec2 transformedTileUV=tileUV;mat4 frameData=getFrameData(frameID+0.5);"
		)
		.replace(/fract\(tUV\)/g, "transformedTileUV")
		.replace("color.xyz*=colorMul;", "if(tileOutside>0.5){color=vec4(0.0);}color.xyz*=colorMul;");
}

/** Installs layout projection and per-cell rotation/reflection support on one Babylon SpriteMap's unique shader before its first render. */

export function configureAdvancedSpriteMap(spriteMap: object, layout: TileGridLayout): void {
	const advanced = spriteMap as IAdvancedSpriteMapLike;
	const shaderName = `spriteMap${advanced.name}PixelShader`;
	const source = Effect.ShadersStore[shaderName];
	if (!source) {
		throw new Error(`SpriteMap shader "${shaderName}" is unavailable.`);
	}
	if (!configuredAdvancedSpriteMaps.has(spriteMap)) {
		Effect.ShadersStore[shaderName] = patchAdvancedSpriteMapShader(source);
		configuredAdvancedSpriteMaps.add(spriteMap);
	}
	const layoutIndex = ["rectangular", "isometric", "hexagonal-point-top", "hexagonal-flat-top"].indexOf(layout);
	advanced._material.setVector2("mousePosition", new Vector2(Math.max(0, layoutIndex), 0));
}

/** Rebuilds all SpriteMap layers once, encoding frame id and tile transform in the existing RGBA tile buffers. */
export function rebuildAdvancedSpriteMapTiles(spriteMap: object, tiles: ISpriteMapTile[]): void {
	const advanced = spriteMap as IAdvancedSpriteMapLike;
	const width = advanced.options.stageSize?.x ?? 0;
	const height = advanced.options.stageSize?.y ?? 0;
	const layerCount = advanced.options.layerCount ?? 1;
	const tileMaps = advanced._tileMaps;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !Array.isArray(tileMaps)) {
		return;
	}
	for (const tileMap of tileMaps) {
		tileMap.dispose();
	}
	tileMaps.splice(0, tileMaps.length);
	for (let layer = 0; layer < layerCount; layer++) {
		const buffer = new Float32Array(width * height * 4);
		for (const tile of tiles) {
			if (tile.layer !== layer) {
				continue;
			}
			const transform = normalizeTileTransform(tile.transform);
			for (let repeatY = 0; repeatY <= tile.repeatCount.y; repeatY++) {
				for (let repeatX = 0; repeatX <= tile.repeatCount.x; repeatX++) {
					const x = tile.position.x + repeatX * (tile.repeatOffset.x + 1);
					const y = tile.position.y + repeatY * (tile.repeatOffset.y + 1);
					if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
						continue;
					}
					const offset = (x + (height - 1 - y) * width) * 4;
					buffer[offset] = tile.tile;
					buffer[offset + 1] = transform.quarterTurns;
					buffer[offset + 2] = transform.flipX ? 1 : 0;
					buffer[offset + 3] = transform.flipY ? 1 : 0;
				}
			}
		}
		tileMaps.push(advanced._createTileBuffer(buffer, layer));
	}
	advanced._material.setTextureArray("tileMaps", tileMaps);
}

/** Reads a SpriteMap node's persisted grid metadata without mutating it. */
export function getSpriteMapTileGridConfiguration(node: { metadata?: Record<string, unknown> }): ReturnType<typeof normalizeTileGridConfiguration> {
	return normalizeTileGridConfiguration(node.metadata?.babylonEditorTileGrid);
}

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

function localSpriteTransform(sprite: Sprite): ISpriteLocalTransform | null {
	const value = sprite.metadata?.babylonEditorLocalSpriteTransform;
	if (
		!value ||
		typeof value !== "object" ||
		!Array.isArray(value.position) ||
		value.position.length !== 3 ||
		value.position.some((coordinate: unknown) => typeof coordinate !== "number" || !Number.isFinite(coordinate)) ||
		typeof value.width !== "number" ||
		!Number.isFinite(value.width) ||
		value.width <= 0 ||
		typeof value.height !== "number" ||
		!Number.isFinite(value.height) ||
		value.height <= 0 ||
		typeof value.angle !== "number" ||
		!Number.isFinite(value.angle)
	) {
		return null;
	}
	return value as ISpriteLocalTransform;
}

/** Applies opt-in node-local sprite position, size, rotation, and current animation visibility through the complete parent world matrix. */
export function applySpriteManagerLocalSpace(node: SpriteManagerNode): number {
	if (node.metadata?.babylonEditorSpriteLocalSpace !== true || !node.spriteManager) {
		return 0;
	}
	const matrix = node.computeWorldMatrix(true);
	const scale = Vector3.One();
	const rotation = Quaternion.Identity();
	const translation = Vector3.Zero();
	matrix.decompose(scale, rotation, translation);
	const zAngle = rotation.toEulerAngles().z;
	let applied = 0;
	for (const sprite of node.spriteManager.sprites) {
		const local = localSpriteTransform(sprite);
		if (!local) {
			continue;
		}
		sprite.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(local.position), matrix));
		sprite.width = Math.abs(local.width * scale.x);
		sprite.height = Math.abs(local.height * scale.y);
		sprite.angle = local.angle + zAngle;
		const playback = playbackMetadata(sprite);
		if (playback) {
			const animation = ((sprite.metadata?.spriteAnimations ?? []) as ISpriteAnimation[]).find((candidate) => candidate.name === playback.name);
			const frame = animation?.frames?.[playback.frameCursor];
			sprite.isVisible = playback.baseVisible && (frame?.visible ?? true);
		}
		applied++;
	}
	return applied;
}

/** Installs the local-space updater once for runtime-loaded generic TransformNodes. */
export function configureSpriteManagerLocalSpace(node: SpriteManagerNode): void {
	if (localSpaceSpriteManagerObservers.has(node)) {
		return;
	}
	const scene = node.getScene();
	const observer = scene.onBeforeRenderObservable.add(() => applySpriteManagerLocalSpace(node));
	localSpaceSpriteManagerObservers.set(node, { scene, observer });
	node.onDisposeObservable.addOnce(() => {
		const configured = localSpaceSpriteManagerObservers.get(node);
		if (configured) {
			configured.scene.onBeforeRenderObservable.remove(configured.observer);
			localSpaceSpriteManagerObservers.delete(node);
		}
	});
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

function animationMetadata(sprite: Sprite): Record<string, any> {
	if (!sprite.metadata || typeof sprite.metadata !== "object" || Array.isArray(sprite.metadata)) {
		sprite.metadata = {};
	}
	return sprite.metadata;
}

function boundedAnimation(value: ISpriteAnimation): ISpriteAnimation {
	if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 256) {
		throw new Error("Sprite animation requires a non-empty name of at most 256 characters.");
	}
	if (!Array.isArray(value.frames) || !value.frames.length || value.frames.length > 10_000) {
		throw new Error(`Sprite animation "${value.name}" requires 1-10,000 variable-timing frames.`);
	}
	const frames = value.frames.map((frame, index): ISpriteAnimationFrame => {
		if (
			!frame ||
			typeof frame !== "object" ||
			(frame.cellRef !== null && (typeof frame.cellRef !== "string" || frame.cellRef.length > 4096)) ||
			(frame.cellIndex !== null && (!Number.isSafeInteger(frame.cellIndex) || frame.cellIndex < 0 || frame.cellIndex > 1_000_000)) ||
			!Number.isFinite(frame.durationMs) ||
			frame.durationMs < 1 ||
			frame.durationMs > 600_000 ||
			!Number.isSafeInteger(frame.sourceFrame) ||
			frame.sourceFrame < 0 ||
			frame.sourceFrame > 1_000_000 ||
			typeof frame.visible !== "boolean"
		) {
			throw new Error(`Sprite animation "${value.name}" frame ${index} is invalid or outside bounded timing/cell limits.`);
		}
		const events = frame.events?.map((event, eventIndex): ISpriteAnimationEvent => {
			if (
				!event ||
				typeof event.text !== "string" ||
				!event.text.trim() ||
				event.text.length > 4096 ||
				(event.color !== undefined && (!Array.isArray(event.color) || event.color.length !== 4))
			) {
				throw new Error(`Sprite animation "${value.name}" frame ${index} event ${eventIndex} is invalid.`);
			}
			const color = event.color?.map((channel) => {
				if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) {
					throw new Error(`Sprite animation "${value.name}" frame ${index} event ${eventIndex} color must contain RGBA8 channels.`);
				}
				return channel;
			}) as [number, number, number, number] | undefined;
			return { text: event.text, ...(color ? { color } : {}) };
		});
		if ((events?.length ?? 0) > 32) {
			throw new Error(`Sprite animation "${value.name}" frame ${index} exceeds 32 events.`);
		}
		let localTransform: ISpriteLocalTransform | undefined;
		if (frame.localTransform !== undefined) {
			const position = frame.localTransform.position;
			if (
				!Array.isArray(position) ||
				position.length !== 3 ||
				position.some((coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 1_000_000_000) ||
				!Number.isFinite(frame.localTransform.width) ||
				frame.localTransform.width <= 0 ||
				frame.localTransform.width > 1_000_000_000 ||
				!Number.isFinite(frame.localTransform.height) ||
				frame.localTransform.height <= 0 ||
				frame.localTransform.height > 1_000_000_000 ||
				!Number.isFinite(frame.localTransform.angle) ||
				Math.abs(frame.localTransform.angle) > 1_000_000
			) {
				throw new Error(`Sprite animation "${value.name}" frame ${index} local transform is invalid.`);
			}
			localTransform = {
				position: [...position] as [number, number, number],
				width: frame.localTransform.width,
				height: frame.localTransform.height,
				angle: frame.localTransform.angle,
			};
		}
		return {
			cellRef: frame.cellRef,
			cellIndex: frame.cellIndex,
			durationMs: frame.durationMs,
			sourceFrame: frame.sourceFrame,
			visible: frame.visible,
			...(events?.length ? { events } : {}),
			...(localTransform ? { localTransform } : {}),
		};
	});
	const repeat = value.repeat ?? (value.loop ? 0 : 1);
	if (!Number.isSafeInteger(repeat) || repeat < 0 || repeat > 1_000_000) {
		throw new Error(`Sprite animation "${value.name}" repeat must be an integer from 0 through 1,000,000; zero means infinite.`);
	}
	return { ...value, name: value.name.trim(), frames, repeat };
}

function playbackMetadata(sprite: Sprite): ISpriteAnimationPlayback | null {
	const value = animationMetadata(sprite).spriteAnimationPlayback;
	return value && typeof value === "object" ? (value as ISpriteAnimationPlayback) : null;
}

function storePlayback(sprite: Sprite, playback: ISpriteAnimationPlayback): void {
	animationMetadata(sprite).spriteAnimationPlayback = { ...playback };
}

function detachVariableSpriteAnimation(sprite: Sprite): void {
	const controller = variableSpriteAnimationControllers.get(sprite);
	if (!controller) {
		return;
	}
	controller.scene.onBeforeRenderObservable.remove(controller.observer);
	sprite.onDisposeObservable.remove(controller.disposeObserver);
	variableSpriteAnimationControllers.delete(sprite);
}

function emitSpriteAnimationEvents(sprite: Sprite, animation: ISpriteAnimation, frame: ISpriteAnimationFrame): void {
	if (!frame.events?.length) {
		return;
	}
	const scene = sprite.manager.scene;
	scene.metadata ??= {};
	const log = Array.isArray(scene.metadata.babylonEditorSpriteAnimationEventLog) ? scene.metadata.babylonEditorSpriteAnimationEventLog : [];
	scene.metadata.babylonEditorSpriteAnimationEventLog = log;
	for (const event of frame.events) {
		const invocation: ISpriteAnimationEventInvocation = {
			animationName: animation.name,
			sourceFrame: frame.sourceFrame,
			spriteName: sprite.name,
			spriteUniqueId: sprite.uniqueId,
			text: event.text,
			...(event.color ? { color: [...event.color] as [number, number, number, number] } : {}),
		};
		log.push(structuredClone(invocation));
		onSpriteAnimationEventObservable.notifyObservers(invocation);
	}
	if (log.length > 256) {
		log.splice(0, log.length - 256);
	}
}

function applyVariableSpriteFrame(sprite: Sprite, animation: ISpriteAnimation, playback: ISpriteAnimationPlayback, emitEvents: boolean): void {
	const frame = animation.frames![playback.frameCursor];
	if (frame.cellRef !== null) {
		sprite.cellRef = frame.cellRef;
	}
	if (frame.cellIndex !== null) {
		sprite.cellIndex = frame.cellIndex;
	}
	if (frame.localTransform) {
		animationMetadata(sprite).babylonEditorLocalSpriteTransform = structuredClone(frame.localTransform);
	}
	sprite.isVisible = playback.baseVisible && frame.visible;
	if (emitEvents) {
		emitSpriteAnimationEvents(sprite, animation, frame);
	}
}

export interface IPlayVariableSpriteAnimationOptions {
	speed?: number;
	frameCursor?: number;
	elapsedMs?: number;
	completedCycles?: number;
	baseVisible?: boolean;
	emitInitialEvents?: boolean;
	onAnimationEnd?: () => void;
}

/** Plays exact per-frame durations from persisted metadata and advances from the engine clock without allocating per tick. */
export function playVariableSpriteAnimation(sprite: Sprite, animationValue: ISpriteAnimation, options: IPlayVariableSpriteAnimationOptions = {}): ISpriteAnimationPlayback {
	const animation = boundedAnimation(animationValue);
	const speed = options.speed ?? 1;
	if (!Number.isFinite(speed) || speed <= 0 || speed > 100) {
		throw new Error("Variable sprite animation speed must be greater than zero and at most 100.");
	}
	const frameCursor = options.frameCursor ?? 0;
	const elapsedMs = options.elapsedMs ?? 0;
	const completedCycles = options.completedCycles ?? 0;
	if (
		!Number.isSafeInteger(frameCursor) ||
		frameCursor < 0 ||
		frameCursor >= animation.frames!.length ||
		!Number.isFinite(elapsedMs) ||
		elapsedMs < 0 ||
		elapsedMs >= animation.frames![frameCursor].durationMs
	) {
		throw new Error(`Variable sprite animation "${animation.name}" resume position is invalid.`);
	}
	if (!Number.isSafeInteger(completedCycles) || completedCycles < 0 || completedCycles > 1_000_000) {
		throw new Error(`Variable sprite animation "${animation.name}" completed-cycle count is invalid.`);
	}
	detachVariableSpriteAnimation(sprite);
	sprite.stopAnimation();
	const playback: ISpriteAnimationPlayback = {
		name: animation.name,
		playing: true,
		speed,
		frameCursor,
		elapsedMs,
		completedCycles,
		baseVisible: options.baseVisible ?? sprite.isVisible,
	};
	storePlayback(sprite, playback);
	applyVariableSpriteFrame(sprite, animation, playback, options.emitInitialEvents !== false);
	const scene = sprite.manager.scene;
	const observer = scene.onBeforeRenderObservable.add(() => {
		playback.elapsedMs += Math.max(0, scene.getEngine().getDeltaTime()) * playback.speed;
		let transitions = 0;
		while (playback.playing && playback.elapsedMs >= animation.frames![playback.frameCursor].durationMs && transitions++ < 10_000) {
			playback.elapsedMs -= animation.frames![playback.frameCursor].durationMs;
			playback.frameCursor++;
			if (playback.frameCursor >= animation.frames!.length) {
				playback.completedCycles++;
				if (animation.repeat !== 0 && playback.completedCycles >= animation.repeat!) {
					playback.playing = false;
					playback.frameCursor = animation.frames!.length - 1;
					playback.elapsedMs = 0;
					storePlayback(sprite, playback);
					detachVariableSpriteAnimation(sprite);
					options.onAnimationEnd?.();
					return;
				}
				playback.frameCursor = 0;
			}
			applyVariableSpriteFrame(sprite, animation, playback, true);
		}
		if (transitions >= 10_000) {
			playback.elapsedMs %= animation.frames![playback.frameCursor].durationMs;
		}
		storePlayback(sprite, playback);
	});
	const disposeObserver = sprite.onDisposeObservable.add(() => detachVariableSpriteAnimation(sprite));
	variableSpriteAnimationControllers.set(sprite, { scene, observer, disposeObserver });
	return { ...playback };
}

/** Stops or pauses a variable sprite animation while retaining a serializable resume position. */
export function stopVariableSpriteAnimation(sprite: Sprite, reset = false): ISpriteAnimationPlayback | null {
	detachVariableSpriteAnimation(sprite);
	const playback = playbackMetadata(sprite);
	if (!playback) {
		return null;
	}
	playback.playing = false;
	if (reset) {
		playback.frameCursor = 0;
		playback.elapsedMs = 0;
		playback.completedCycles = 0;
	}
	storePlayback(sprite, playback);
	return { ...playback };
}

/** Restores a serialized variable animation only when its exact named frame contract is still present. */
export function restoreVariableSpriteAnimation(sprite: Sprite): ISpriteAnimationPlayback | null {
	const playback = playbackMetadata(sprite);
	if (!playback?.playing) {
		return playback ? { ...playback } : null;
	}
	const animations = (animationMetadata(sprite).spriteAnimations ?? []) as ISpriteAnimation[];
	const animation = animations.find((candidate) => candidate.name === playback.name);
	if (!animation?.frames?.length) {
		playback.playing = false;
		storePlayback(sprite, playback);
		return { ...playback };
	}
	return playVariableSpriteAnimation(sprite, animation, { ...playback, emitInitialEvents: false });
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

	if (animation.frames?.length) {
		playVariableSpriteAnimation(sprite, animation, { onAnimationEnd });
	} else {
		detachVariableSpriteAnimation(sprite);
		sprite.playAnimation(animation.from, animation.to, animation.loop, animation.delay, onAnimationEnd);
	}
}
