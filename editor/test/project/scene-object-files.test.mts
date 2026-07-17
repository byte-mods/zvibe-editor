import { describe, expect, test } from "vitest";

import { filterSerializedSceneObjectFiles, isSerializedSceneObjectFile } from "../../src/project/load/files";

describe("serialized scene object files", () => {
	test("rejects asset metadata sidecars and unrelated directory entries", () => {
		expect(isSerializedSceneObjectFile("mesh.json")).toBe(true);
		expect(isSerializedSceneObjectFile("MESH.JSON")).toBe(true);
		expect(isSerializedSceneObjectFile("mesh.json.bjsmeta.json")).toBe(false);
		expect(isSerializedSceneObjectFile("MESH.JSON.BJSMETA.JSON")).toBe(false);
		expect(isSerializedSceneObjectFile(".DS_Store")).toBe(false);
		expect(isSerializedSceneObjectFile("mesh.babylon")).toBe(false);
	});

	test("returns deterministic scene-object input without metadata duplicates", () => {
		expect(filterSerializedSceneObjectFiles(["z.json.bjsmeta.json", "z.json", ".hidden.json", "a.json", "readme.txt"])).toEqual(["a.json", "z.json"]);
	});
});
