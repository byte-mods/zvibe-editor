import { FontImporterRenderMode, IFontAtlasManifest } from "../assets/font-importer";

export interface ILoadedImportedFont {
	authoredPath: string;
	renderMode: FontImporterRenderMode;
	family: string;
	manifestUrl: string;
	manifest: IFontAtlasManifest;
	pageUrls: string[];
	dynamicFontUrl: string | null;
}

function joinRoot(rootUrl: string, path: string): string {
	return `${rootUrl}${path}`;
}

/** Resolves one authored font through its generated build sidecar and loads the portable manifest. */
export async function loadImportedFontAsset(rootUrl: string, authoredPath: string): Promise<ILoadedImportedFont> {
	const sidecarResponse = await fetch(joinRoot(rootUrl, `${authoredPath}.bjsfont.json`));
	if (!sidecarResponse.ok) {
		throw new Error(`Imported font sidecar was not found for "${authoredPath}".`);
	}
	const sidecar = await sidecarResponse.json();
	if (typeof sidecar?.manifestPath !== "string" || typeof sidecar?.family !== "string" || typeof sidecar?.renderMode !== "string") {
		throw new Error(`Imported font sidecar is malformed for "${authoredPath}".`);
	}
	const manifestUrl = joinRoot(rootUrl, sidecar.manifestPath);
	const manifestResponse = await fetch(manifestUrl);
	if (!manifestResponse.ok) {
		throw new Error(`Imported font manifest was not found for "${authoredPath}".`);
	}
	const manifest = (await manifestResponse.json()) as IFontAtlasManifest;
	const manifestDirectory = sidecar.manifestPath.includes("/") ? sidecar.manifestPath.slice(0, sidecar.manifestPath.lastIndexOf("/") + 1) : "";
	const dynamicFontUrl = typeof sidecar.dynamicFontPath === "string" && sidecar.dynamicFontPath ? joinRoot(rootUrl, sidecar.dynamicFontPath) : null;
	return {
		authoredPath,
		renderMode: sidecar.renderMode as FontImporterRenderMode,
		family: sidecar.family,
		manifestUrl,
		manifest,
		pageUrls: manifest.pages.map((page) => joinRoot(rootUrl, `${manifestDirectory}${page}`)),
		dynamicFontUrl,
	};
}

/** Loads a dynamic imported font into the browser FontFaceSet and returns its generated family name. */
export async function installDynamicImportedFont(rootUrl: string, authoredPath: string): Promise<string> {
	const asset = await loadImportedFontAsset(rootUrl, authoredPath);
	if (asset.renderMode !== "dynamic" || !asset.dynamicFontUrl) {
		throw new Error(`Imported font "${authoredPath}" is not configured for dynamic rendering.`);
	}
	if (typeof FontFace === "undefined" || typeof document === "undefined") {
		throw new Error("Dynamic font installation requires a browser FontFace API.");
	}
	const face = new FontFace(asset.family, `url(${JSON.stringify(asset.dynamicFontUrl)})`);
	await face.load();
	document.fonts.add(face);
	return asset.family;
}
