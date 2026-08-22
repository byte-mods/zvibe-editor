import { randomUUID } from "crypto";

import { Scene } from "babylonjs";
import { ICinematicDocument, TCinematicClip, TCinematicPropertyKey, TCinematicTrack } from "babylonjs-editor-tools";

function identifier(kind: string): string {
	return `${kind}-${randomUUID()}`;
}

function trackBase(document: ICinematicDocument, type: TCinematicTrack["type"]): Omit<TCinematicTrack, "type"> & { type: TCinematicTrack["type"] } {
	return {
		id: identifier("track"),
		name: `${type[0].toUpperCase()}${type.slice(1)} Track`,
		type,
		order: document.tracks.length,
		parentId: null,
		muted: false,
		solo: false,
		locked: false,
		color: type === "audio" ? "#22C55E" : type === "video" ? "#06B6D4" : type === "signal" ? "#F59E0B" : type === "camera" ? "#A855F7" : "#64748B",
	} as Omit<TCinematicTrack, "type"> & { type: TCinematicTrack["type"] };
}

function targetNodeId(scene: Scene): string {
	return scene.activeCamera?.id ?? scene.meshes[0]?.id ?? scene.transformNodes[0]?.id ?? "node";
}

export function createDefaultCinematicTrack(document: ICinematicDocument, scene: Scene, type: TCinematicTrack["type"]): TCinematicTrack {
	const base = trackBase(document, type);
	switch (type) {
		case "group":
			return { ...base, type, collapsed: false };
		case "property":
			return { ...base, type, targetType: "node", targetId: targetNodeId(scene), propertyPath: "position.x", keys: [] };
		case "animation":
			return { ...base, type, clips: [], weightKeys: [] };
		case "audio":
			return { ...base, type, clips: [], volumeKeys: [] };
		case "video":
			return { ...base, type, clips: [] };
		case "signal":
			return { ...base, type, markers: [] };
		case "activation":
		case "camera":
		case "control":
		case "recorder":
			return { ...base, type, clips: [] } as TCinematicTrack;
	}
}

function clipBase(document: ICinematicDocument, type: TCinematicClip["type"], startFrame: number) {
	return {
		id: identifier("clip"),
		name: `${type[0].toUpperCase()}${type.slice(1)} Clip`,
		startFrame,
		durationFrames: Math.max(
			1,
			Math.min(document.framesPerSecond, document.durationMode === "fixed" ? Math.max(1, document.durationFrames - startFrame) : document.framesPerSecond)
		),
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 0,
		blendOutFrames: 0,
		easeIn: "linear" as const,
		easeOut: "linear" as const,
		preExtrapolation: "none" as const,
		postExtrapolation: "none" as const,
	};
}

export function createDefaultCinematicClip(document: ICinematicDocument, scene: Scene, track: TCinematicTrack, startFrame: number): TCinematicClip {
	switch (track.type) {
		case "animation": {
			const group = scene.animationGroups[0];
			return {
				...clipBase(document, "animation", startFrame),
				type: "animation",
				animationGroupId: group?.name ?? "AnimationGroup",
				sourceStartFrame: group?.from ?? 0,
				sourceEndFrame: Math.max(group?.from ?? 0, group?.to ?? document.framesPerSecond),
				loopCount: 0,
			};
		}
		case "audio": {
			const sound = scene.transformNodes.find((node) => (node as { isSoundNode?: boolean }).isSoundNode);
			return { ...clipBase(document, "audio", startFrame), type: "audio", soundId: sound?.id ?? "Sound", volume: 1, loop: false };
		}
		case "video": {
			const player = (scene.metadata?.babylonEditorVideoPlayers as Array<{ id?: string; name?: string; loop?: boolean }> | undefined)?.[0];
			if (!player?.id) {
				throw new Error("Create a persistent Video Player in the Scene Inspector before adding a Video clip.");
			}
			return {
				...clipBase(document, "video", startFrame),
				type: "video",
				name: player.name ? `${player.name} Clip` : "Video Clip",
				videoPlayerId: player.id,
				volume: 1,
				loop: player.loop ?? false,
				muteAudio: false,
			};
		}
		case "activation":
			return { ...clipBase(document, "activation", startFrame), type: "activation", nodeId: targetNodeId(scene), active: true };
		case "camera":
			return { ...clipBase(document, "camera", startFrame), type: "camera", cameraId: scene.activeCamera?.id ?? scene.cameras[0]?.id ?? "Camera", blendMode: "cut" };
		case "control": {
			const particleSystem = scene.particleSystems[0];
			return {
				...clipBase(document, "control", startFrame),
				type: "control",
				targetType: particleSystem ? "particleSystem" : "cinematic",
				targetId: particleSystem?.id ?? "assets/child.cinematic",
				action: "play",
			};
		}
		case "recorder": {
			const profile = document.recorderProfiles[0];
			if (!profile) {
				throw new Error("Create a recorder profile before adding a recorder clip.");
			}
			return { ...clipBase(document, "recorder", startFrame), type: "recorder", profileId: profile.id };
		}
		default:
			throw new Error(`Cinematic ${track.type} tracks do not contain clips.`);
	}
}

export function createDefaultCinematicKey(track: TCinematicTrack, frame: number): { lane: "property" | "weight" | "volume"; key: TCinematicPropertyKey } {
	const lane = track.type === "property" ? "property" : track.type === "animation" ? "weight" : track.type === "audio" ? "volume" : null;
	if (!lane) {
		throw new Error(`Cinematic ${track.type} tracks do not contain property keys.`);
	}
	return { lane, key: { id: identifier("key"), type: "key", frame, value: lane === "property" ? 0 : 1, interpolation: "linear" } };
}

export function createDefaultCinematicCut(track: TCinematicTrack, frame: number): { lane: "property" | "weight" | "volume"; key: TCinematicPropertyKey } {
	const lane = track.type === "property" ? "property" : track.type === "animation" ? "weight" : track.type === "audio" ? "volume" : null;
	if (!lane) {
		throw new Error(`Cinematic ${track.type} tracks do not contain property cuts.`);
	}
	const value = lane === "property" ? 0 : 1;
	return { lane, key: { id: identifier("cut"), type: "cut", frame, incomingValue: value, outgoingValue: value } };
}

export function createDefaultCinematicMarker(frame: number) {
	return { id: identifier("marker"), name: "Signal", type: "signal" as const, frame, emitOnce: false, retroactive: false, payload: null };
}

export function createDefaultRecorderProfile() {
	return { id: identifier("capture"), name: "Game View 1080p", format: "webm" as const, width: 1920, height: 1080, framesPerSecond: 60, quality: 0.9, includeAudio: false };
}
