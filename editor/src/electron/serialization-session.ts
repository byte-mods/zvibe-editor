import { ipcMain } from "electron";

import type { ISerializationSessionSnapshot } from "../project/serialization-session";

const sessions = new Map<number, ISerializationSessionSnapshot>();

function isSnapshot(value: unknown): value is ISerializationSessionSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const source = value as Partial<ISerializationSessionSnapshot>;
	return source.version === 1 && Number.isSafeInteger(source.revision) && typeof source.loadedFileCount === "number" && typeof source.totalLoadCount === "number";
}

ipcMain.on("editor:serialization-session-update", (event, snapshot: unknown) => {
	if (isSnapshot(snapshot)) {
		sessions.set(event.sender.id, structuredClone(snapshot));
	}
});

/** Emits the shutdown diagnostic from Electron main while the renderer's final snapshot is still retained. */
export function logSerializationSessionShutdown(webContentsId: number): void {
	const snapshot = sessions.get(webContentsId);
	if (!snapshot?.oldest) {
		console.info("[Serialization] Editor session loaded no serialized files.");
	} else {
		console.info(
			`[Serialization] Editor session loaded ${snapshot.loadedFileCount} serialized files (${snapshot.totalLoadCount} reads). Oldest loaded version: ${snapshot.oldest.version} (${snapshot.oldest.path}).`
		);
	}
	sessions.delete(webContentsId);
}
