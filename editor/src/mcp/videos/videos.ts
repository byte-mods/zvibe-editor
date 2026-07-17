import { Scene, Tools, VideoTexture } from "babylonjs";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { IMCPActionOptions } from "../action";

type IVideoPlayer = {
	id: string;
	name: string;
	path: string;
	materialId: string;
	textureSlot: "diffuseTexture" | "albedoTexture" | "emissiveTexture" | "opacityTexture";
	autoPlay: boolean;
	loop: boolean;
	muted: boolean;
	volume: number;
	startTime: number;
};

const videoExtensions = new Set(["mp4", "webm", "ogv", "mov"]);
const textureSlots = new Set<IVideoPlayer["textureSlot"]>(["diffuseTexture", "albedoTexture", "emissiveTexture", "opacityTexture"]);
const previewTextures = new WeakMap<Scene, Map<string, VideoTexture>>();

function getPreviewTextures(scene: Scene): Map<string, VideoTexture> {
	let textures = previewTextures.get(scene);
	if (!textures) {
		textures = new Map();
		previewTextures.set(scene, textures);
	}
	return textures;
}

function disposePreviewTexture(scene: Scene, playerId: string): void {
	const texture = previewTextures.get(scene)?.get(playerId);
	if (!texture) {
		return;
	}
	texture.dispose();
	previewTextures.get(scene)?.delete(playerId);
}

/** Attaches a VideoTexture to the live editor scene when a project asset root is available. */
function synchronizePreview(scene: Scene, player: IVideoPlayer): boolean {
	disposePreviewTexture(scene, player.id);
	const rootUrl = getProjectAssetsRootUrl();
	const material: any = scene.getMaterialById(player.materialId);
	if (!rootUrl || !material) {
		return false;
	}

	try {
		const texture = new VideoTexture(player.name, `${rootUrl}${player.path}`, scene, false, true, undefined, {
			autoPlay: player.autoPlay,
			loop: player.loop,
			muted: player.muted,
			autoUpdateTexture: true,
		});
		texture.video.volume = player.volume;
		if (player.startTime > 0) {
			texture.video.addEventListener("loadedmetadata", () => (texture.video.currentTime = player.startTime), { once: true });
		}
		material[player.textureSlot] = texture;
		getPreviewTextures(scene).set(player.id, texture);
		return true;
	} catch {
		return false;
	}
}

function getVideoPlayers(scene: Scene): IVideoPlayer[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorVideoPlayers ??= []);
}

function findVideoPlayer(scene: Scene, data: { id?: string; name?: string }): IVideoPlayer {
	const player = getVideoPlayers(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!player) {
		throw new Error("Video player not found.");
	}
	return player;
}

function validatePlayer(scene: Scene, data: any): void {
	if (typeof data.path !== "string" || !videoExtensions.has(data.path.split(".").pop()?.toLowerCase() ?? "")) {
		throw new Error("`path` must reference an .mp4, .webm, .ogv, or .mov video asset.");
	}
	if (!scene.getMaterialById(data.materialId)) {
		throw new Error(`Material "${data.materialId}" was not found.`);
	}
	if (data.textureSlot !== undefined && !textureSlots.has(data.textureSlot)) {
		throw new Error("textureSlot must be diffuseTexture, albedoTexture, emissiveTexture, or opacityTexture.");
	}
	if (data.volume !== undefined && (!Number.isFinite(data.volume) || data.volume < 0 || data.volume > 1)) {
		throw new Error("volume must be between 0 and 1.");
	}
	if (data.startTime !== undefined && (!Number.isFinite(data.startTime) || data.startTime < 0)) {
		throw new Error("startTime must be zero or greater.");
	}
}

/** Lists persistent, material-targeted video players. */
export function listVideoPlayers(scene: Scene): any {
	return {
		players: getVideoPlayers(scene).map((player) => ({
			...structuredClone(player),
			previewAttached: Boolean(previewTextures.get(scene)?.has(player.id)),
		})),
	};
}

/** Creates a persistent VideoTexture player. The exported runtime attaches it to the selected material slot. */
export function createVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	validatePlayer(scene, data);
	if (getVideoPlayers(scene).some((candidate) => candidate.name === data.name)) {
		throw new Error(`Video player "${data.name}" already exists.`);
	}
	const material: any = scene.getMaterialById(data.materialId);
	const textureSlot = data.textureSlot ?? ("albedoTexture" in material ? "albedoTexture" : "diffuseTexture");
	const player: IVideoPlayer = {
		id: Tools.RandomId(),
		name: data.name,
		path: data.path,
		materialId: data.materialId,
		textureSlot,
		autoPlay: data.autoPlay ?? true,
		loop: data.loop ?? true,
		muted: data.muted ?? true,
		volume: data.volume ?? 1,
		startTime: data.startTime ?? 0,
	};
	getVideoPlayers(scene).push(player);
	const previewAttached = synchronizePreview(scene, player);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(player), previewAttached };
}

/** Updates persistent video playback properties and synchronizes the live editor preview. */
export function setVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const player = findVideoPlayer(scene, data);
	const next = { ...player, ...data, id: player.id, name: data.name ?? player.name };
	validatePlayer(scene, next);
	if (data.name !== undefined && getVideoPlayers(scene).some((candidate) => candidate !== player && candidate.name === data.name)) {
		throw new Error(`Video player "${data.name}" already exists.`);
	}
	Object.assign(player, next);
	const previewAttached = synchronizePreview(scene, player);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(player), previewAttached };
}

/** Plays, pauses, or seeks the live editor VideoTexture for a persisted player. */
export async function controlVideoPlayer(scene: Scene, data: any): Promise<any> {
	const player = findVideoPlayer(scene, data);
	const texture = previewTextures.get(scene)?.get(player.id) ?? (synchronizePreview(scene, player) ? previewTextures.get(scene)?.get(player.id) : undefined);
	if (!texture) {
		throw new Error("Video preview is unavailable. Open a project with the video asset to control playback.");
	}
	if (data.action === "play") {
		await texture.video.play();
	} else if (data.action === "pause") {
		texture.video.pause();
	} else if (data.action === "seek") {
		if (!Number.isFinite(data.time) || data.time < 0) {
			throw new Error("`time` must be a non-negative number when seeking.");
		}
		texture.video.currentTime = data.time;
	} else {
		throw new Error("action must be play, pause, or seek.");
	}
	return {
		...structuredClone(player),
		previewAttached: true,
		isPlaying: !texture.video.paused,
		currentTime: texture.video.currentTime,
	};
}

/** Deletes a video player configuration. It does not delete the source video asset or material. */
export function deleteVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const player = findVideoPlayer(scene, data);
	disposePreviewTexture(scene, player.id);
	getVideoPlayers(scene).splice(getVideoPlayers(scene).indexOf(player), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: player.id };
}
