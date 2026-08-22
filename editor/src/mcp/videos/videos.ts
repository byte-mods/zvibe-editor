import { Scene, Tools } from "babylonjs";
import { dirname, join } from "path/posix";
import { pathToFileURL } from "url";
import {
	configureVideoPlayer,
	disposeVideoPlayer,
	IVideoPlayerConfiguration,
	normalizeVideoPlayerConfiguration,
	pauseConfiguredVideoPlayer,
	playConfiguredVideoPlayer,
	seekConfiguredVideoPlayer,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { getVideoImporterArtifactStatus } from "../assets/video-importer";

function getVideoPlayers(scene: Scene): IVideoPlayerConfiguration[] {
	scene.metadata ??= {};
	const raw = scene.metadata.babylonEditorVideoPlayers;
	const players = Array.isArray(raw) ? raw.map((value) => normalizeVideoPlayerConfiguration(value)) : [];
	scene.metadata.babylonEditorVideoPlayers = players;
	return players;
}

function findVideoPlayerIn(players: IVideoPlayerConfiguration[], data: { id?: string; name?: string }): IVideoPlayerConfiguration {
	const player = players.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!player) {
		throw new Error("Video player not found.");
	}
	return player;
}

function findVideoPlayer(scene: Scene, data: { id?: string; name?: string }): IVideoPlayerConfiguration {
	return findVideoPlayerIn(getVideoPlayers(scene), data);
}

function validateReferences(scene: Scene, player: IVideoPlayerConfiguration): void {
	if (player.targetMode === "material" && !scene.getMaterialById(player.materialId!)) {
		throw new Error(`Material "${player.materialId}" was not found.`);
	}
	if ((player.targetMode === "cameraNearPlane" || player.targetMode === "cameraFarPlane") && player.cameraId && !scene.getCameraById(player.cameraId)) {
		throw new Error(`Camera "${player.cameraId}" was not found.`);
	}
	if ((player.targetMode === "cameraNearPlane" || player.targetMode === "cameraFarPlane") && !player.cameraId && !scene.activeCamera) {
		throw new Error("Camera-targeted video players require cameraId or an active camera.");
	}
}

function runtimeSnapshot(scene: Scene, player: IVideoPlayerConfiguration): Record<string, unknown> {
	const runtime = (scene as any).videoPlayerRuntimes?.get(player.id);
	return {
		...structuredClone(player),
		autoPlay: player.playOnAwake,
		previewAttached: Boolean(runtime),
		runtime: runtime
			? {
					status: runtime.status,
					error: runtime.error,
					resolvedSource: runtime.resolvedSource,
					currentTime: runtime.texture.video.currentTime,
					duration: Number.isFinite(runtime.texture.video.duration) ? runtime.texture.video.duration : null,
					readyState: runtime.texture.video.readyState,
					isPlaying: runtime.configuration.updateMode === "audioTime" ? !runtime.texture.video.paused : runtime.manualPlaying,
					targetAttached:
						runtime.configuration.targetMode === "material"
							? true
							: runtime.configuration.targetMode === "renderTexture"
								? Boolean((scene as any).videoRenderTextures?.has(player.id))
								: runtime.configuration.targetMode === "cameraNearPlane" || runtime.configuration.targetMode === "cameraFarPlane"
									? Boolean(runtime.layer)
									: Boolean((scene as any).videoPlayers?.has(player.id)),
				}
			: null,
	};
}

async function synchronizePreview(scene: Scene, player: IVideoPlayerConfiguration): Promise<boolean> {
	const rootUrl = getProjectAssetsRootUrl();
	if (player.sourceType === "asset" && !rootUrl) {
		disposeVideoPlayer(scene as any, player.id);
		return false;
	}
	try {
		let resolvedAssetSource: string | undefined;
		if (player.sourceType === "asset") {
			const absolutePath = join(dirname(projectConfiguration.path!), player.path);
			const imported = await getVideoImporterArtifactStatus(absolutePath);
			resolvedAssetSource = imported.current && imported.exists ? pathToFileURL(imported.artifactPath).toString() : `${rootUrl}${player.path}`;
		}
		await configureVideoPlayer(scene as any, rootUrl ?? "", player, resolvedAssetSource);
		return true;
	} catch (error) {
		disposeVideoPlayer(scene as any, player.id);
		throw error;
	}
}

