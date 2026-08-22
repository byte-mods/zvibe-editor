/** Canonical portable asset-format contract shared by editor import, editor export, and CLI packing. */
export const assetImageExtensions: readonly string[] = [".jpg", ".jpeg", ".webp", ".png", ".bmp", ".gif", ".tif", ".tiff", ".tga", ".psd", ".psb", ".svg", ".hdr", ".exr"];
export const assetCubeTextureExtensions: readonly string[] = [".env", ".dds", ".hdr"];
export const assetAudioExtensions: readonly string[] = [".mp3", ".wav", ".wave", ".ogg", ".flac", ".m4a"];
export const assetVideoExtensions: readonly string[] = [".mp4", ".webm", ".ogv", ".mov"];
export const assetModelExtensions: readonly string[] = [".glb", ".gltf", ".babylon", ".fbx", ".obj", ".stl", ".dae", ".3ds", ".ms3d", ".b3d", ".x", ".lwo", ".dxf", ".blend"];
export const assetAlembicExtensions: readonly string[] = [".abc"];
export const assetAsepriteExtensions: readonly string[] = [".ase", ".aseprite"];
export const assetFontExtensions: readonly string[] = [".ttf", ".otf", ".woff", ".woff2"];
export const assetAnimationExtensions: readonly string[] = [".animation", ".animations", ".anim", ".animator", ".controller"];
export const assetMaterialExtensions: readonly string[] = [".material", ".mtl"];
export const assetJsonDocumentExtensions: readonly string[] = [".material", ".gui", ".cinematic", ".npss", ".ragdoll", ".json"];
export const assetMiscExtensions: readonly string[] = [".3dl", ".exr", ".hdr", ".uxml", ".uss", ".onnx", ".tflite", ".pt2"];
export const assetRetainedUIExtensions: readonly string[] = [".uxml", ".uss"];

function uniqueExtensions(groups: readonly (readonly string[])[]): readonly string[] {
	return [...new Set(groups.flat())];
}

export const assetBuildSupportedExtensions: readonly string[] = uniqueExtensions([
	assetImageExtensions,
	assetCubeTextureExtensions,
	assetAudioExtensions,
	assetVideoExtensions,
	assetModelExtensions,
	assetAlembicExtensions,
	assetAsepriteExtensions,
	assetFontExtensions,
	assetAnimationExtensions,
	assetMaterialExtensions,
	assetJsonDocumentExtensions,
	assetMiscExtensions,
]);

// Generic JSON also represents project configuration files, so only typed JSON-backed asset suffixes require /assets placement.
export const assetRootPlacementExclusions: readonly string[] = [".json"];
export const assetRootRequiredExtensions: readonly string[] = assetBuildSupportedExtensions.filter((extension) => !assetRootPlacementExclusions.includes(extension));

export function requiresAssetRoot(extension: string): boolean {
	return assetRootRequiredExtensions.includes(extension.trim().toLowerCase());
}
