import { AnimationKeyInterpolation } from "@babylonjs/core/Animations/animationKey";

import { ICinematicDocument, TCinematicPropertyKey, TCinematicTrack, migrateLegacyCinematic, normalizeCinematicDocument } from "./model";
import { ICinematic, ICinematicKey, ICinematicKeyCut, ICinematicKeyEvent, ICinematicTrack } from "./typings";

const legacyEditableTypes: TCinematicTrack["type"][] = ["property", "animation", "audio", "signal"];

/** Converts one typed key into the original editor shape while retaining stable identity. */
function legacyPropertyKey(key: TCinematicPropertyKey): ICinematicKey | ICinematicKeyCut {
	if (key.type === "cut") {
		return {
			id: key.id,
			type: "cut",
			key1: { frame: key.frame, value: structuredClone(key.incomingValue) },
			key2: { frame: key.frame, value: structuredClone(key.outgoingValue) },
		};
	}
	return {
		id: key.id,
		type: "key",
		frame: key.frame,
		value: structuredClone(key.value),
		interpolation: key.interpolation === "step" ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE,
		...(key.inTangent === undefined ? {} : { inTangent: structuredClone(key.inTangent) }),
		...(key.outTangent === undefined ? {} : { outTangent: structuredClone(key.outTangent) }),
	};
}

/** Carries marker-only replay metadata through the original event panel without payload loss. */
function legacyMarker(track: Extract<TCinematicTrack, { type: "signal" }>, index: number): ICinematicKeyEvent {
	const marker = track.markers[index];
	return {
		id: marker.id,
		type: "event",
		frame: marker.frame,
		name: marker.name,
		markerType: marker.type,
		emitOnce: marker.emitOnce,
		retroactive: marker.retroactive,
		data: structuredClone(marker.payload),
	};
}

/** Projects one supported typed lane and explicitly declines lanes the old panels cannot represent. */
function legacyTrack(track: TCinematicTrack): ICinematicTrack | null {
	switch (track.type) {
		case "property":
			return {
				_id: track.id,
				node: track.targetType === "node" ? track.targetId : undefined,
				defaultRenderingPipeline: track.targetType === "renderingPipeline",
				propertyPath: track.propertyPath,
				keyFrameAnimations: track.keys.map(legacyPropertyKey),
			};
		case "animation": {
			const animationGroupId = track.clips[0]?.animationGroupId;
			if (!animationGroupId) {
				return null;
			}
			if (track.clips.some((clip) => clip.animationGroupId !== animationGroupId)) {
				throw new Error(`Legacy compatibility cannot flatten animation track "${track.id}" because it references multiple animation groups.`);
			}
			return {
				_id: track.id,
				animationGroup: animationGroupId,
				animationGroups: track.clips.map((clip) => ({
					id: clip.id,
					name: clip.name,
					type: "group",
					frame: clip.startFrame,
					speed: clip.timeScale,
					startFrame: clip.sourceStartFrame,
					endFrame: clip.sourceEndFrame,
					repeatCount: clip.loopCount,
					clipInFrame: clip.clipInFrame,
					enabled: clip.enabled,
					blendInFrames: clip.blendInFrames,
					blendOutFrames: clip.blendOutFrames,
					easeIn: clip.easeIn,
					easeOut: clip.easeOut,
					preExtrapolation: clip.preExtrapolation,
					postExtrapolation: clip.postExtrapolation,
				})),
				animationGroupWeight: track.weightKeys.map(legacyPropertyKey),
			};
		}
		case "audio": {
			const soundId = track.clips[0]?.soundId;
			if (!soundId) {
				return null;
			}
			if (track.clips.some((clip) => clip.soundId !== soundId)) {
				throw new Error(`Legacy compatibility cannot flatten audio track "${track.id}" because it references multiple sounds.`);
			}
			return {
				_id: track.id,
				sound: soundId,
				sounds: track.clips.map((clip) => ({
					id: clip.id,
					name: clip.name,
					type: "sound",
					frame: clip.startFrame,
					startFrame: clip.clipInFrame,
					endFrame: clip.clipInFrame + clip.durationFrames * Math.abs(clip.timeScale),
					speed: clip.timeScale,
					volume: clip.volume,
					loop: clip.loop,
					enabled: clip.enabled,
					blendInFrames: clip.blendInFrames,
					blendOutFrames: clip.blendOutFrames,
					easeIn: clip.easeIn,
					easeOut: clip.easeOut,
					preExtrapolation: clip.preExtrapolation,
					postExtrapolation: clip.postExtrapolation,
				})),
				soundVolume: track.volumeKeys.map(legacyPropertyKey),
			};
		}
		case "signal":
			return { _id: track.id, keyFrameEvents: track.markers.map((_marker, index) => legacyMarker(track, index)) };
		default:
			return null;
	}
}

/** Projects supported version-2 lanes into the original editor/runtime representation without mutating the document. */
export function toLegacyCinematic(value: ICinematicDocument): ICinematic {
	const document = normalizeCinematicDocument(value);
	return {
		name: document.name,
		framesPerSecond: document.framesPerSecond,
		outputFramesPerSecond: document.outputFramesPerSecond,
		tracks: document.tracks.map(legacyTrack).filter((track): track is ICinematicTrack => track !== null),
	};
}

/** Reports typed lanes that the original editor/runtime cannot display, preventing silent destructive conversions. */
export function getLegacyCinematicUnsupportedTracks(value: ICinematicDocument): TCinematicTrack[] {
	const document = normalizeCinematicDocument(value);
	return document.tracks.filter((track) => !legacyEditableTypes.includes(track.type)).map((track) => structuredClone(track));
}

/** Merges edits made through the original UI back into a canonical document while preserving version-2-only lanes and metadata. */
export function mergeLegacyCinematic(value: ICinematicDocument, legacy: ICinematic): ICinematicDocument {
	const current = normalizeCinematicDocument(value);
	const incoming = migrateLegacyCinematic({ ...legacy, version: 1 }, { identitySeed: current.id }).tracks;
	const incomingById = new Map(incoming.map((track) => [track.id, track]));
	const consumed = new Set<string>();
	const tracks: TCinematicTrack[] = [];
	for (const existing of current.tracks) {
		if (!legacyEditableTypes.includes(existing.type)) {
			tracks.push(structuredClone(existing));
			continue;
		}
		const edited = incomingById.get(existing.id);
		if (!edited) {
			continue;
		}
		consumed.add(edited.id);
		tracks.push({ ...edited, name: existing.name, parentId: existing.parentId, muted: existing.muted, solo: existing.solo, locked: existing.locked, color: existing.color });
	}
	for (const edited of incoming) {
		if (!consumed.has(edited.id)) {
			tracks.push(edited);
		}
	}
	tracks.forEach((track, order) => (track.order = order));
	return normalizeCinematicDocument({
		...current,
		name: legacy.name,
		framesPerSecond: legacy.framesPerSecond,
		outputFramesPerSecond: legacy.outputFramesPerSecond,
		tracks,
	});
}
