import { describe, expect, test } from "vitest";

import * as materialGuards from "../../../src/tools/guards/material";
import * as mathGuards from "../../../src/tools/guards/math";
import * as nodeGuards from "../../../src/tools/guards/nodes";
import * as particleGuards from "../../../src/tools/guards/particles";
import * as sceneGuards from "../../../src/tools/guards/scene";
import * as shadowGuards from "../../../src/tools/guards/shadows";
import * as soundGuards from "../../../src/tools/guards/sound";
import * as spriteGuards from "../../../src/tools/guards/sprites";

describe("tools/guards null safety", () => {
	test("all class-name guards reject nullish values without throwing", () => {
		const guards = [
			...Object.values(materialGuards),
			...Object.values(mathGuards),
			...Object.values(nodeGuards),
			...Object.values(particleGuards),
			...Object.values(sceneGuards),
			...Object.values(shadowGuards),
			...Object.values(soundGuards),
			...Object.values(spriteGuards),
		];

		for (const guard of guards) {
			expect(guard(undefined)).toBe(false);
			expect(guard(null)).toBe(false);
		}
	});
});
