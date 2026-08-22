import { Server, Socket } from "net";
import { copyFile, mkdir, pathExists } from "fs-extra";
import { dirname, join, basename, extname } from "path/posix";

import { PBRMaterial } from "babylonjs";
import { Editor, IEditorExtensionContext } from "babylonjs-editor";

import { importMaterial } from "./material";
import { QuixelJsonType, QuixelLodListType } from "./typings";
import { importMeshes, saveMeshesAsBabylonFormat } from "./mesh";

export const title = "Quixel Bridge";
export const description = "Quixel Bridge integration for Babylon.js Editor";

let server: Server | null = null;

function startServer(editor: Editor): Promise<void> {
	if (server?.listening) {
		return Promise.resolve();
	}
	server = new Server((socket) => {
		handeServerEvents(editor, socket);
	});
	return new Promise((resolve, reject) => {
		const instance = server!;
		let onError: (error: Error) => void;
		const onListening = (): void => {
			instance.removeListener("error", onError);
			instance.on("error", (error) => editor.layout.console.error(`Quixel Bridge listener error: ${error.message}`));
			resolve();
		};
		onError = (error: Error): void => {
			instance.removeListener("listening", onListening);
			if (server === instance) {
				server = null;
			}
			reject(error);
		};
		instance.once("error", onError);
		instance.once("listening", onListening);
		// Keep the import bridge loopback-only: trusting the extension must not expose an unauthenticated LAN listener.
		instance.listen(24981, "127.0.0.1");
	});
}

/** Versioned extension lifecycle used by Package Manager and external MCP automation. */
export async function activate(context: IEditorExtensionContext): Promise<() => void> {
	const editor = context.getEditor();
	await createRootFolder(editor);
	await startServer(editor);
	context.tests.register({
		id: "babylon.editor.quixel.listener",
		run: () => {
			if (!server?.listening) {
				throw new Error("Quixel Bridge loopback listener is not running.");
			}
		},
	});
	return close;
}

/** Legacy plugin entry retained while existing project files migrate to zvibeEditor manifests. */
export function main(editor: Editor): void {
	void createRootFolder(editor)
		.then(() => startServer(editor))
		.catch((error) => editor.layout.console.error(`Failed to start Quixel Bridge listener: ${error instanceof Error ? error.message : String(error)}`));
}

export function close(): void {
	try {
		server?.close();
	} catch (e) {
		// Catch silently
	} finally {
		server = null;
	}
}

/** Host-compatible cleanup name; close remains available to legacy plugin loading. */
export const deactivate = close;

function handeServerEvents(editor: Editor, socket: Socket): void {
	let buffer: Buffer | null = null;

	socket.on("data", (d: Buffer) => {
		if (!buffer) {
			buffer = Buffer.from(d);
		} else {
			buffer = Buffer.concat([buffer, d]);
		}
	});

	socket.on("end", async () => {
		if (!buffer) {
			return;
		}

		try {
			const data = JSON.parse(buffer.toString("utf-8")) as QuixelJsonType[];

			data.forEach((json) => {
				handleParsedAsset(editor, json);
			});
		} catch (e) {
			editor.layout.console.error("Failed to parse quixel JSON.");
		}

		buffer = null;
	});
}

async function createRootFolder(editor: Editor): Promise<void> {
	if (!editor.state.projectPath) {
		return;
	}

	const assetsFolder = join(dirname(editor.state.projectPath), "assets");
	if (!(await pathExists(assetsFolder))) {
		await mkdir(assetsFolder);
	}

	const quixelFolder = join(assetsFolder, "quixel");
	if (!(await pathExists(quixelFolder))) {
		await mkdir(quixelFolder);
	}
}

async function handleParsedAsset(editor: Editor, json: QuixelJsonType) {
	if (!editor.state.projectPath) {
		return;
	}

	json.path = json.path.replace(/\\/g, "/");

	// Create folders
	const quixelFolder = join(dirname(editor.state.projectPath), "assets", "quixel");

	const assetFolder = join(quixelFolder, basename(json.path));
	if (!(await pathExists(assetFolder))) {
		await mkdir(assetFolder);
	}

	const material = await importMaterial(editor, json, assetFolder);

	switch (json.type) {
		case "3d":
			await handleParse3d(editor, json, assetFolder, material);
			break;

		case "3dplant":
			await handleImport3dPlant(editor, json, assetFolder, material);
			break;
	}

	// Write preview for folder
	if (json.previewImage) {
		const extension = extname(json.previewImage);
		await copyFile(json.previewImage, join(assetFolder, `editor_preview${extension}`));
	}

	editor.layout.graph.refresh();
	editor.layout.assets.refresh();
}

async function handleParse3d(editor: Editor, json: QuixelJsonType, assetFolder: string, material: PBRMaterial | null) {
	const meshes = await importMeshes(editor, json.lodList);
	meshes.forEach((mesh) => {
		mesh.material = material;

		mesh.getLODLevels().forEach((lodLevel) => {
			if (lodLevel.mesh) {
				lodLevel.mesh.material = material;
			}
		});
	});

	saveMeshesAsBabylonFormat(editor, meshes, assetFolder);
}

async function handleImport3dPlant(editor: Editor, json: QuixelJsonType, assetFolder: string, material: PBRMaterial | null) {
	const variationsMap = new Map<number, QuixelLodListType[]>();
	json.lodList.forEach((lod) => {
		if (lod.variation === undefined) {
			return;
		}

		let variations = variationsMap.get(lod.variation);
		if (!variations) {
			variations = [lod];
			variationsMap.set(lod.variation, variations);
		} else {
			variations.push(lod);
		}
	});

	for (const [variation, lodList] of variationsMap) {
		const meshes = await importMeshes(editor, lodList);
		meshes.forEach((mesh) => {
			mesh.material = material;

			mesh.getLODLevels().forEach((lodLevel) => {
				if (lodLevel.mesh) {
					lodLevel.mesh.material = material;
				}
			});
		});

		saveMeshesAsBabylonFormat(editor, meshes, assetFolder, variation);
	}
}
