import type { ISpriteAnimation, ISpriteAnimationEvent, ISpriteAnimationFrame, ISpriteLocalTransform } from "babylonjs-editor-tools";

import type { IAsepriteImporterResult } from "./aseprite-importer";

function sequence(from: number, to: number, direction: string): number[] {
	const forward = Array.from({ length: to - from + 1 }, (_, index) => from + index);
	if (direction === "reverse") {
		return forward.reverse();
	}
	if (direction === "pingpong") {
		return [...forward, ...forward.slice(1, -1).reverse()];
	}
	if (direction === "pingpong_reverse") {
		const reverse = [...forward].reverse();
		return [...reverse, ...reverse.slice(1, -1).reverse()];
	}
	return forward;
}

function layerIncluded(result: IAsepriteImporterResult, layerIndex: number): boolean {
	let layer = result.document.layers[layerIndex];
	let depth = 0;
	while (layer && depth++ <= result.document.layers.length) {
		if (!result.settings.includeHiddenLayers && !layer.visible) {
			return false;
		}
		layer = layer.parentIndex === null ? undefined! : result.document.layers[layer.parentIndex];
	}
	return depth <= result.document.layers.length;
}

function eventsFor(result: IAsepriteImporterResult, frameIndex: number, layerIndex: number | null): ISpriteAnimationEvent[] | undefined {
	const events = result.document.celUserData
		.filter(
			(value) =>
				value.frameIndex === frameIndex && Boolean(value.text?.trim()) && (layerIndex === null ? layerIncluded(result, value.layerIndex) : value.layerIndex === layerIndex)
		)
		.map((value) => ({ text: value.text!, ...(value.color ? { color: [...value.color] as [number, number, number, number] } : {}) }));
	if (events.length > 32) {
		throw new Error(`Aseprite frame ${frameIndex} has ${events.length} animation events; at most 32 are supported per sprite frame.`);
	}
	return events.length ? events : undefined;
}

function fallbackTransform(result: IAsepriteImporterResult, layerIndex: number | null): ISpriteLocalTransform {
	const aspect = result.document.pixelRatio.width / result.document.pixelRatio.height;
	return {
		position: [0, 0, layerIndex === null ? 0 : layerIndex * 0.001],
		width: (result.document.width / result.settings.pixelsPerUnit) * 100 * aspect,
		height: (result.document.height / result.settings.pixelsPerUnit) * 100,
		angle: 0,
	};
}

function localTransform(result: IAsepriteImporterResult, atlasFrame: IAsepriteImporterResult["atlas"]["frames"][number], layerIndex: number | null): ISpriteLocalTransform {
	const aspect = result.document.pixelRatio.width / result.document.pixelRatio.height;
	const width = (Math.max(1, atlasFrame.frame.w) / result.settings.pixelsPerUnit) * 100 * aspect;
	const height = (Math.max(1, atlasFrame.frame.h) / result.settings.pixelsPerUnit) * 100;
	return {
		position: [(0.5 - atlasFrame.pivot.x) * width, (atlasFrame.pivot.y - 0.5) * height, layerIndex === null ? 0 : layerIndex * 0.001],
		width,
		height,
		angle: 0,
	};
}

function uniqueAnimationName(name: string, used: Set<string>): string {
	const base = name.trim() || "Animation";
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base} (${suffix++})`;
	}
	used.add(candidate);
	return candidate;
}

/** Converts exact Aseprite tag directions, durations, pivots, empty frames, and cel events into serializable Sprite animations. */
export function buildAsepriteSpriteAnimations(result: IAsepriteImporterResult, layerIndex: number | null): ISpriteAnimation[] {
	const atlasFrames = new Map(
		result.atlas.frames
			.map((frame, cellIndex) => ({ frame, cellIndex }))
			.filter(({ frame }) => frame.layerIndex === layerIndex)
			.map(({ frame, cellIndex }) => [frame.frameIndex, { frame, cellIndex }] as const)
	);
	if (!atlasFrames.size) {
		throw new Error(`Aseprite atlas contains no ${layerIndex === null ? "composite" : `layer ${layerIndex}`} frames.`);
	}
	const tags = result.atlas.frameTags.length
		? result.atlas.frameTags
		: [{ name: "Default", from: 0, to: result.document.frameCount - 1, direction: "forward" as const, repeat: 0, color: [0, 0, 0, 255] as const }];
	const used = new Set<string>();
	return tags.map((tag) => {
		const indices = sequence(tag.from, tag.to, tag.direction);
		const frames: ISpriteAnimationFrame[] = indices.map((sourceFrame) => {
			const entry = atlasFrames.get(sourceFrame);
			const events = eventsFor(result, sourceFrame, layerIndex);
			return {
				cellRef: entry?.frame.name ?? null,
				cellIndex: entry?.cellIndex ?? null,
				durationMs: result.document.frameDurationsMs[sourceFrame],
				sourceFrame,
				visible: Boolean(entry && !entry.frame.empty),
				...(events ? { events } : {}),
				localTransform: entry ? localTransform(result, entry.frame, layerIndex) : fallbackTransform(result, layerIndex),
			};
		});
		return {
			name: uniqueAnimationName(tag.name, used),
			from: 0,
			to: frames.length - 1,
			loop: tag.repeat === 0 || tag.repeat > 1,
			delay: frames[0].durationMs,
			repeat: tag.repeat,
			frames,
		};
	});
}
