import { Scene } from "@babylonjs/core/scene";
import { VideoTexture } from "@babylonjs/core/Materials/Textures/videoTexture";

export type IVideoPlayerConfiguration = {
	id: string;
	name: string;
	path: string;
	materialId: string;
	textureSlot: "diffuseTexture" | "albedoTexture" | "emissiveTexture" | "opacityTexture";
	autoPlay?: boolean;
	loop?: boolean;
	muted?: boolean;
	volume?: number;
	startTime?: number;
};

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		videoPlayers?: Map<string, VideoTexture>;
	}
}

export async function resolveImportedVideoPath(rootUrl: string, path: string): Promise<string> {
	try {
		const response = await fetch(`${rootUrl}${path}.bjsvideo.json`);
		if (!response.ok) {
			return path;
		}
		const metadata = await response.json();
		return typeof metadata?.outputPath === "string" && metadata.outputPath ? metadata.outputPath : path;
	} catch {
		return path;
	}
}

/** Recreates persistent editor video players after scene loading, resolving imported build artifacts when available. */
export async function configureVideoPlayers(scene: Scene, rootUrl: string): Promise<void> {
	const players = scene.metadata?.babylonEditorVideoPlayers as IVideoPlayerConfiguration[] | undefined;
	if (!players?.length) {
		return;
	}
	scene.videoPlayers ??= new Map();
	for (const player of players) {
		if (!player.path || !player.materialId) {
			continue;
		}
		const material: any = scene.getMaterialById(player.materialId);
		if (!material) {
			continue;
		}
		const importedPath = await resolveImportedVideoPath(rootUrl, player.path);
		const texture = new VideoTexture(player.name, `${rootUrl}${importedPath}`, scene, false, true, undefined, {
			autoPlay: player.autoPlay ?? true,
			loop: player.loop ?? true,
			muted: player.muted ?? true,
			autoUpdateTexture: true,
		});
		texture.video.volume = player.volume ?? 1;
		const startTime = player.startTime ?? 0;
		if (startTime > 0) {
			texture.video.addEventListener("loadedmetadata", () => (texture.video.currentTime = startTime), { once: true });
		}
		material[player.textureSlot] = texture;
		scene.videoPlayers.set(player.id, texture);
	}
}