function defaultTextureSlot(scene: Scene, materialId: string | null): IVideoPlayerConfiguration["textureSlot"] {
	const material: any = materialId ? scene.getMaterialById(materialId) : null;
	return material && "albedoTexture" in material ? "albedoTexture" : "diffuseTexture";
}

function configurationFromData(scene: Scene, data: any, existing?: IVideoPlayerConfiguration): IVideoPlayerConfiguration {
	const materialId = data.materialId !== undefined ? data.materialId : (existing?.materialId ?? null);
	return normalizeVideoPlayerConfiguration({
		...(existing ?? {}),
		...data,
		version: 2,
		id: existing?.id ?? data.id ?? Tools.RandomId(),
		name: data.name ?? existing?.name,
		sourceType: data.sourceType ?? existing?.sourceType ?? "asset",
		path: data.path ?? existing?.path,
		targetMode: data.targetMode ?? existing?.targetMode ?? "material",
		materialId,
		textureSlot: data.textureSlot ?? existing?.textureSlot ?? defaultTextureSlot(scene, materialId),
		cameraId: data.cameraId !== undefined ? data.cameraId : (existing?.cameraId ?? null),
		playOnAwake: data.playOnAwake ?? data.autoPlay ?? existing?.playOnAwake,
	});
}

/** Lists normalized players plus live decode, clock, and target diagnostics. */
export function listVideoPlayers(scene: Scene): any {
	return { players: getVideoPlayers(scene).map((player) => runtimeSnapshot(scene, player)) };
}

/** Creates one version-2 Video Player and attaches its selected target in the live preview. */
export async function createVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const player = configurationFromData(scene, data);
	const players = getVideoPlayers(scene);
	if (players.some((candidate) => candidate.name === player.name)) {
		throw new Error(`Video player "${player.name}" already exists.`);
	}
	validateReferences(scene, player);
	players.push(player);
	try {
		await synchronizePreview(scene, player);
	} catch (error) {
		players.splice(
			players.findIndex((candidate) => candidate.id === player.id),
			1
		);
		throw error;
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return runtimeSnapshot(scene, player);
}

/** Updates all authored source, target, timing, layout, audio, and color properties atomically. */
export async function setVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const players = getVideoPlayers(scene);
	const player = findVideoPlayerIn(players, { id: data.id, name: data.currentName ?? data.name });
	const next = configurationFromData(scene, data, player);
	if (players.some((candidate) => candidate.id !== player.id && candidate.name === next.name)) {
		throw new Error(`Video player "${next.name}" already exists.`);
	}
	validateReferences(scene, next);
	const previous = structuredClone(player);
	Object.assign(player, next);
	try {
		await synchronizePreview(scene, player);
	} catch (error) {
		Object.assign(player, previous);
		await synchronizePreview(scene, player).catch(() => undefined);
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	return runtimeSnapshot(scene, player);
}

/** Plays, pauses, or seeks the exact runtime associated with a persisted player. */
export async function controlVideoPlayer(scene: Scene, data: any): Promise<any> {
	const player = findVideoPlayer(scene, data);
	let runtime = (scene as any).videoPlayerRuntimes?.get(player.id);
	if (!runtime && (await synchronizePreview(scene, player))) {
		runtime = (scene as any).videoPlayerRuntimes?.get(player.id);
	}
	if (!runtime) {
		throw new Error("Video preview is unavailable. Open a project with the video asset to control playback.");
	}
	if (data.action === "play") {
		await playConfiguredVideoPlayer(runtime);
	} else if (data.action === "pause") {
		pauseConfiguredVideoPlayer(runtime);
	} else if (data.action === "seek") {
		seekConfiguredVideoPlayer(runtime, data.time);
	} else {
		throw new Error("action must be play, pause, or seek.");
	}
	return runtimeSnapshot(scene, player);
}

/** Deletes a player and restores/disposes only the resources owned by that player. */
export function deleteVideoPlayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const players = getVideoPlayers(scene);
	const player = findVideoPlayerIn(players, data);
	disposeVideoPlayer(scene as any, player.id);
	players.splice(
		players.findIndex((candidate) => candidate.id === player.id),
		1
	);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: player.id };
}
