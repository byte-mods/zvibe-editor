import { describe, expect, test } from "vitest";

import { selectBuildSceneFiles } from "../src/pack/scenes.mjs";

describe("scene build settings", () => {
	test("uses enabled catalog order and ignores disabled scenes", () => {
		const projectDirectory = "/project";
		const discovered = ["/project/assets/A.scene", "/project/assets/B.scene", "/project/assets/C.scene"];

		expect(
			selectBuildSceneFiles(projectDirectory, discovered, {
				version: 1,
				scenes: [
					{ path: "assets/C.scene", enabled: true },
					{ path: "assets/A.scene", enabled: false },
					{ path: "assets/B.scene", enabled: true },
				],
			})
		).toEqual(["/project/assets/C.scene", "/project/assets/B.scene"]);
	});

	test("fails instead of silently producing an incomplete build when an enabled scene is missing", () => {
		expect(() =>
			selectBuildSceneFiles("/project", ["/project/assets/A.scene"], {
				version: 1,
				scenes: [
					{ path: "assets/A.scene", enabled: true },
					{ path: "assets/Missing.scene", enabled: true },
				],
			})
		).toThrow("does not exist");
	});

	test("keeps legacy discovery behavior when settings are absent", () => {
		const discovered = ["/project/assets/A.scene", "/project/assets/B.scene"];
		expect(selectBuildSceneFiles("/project", discovered)).toBe(discovered);
	});
});
