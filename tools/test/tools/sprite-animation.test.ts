import { Observable } from "@babylonjs/core/Misc/observable";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	ISpriteAnimation,
	applySpriteManagerLocalSpace,
	onSpriteAnimationEventObservable,
	playSpriteAnimationFromName,
	playVariableSpriteAnimation,
	restoreVariableSpriteAnimation,
	stopVariableSpriteAnimation,
} from "../../src/tools/sprite";

function runtime(): { scene: Scene; sprite: Sprite; setDelta(value: number): void } {
	let delta = 0;
	const scene = {
		metadata: null,
		onBeforeRenderObservable: new Observable<Scene>(),
		getEngine: () => ({ getDeltaTime: () => delta }),
	} as unknown as Scene;
	const sprite = {
		name: "Hero",
		uniqueId: 42,
		manager: { scene },
		metadata: {},
		cellRef: "",
		cellIndex: 0,
		isVisible: true,
		stopAnimation: vi.fn(),
		playAnimation: vi.fn(),
		onDisposeObservable: new Observable<Sprite>(),
	} as unknown as Sprite;
	return { scene, sprite, setDelta: (value) => (delta = value) };
}

const animation: ISpriteAnimation = {
	name: "Run",
	from: 0,
	to: 2,
	loop: false,
	delay: 80,
	repeat: 2,
	frames: [
		{ cellRef: "run/0", cellIndex: 0, durationMs: 50, sourceFrame: 0, visible: true },
		{ cellRef: "run/1", cellIndex: 1, durationMs: 100, sourceFrame: 1, visible: true, events: [{ text: "Footstep", color: [1, 2, 3, 255] }] },
		{ cellRef: null, cellIndex: null, durationMs: 25, sourceFrame: 2, visible: false },
	],
};

describe("variable-timing sprite animation", () => {
	beforeEach(() => onSpriteAnimationEventObservable.clear());

	test("executes exact durations, visibility, events, and finite repeat completion", () => {
		const { scene, sprite, setDelta } = runtime();
		const events: any[] = [];
		onSpriteAnimationEventObservable.add((event) => events.push(event));
		expect(playVariableSpriteAnimation(sprite, animation)).toMatchObject({ name: "Run", playing: true, frameCursor: 0, completedCycles: 0 });
		expect(sprite).toMatchObject({ cellRef: "run/0", cellIndex: 0, isVisible: true });

		setDelta(50);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(sprite).toMatchObject({ cellRef: "run/1", cellIndex: 1, isVisible: true });
		expect(events).toEqual([expect.objectContaining({ animationName: "Run", sourceFrame: 1, spriteName: "Hero", text: "Footstep", color: [1, 2, 3, 255] })]);

		setDelta(100);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(sprite.isVisible).toBe(false);
		setDelta(25);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(sprite).toMatchObject({ cellRef: "run/0", isVisible: true });
		expect(sprite.metadata.spriteAnimationPlayback).toMatchObject({ frameCursor: 0, completedCycles: 1, playing: true });

		setDelta(175);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(sprite.metadata.spriteAnimationPlayback).toMatchObject({ frameCursor: 2, completedCycles: 2, elapsedMs: 0, playing: false });
		expect(sprite.isVisible).toBe(false);
		expect(events).toHaveLength(2);
		expect(scene.metadata.babylonEditorSpriteAnimationEventLog).toHaveLength(2);
	});

	test("serializes an in-frame position, restores without replaying entry events, and pauses safely", () => {
		const first = runtime();
		first.sprite.metadata = { spriteAnimations: [{ ...animation, repeat: 0 }] };
		playVariableSpriteAnimation(first.sprite, first.sprite.metadata.spriteAnimations[0]);
		first.setDelta(60);
		first.scene.onBeforeRenderObservable.notifyObservers(first.scene);
		expect(first.sprite.metadata.spriteAnimationPlayback).toMatchObject({ frameCursor: 1, elapsedMs: 10, playing: true });
		const persisted = structuredClone(first.sprite.metadata);
		first.sprite.onDisposeObservable.notifyObservers(first.sprite);

		const restored = runtime();
		restored.sprite.metadata = persisted;
		expect(restoreVariableSpriteAnimation(restored.sprite)).toMatchObject({ frameCursor: 1, elapsedMs: 10, playing: true });
		expect(restored.scene.metadata).toBeNull();
		restored.setDelta(90);
		restored.scene.onBeforeRenderObservable.notifyObservers(restored.scene);
		expect(restored.sprite).toMatchObject({ cellRef: "run/1", isVisible: false });
		expect(restored.sprite.metadata.spriteAnimationPlayback).toMatchObject({ frameCursor: 2, elapsedMs: 0 });
		expect(stopVariableSpriteAnimation(restored.sprite)).toMatchObject({ playing: false, frameCursor: 2 });
		restored.setDelta(100);
		restored.scene.onBeforeRenderObservable.notifyObservers(restored.scene);
		expect(restored.sprite.metadata.spriteAnimationPlayback).toMatchObject({ playing: false, frameCursor: 2, elapsedMs: 0 });
	});

	test("routes named variable animations while retaining the fixed-delay fallback and bounded rejection", () => {
		const variable = runtime();
		variable.sprite.metadata = { spriteAnimations: [animation] };
		playSpriteAnimationFromName(variable.sprite, "Run");
		expect(variable.sprite.cellRef).toBe("run/0");
		expect(variable.sprite.playAnimation).not.toHaveBeenCalled();

		const fixed = runtime();
		fixed.sprite.metadata = { spriteAnimations: [{ name: "Idle", from: 2, to: 4, loop: true, delay: 120 }] };
		playSpriteAnimationFromName(fixed.sprite, "Idle");
		expect(fixed.sprite.playAnimation).toHaveBeenCalledWith(2, 4, true, 120, undefined);
		expect(() => playVariableSpriteAnimation(variable.sprite, { ...animation, frames: [{ ...animation.frames![0], durationMs: 0 }] })).toThrow("invalid");
		expect(() => playVariableSpriteAnimation(variable.sprite, animation, { speed: 0 })).toThrow("speed");
	});

	test("applies node-local position, scale, rotation, and current frame visibility", () => {
		const { sprite } = runtime();
		sprite.position = Vector3.Zero();
		sprite.metadata = {
			babylonEditorLocalSpriteTransform: { position: [1, 0, 0], width: 10, height: 20, angle: 0 },
			spriteAnimations: [animation],
			spriteAnimationPlayback: { name: "Run", playing: true, speed: 1, frameCursor: 2, elapsedMs: 0, completedCycles: 0, baseVisible: true },
		};
		const world = Matrix.Compose(new Vector3(2, 3, 1), Quaternion.FromEulerAngles(0, 0, Math.PI / 2), new Vector3(5, 7, 0));
		const node = {
			metadata: { babylonEditorSpriteLocalSpace: true },
			spriteManager: { sprites: [sprite] },
			computeWorldMatrix: () => world,
		};
		expect(applySpriteManagerLocalSpace(node as any)).toBe(1);
		expect(sprite.position.asArray().map((value) => Math.round(value * 1_000) / 1_000)).toEqual([5, 9, 0]);
		expect(sprite).toMatchObject({ width: 20, height: 60, angle: expect.closeTo(Math.PI / 2), isVisible: false });
	});
});
