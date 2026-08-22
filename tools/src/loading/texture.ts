import { Scene } from "@babylonjs/core/scene";
import { Nullable } from "@babylonjs/core/types";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SerializationHelper } from "@babylonjs/core/Misc/decorators.serialization";

import { _getKtx2TextureName, getTextureUrl, isUsingKtx2CompressedTextures } from "../tools/texture";
import { ITextureImportProcessingEvidence, ITextureImportSpriteMetadata, ITextureRuntimeManifest } from "../assets/texture-importer";

let registered = false;

export function registerTextureParser() {
	if (registered) {
		return;
	}

	registered = true;

	const textureParser =
		typeof SerializationHelper._TextureParser === "function"
			? SerializationHelper._TextureParser
			: (sourceProperty: any, scene: Scene, rootUrl: string) => Texture.Parse(sourceProperty, scene, rootUrl);

	SerializationHelper._TextureParser = (sourceProperty: any, scene: Scene, rootUrl: string): Nullable<BaseTexture> => {
		const authoredTextureUrl = sourceProperty.url || sourceProperty.name;
		if (isUsingKtx2CompressedTextures()) {
			if (sourceProperty.name) {
				sourceProperty.name = _getKtx2TextureName(sourceProperty.name);
			}

			if (sourceProperty.url) {
				sourceProperty.url = _getKtx2TextureName(sourceProperty.url);
			}
		}

		const suffix = getTextureUrl(sourceProperty, scene);
		if (!suffix) {
			return textureParser(sourceProperty, scene, rootUrl);
		}

		const originalName = sourceProperty.name;
		sourceProperty.name = suffix;

		const texture = textureParser(sourceProperty, scene, rootUrl);
		if (texture) {
			texture.name = originalName;
			if (authoredTextureUrl && authoredTextureUrl !== sourceProperty.url && authoredTextureUrl !== sourceProperty.name) {
				texture.metadata ??= {};
				texture.metadata.babylonEditorAuthoredTexturePath = authoredTextureUrl;
			}
		}

		return texture;
	};
}

