import { Scene } from "@babylonjs/core/scene";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";

type IAnimatedTile = { id: string; tileIds: string[]; frames: number[]; frameDuration: number; loop?: boolean; enabled?: boolean };

/** Restores persisted Sprite Map animated-tile sequences in generated games. */
export function configureAnimatedTiles(scene: Scene): void {
	const states = new Map<string, { elapsed: number; frame: number }>();
	scene.onBeforeRenderObservable.add(() => {
		for (const node of scene.transformNodes as any[]) {
			const animations = node.metadata?.babylonEditorAnimatedTiles as IAnimatedTile[] | undefined;
			const spriteMap = node.spriteMap;
			const tiles = node.tiles as any[] | undefined;
			if (!animations?.length || !spriteMap || !tiles) continue;
			for (const animation of animations) {
				if (animation.enabled === false || animation.frames.length < 2 || !(animation.frameDuration > 0)) continue;
				const state = states.get(animation.id) ?? { elapsed: 0, frame: 0 };
				states.set(animation.id, state);
				state.elapsed += scene.getEngine().getDeltaTime();
				if (state.elapsed < animation.frameDuration) continue;
				const steps = Math.floor(state.elapsed / animation.frameDuration);
				state.elapsed %= animation.frameDuration;
				const next = state.frame + steps;
				state.frame = animation.loop === false ? Math.min(animation.frames.length - 1, next) : next % animation.frames.length;
				const frame = animation.frames[state.frame];
				for (const tileId of animation.tileIds) {
					const tile = tiles.find((candidate) => candidate.id === tileId);
					if (!tile) continue;
					for (let x = 0; x <= tile.repeatCount.x; x++)
						for (let y = 0; y <= tile.repeatCount.y; y++)
							spriteMap.changeTiles(
								tile.layer,
								new Vector2(
									tile.position.x + x * (tile.repeatOffset.x + 1),
									(spriteMap.options.stageSize?.y ?? 0) - 1 - tile.position.y - y * (tile.repeatOffset.y + 1)
								),
								frame
							);
				}
			}
		}
	});
}
