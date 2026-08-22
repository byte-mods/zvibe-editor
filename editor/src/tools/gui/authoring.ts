import { dirname, isAbsolute, join, normalize } from "path/posix";
import { pathToFileURL } from "url";
import { readJSON } from "fs-extra";

import { IFontAtlasManifest, ILoadedImportedFont } from "babylonjs-editor-tools";

import { applyFontImporterArtifact, getFontImporterArtifactStatus } from "../../mcp/assets/font-importer";
import { projectConfiguration } from "../../project/configuration";

function resolveProjectFontPath(authoredPath: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const projectDirectory = dirname(projectConfiguration.path);
	const absolutePath = normalize(isAbsolute(authoredPath) ? authoredPath : join(projectDirectory, authoredPath));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("GUI font paths must stay inside the open project directory.");
	}
	return absolutePath;
}

/** Builds an exact imported-font artifact when needed and installs its source face for GUI preview. */
export async function installEditorGUIFontFamily(_rootUrl: string, authoredPath: string): Promise<string> {
	const absolutePath = resolveProjectFontPath(authoredPath);
	let status = await getFontImporterArtifactStatus(absolutePath);
	if (!status.current) {
		status = await applyFontImporterArtifact(absolutePath, status.fingerprint);
	}
	if (!status.result) {
		throw new Error(`Font importer did not produce an artifact for "${authoredPath}".`);
	}
	const sourcePath = status.result.sourceFontPath ?? status.result.dynamicFontPath ?? absolutePath;
	if (typeof FontFace === "undefined" || typeof document === "undefined") {
		throw new Error("GUI font preview requires the browser FontFace API.");
	}
	if (!document.fonts.check(`12px ${JSON.stringify(status.result.family)}`)) {
		const face = new FontFace(status.result.family, `url(${JSON.stringify(pathToFileURL(sourcePath).href)})`);
		await face.load();
		document.fonts.add(face);
	}
	return status.result.family;
}

/** Builds and resolves a complete imported-font artifact for atlas text in the live editor. */
export async function loadEditorGUIFontAsset(_rootUrl: string, authoredPath: string): Promise<ILoadedImportedFont> {
	const absolutePath = resolveProjectFontPath(authoredPath);
	let status = await getFontImporterArtifactStatus(absolutePath);
	if (!status.current) {
		status = await applyFontImporterArtifact(absolutePath, status.fingerprint);
	}
	if (!status.result) {
		throw new Error(`Font importer did not produce an artifact for "${authoredPath}".`);
	}
	const manifest = (await readJSON(status.result.manifestPath)) as IFontAtlasManifest;
	return {
		authoredPath,
		renderMode: status.result.renderMode,
		family: status.result.family,
		manifestUrl: pathToFileURL(status.result.manifestPath).href,
		manifest,
		pageUrls: status.result.pages.map((page) => pathToFileURL(page.path).href),
		dynamicFontUrl: status.result.dynamicFontPath ? pathToFileURL(status.result.dynamicFontPath).href : null,
		sourceFontUrl: status.result.sourceFontPath ? pathToFileURL(status.result.sourceFontPath).href : null,
	};
}