function authoredTexturePath(texture: BaseTexture, rootUrl: string): string | null {
	const importedAuthoredPath = texture.metadata?.babylonEditorAuthoredTexturePath;
	const candidate = (typeof importedAuthoredPath === "string" && importedAuthoredPath) || (texture as Texture).url || texture.name;
	if (!candidate || /^(?:data:|blob:|https?:\/\/)/i.test(candidate)) {
		return null;
	}
	const relativePath = (candidate.startsWith(rootUrl) ? candidate.slice(rootUrl.length) : candidate.replace(/^\.\//, "")).replace(/^\/+/, "");
	return relativePath.startsWith("assets/") ? relativePath : null;
}

/** Limits importer-manifest probes to source formats that the Editor/CLI texture importer actually processes. */
function supportsImportedTextureManifest(path: string): boolean {
	return /\.(?:jpe?g|webp|png|bmp|gif|tiff?|tga|psd|psb|svg|hdr|exr)(?:[?#]|$)/i.test(path);
}

/** Narrows fetched JSON objects without permitting arrays or null through the runtime manifest boundary. */
function manifestRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Validates optional v2 sprite metadata before it is exposed to gameplay code through texture metadata. */
function normalizeRuntimeSprite(value: unknown): ITextureImportSpriteMetadata | null | undefined {
	if (value === null) {
		return null;
	}
	const source = manifestRecord(value);
	const bounds = manifestRecord(source?.bounds);
	if (
		!source ||
		!bounds ||
		typeof source.pixelsPerUnit !== "number" ||
		!Number.isFinite(source.pixelsPerUnit) ||
		source.pixelsPerUnit <= 0 ||
		!["fullRect", "tight"].includes(String(source.meshType)) ||
		typeof source.extrude !== "number" ||
		!Number.isInteger(source.extrude) ||
		source.extrude < 0 ||
		source.extrude > 32 ||
		!["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key]) && (bounds[key] as number) >= 0)
	) {
		return undefined;
	}
	return {
		pixelsPerUnit: source.pixelsPerUnit,
		meshType: source.meshType as ITextureImportSpriteMetadata["meshType"],
		extrude: source.extrude,
		bounds: { x: bounds.x as number, y: bounds.y as number, width: bounds.width as number, height: bounds.height as number },
	};
}

/** Validates execution evidence so malformed sidecars cannot masquerade as a successful importer run. */
function normalizeRuntimeProcessing(value: unknown): ITextureImportProcessingEvidence | null {
	const source = manifestRecord(value);
	const booleanKeys: Array<keyof ITextureImportProcessingEvidence> = [
		"maxSizeApplied",
		"nonPowerOfTwoApplied",
		"fullMipChain",
		"alphaDerivedFromGrayscale",
		"transparentColorsDilated",
		"normalMapGenerated",
		"mipmapCoveragePreserved",
	];
	if (!source || typeof source.outputFormat !== "string" || !source.outputFormat || !booleanKeys.every((key) => typeof source[key] === "boolean")) {
		return null;
	}
	return {
		outputFormat: source.outputFormat,
		maxSizeApplied: source.maxSizeApplied as boolean,
		nonPowerOfTwoApplied: source.nonPowerOfTwoApplied as boolean,
		fullMipChain: source.fullMipChain as boolean,
		alphaDerivedFromGrayscale: source.alphaDerivedFromGrayscale as boolean,
		transparentColorsDilated: source.transparentColorsDilated as boolean,
		normalMapGenerated: source.normalMapGenerated as boolean,
		mipmapCoveragePreserved: source.mipmapCoveragePreserved as boolean,
	};
}

/** Migrates legacy v1 sidecars and rejects malformed v2 sampler/evidence contracts. */
function normalizeRuntimeManifest(value: unknown): ITextureRuntimeManifest | null {
	const source = manifestRecord(value);
	if (
		!source ||
		(source.version !== 1 && source.version !== 2) ||
		typeof source.outputPath !== "string" ||
		!source.outputPath ||
		!["default", "normalMap", "sprite", "lightmap", "cursor"].includes(String(source.textureType)) ||
		!["sRGB", "linear"].includes(String(source.colorSpace)) ||
		!["input", "none", "grayscale"].includes(String(source.alphaSource)) ||
		typeof source.generateMipmaps !== "boolean"
	) {
		return null;
	}
	if (source.version === 1) {
		const outputFormat = source.outputPath.split(".").pop()?.toLowerCase() || "unknown";
		return {
			...(source as Omit<ITextureRuntimeManifest, "version" | "filterMode" | "wrapModeU" | "wrapModeV" | "anisoLevel" | "sprite" | "processing">),
			version: 2,
			filterMode: "trilinear",
			wrapModeU: "repeat",
			wrapModeV: "repeat",
			anisoLevel: 1,
			sprite: null,
			processing: {
				outputFormat,
				maxSizeApplied: false,
				nonPowerOfTwoApplied: false,
				fullMipChain: !source.generateMipmaps,
				alphaDerivedFromGrayscale: source.alphaSource === "grayscale",
				transparentColorsDilated: false,
				normalMapGenerated: false,
				mipmapCoveragePreserved: false,
			},
		} as ITextureRuntimeManifest;
	}
	const sprite = normalizeRuntimeSprite(source.sprite);
	const processing = normalizeRuntimeProcessing(source.processing);
	if (
		!["point", "bilinear", "trilinear"].includes(String(source.filterMode)) ||
		!["repeat", "clamp", "mirror"].includes(String(source.wrapModeU)) ||
		!["repeat", "clamp", "mirror"].includes(String(source.wrapModeV)) ||
		typeof source.anisoLevel !== "number" ||
		!Number.isInteger(source.anisoLevel) ||
		source.anisoLevel < 0 ||
		source.anisoLevel > 16 ||
		sprite === undefined ||
		!processing
	) {
		return null;
	}
	return { ...(source as unknown as ITextureRuntimeManifest), sprite, processing };
}

/** Resolves the portable Texture Importer sidecar written by editor and CLI builds. */
export async function resolveImportedTextureManifest(rootUrl: string, authoredPath: string): Promise<ITextureRuntimeManifest | null> {
	try {
		const response = await fetch(`${rootUrl}${authoredPath}.bjstexture.json`);
		if (!response.ok) {
			return null;
		}
		return normalizeRuntimeManifest(await response.json());
	} catch {
		return null;
	}
}

/** Maps persisted importer filter modes to Babylon's explicit sampling constants. */
function runtimeSamplingMode(manifest: ITextureRuntimeManifest): number {
	return manifest.filterMode === "point" ? Texture.NEAREST_SAMPLINGMODE : manifest.filterMode === "bilinear" ? Texture.BILINEAR_SAMPLINGMODE : Texture.TRILINEAR_SAMPLINGMODE;
}

/** Maps persisted importer wrap modes to Babylon's explicit address-mode constants. */
function runtimeWrapMode(mode: ITextureRuntimeManifest["wrapModeU"]): number {
	return mode === "clamp" ? Texture.CLAMP_ADDRESSMODE : mode === "mirror" ? Texture.MIRROR_ADDRESSMODE : Texture.WRAP_ADDRESSMODE;
}

/** Applies importer sampler state after any URL redirect so compressed and portable outputs behave identically. */
function applyRuntimeSampler(texture: BaseTexture, manifest: ITextureRuntimeManifest): void {
	texture.wrapU = runtimeWrapMode(manifest.wrapModeU);
	texture.wrapV = runtimeWrapMode(manifest.wrapModeV);
	texture.anisotropicFilteringLevel = manifest.anisoLevel;
	const runtimeTexture = texture as Texture;
	if (typeof runtimeTexture.updateSamplingMode === "function") {
		runtimeTexture.updateSamplingMode(runtimeSamplingMode(manifest));
	}
}

/** Applies imported output redirects and sampling color-space flags before the loader's final readiness wait. */
export async function configureImportedTextures(scene: Scene, rootUrl: string, textures: BaseTexture[] = scene.textures): Promise<number> {
	const candidates = textures
		.map((texture) => ({ texture, path: authoredTexturePath(texture, rootUrl) }))
		.filter((candidate): candidate is { texture: BaseTexture; path: string } => candidate.path !== null && supportsImportedTextureManifest(candidate.path));
	let applied = 0;
	for (let offset = 0; offset < candidates.length; offset += 8) {
		await Promise.all(
			candidates.slice(offset, offset + 8).map(async ({ texture, path }) => {
				const manifest = await resolveImportedTextureManifest(rootUrl, path);
				if (!manifest) {
					return;
				}
				texture.gammaSpace = manifest.colorSpace === "sRGB";
				texture.metadata ??= {};
				texture.metadata.babylonEditorTextureImporter = manifest;
				const runtimeTexture = texture as Texture;
				const alreadyUsingCompressedOutput = typeof runtimeTexture.url === "string" && /\.ktx2(?:[?#]|$)/i.test(runtimeTexture.url);
				if (!alreadyUsingCompressedOutput && manifest.outputPath !== path && typeof runtimeTexture.updateURL === "function") {
					runtimeTexture.updateURL(`${rootUrl}${manifest.outputPath}`);
				}
				applyRuntimeSampler(texture, manifest);
				applied++;
			})
		);
	}
	return applied;
}
