import { ensureDir, mkdtemp, readJSON, remove } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	currentEditorSerializationVersion,
	formatSerializationSessionShutdownLog,
	getSerializationSessionDiagnostics,
	readSerializedJSON,
	recordSerializedFileLoaded,
	resetSerializationSessionDiagnosticsForTests,
	writeSerializedJSON,
} from "../../src/project/serialization-session";

describe("serialization session diagnostics", () => {
	let directory: string;

	beforeEach(async () => {
		resetSerializationSessionDiagnosticsForTests();
		directory = await mkdtemp(join(tmpdir(), "zvibe-serialization-session-"));
	});

	afterEach(async () => {
		await remove(directory);
	});

	test("orders legacy, numeric, semver, and current markers and retains bounded load evidence", () => {
		recordSerializedFileLoaded(join(directory, "current.json"), { serializationVersion: currentEditorSerializationVersion }, "scene-config");
		recordSerializedFileLoaded(join(directory, "project.bjseditor"), { version: "0.9.0" }, "project");
		recordSerializedFileLoaded(join(directory, "component.json"), { version: 2 }, "component");
		recordSerializedFileLoaded(join(directory, "legacy.json"), {}, "mesh");
		recordSerializedFileLoaded(join(directory, "legacy.json"), {}, "mesh");
		const snapshot = getSerializationSessionDiagnostics({ limit: 2 });
		expect(snapshot).toMatchObject({ revision: 5, loadedFileCount: 4, totalLoadCount: 5, oldest: { version: "legacy-unversioned", loadCount: 2 } });
		expect(snapshot.entries).toHaveLength(2);
		expect(snapshot.pagination).toMatchObject({ total: 4, hasMore: true, nextOffset: 2 });
		expect(formatSerializationSessionShutdownLog(snapshot)).toContain("Oldest loaded version: legacy-unversioned");
	});

	test("writes the current explicit marker and records it when read", async () => {
		const path = join(directory, "scene", "config.json");
		await ensureDir(join(directory, "scene"));
		await writeSerializedJSON(path, { clearColor: [0, 0, 0, 1] }, { spaces: 2 });
		expect(await readJSON(path)).toMatchObject({ serializationVersion: currentEditorSerializationVersion });
		await readSerializedJSON(path, "utf8");
		expect(getSerializationSessionDiagnostics().oldest).toMatchObject({ path, version: currentEditorSerializationVersion, isCurrent: true });
	});

	test("rejects unsafe pagination and non-object publication roots", async () => {
		expect(() => getSerializationSessionDiagnostics({ limit: 501 })).toThrow(/1 through 500/);
		await expect(writeSerializedJSON(join(directory, "array.json"), [])).rejects.toThrow(/object root/);
	});
});
