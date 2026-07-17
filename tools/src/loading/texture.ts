import { Scene } from "@babylonjs/core/scene";
import { Nullable } from "@babylonjs/core/types";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { SerializationHelper } from "@babylonjs/core/Misc/decorators.serialization";

import { _getKtx2TextureName, getTextureUrl, isUsingKtx2CompressedTextures } from "../tools/texture";
import { ITextureRuntimeManifest } from "../assets/texture-importer";

let registered = false;

export function registerTextureParser() {
	if (registered) {
		return;
	}

	registered = true;

	const textureParser = SerializationHelper._TextureParser;

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
	return candidate.startsWith(rootUrl) ? candidate.slice(rootUrl.length) : candidate.replace(/^\.\//, "");
}

/** Resolves the portable Texture Importer sidecar written by editor and CLI builds. */
export async function resolveImportedTextureManifest(rootUrl: string, authoredPath: string): Promise<ITextureRuntimeManifest | null> {
	try {
		const response = await fetch(`${rootUrl}${authoredPath}.bjstexture.json`);
		if (!response.ok) {
			return null;
		}
		const manifest = (await response.json()) as Partial<ITextureRuntimeManifest>;
		if (
			manifest.version !== 1 ||
			typeof manifest.outputPath !== "string" ||
			!manifest.outputPath ||
			!["default", "normalMap", "sprite", "lightmap", "cursor"].includes(String(manifest.textureType)) ||
			!["sRGB", "linear"].includes(String(manifest.colorSpace))
		) {
			return null;
		}
		return manifest as ITextureRuntimeManifest;
	} catch {
		return null;
	}
}

/** Applies imported output redirects and sampling color-space flags before the loader's final readiness wait. */
export async function configureImportedTextures(scene: Scene, rootUrl: string): Promise<number> {
	const candidates = scene.textures
		.map((texture) => ({ texture, path: authoredTexturePath(texture, rootUrl) }))
		.filter((candidate): candidate is { texture: BaseTexture; path: string } => candidate.path !== null);
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
				applied++;
			})
		);
	}
	return applied;
}
