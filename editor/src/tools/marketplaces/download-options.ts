import { IDownloadOptions } from "./types";

/**
 * Formats ordered from most to least suitable for a web game project.
 * glTF meshes and plain texture sets load directly in the editor and exported games; HDR/EXR are converted to `.env`.
 * Authoring formats such as `.blend` or `.fbx` are only used when nothing better is available.
 */
const preferredDownloadTypes = ["gltf", "glb", "jpg textures", "png textures", "jpg", "png", "hdr", "exr", "usdz", "zip", "fbx", "blend"];

export interface IMarketplaceDownloadSelection {
	quality: string;
	type: string;
	/**
	 * The import mode passed to `MarketplaceProvider.downloadAndImport`: `"env"` converts HDR/EXR files to environment textures.
	 */
	importAs: string;
}

/**
 * Picks the quality and file type to download when no explicit selection was made in the inspector (e.g. MCP-driven imports).
 * The requested resolution is matched case-insensitively ("2k" matches "2K"); otherwise the first quality is used.
 */
export function pickMarketplaceDownloadOption(downloadOptions: IDownloadOptions, resolution?: string): IMarketplaceDownloadSelection | null {
	const qualities = Object.keys(downloadOptions).filter((q) => Object.keys(downloadOptions[q] ?? {}).length > 0);
	if (!qualities.length) {
		return null;
	}

	const requested = resolution?.trim().toLowerCase();
	const quality = qualities.find((q) => q.toLowerCase() === requested) ?? qualities[0];

	const types = Object.keys(downloadOptions[quality]);
	const rank = (type: string): number => {
		const index = preferredDownloadTypes.indexOf(type.toLowerCase());
		return index === -1 ? preferredDownloadTypes.length : index;
	};
	const type = [...types].sort((a, b) => rank(a) - rank(b))[0];

	return {
		quality,
		type,
		importAs: /^(hdr|exr)$/i.test(type) ? "env" : type,
	};
}
