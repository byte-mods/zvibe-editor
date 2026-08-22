import { mkdtemp, readdir, remove, writeJSON } from "fs-extra";
import { join } from "path/posix";
import { tmpdir } from "os";

import { afterEach, describe, expect, test } from "vitest";

import { createCinematicDocument } from "babylonjs-editor-tools";

import { createCinematicDocumentFile, loadCinematicDocument, saveCinematicDocument } from "../../src/editor/layout/cinematic/serialization/document";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "zvibe-cinematic-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => remove(directory)));
});

describe("cinematic document persistence", () => {
	test("loads legacy assets and commits the migration under an exact lease", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "legacy.cinematic");
		await writeJSON(path, { name: "Legacy", framesPerSecond: 30, outputFramesPerSecond: 60, tracks: [] });

		const loaded = await loadCinematicDocument(path, { identitySeed: "assets/legacy.cinematic" });
		expect(loaded).toMatchObject({ migrated: true, document: { version: 2, revision: 0, name: "Legacy" } });

		const saved = await saveCinematicDocument(
			path,
			{ ...loaded.document, name: "Migrated" },
			{ expectedRevision: loaded.document.revision, expectedFingerprint: loaded.fingerprint },
			{ identitySeed: "assets/legacy.cinematic" }
		);
		expect(saved).toMatchObject({ migrated: false, document: { version: 2, revision: 1, name: "Migrated" } });
		expect((await loadCinematicDocument(path)).document).toMatchObject({ version: 2, revision: 1, name: "Migrated" });
		expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});

	test("serializes competing saves and rejects the stale writer", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "exact.cinematic");
		const created = await createCinematicDocumentFile(path, createCinematicDocument("Exact", "exact"));
		const lease = { expectedRevision: created.document.revision, expectedFingerprint: created.fingerprint };
		const results = await Promise.allSettled([
			saveCinematicDocument(path, { ...created.document, name: "First" }, lease),
			saveCinematicDocument(path, { ...created.document, name: "Second" }, lease),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await loadCinematicDocument(path)).document.revision).toBe(1);
		expect(() => createCinematicDocumentFile(path, createCinematicDocument("Duplicate", "duplicate"))).rejects.toThrow("already exists");
	});
});
